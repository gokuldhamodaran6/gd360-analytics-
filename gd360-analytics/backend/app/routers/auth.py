"""
Registration / login / profile / password.

Security measures in this file:
  - New accounts must correctly answer a random one-digit addition
    question before the account is created at all (blocks scripted/bot
    signups, at no cost and with no third-party service needed).
  - Failed logins are tracked per account; too many in a row locks the
    account for a cooldown period (blocks password-guessing bots).
  - Register, login and captcha issuance are all rate limited per client
    IP (blocks scripted abuse of any single endpoint).
  - Passwords are hashed with bcrypt; sessions use JWT bearer tokens.
"""
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from .. import models, schemas, security
from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user
from ..services import audit, captcha
from ..services import mfa as mfa_svc

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()

# Simple in-memory sliding-window rate limiter (per process), the same
# pattern already used in chat.py. Kept as its own copy here rather than
# shared, so this file does not depend on - or risk destabilizing - the
# working chat rate limiter.
_call_log: dict[str, deque] = defaultdict(deque)


def _check_rate_limit(key: str, limit: int, window_seconds: int = 60):
    now = time.time()
    log = _call_log[key]
    while log and now - log[0] > window_seconds:
        log.popleft()
    if len(log) >= limit:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many attempts. Please wait a minute and try again.",
        )
    log.append(now)


def _client_ip(request: Request) -> str:
    # Render (and most PaaS platforms) sit behind a proxy, so the real
    # client address is in X-Forwarded-For, not request.client.host.
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@router.get("/captcha", response_model=schemas.CaptchaOut)
def get_captcha(request: Request):
    ip = _client_ip(request)
    _check_rate_limit(f"captcha:ip:{ip}", limit=20)
    captcha_id, question = captcha.create_challenge()
    return schemas.CaptchaOut(captcha_id=captcha_id, question=f"What is {question}?")


@router.post("/register", response_model=schemas.Token, status_code=status.HTTP_201_CREATED)
def register(payload: schemas.UserCreate, request: Request, db: Session = Depends(get_db)):
    ip = _client_ip(request)
    _check_rate_limit(f"register:ip:{ip}", limit=10)

    if not captcha.verify_and_consume(payload.captcha_id, payload.captcha_answer):
        raise HTTPException(
            status_code=400,
            detail="That answer was not correct. Please try the new question below.",
        )

    existing = db.query(models.User).filter(models.User.email == payload.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="An account with this email already exists.")

    user = models.User(
        email=payload.email,
        hashed_password=security.hash_password(payload.password),
        full_name=payload.full_name,
        company=payload.company,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    # Every account gets one real, non-deletable "Personal Workspace" from
    # the moment it exists - see models.Workspace and routers/workspaces.py.
    # Pre-existing accounts get the same thing via
    # database._ensure_personal_workspaces, run once at startup.
    personal_ws = models.Workspace(name="Personal Workspace", owner_id=user.id, is_personal=True)
    db.add(personal_ws)
    db.flush()
    db.add(models.WorkspaceMember(workspace_id=personal_ws.id, user_id=user.id, role="owner"))
    audit.log_audit_event(
        db, actor=user, action="signup", workspace_id=personal_ws.id, target_type="user", target_id=user.id,
    )
    db.commit()

    token = security.create_access_token(subject=user.id, token_version=user.token_version or 0)
    return schemas.Token(access_token=token, user=_user_out(db, user))


@router.post("/login", response_model=schemas.Token)
def login(payload: schemas.UserLogin, request: Request, db: Session = Depends(get_db)):
    ip = _client_ip(request)
    _check_rate_limit(f"login:ip:{ip}", limit=20)

    user = db.query(models.User).filter(models.User.email == payload.email).first()

    if user and getattr(user, "disabled_at", None):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This account is suspended. Contact support.")

    if user and user.locked_until and user.locked_until > datetime.utcnow():
        minutes_left = max(1, int((user.locked_until - datetime.utcnow()).total_seconds() // 60) + 1)
        raise HTTPException(
            status_code=status.HTTP_423_LOCKED,
            detail=f"Too many failed attempts. Try again in about {minutes_left} minute(s).",
        )

    if not user or not security.verify_password(payload.password, user.hashed_password):
        if user:
            user.failed_login_attempts = (user.failed_login_attempts or 0) + 1
            if user.failed_login_attempts >= settings.LOGIN_LOCKOUT_ATTEMPTS:
                user.locked_until = datetime.utcnow() + timedelta(minutes=settings.LOGIN_LOCKOUT_MINUTES)
                user.failed_login_attempts = 0
            db.commit()
        raise HTTPException(status_code=401, detail="Incorrect email or password.")

    user.failed_login_attempts = 0
    user.locked_until = None
    if user.mfa_enabled_at and user.mfa_secret_enc:
        # 2026-10-10 (round 19): the password was right; now the code.
        db.commit()
        return schemas.Token(access_token="", user=_user_out(db, user), mfa_required=True,
                             mfa_token=security.create_mfa_token(user.id, user.token_version or 0))
    audit.log_audit_event(db, actor=user, action="login")
    db.commit()
    db.refresh(user)

    token = security.create_access_token(subject=user.id, token_version=user.token_version or 0)
    return schemas.Token(access_token=token, user=_user_out(db, user))


def _user_out(db: Session, user: models.User) -> schemas.UserOut:
    """UserOut plus the 2-step flags (round 19)."""
    out = schemas.UserOut.model_validate(user)
    if not user.mfa_enabled_at:
        from ..services import policies
        rows = (db.query(models.Workspace).join(models.WorkspaceMember, models.WorkspaceMember.workspace_id == models.Workspace.id)
                .filter(models.WorkspaceMember.user_id == user.id, models.Workspace.is_personal.is_(False)).all())
        out.mfa_setup_required = any(policies.get(ws).get("require_mfa") for ws in rows)
    return out


@router.get("/me", response_model=schemas.UserOut)
def me(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return _user_out(db, current_user)


# ------------------------------------------------- 2-step sign-in (round 19) ----

class _MfaLogin(schemas.BaseModel):
    mfa_token: str
    code: str


@router.post("/login/mfa", response_model=schemas.Token)
def login_mfa(payload: _MfaLogin, request: Request, db: Session = Depends(get_db)):
    """Second step of a 2-step sign-in: a 6-digit code from the
    authenticator app, or one of the person's recovery codes."""
    data = security.decode_mfa_token(payload.mfa_token)
    if not data:
        raise HTTPException(401, "That sign-in took too long - enter your email and password again.")
    _check_rate_limit(f"mfa:{data['uid']}", limit=8)
    _check_rate_limit(f"mfa:ip:{_client_ip(request)}", limit=20)
    user = db.get(models.User, data["uid"])
    if not user or not user.mfa_enabled_at or int(data.get("tv", 0)) != int(user.token_version or 0):
        raise HTTPException(401, "That sign-in took too long - enter your email and password again.")
    if getattr(user, "disabled_at", None):
        raise HTTPException(403, "This account is suspended. Contact support.")
    secret = security.decrypt_secret(user.mfa_secret_enc) if user.mfa_secret_enc else ""
    code = (payload.code or "").strip()
    used_recovery = False
    if not (secret and mfa_svc.verify(secret, code)):
        left = mfa_svc.use_recovery_code(user.mfa_recovery_hashes, code)
        if left is None:
            raise HTTPException(400, "That code didn't match. Use the 6-digit code your app shows now, or a recovery code.")
        user.mfa_recovery_hashes = left
        used_recovery = True
    audit.log_audit_event(db, actor=user, action="mfa_recovery_used" if used_recovery else "login",
                          metadata={"two_step": True, "host": data.get("host")})
    db.commit()
    db.refresh(user)
    token = security.create_access_token(subject=user.id, token_version=user.token_version or 0)
    return schemas.Token(access_token=token, user=_user_out(db, user))


@router.get("/mfa")
def mfa_status(current_user: models.User = Depends(get_current_user)):
    return {"enabled": bool(current_user.mfa_enabled_at),
            "enabled_at": current_user.mfa_enabled_at.isoformat() + "Z" if current_user.mfa_enabled_at else None,
            "recovery_codes_left": len(current_user.mfa_recovery_hashes or []) if current_user.mfa_enabled_at else 0}


@router.post("/mfa/setup")
def mfa_setup(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Starts setup: a new secret (not active until a first code proves the
    app has it). Calling it again replaces an unfinished setup."""
    if current_user.mfa_enabled_at:
        raise HTTPException(409, "2-step sign-in is already on.")
    secret = mfa_svc.new_secret()
    current_user.mfa_secret_enc = security.encrypt_secret(secret)
    db.commit()
    uri = mfa_svc.otpauth_uri(current_user.email, secret)
    return {"secret": " ".join(secret[i:i + 4] for i in range(0, len(secret), 4)), "uri": uri, "qr_svg": mfa_svc.qr_svg(uri)}


class _MfaCode(schemas.BaseModel):
    code: str


@router.post("/mfa/enable")
def mfa_enable(payload: _MfaCode, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _check_rate_limit(f"mfa-enable:{current_user.id}", limit=10)
    if current_user.mfa_enabled_at:
        raise HTTPException(409, "2-step sign-in is already on.")
    secret = security.decrypt_secret(current_user.mfa_secret_enc) if current_user.mfa_secret_enc else ""
    if not secret:
        raise HTTPException(400, "Start again - scan the code first.")
    if not mfa_svc.verify(secret, payload.code):
        raise HTTPException(400, "That code didn't match. Check the time on your phone is set automatically, then try the newest code.")
    codes = mfa_svc.new_recovery_codes()
    current_user.mfa_enabled_at = datetime.utcnow()
    current_user.mfa_recovery_hashes = [mfa_svc.hash_code(c) for c in codes]
    audit.log_audit_event(db, actor=current_user, action="mfa_enabled")
    db.commit()
    return {"enabled": True, "recovery_codes": codes}


class _Password(schemas.BaseModel):
    password: str


@router.post("/mfa/disable")
def mfa_disable(payload: _Password, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _check_rate_limit(f"mfa-disable:{current_user.id}", limit=10)
    if not security.verify_password(payload.password, current_user.hashed_password):
        raise HTTPException(400, "Your password is incorrect.")
    current_user.mfa_enabled_at = None
    current_user.mfa_secret_enc = None
    current_user.mfa_recovery_hashes = None
    audit.log_audit_event(db, actor=current_user, action="mfa_disabled")
    db.commit()
    return {"enabled": False}


@router.post("/mfa/recovery-codes")
def mfa_new_codes(payload: _Password, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _check_rate_limit(f"mfa-codes:{current_user.id}", limit=10)
    if not current_user.mfa_enabled_at:
        raise HTTPException(400, "Turn on 2-step sign-in first.")
    if not security.verify_password(payload.password, current_user.hashed_password):
        raise HTTPException(400, "Your password is incorrect.")
    codes = mfa_svc.new_recovery_codes()
    current_user.mfa_recovery_hashes = [mfa_svc.hash_code(c) for c in codes]
    db.commit()
    return {"recovery_codes": codes}


# ------------------------------------------- one-time email codes (round 19) ----

class _CodeRequest(schemas.BaseModel):
    email: schemas.EmailStr
    host: str | None = None


class _CodeVerify(schemas.BaseModel):
    email: schemas.EmailStr
    code: str
    host: str | None = None
    full_name: str | None = None


def _site_name(db: Session, host: str | None) -> str:
    if host:
        dom = db.query(models.WorkspaceDomain).filter(models.WorkspaceDomain.hostname == host.lower()).first()
        if dom:
            ws = db.get(models.Workspace, dom.workspace_id)
            return dom.site_title or (f"{ws.name} data" if ws else host)
    return "GD360"


@router.post("/code/request")
def request_code(payload: _CodeRequest, request: Request, db: Session = Depends(get_db)):
    """Emails a 6-digit sign-in code. Always answers the same way, so it
    never tells anyone whether an email has an account."""
    import hashlib
    import secrets as _secrets
    from ..services import automations as auto_svc
    ip = _client_ip(request)
    email = str(payload.email).lower().strip()
    _check_rate_limit(f"code:ip:{ip}", limit=10)
    _check_rate_limit(f"code:email:{email}", limit=4, window_seconds=600)
    if not auto_svc.email_configured():
        raise HTTPException(503, "Sign-in codes need email, which isn't set up on this server yet - use your password.")
    code = f"{_secrets.randbelow(1000000):06d}"
    db.query(models.LoginCode).filter(models.LoginCode.email == email, models.LoginCode.used_at.is_(None)).update(
        {models.LoginCode.used_at: datetime.utcnow()}, synchronize_session=False)
    db.add(models.LoginCode(email=email, code_hash=hashlib.sha256(code.encode()).hexdigest(), host=(payload.host or None),
                            expires_at=datetime.utcnow() + timedelta(minutes=10)))
    db.commit()
    site = _site_name(db, payload.host)
    try:
        auto_svc.send_email(
            [email], f"{code} is your {site} sign-in code",
            f"<p>Your sign-in code for <b>{site}</b> is</p><p style=\"font-size:28px;font-weight:700;letter-spacing:4px\">{code}</p>"
            f"<p>It works once, for 10 minutes. If you didn't ask for it, ignore this email.</p>",
            f"Your sign-in code for {site} is {code}. It works once, for 10 minutes. If you didn't ask for it, ignore this email.",
        )
    except Exception as e:  # noqa: BLE001
        print(f"[auth] sign-in code email failed: {e}")
        raise HTTPException(502, "We couldn't send the email just now - try again in a minute, or use your password.")
    return {"sent": True}


@router.post("/code/verify", response_model=schemas.Token)
def verify_code(payload: _CodeVerify, request: Request, db: Session = Depends(get_db)):
    """Signs in with an emailed code - and proves the email is theirs. A
    person with no GD360 account yet gets one (no password; they can set
    one later), with their own personal workspace."""
    import hashlib
    import secrets as _secrets
    email = str(payload.email).lower().strip()
    _check_rate_limit(f"code-verify:ip:{_client_ip(request)}", limit=20)
    row = (db.query(models.LoginCode).filter(models.LoginCode.email == email, models.LoginCode.used_at.is_(None))
           .order_by(models.LoginCode.created_at.desc()).first())
    wrong = HTTPException(400, "That code didn't match or has expired - ask for a new one.")
    if not row or row.expires_at < datetime.utcnow():
        raise wrong
    if row.attempts >= 5:
        row.used_at = datetime.utcnow()
        db.commit()
        raise wrong
    digits = "".join(ch for ch in payload.code if ch.isdigit())
    if hashlib.sha256(digits.encode()).hexdigest() != row.code_hash:
        row.attempts += 1
        db.commit()
        raise wrong
    row.used_at = datetime.utcnow()
    user = db.query(models.User).filter(models.User.email.ilike(email)).first()
    created = False
    if not user:
        user = models.User(email=email, hashed_password=security.hash_password(_secrets.token_urlsafe(24)),
                           full_name=(payload.full_name or "").strip() or None)
        db.add(user)
        db.flush()
        ws = models.Workspace(name="Personal Workspace", owner_id=user.id, is_personal=True)
        db.add(ws)
        db.flush()
        db.add(models.WorkspaceMember(workspace_id=ws.id, user_id=user.id, role="owner"))
        audit.log_audit_event(db, actor=user, action="signup", workspace_id=ws.id, target_type="user", target_id=user.id,
                              metadata={"via": "email_code", "host": payload.host})
        created = True
    if getattr(user, "disabled_at", None):
        db.commit()
        raise HTTPException(403, "This account is suspended. Contact support.")
    user.email_verified_at = user.email_verified_at or datetime.utcnow()
    if user.mfa_enabled_at and user.mfa_secret_enc and not created:
        db.commit()
        return schemas.Token(access_token="", user=_user_out(db, user), mfa_required=True,
                             mfa_token=security.create_mfa_token(user.id, user.token_version or 0, payload.host))
    audit.log_audit_event(db, actor=user, action="login", metadata={"via": "email_code", "host": payload.host})
    db.commit()
    db.refresh(user)
    token = security.create_access_token(subject=user.id, token_version=user.token_version or 0)
    return schemas.Token(access_token=token, user=_user_out(db, user))


@router.post("/verify-email/request")
def verify_email_request(request: Request, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """For a signed-in person whose email isn't proven yet (company domains
    need it): sends a code to it."""
    return request_code(_CodeRequest(email=current_user.email, host=request.headers.get("x-gd360-host")), request, db)


@router.post("/verify-email/confirm")
def verify_email_confirm(payload: _MfaCode, request: Request, db: Session = Depends(get_db),
                         current_user: models.User = Depends(get_current_user)):
    import hashlib
    email = current_user.email.lower()
    _check_rate_limit(f"code-verify:ip:{_client_ip(request)}", limit=20)
    row = (db.query(models.LoginCode).filter(models.LoginCode.email == email, models.LoginCode.used_at.is_(None))
           .order_by(models.LoginCode.created_at.desc()).first())
    if not row or row.expires_at < datetime.utcnow() or row.attempts >= 5:
        raise HTTPException(400, "That code has expired - ask for a new one.")
    digits = "".join(ch for ch in payload.code if ch.isdigit())
    if hashlib.sha256(digits.encode()).hexdigest() != row.code_hash:
        row.attempts += 1
        db.commit()
        raise HTTPException(400, "That code didn't match.")
    row.used_at = datetime.utcnow()
    current_user.email_verified_at = datetime.utcnow()
    db.commit()
    return {"email_verified": True}


@router.patch("/profile", response_model=schemas.UserOut)
def update_profile(
    payload: schemas.UpdateProfileRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if payload.full_name is not None:
        current_user.full_name = payload.full_name.strip() or None
    if payload.company is not None:
        current_user.company = payload.company.strip() or None
    db.commit()
    db.refresh(current_user)
    return current_user


@router.post("/change-password")
def change_password(
    payload: schemas.ChangePasswordRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if not security.verify_password(payload.current_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Your current password is incorrect.")

    current_user.hashed_password = security.hash_password(payload.new_password)
    # 2026-10-10 (round 19): signs out every other session, as the model
    # comment always said it did. This session gets a fresh token.
    current_user.token_version = (current_user.token_version or 0) + 1
    audit.log_audit_event(db, actor=current_user, action="password_changed")
    db.commit()
    db.refresh(current_user)
    token = security.create_access_token(subject=current_user.id, token_version=current_user.token_version or 0)
    return {"message": "Your password has been updated. Other devices have been signed out.", "access_token": token}

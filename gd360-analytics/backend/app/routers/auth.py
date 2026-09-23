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
from ..services import captcha

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
    db.commit()

    token = security.create_access_token(subject=user.id)
    return schemas.Token(access_token=token, user=schemas.UserOut.model_validate(user))


@router.post("/login", response_model=schemas.Token)
def login(payload: schemas.UserLogin, request: Request, db: Session = Depends(get_db)):
    ip = _client_ip(request)
    _check_rate_limit(f"login:ip:{ip}", limit=20)

    user = db.query(models.User).filter(models.User.email == payload.email).first()

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
    db.commit()
    db.refresh(user)

    token = security.create_access_token(subject=user.id)
    return schemas.Token(access_token=token, user=schemas.UserOut.model_validate(user))


@router.get("/me", response_model=schemas.UserOut)
def me(current_user: models.User = Depends(get_current_user)):
    return current_user


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
    db.commit()

    return {"message": "Your password has been updated."}

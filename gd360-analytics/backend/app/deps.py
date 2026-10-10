"""
Shared FastAPI dependencies: DB session + current authenticated user.
"""
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from .config import get_settings
from .database import get_db
from .security import decode_access_token, decode_access_token_full  # noqa: F401
from . import models

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> models.User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    payload = decode_access_token_full(token)
    # 2026-10-10 (round 19): only a real access token signs a person in. The
    # app's other signed tokens (OAuth state, private-dashboard viewer, the
    # 2-step pending token) all carry a "typ" and are refused here.
    if payload and payload.get("typ"):
        raise credentials_exception
    user_id = payload.get("sub") if payload else None
    if user_id is None:
        raise credentials_exception
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if user is None:
        raise credentials_exception
    # 2026-10-10 (Mission Control): "Sign out everywhere" bumps token_version;
    # a token issued before that no longer works. Tokens issued before this
    # change carry no "tv" and count as version 0.
    if int(payload.get("tv", 0) or 0) != int(user.token_version or 0):
        raise credentials_exception
    if getattr(user, "disabled_at", None):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This account is suspended. Contact support.")
    return user


def get_current_admin(
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> models.User:
    """Anyone with Mission Control access: an ADMIN_EMAILS owner or an
    active staff member. Finer permissions: services/admin_access.require()."""
    from .services.admin_access import staff_role  # local import avoids a cycle
    if not staff_role(db, current_user.email):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access only.")
    return current_user

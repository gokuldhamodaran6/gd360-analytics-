"""
Security primitives:
  - password hashing (bcrypt via passlib)
  - JWT issuance/verification
  - symmetric encryption for datasource credentials at rest (Fernet)

No customer database credential is ever stored in plaintext, logged, or
returned to the frontend once saved.
"""
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
from cryptography.fernet import Fernet
from jose import jwt, JWTError

from .config import get_settings

settings = get_settings()

# We call the `bcrypt` library directly rather than going through passlib's
# CryptContext: passlib's own self-test (which hashes an intentionally long
# secret to detect an old bcrypt wrap-around bug) is incompatible with
# modern bcrypt releases and raises at import/hash time. Hashing directly
# avoids that entirely. bcrypt itself only uses the first 72 bytes of a
# password, so we truncate defensively before hashing/verifying.


def hash_password(password: str) -> str:
    pw_bytes = password.encode("utf-8")[:72]
    return bcrypt.hashpw(pw_bytes, bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8")[:72], hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def create_access_token(subject: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": subject, "exp": expire}
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_access_token(token: str) -> Optional[str]:
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
        return payload.get("sub")
    except JWTError:
        return None


def create_oauth_state(user_id: str, provider: str) -> str:
    """A short-lived, signed token that round-trips through a third-party
    OAuth consent screen (Google/Microsoft - see routers/connections.py) and
    comes back on the callback as the `state` query param. This is what
    lets an otherwise-anonymous browser redirect back into the app be
    trusted to belong to a specific already-logged-in user, without ever
    needing a cookie or Authorization header on that unauthenticated
    callback request - the provider itself is trusted to echo `state` back
    unmodified, and the signature here means nobody else can forge one for
    a different user_id. `nonce` makes each state token unique even when
    the same user starts the same provider's flow twice in a row."""
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.OAUTH_STATE_EXPIRE_MINUTES)
    payload = {
        "sub": user_id,
        "provider": provider,
        "typ": "oauth_state",
        "nonce": secrets.token_urlsafe(12),
        "exp": expire,
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_oauth_state(token: str, expected_provider: str) -> Optional[str]:
    """Returns the user_id a create_oauth_state token was minted for, or
    None if the token is missing, expired, tampered with, or was minted for
    a different provider than the callback that received it."""
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except JWTError:
        return None
    if payload.get("typ") != "oauth_state" or payload.get("provider") != expected_provider:
        return None
    return payload.get("sub")


def _fernet() -> Fernet:
    key = settings.CREDENTIAL_ENCRYPTION_KEY
    if not key:
        raise RuntimeError(
            "CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with:\n"
            "  python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\"\n"
            "and set it in your environment before storing any datasource credentials."
        )
    return Fernet(key.encode() if isinstance(key, str) else key)


def encrypt_secret(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt_secret(ciphertext: str) -> str:
    return _fernet().decrypt(ciphertext.encode()).decode()

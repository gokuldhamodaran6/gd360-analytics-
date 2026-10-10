"""
2-step sign-in with an authenticator app (2026-10-10, round 19).

TOTP as in RFC 6238 (SHA-1, 6 digits, 30-second steps) - what Google
Authenticator, Microsoft Authenticator, 1Password, Authy and others use.
The shared secret is stored encrypted (security.encrypt_secret). Ten
one-time recovery codes are shown once and stored only as SHA-256 hashes.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

ISSUER = "GD360"
STEP = 30
DIGITS = 6


def new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def _key(secret: str) -> bytes:
    s = secret.strip().replace(" ", "").upper()
    return base64.b32decode(s + "=" * (-len(s) % 8))


def code_at(secret: str, t: float | None = None) -> str:
    counter = int((t if t is not None else time.time()) // STEP)
    digest = hmac.new(_key(secret), struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % (10 ** DIGITS)).zfill(DIGITS)


def verify(secret: str, code: str, window: int = 1, t: float | None = None) -> bool:
    c = "".join(ch for ch in str(code or "") if ch.isdigit())
    if len(c) != DIGITS:
        return False
    now = t if t is not None else time.time()
    return any(hmac.compare_digest(code_at(secret, now + i * STEP), c) for i in range(-window, window + 1))


def otpauth_uri(email: str, secret: str) -> str:
    label = quote(f"{ISSUER}:{email}")
    return f"otpauth://totp/{label}?secret={secret}&issuer={quote(ISSUER)}&algorithm=SHA1&digits={DIGITS}&period={STEP}"


def qr_svg(uri: str) -> str | None:
    """An SVG QR code of the otpauth link (segno is a small pure-Python
    library). None if it isn't installed - the page then shows the key to
    type in instead."""
    try:
        import segno
    except ImportError:
        return None
    qr = segno.make(uri, error="m")
    return qr.svg_inline(scale=5, dark="#07090A", light="#FFFFFF", border=2)


def new_recovery_codes(n: int = 10) -> list[str]:
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    out = []
    for _ in range(n):
        raw = "".join(secrets.choice(alphabet) for _ in range(10))
        out.append(f"{raw[:5]}-{raw[5:]}")
    return out


def hash_code(code: str) -> str:
    c = "".join(ch for ch in str(code or "").lower() if ch.isalnum())
    return hashlib.sha256(c.encode()).hexdigest()


def use_recovery_code(hashes: list[str] | None, code: str) -> list[str] | None:
    """Returns the remaining hashes if `code` is one of them (it is used up),
    else None."""
    h = hash_code(code)
    hashes = list(hashes or [])
    for i, x in enumerate(hashes):
        if hmac.compare_digest(x, h):
            return hashes[:i] + hashes[i + 1:]
    return None

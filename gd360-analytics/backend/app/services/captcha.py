"""
A tiny, no-dependency "prove you are a person" check shown once at signup:
a random one-digit addition question (e.g. "4 + 8"). No email, SMS, or
third-party API is required, so it costs nothing to run.

Answers are stored in memory, keyed by a random one-time id, and expire
after a few minutes. This mirrors the same in-process pattern already used
for rate limiting elsewhere in the app (see chat.py / auth.py) - it works
well on a single backend instance and needs no extra infrastructure.
"""
import random
import secrets
from datetime import datetime, timedelta

from ..config import get_settings

settings = get_settings()

_store: dict[str, dict] = {}


def _sweep_expired():
    now = datetime.utcnow()
    expired = [cid for cid, entry in _store.items() if entry["expires_at"] < now]
    for cid in expired:
        _store.pop(cid, None)


def create_challenge() -> tuple[str, str]:
    """Returns (captcha_id, question_text) such as ("ab12...", "4 + 8").
    The correct answer is kept server-side only - it is never sent to the
    browser."""
    _sweep_expired()
    a = random.randint(1, 9)
    b = random.randint(1, 9)
    captcha_id = secrets.token_urlsafe(16)
    _store[captcha_id] = {
        "answer": a + b,
        "expires_at": datetime.utcnow() + timedelta(minutes=settings.CAPTCHA_EXPIRE_MINUTES),
    }
    return captcha_id, f"{a} + {b}"


def verify_and_consume(captcha_id: str, answer: str) -> bool:
    """Single-use: whether this call succeeds or fails, the challenge is
    removed so it cannot be replayed."""
    entry = _store.pop(captcha_id, None)
    if not entry:
        return False
    if entry["expires_at"] < datetime.utcnow():
        return False
    try:
        given = int(str(answer).strip())
    except (TypeError, ValueError):
        return False
    return given == entry["answer"]

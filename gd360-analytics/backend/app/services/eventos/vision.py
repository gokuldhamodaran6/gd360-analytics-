"""Seeing pictures: reading a business card for a walk-in, and checking
whether a post's image shows the event's banner, backdrop, badge or logo.
Uses the configured AI provider's vision model (Gemini by default, a
lighter model for cost). No face recognition: the prompt asks for brand
marks and printed text only."""
from __future__ import annotations

import base64
import json
import re

import requests

from ...config import get_settings

settings = get_settings()


def available() -> bool:
    p = settings.AI_PROVIDER
    return bool((p == "gemini" and settings.GEMINI_API_KEY) or (p == "openai" and settings.OPENAI_API_KEY))


def _sniff(raw: bytes) -> str:
    if raw[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return "image/jpeg"


def _call(prompt: str, images: list[bytes], max_tokens: int = 600) -> str:
    parts = [{"type": "text", "text": prompt}]
    for raw in images:
        parts.append({"type": "image_url", "image_url": {"url": f"data:{_sniff(raw)};base64,{base64.b64encode(raw).decode()}"}})
    msgs = [{"role": "user", "content": parts}]
    if settings.AI_PROVIDER == "gemini":
        url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        key = settings.GEMINI_API_KEY.strip()
        model = settings.GEMINI_GOKU_MODEL or settings.GEMINI_MODEL
    else:
        url, key, model = "https://api.openai.com/v1/chat/completions", settings.OPENAI_API_KEY.strip(), settings.OPENAI_MODEL
    r = requests.post(url, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                      json={"model": model, "messages": msgs, "temperature": 0.1, "max_tokens": max_tokens}, timeout=45)
    if r.status_code >= 400:
        raise RuntimeError(f"The vision model answered {r.status_code}: {r.text[:200]}")
    body = r.json()
    try:
        from ..ai_engine import _meter_usage
        _meter_usage(body)
    except Exception:  # noqa: BLE001
        pass
    return (body.get("choices") or [{}])[0].get("message", {}).get("content") or ""


def _json(text: str) -> dict:
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return {}
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return {}


def read_card(image: bytes) -> dict:
    """A business card, badge or LinkedIn profile screenshot -> contact fields."""
    out = _json(_call(
        "Read the contact details printed on this business card, conference badge or profile screenshot. "
        "Return JSON only: {\"name\": str|null, \"title\": str|null, \"company\": str|null, \"email\": str|null, "
        "\"phone\": str|null, \"website\": str|null, \"linkedin\": str|null}. Use null for anything not printed. "
        "Do not guess.", [image], 300))
    clean = {}
    for k in ("name", "title", "company", "email", "phone", "website", "linkedin"):
        v = out.get(k)
        clean[k] = str(v).strip()[:200] if v not in (None, "", "null") else None
    return clean


def match_brand(post_image: bytes, refs: list[bytes], event_title: str, hashtags: list[str]) -> dict:
    """Does this picture show the event? Compares with the reference images
    (banner, backdrop, badge, logo) and reads any printed text."""
    prompt = (
        f"The event is \"{event_title}\" (hashtags: {', '.join(hashtags) or 'none'}). The first image is a social media post. "
        f"The other {len(refs)} image(s) are the event's own banner, stage backdrop, badge or logo. "
        "Decide whether the post's image shows this event's branding: the same banner or backdrop design, the event name "
        "or logo printed anywhere, or the event badge/lanyard. Ignore people's faces - never identify anyone. "
        "Return JSON only: {\"match\": true|false, \"confidence\": 0-1, \"seen\": \"banner|backdrop|badge|logo|text|none\", "
        "\"ocr_text\": \"text printed in the image\", \"why\": \"one short sentence\"}")
    out = _json(_call(prompt, [post_image] + refs[:3], 300))
    try:
        conf = max(0.0, min(1.0, float(out.get("confidence") or 0)))
    except (TypeError, ValueError):
        conf = 0.0
    return {"match": bool(out.get("match")), "confidence": conf, "seen": str(out.get("seen") or "none")[:20],
            "ocr_text": str(out.get("ocr_text") or "")[:400], "why": str(out.get("why") or "")[:240]}

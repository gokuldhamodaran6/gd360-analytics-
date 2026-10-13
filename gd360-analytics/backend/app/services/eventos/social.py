"""Posts about the event - before, during and after - found without anyone
tagging them.

Where posts come from
  * your own synced accounts (Instagram, Facebook Pages, LinkedIn Pages,
    YouTube) - already in GD360, read every scan
  * X recent search, when X_BEARER_TOKEN is set (anyone's public posts)
  * YouTube search, when YOUTUBE_API_KEY is set (anyone's public videos)
  * any link pasted by hand (a LinkedIn post, an article, a vlog): the
    page's title, text and picture are read

How a post is matched (three tiers, cheapest first)
  1 rules   hashtag (0.97), tracked link or code (0.98 / 0.95), the event
            name (0.93), two or more keywords (0.80 -> review)
  2 vision  the picture shows the event's banner, backdrop, badge or logo
            (only for posts the rules missed, only when brand images are
            uploaded and a vision model is set up)
  3 people  anything under 0.90 waits in the review queue; every match
            says why and can be undone
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from ... import models
from ...config import get_settings
from . import core, net, vision

settings = get_settings()
SOCIAL_KINDS = {"instagram": "instagram", "facebook_pages": "facebook", "linkedin_pages": "linkedin", "youtube": "youtube"}
AUTO_AT = 0.9

_POS = {"great", "amazing", "awesome", "love", "loved", "insightful", "brilliant", "fantastic", "excellent", "thanks",
        "thank", "grateful", "inspiring", "best", "wonderful", "superb", "fun", "learned", "learnt", "excited", "congrats",
        "congratulations", "proud", "honoured", "honored", "delighted", "incredible", "valuable", "well organised",
        "well organized", "stacked", "killer", "nice", "smooth", "fast", "good", "ovation", "highlights", "takeaways", "blast",
        "packed", "useful", "helpful", "recommend", "worth"}
_NEG = {"bad", "worst", "terrible", "awful", "mess", "messy", "disappointed", "disappointing", "late", "delay", "delayed",
        "queue", "crowded", "rude", "boring", "waste", "poor", "broken", "chaos", "chaotic", "overpriced", "parking",
        "cancelled", "canceled", "refund", "hate", "issue", "problem"}
_ATTENDED = ("i attended", "attended the", "i was at", "was at the", "great to be at", "thanks for having", "thank you for having",
             "my takeaways", "takeaways from", "had a blast", "spoke at", "speaking at", "at the booth", "met so many",
             "recap", "highlights from", "day 1 at", "day 2 at", "here at")


def sentiment(text: str | None) -> str:
    t = (text or "").lower()
    words = set(re.findall(r"[a-z']+", t))
    pos = len(words & _POS) + sum(1 for p in _POS if " " in p and p in t)
    neg = len(words & _NEG)
    if re.search(r"\b(no|not|never|without)\s+(\w+\s+)?(queue|delay|issue|problem|chaos)", t):
        neg = max(0, neg - 1)
    if neg > pos:
        return "negative"
    if pos > 0:
        return "positive"
    return "neutral"


def rules_for(db: Session, i: models.Initiative, cfg: models.EventConfig) -> dict:
    tags = [str(h).lower().lstrip("#") for h in (cfg.hashtags or []) if str(h).strip()]
    codes = [str(c).lower() for c in ([cfg.code] if cfg.code else []) + list(cfg.promo_codes or []) if str(c).strip()]
    links = []
    for l in db.query(models.InitiativeLink).filter(models.InitiativeLink.initiative_id == i.id):
        links.append(l.code.lower())
        u = re.sub(r"^https?://(www\.)?", "", (l.url or "").lower()).rstrip("/")
        if len(u) > 8:
            links.append(u)
    links.append(i.public_token.lower())
    title = re.sub(r"\s*\(sample\)\s*$", "", (i.title or "").lower()).strip()
    kws = [str(k).lower().strip() for k in (cfg.keywords or []) if str(k).strip()]
    return {"tags": tags, "codes": codes, "links": links, "title": title, "keywords": [k for k in kws if k != title]}


def match_text(text: str | None, rules: dict) -> tuple[str | None, float, str]:
    t = (text or "").lower()
    if not t:
        return None, 0.0, ""
    for tag in rules["tags"]:
        if re.search(r"#" + re.escape(tag) + r"\b", t):
            return "hashtag", 0.97, f"#{tag} in the text"
    for l in rules["links"]:
        if l and l in t:
            return "link", 0.98, "a tracked link of this event"
    for c in rules["codes"]:
        if len(c) >= 4 and re.search(r"\b" + re.escape(c) + r"\b", t):
            return "code", 0.95, f"code {c.upper()}"
    if rules["title"] and len(rules["title"]) >= 6 and rules["title"] in t:
        return "keyword", 0.93, "the event's name"
    hits = [k for k in rules["keywords"] if k and k in t]
    if len(hits) >= 2:
        return "keyword", 0.8, "words: " + ", ".join(hits[:3])
    return None, 0.0, ""


def _author_kind(cfg: models.EventConfig, author: str | None, text: str | None, own: bool, attendee_names: set[str]) -> str:
    if own:
        return "own"
    a = (author or "").lower().lstrip("@")
    h = cfg.handles or {}
    for kind, key in (("speaker", "speakers"), ("sponsor", "sponsors"), ("press", "press"), ("creator", "creators")):
        if a and any(a == str(x).lower().lstrip("@") or (len(str(x)) > 3 and str(x).lower().lstrip("@") in a) for x in (h.get(key) or [])):
            return kind
    t = (text or "").lower()
    if a in attendee_names or any(p in t for p in _ATTENDED):
        return "attendee"
    return "public"


def _brand_refs(db: Session, i: models.Initiative) -> list[bytes]:
    rows = db.query(models.EventAsset).filter(models.EventAsset.initiative_id == i.id,
                                              models.EventAsset.kind.in_(("banner", "logo", "backdrop", "badge"))).limit(3).all()
    return [r.data for r in rows if r.data]


def _upsert(db: Session, i: models.Initiative, existing: dict, p: dict) -> tuple[models.EventMention, bool]:
    key = (p["platform"], p["external_id"])
    m = existing.get(key)
    new = m is None
    if new:
        m = models.EventMention(initiative_id=i.id, platform=p["platform"], external_id=p["external_id"])
        db.add(m)
        existing[key] = m
    for f in ("author", "url", "text", "media_url", "posted_at", "reach", "engagements"):
        v = p.get(f)
        if v is not None:
            setattr(m, f, v)
    if new or m.state in ("auto", "review"):
        m.author_kind = p.get("author_kind") or m.author_kind
        m.matched_by, m.confidence, m.why = p.get("matched_by"), p.get("confidence"), p.get("why")
        m.state = "auto" if (p.get("confidence") or 0) >= AUTO_AT else "review"
    m.sentiment = sentiment(m.text)
    return m, new


def _num(v):
    try:
        f = float(v)
        return None if f != f else f
    except (TypeError, ValueError):
        return None


def _ts(v) -> datetime | None:
    from .pipeline import _ts as t
    return t(v)


def own_posts(db: Session, i: models.Initiative, lo: datetime, hi: datetime) -> tuple[list[dict], list[dict]]:
    from ..synced_sources import load_table
    out, sources = [], []
    if not i.workspace_id:
        return out, sources
    for ds in db.query(models.DataSource).filter(models.DataSource.workspace_id == i.workspace_id,
                                                 models.DataSource.kind.in_(tuple(SOCIAL_KINDS))).all():
        try:
            df = load_table(db, ds.id, "posts")
        except Exception:  # noqa: BLE001
            continue
        if df is None or not len(df):
            continue
        sources.append({"platform": SOCIAL_KINDS[ds.kind], "name": ds.name, "posts": int(len(df))})
        for r in df.to_dict("records"):
            at = _ts(r.get("posted_at"))
            if at is None or at < lo or at > hi:
                continue
            reach = _num(r.get("reach")) or _num(r.get("impressions"))
            eng = _num(r.get("engagements"))
            if eng is None:
                eng = sum(x for x in (_num(r.get(k)) for k in ("likes", "comments", "shares", "saves")) if x) or None
            out.append({"platform": SOCIAL_KINDS[ds.kind], "external_id": str(r.get("post_id")), "author": r.get("account"),
                        "url": r.get("url"), "text": r.get("text"), "media_url": r.get("media_url") if "media_url" in r else None,
                        "posted_at": at, "reach": reach, "engagements": eng, "own": True})
    return out, sources


def x_posts(rules: dict, lo: datetime) -> list[dict]:
    token = (getattr(settings, "X_BEARER_TOKEN", "") or "").strip()
    if not token:
        return []
    import requests
    terms = [f"#{t}" for t in rules["tags"][:4]] + ([f'"{rules["title"]}"'] if rules["title"] else [])
    if not terms:
        return []
    start = max(lo, datetime.utcnow() - timedelta(days=6, hours=23))  # recent search covers 7 days
    r = requests.get("https://api.x.com/2/tweets/search/recent", headers={"Authorization": f"Bearer {token}"}, timeout=15,
                     params={"query": f"({' OR '.join(terms)}) -is:retweet", "max_results": 100,
                             "start_time": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                             "tweet.fields": "created_at,public_metrics,author_id", "expansions": "author_id,attachments.media_keys",
                             "media.fields": "url,preview_image_url", "user.fields": "username"})
    if r.status_code >= 400:
        raise RuntimeError(f"X search answered {r.status_code}")
    body = r.json() or {}
    users = {u["id"]: u.get("username") for u in (body.get("includes") or {}).get("users", [])}
    media = {m["media_key"]: m.get("url") or m.get("preview_image_url") for m in (body.get("includes") or {}).get("media", [])}
    out = []
    for t in body.get("data") or []:
        pm = t.get("public_metrics") or {}
        keys = ((t.get("attachments") or {}).get("media_keys") or [])
        out.append({"platform": "x", "external_id": t["id"], "author": users.get(t.get("author_id")),
                    "url": f"https://x.com/{users.get(t.get('author_id')) or 'i'}/status/{t['id']}", "text": t.get("text"),
                    "media_url": media.get(keys[0]) if keys else None, "posted_at": _ts(t.get("created_at")),
                    "reach": _num(pm.get("impression_count")),
                    "engagements": sum(_num(pm.get(k)) or 0 for k in ("like_count", "retweet_count", "reply_count", "quote_count")),
                    "own": False})
    return out


def youtube_posts(rules: dict, lo: datetime) -> list[dict]:
    key = (getattr(settings, "YOUTUBE_API_KEY", "") or "").strip()
    if not key or not (rules["tags"] or rules["title"]):
        return []
    import requests
    q = rules["title"] or rules["tags"][0]
    r = requests.get("https://www.googleapis.com/youtube/v3/search", timeout=15,
                     params={"key": key, "part": "snippet", "type": "video", "q": q, "maxResults": 25,
                             "publishedAfter": lo.strftime("%Y-%m-%dT%H:%M:%SZ")})
    if r.status_code >= 400:
        raise RuntimeError(f"YouTube search answered {r.status_code}")
    items = (r.json() or {}).get("items") or []
    ids = [it["id"]["videoId"] for it in items if (it.get("id") or {}).get("videoId")]
    stats = {}
    if ids:
        s = requests.get("https://www.googleapis.com/youtube/v3/videos", timeout=15,
                         params={"key": key, "part": "statistics", "id": ",".join(ids)})
        if s.ok:
            stats = {v["id"]: v.get("statistics") or {} for v in (s.json() or {}).get("items") or []}
    out = []
    for it in items:
        vid = (it.get("id") or {}).get("videoId")
        if not vid:
            continue
        sn = it.get("snippet") or {}
        st = stats.get(vid, {})
        out.append({"platform": "youtube", "external_id": vid, "author": sn.get("channelTitle"),
                    "url": f"https://www.youtube.com/watch?v={vid}", "text": f"{sn.get('title') or ''}\n{sn.get('description') or ''}",
                    "media_url": ((sn.get("thumbnails") or {}).get("high") or {}).get("url"),
                    "posted_at": _ts(sn.get("publishedAt")), "reach": _num(st.get("viewCount")),
                    "engagements": (_num(st.get("likeCount")) or 0) + (_num(st.get("commentCount")) or 0), "own": False})
    return out


def scan(db: Session, i: models.Initiative, cfg: models.EventConfig, vision_budget: int = 20) -> dict:
    """Finds and refreshes posts about the event. Returns what happened."""
    if (cfg.data or {}).get("sample"):
        return {"new": 0, "updated": 0, "review": 0, "sources": [{"platform": "sample", "name": "Sample data"}], "errors": [],
                "vision": "sample"}
    w = core.Windows(i, cfg)
    lo = w.open - timedelta(days=3)
    hi = (w.close or datetime.utcnow()) + timedelta(days=1)
    rules = rules_for(db, i, cfg)
    errors: list[str] = []
    posts, sources = own_posts(db, i, lo, hi)
    for name, fn in (("X", x_posts), ("YouTube", youtube_posts)):
        try:
            got = fn(rules, lo)
            if got:
                sources.append({"platform": name.lower(), "name": f"{name} search", "posts": len(got)})
            posts += got
        except Exception as e:  # noqa: BLE001 - one source failing never stops the scan
            errors.append(f"{name}: {e}")
    existing = {(m.platform, m.external_id): m for m in db.query(models.EventMention).filter(models.EventMention.initiative_id == i.id)}
    names = {(t[0] or "").lower() for t in db.query(models.EventTicket.name).filter(models.EventTicket.initiative_id == i.id) if t[0]}
    refs = _brand_refs(db, i) if vision.available() else []
    new = updated = review = used = 0
    for p in posts:
        how, conf, why = match_text(p.get("text"), rules)
        if not how and refs and p.get("media_url") and used < vision_budget and (p["platform"], p["external_id"]) not in existing:
            used += 1
            try:
                img, ctype, _ = net.safe_get(p["media_url"], max_bytes=3_000_000, accept="image/*")
                if ctype.startswith("image/") or img[:3] == b"\xff\xd8\xff" or img[:4] == b"\x89PNG":
                    v = vision.match_brand(img, refs, i.title, cfg.hashtags or [])
                    if v["match"] and v["confidence"] >= 0.5:
                        how, conf, why = "banner", round(v["confidence"], 2), f"{v['seen']} seen in the picture: {v['why']}"
            except Exception as e:  # noqa: BLE001
                errors.append(f"vision: {str(e)[:120]}")
        if not how:
            continue
        p.update({"matched_by": how, "confidence": conf, "why": {"text": why},
                  "author_kind": _author_kind(cfg, p.get("author"), p.get("text"), bool(p.get("own")), names)})
        m, is_new = _upsert(db, i, existing, p)
        new += int(is_new)
        updated += int(not is_new)
        review += int(m.state == "review")
    data = dict(cfg.data or {})
    data["last_scan_at"] = datetime.utcnow().isoformat()
    data["last_scan"] = {"new": new, "updated": updated, "review": review, "sources": sources, "errors": errors[:6],
                         "vision": "on" if refs else ("no brand images yet" if vision.available() else "not set up"),
                         "x": bool((getattr(settings, "X_BEARER_TOKEN", "") or "").strip()),
                         "youtube": bool((getattr(settings, "YOUTUBE_API_KEY", "") or "").strip())}
    cfg.data = data
    db.flush()
    return data["last_scan"]


def add_link(db: Session, i: models.Initiative, cfg: models.EventConfig, url: str, author_kind: str | None = None,
             author: str | None = None) -> models.EventMention:
    """A post or article pasted by hand: read its preview, keep it,
    confirmed (a person chose it)."""
    url = url.strip()
    if not re.match(r"^https?://", url):
        url = "https://" + url
    host = (re.sub(r"^https?://(www\.)?", "", url).split("/")[0]).lower()
    platform = ("linkedin" if "linkedin" in host else "instagram" if "instagram" in host else "facebook" if ("facebook" in host or host.startswith("fb."))
                else "x" if host in ("x.com", "twitter.com", "mobile.twitter.com") else "youtube" if ("youtube" in host or "youtu.be" in host)
                else "news")
    try:
        prev = net.page_preview(url)
    except Exception:  # noqa: BLE001 - keep the link even when the page can't be read
        prev = {"url": url, "title": None, "description": None, "image": None, "site": host}
    text = "\n".join(x for x in (prev.get("title"), prev.get("description")) if x) or None
    ext = hashlib.sha1(url.encode()).hexdigest()[:20]
    existing = {(m.platform, m.external_id): m for m in db.query(models.EventMention).filter(
        models.EventMention.initiative_id == i.id, models.EventMention.external_id == ext)}
    names = {(t[0] or "").lower() for t in db.query(models.EventTicket.name).filter(models.EventTicket.initiative_id == i.id) if t[0]}
    kind = author_kind if author_kind in ("own", "speaker", "sponsor", "attendee", "press", "creator", "public") else \
        _author_kind(cfg, author, text, False, names)
    m, _ = _upsert(db, i, existing, {"platform": platform, "external_id": ext, "author": author or prev.get("site"),
                                     "url": prev.get("url") or url, "text": text, "media_url": prev.get("image"),
                                     "posted_at": _ts(prev.get("published")) or datetime.utcnow(), "matched_by": "manual",
                                     "confidence": 1.0, "why": {"text": "added by hand"}, "author_kind": kind})
    m.state = "confirmed"
    db.flush()
    return m

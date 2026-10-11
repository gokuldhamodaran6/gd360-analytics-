"""
Euliv - the GD360 voice assistant (2026-10-11).

"Hi Euliv, how is my marketing doing?" -> which data does that need, does
this person have it, and if not, can they connect it now?

This module is the conversation's brain and is deliberately rule-based (fast,
predictable, no model call on the hot path):

  strip_wake(text)        drop "hi/hey Euliv" from the front of what was said;
  intent(text)            end / thanks / greeting / help / yes / no / question;
  resolve(...)            the sources a question needs:
                            1. sources named in the words ("from Google Ads",
                               "in Ecommerce_Data");
                            2. what this person chose for the topic before
                               (AssistantMemory "topic:marketing");
                            3. the topic's apps (Google Ads, Meta Ads, GA4 ...)
                               plus warehouses / files whose tables talk about
                               it (campaign, spend, utm ...);
                          -> "ok" (one clear answer), "choose" (more than one
                          fits - Euliv asks), "connect" (nothing connected -
                          Euliv offers to connect it) or "none";
  choose(text, candidates) which of the offered sources the reply picked;
  speakable(text)         numbers written for the ear ("$48.2k" -> "48.2
                          thousand dollars", "−" -> "minus").

The answering itself is the same engine as typed questions
(routers/projects.py): a question becomes a Quick-answer project; a
follow-up in the same conversation is asked in that project with route=true,
so "why?" is explained from the numbers already computed.
"""
from __future__ import annotations

import re
from datetime import datetime

from sqlalchemy.orm import Session

from .. import models
from .project_engine.catalog import KIND_LABELS, accessible_sources

MAX_CHOICES = 6

# ---- the name ----------------------------------------------------------------

# How speech recognisers hear "Euliv" (it is not a dictionary word): exact
# spellings count on their own; the look-alikes only right after a greeting.
EXACT_NAMES = r"e+u+\s?li+ve?|eu\s?leave|yu+li+ve?|ju+li+ve?|ew+li+ve?"
LOOSE_NAMES = r"you\s?li+ve?|you\s?leave|u\s?li+ve?|o\s?li+ve?|evil|olive|yuli|julie|you'?ll\s?live|ulysse?s?|you\s?lift|eulogy"
GREETINGS = r"hi|hey|hello|hiya|ok|okay|yo|ola|hai|hay"
_WAKE_STRIP = re.compile(
    rf"^\s*(?:(?:{GREETINGS})[\s,!.]*)?(?:{EXACT_NAMES}|{LOOSE_NAMES})\b[\s,.!?:;-]*", re.I)
_GREET_STRIP = re.compile(rf"^\s*(?:{GREETINGS}|good (?:morning|afternoon|evening))\b[\s,!.]*", re.I)


def strip_wake(text: str) -> str:
    t = (text or "").strip()
    m = _WAKE_STRIP.match(t)
    if m and (re.search(EXACT_NAMES, m.group(0), re.I) or re.match(rf"\s*(?:{GREETINGS})\b", m.group(0), re.I)):
        t = t[m.end():]
    return t.strip()


# ---- intents -----------------------------------------------------------------

_END = re.compile(r"^(?:bye|bye bye|goodbye|good bye|see (?:you|ya)|stop|stop listening|that'?s (?:all|it)|that is (?:all|it)|"
                  r"nothing else|no thanks|no thank you|close|exit|cancel|i'?m done|im done|we'?re done|done|goodnight|good night|"
                  r"thanks,? that'?s (?:all|it)|thank you,? that'?s (?:all|it)|end|quit)\b[\s.!]*$", re.I)
_THANKS = re.compile(r"^(?:thanks|thank you|thank u|cheers|great,? thanks|perfect|awesome|nice|cool|got it|okay thanks|ok thanks)\b[\s.!]*$", re.I)
_HELP = re.compile(r"\b(?:what can you do|what do you do|how do you work|help me|what can i ask|who are you|what are you)\b", re.I)
_YES = re.compile(r"^(?:yes|yeah|yep|yup|sure|ok|okay|please|go ahead|do it|connect it|connect|yes please|let'?s do it|absolutely|"
                  r"of course|why not|sounds good|alright|all right)\b", re.I)
_NO = re.compile(r"^(?:no|nope|nah|not now|later|skip|don'?t|never mind|nevermind|maybe later)\b", re.I)
_USE_CONNECTED = re.compile(r"\b(?:use (?:what'?s|what is|what you have|whatever'?s|the) (?:connected|there|available|have)|"
                            r"use what you (?:have|can see)|whatever you have)\b", re.I)


_POLITE = re.compile(r"^(?:(?:ok|okay|alright|great|perfect|cool|thanks|thank you|cheers)[\s,.!]+)+|"
                     r"(?:[\s,.!]+(?:thanks|thank you|thank u|cheers|euliv|for now|then))+[\s.!]*$", re.I)
_CONNECT = re.compile(r"^(?:please\s+|can you\s+|could you\s+|i want to\s+|i'?d like to\s+|let'?s\s+)?"
                      r"(?:connect|add|link|hook up|set up|integrate)\s+(?:my\s+|our\s+|the\s+|a\s+)?(.+?)"
                      r"(?:\s+(?:account|data|source|please|for me|now))*[\s.!?]*$", re.I)


def connect_target(text: str) -> str | None:
    """What follows "connect ..." (normalised), or None when it isn't a connect request."""
    m = _CONNECT.match((text or "").strip())
    return _norm(m.group(1)) if m else None


def connect_request(text: str) -> str | None:
    """"connect Google Ads" -> "google_ads" (a known synced app), else None."""
    m = _CONNECT.match((text or "").strip())
    if not m:
        return None
    said = _norm(m.group(1))
    for alias in sorted(ALIASES, key=len, reverse=True):
        if f" {alias} " in said:
            return ALIASES[alias]
    return None


def intent(text: str) -> str:
    t = re.sub(rf"[\s,]+(?:{EXACT_NAMES})[\s.!?]*$", "", (text or "").strip(), flags=re.I).strip()  # "thanks, Euliv"
    if not t:
        return "greeting"
    core = _POLITE.sub("", t).strip()
    if core and _END.match(core) or (not core and re.search(r"\b(?:bye|that'?s all|that'?s it)\b", t, re.I)):
        return "end"
    if _END.match(t):
        return "end"
    if _THANKS.match(t):
        return "thanks"
    if _HELP.search(t):
        return "help"
    if _GREET_STRIP.match(t) and not _GREET_STRIP.sub("", t).strip():
        return "greeting"
    return "question"


def is_yes(text: str) -> bool:
    return bool(_YES.match((text or "").strip()))


def is_no(text: str) -> bool:
    return bool(_NO.match((text or "").strip()))


def wants_connected(text: str) -> bool:
    return bool(_USE_CONNECTED.search(text or ""))


# ---- topics and sources ---------------------------------------------------------

TOPICS = [
    {"key": "marketing", "label": "marketing", "connect": "google_ads",
     "words": {"marketing", "campaign", "campaigns", "ads", "ad", "advert", "adverts", "advertising", "spend", "roas", "cpc",
               "cpm", "ctr", "impression", "impressions", "click", "clicks", "conversion", "conversions", "cac", "paid",
               "promotion", "promotions", "leads", "lead", "acquisition", "utm", "channel", "channels", "creative"},
     "kinds": ["google_ads", "meta_ads", "ga4", "linkedin_pages", "instagram", "facebook_pages", "youtube",
               "search_console", "klaviyo", "hubspot"]},
    {"key": "website", "label": "website traffic", "connect": "ga4",
     "words": {"traffic", "website", "site", "sessions", "session", "visitors", "visitor", "pageviews", "pageview", "bounce",
               "seo", "organic", "landing", "page", "pages"},
     "kinds": ["ga4", "search_console"]},
    {"key": "social", "label": "social media", "connect": "instagram",
     "words": {"social", "followers", "follower", "engagement", "posts", "post", "reach", "likes", "comments", "reels",
               "subscribers", "views"},
     "kinds": ["instagram", "facebook_pages", "linkedin_pages", "youtube"]},
    {"key": "email", "label": "email", "connect": "klaviyo",
     "words": {"email", "emails", "newsletter", "newsletters", "flows", "unsubscribes", "opens"},
     "kinds": ["klaviyo", "hubspot"]},
    {"key": "payments", "label": "payments", "connect": "stripe",
     "words": {"payments", "payment", "subscriptions", "subscription", "mrr", "arr", "invoices", "invoice", "payouts", "charges"},
     "kinds": ["stripe"]},
    {"key": "customers", "label": "customers", "connect": "hubspot",
     "words": {"customers", "customer", "churn", "retention", "ltv", "crm", "deals", "deal", "pipeline", "contacts"},
     "kinds": ["hubspot", "stripe", "shopify"]},
    {"key": "sales", "label": "sales", "connect": "shopify",
     "words": {"sales", "revenue", "orders", "order", "gmv", "aov", "basket", "products", "product", "sku", "refunds",
               "returns", "profit", "margin", "income", "turnover", "bookings", "booking"},
     "kinds": ["shopify", "woocommerce", "stripe"]},
]

# spoken names -> source kinds
ALIASES = {
    "google ads": "google_ads", "adwords": "google_ads", "google adwords": "google_ads",
    "meta ads": "meta_ads", "meta": "meta_ads", "facebook ads": "meta_ads",
    "google analytics": "ga4", "ga4": "ga4", "ga 4": "ga4",
    "instagram": "instagram", "insta": "instagram", "facebook": "facebook_pages", "facebook page": "facebook_pages",
    "linkedin": "linkedin_pages", "youtube": "youtube", "search console": "search_console",
    "shopify": "shopify", "woocommerce": "woocommerce", "woo commerce": "woocommerce", "stripe": "stripe",
    "hubspot": "hubspot", "hub spot": "hubspot", "klaviyo": "klaviyo",
    "bigquery": "bigquery", "big query": "bigquery", "snowflake": "snowflake", "postgres": "postgres",
    "postgresql": "postgres", "mysql": "mysql", "my sql": "mysql", "supabase": "supabase", "excel": "excel",
    "google sheets": "google_sheets",
}
CORE_KINDS = {"postgres", "mysql", "bigquery", "snowflake", "sqlserver", "supabase", "csv", "excel", "google_sheets",
              "microsoft_excel", "mongodb", "api", "streaming"}

_WORD = re.compile(r"[a-z0-9]+")


def _words(text: str) -> set[str]:
    out = set()
    for w in _WORD.findall((text or "").lower().replace("_", " ")):
        out.add(w)
        if w.endswith("s") and len(w) > 3:
            out.add(w[:-1])
    return out


def topic_of(text: str) -> dict | None:
    w = _words(text)
    best, score = None, 0
    for t in TOPICS:
        s = len(w & t["words"])
        if s > score:
            best, score = t, s
    return best


def _schema_words(ds: models.DataSource) -> set[str]:
    from .project_engine.catalog import _schema_tables
    words = _words(ds.name or "")
    try:
        pairs = _schema_tables(ds)
    except Exception:  # noqa: BLE001 - an odd schema never breaks the conversation
        pairs = []
    for table, cols in pairs[:60]:
        words |= _words(str(table or ""))
        for c in (cols or [])[:120]:
            name = c.get("name") if isinstance(c, dict) else c
            words |= _words(str(name or ""))
    return words


def _norm(text: str) -> str:
    return " " + re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", (text or "").lower().replace("_", " "))).strip() + " "


def _says(said: str, name: str) -> bool:
    """Is `name` in what was said - also when speech split or joined the
    words ("e commerce data" / "ecommerce data")?"""
    n = _norm(name).strip()
    if len(n) < 3:
        return False
    if f" {n} " in said:
        return True
    squashed = n.replace(" ", "")
    return len(squashed) >= 5 and squashed in said.replace(" ", "")


def label_of(ds: models.DataSource) -> str:
    return ds.name or KIND_LABELS.get(ds.kind, ds.kind)


def source_out(ds: models.DataSource) -> dict:
    from .project_engine.catalog import freshness_text
    return {"id": ds.id, "name": ds.name, "kind": ds.kind, "label": KIND_LABELS.get(ds.kind, ds.kind),
            "freshness": freshness_text(ds)}


def _named(text: str, sources: list[models.DataSource]) -> tuple[list[models.DataSource], list[str]]:
    """(sources the words name, kinds named but not connected)."""
    said = _norm(text)
    hits: list[models.DataSource] = [ds for ds in sources if len(_norm(ds.name).strip()) >= 4 and _says(said, ds.name)]
    kinds: list[str] = []
    low = said
    for alias in sorted(ALIASES, key=len, reverse=True):
        if f" {alias} " in low:
            k = ALIASES[alias]
            if k not in kinds:
                kinds.append(k)
            low = low.replace(f" {alias} ", " ")
    missing = []
    for k in kinds:
        have = [ds for ds in sources if ds.kind == k]
        if have:
            hits += [ds for ds in have if ds not in hits]
        elif not any(KIND_LABELS.get(h.kind) == KIND_LABELS.get(k) for h in hits):
            missing.append(k)
    return hits, missing


def remembered(db: Session, user: models.User, topic_key: str) -> list[str]:
    row = db.query(models.AssistantMemory).filter_by(user_id=user.id, key=f"topic:{topic_key}").first()
    return list((row.value or {}).get("source_ids") or []) if row else []


def remember(db: Session, user: models.User, topic_key: str, source_ids: list[str]) -> None:
    row = db.query(models.AssistantMemory).filter_by(user_id=user.id, key=f"topic:{topic_key}").first()
    if not row:
        row = models.AssistantMemory(user_id=user.id, key=f"topic:{topic_key}")
        db.add(row)
    row.value = {"source_ids": source_ids[:MAX_CHOICES]}
    row.updated_at = datetime.utcnow()


def forget(db: Session, user: models.User, topic_key: str | None = None) -> int:
    q = db.query(models.AssistantMemory).filter(models.AssistantMemory.user_id == user.id)
    if topic_key:
        q = q.filter(models.AssistantMemory.key == f"topic:{topic_key}")
    return q.delete(synchronize_session=False)


def resolve(db: Session, user: models.User, text: str, workspace_id: str | None = None) -> dict:
    """The sources a question needs - see the module docstring."""
    from . import synced_sources
    sources = accessible_sources(db, user, workspace_id)
    topic = topic_of(text)
    base = {"topic": topic["key"] if topic else None, "topic_label": topic["label"] if topic else None}
    if not sources:
        kind = (topic or {}).get("connect")
        return {**base, "status": "connect", "connect": _connect_info(kind), "candidates": [], "any_sources": False}
    named, missing = _named(text, sources)
    if named:
        return {**base, "status": "ok", "sources": [source_out(s) for s in named[:MAX_CHOICES]], "why": "named"}
    if missing and missing[0] in synced_sources.APPS:
        return {**base, "status": "connect", "connect": _connect_info(missing[0]), "candidates": [], "any_sources": True}
    if missing:
        return {**base, "status": "none", "missing": KIND_LABELS.get(missing[0], missing[0]), "any_sources": True}
    if not topic:
        return {**base, "status": "ok", "sources": [], "why": "all"}  # the planner picks across everything
    by_id = {s.id: s for s in sources}
    mem = [by_id[i] for i in remembered(db, user, topic["key"]) if i in by_id]
    if mem:
        return {**base, "status": "ok", "sources": [source_out(s) for s in mem], "why": "remembered"}
    apps = [s for s in sources if s.kind in topic["kinds"]]
    apps.sort(key=lambda s: topic["kinds"].index(s.kind))
    others = []
    for s in sources:
        if s in apps or s.kind not in CORE_KINDS:
            continue
        hit = len(_schema_words(s) & topic["words"])
        if hit >= 2:
            others.append((hit, s))
    others.sort(key=lambda x: -x[0])
    cands = (apps + [s for _, s in others])[:MAX_CHOICES]
    if len(cands) == 1:
        why = "only" if apps else "schema"  # no app for this topic - a warehouse/file whose tables fit
        return {**base, "status": "ok", "sources": [source_out(cands[0])], "why": why,
                "connect": _connect_info(topic.get("connect")) if why == "schema" else None}
    if len(cands) > 1:
        return {**base, "status": "choose", "candidates": [source_out(s) for s in cands]}
    kind = next((k for k in topic["kinds"] if k in synced_sources.APPS), topic.get("connect"))
    return {**base, "status": "connect", "connect": _connect_info(kind), "candidates": [], "any_sources": True}


def _connect_info(kind: str | None) -> dict | None:
    if not kind:
        return {"kind": None, "label": "a data source", "url": "/data?tab=catalog"}
    return {"kind": kind, "label": KIND_LABELS.get(kind, kind), "url": f"/data?tab=catalog&connect={kind}"}


_ORD = {"first": 0, "1st": 0, "one": 0, "second": 1, "2nd": 1, "two": 1, "third": 2, "3rd": 2, "three": 2,
        "fourth": 3, "4th": 3, "four": 3, "fifth": 4, "last": -1}


def choose(text: str, candidates: list[dict]) -> list[dict] | None:
    """Which of the offered sources the reply picked; None when it picked none."""
    t = _norm(text)
    if re.search(r"\b(all|both|every|everything|each)\b", t) and not re.search(r"\b(not all|except|but not|apart from|other than)\b", t):
        return list(candidates)
    m = re.search(r"\b(?:except|but not|apart from|other than|not)\s+(.+)$", t)
    if m:
        drop = choose(m.group(1), candidates) or []
        if drop and len(drop) < len(candidates):
            return [c for c in candidates if c not in drop]

    # the first word of a name ("Google", "Meta") counts when no other offered source shares it
    firsts: dict[str, int] = {}
    for c in candidates:
        for w in {_norm(c.get("name")).split()[:1][0] if _norm(c.get("name")).strip() else "",
                  _norm(c.get("label")).split()[:1][0] if _norm(c.get("label")).strip() else ""} - {""}:
            firsts[w] = firsts.get(w, 0) + 1

    def names(c: dict) -> set[str]:
        out = {c.get("name") or "", c.get("label") or ""}
        out |= {a for a, k in ALIASES.items() if k == c.get("kind")}
        for n in (c.get("name"), c.get("label")):
            w = _norm(n).split()[:1]
            if w and len(w[0]) >= 4 and firsts.get(w[0]) == 1 and w[0] not in {"data", "file", "the", "sales", "main"}:
                out.add(w[0])
        return {n for n in out if n}

    picked = [c for c in candidates if any(_says(t, n) for n in names(c))]
    # a kind label shared by several candidates ("Google Ads") picks them all,
    # but a full name picked one - keep only full-name hits when there are any
    full = [c for c in candidates if c.get("name") and _says(t, c["name"])]
    if full:
        picked = full + [c for c in picked if c not in full and not any(
            KIND_LABELS.get(c.get("kind")) == KIND_LABELS.get(f.get("kind")) for f in full)]
    if not picked:
        for word, idx in _ORD.items():
            if re.search(rf"\b{word}\b", t):
                try:
                    picked.append(candidates[idx])
                except IndexError:
                    pass
                break
    seen, out = set(), []
    for c in picked:
        if c["id"] not in seen:
            seen.add(c["id"])
            out.append(c)
    return out or None


def names_text(items: list[dict], limit: int = 3) -> str:
    names = [i.get("name") or i.get("label") for i in items][:limit]
    more = len(items) - len(names)
    if more > 0:
        names.append(f"{more} more")
    if len(names) <= 1:
        return names[0] if names else ""
    return ", ".join(names[:-1]) + " and " + names[-1]


# ---- for the ear --------------------------------------------------------------------

_SCALE = {"k": "thousand", "m": "million", "mn": "million", "b": "billion", "bn": "billion"}
_CUR = {"$": "dollars", "€": "euros", "£": "pounds", "₹": "rupees", "¥": "yen"}


def speakable(text: str) -> str:
    t = str(text or "")
    t = re.sub(r"[*`#>]+", "", t).replace("_", " ")
    t = t.replace("−", "-").replace("–", " to ").replace("—", ", ").replace("·", ",")

    def money(m):
        sign, sym, num, scale = m.group(1) or "", m.group(2), m.group(3), (m.group(4) or "").lower()
        words = f"{num} {_SCALE[scale]} {_CUR[sym]}" if scale else f"{sym}{num}"
        return ("minus " if sign else "") + words

    t = re.sub(r"(-)?([$€£₹¥])(\d[\d,]*(?:\.\d+)?)\s?(k|K|m|M|mn|b|B|bn)?\b", money, t)
    t = re.sub(r"(?<![\w.])-(\d)", r"minus \1", t)
    t = re.sub(r"\b(\d[\d,]*(?:\.\d+)?)\s?(k|K|M|bn|B)\b", lambda m: f"{m.group(1)} {_SCALE[m.group(2).lower()]}", t)
    t = re.sub(r"\bpts?\b", "points", t)
    t = re.sub(r"\bvs\.?\b", "versus", t)
    t = re.sub(r"\be\.g\.", "for example", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def first_sentences(text: str, n: int = 2, max_chars: int = 320) -> str:
    parts = re.split(r"(?<=[.!?])\s+", (text or "").strip())
    out = ""
    for p in parts[:n]:
        if len(out) + len(p) > max_chars and out:
            break
        out = (out + " " + p).strip()
    return out

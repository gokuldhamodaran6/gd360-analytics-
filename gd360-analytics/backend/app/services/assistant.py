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


_GREETING_WORDS = {"hi", "hey", "hello", "helo", "hallo", "hullo", "hiya", "heya", "hai", "hay", "hy", "hye", "ok", "okay", "yo",
                   "ola", "hola", "oye", "hie", "aye", "ey", "hei", "namaste", "vanakkam"}
# round 27 (same rules as thread/voice.ts): the name by its sound, generously, but only where a person says it
_WEAK_GREETINGS = {"i", "a", "ay", "high", "eh", "oh", "ah", "hm", "huh"}
_NAME_SOUND = re.compile(r"^h?(?:[yj]?[aeiouw]{1,3}|[yj])l(?:[iey]|ea|ie|ei)(?:v|f|ph|b|w)e?$")
_CORE_SHAPES = ["euliv", "eulive", "yuliv", "yulive", "uliv", "ulive", "euleav", "euleave"]
_BARE_NAMES = {"liv", "leev", "lif", "leef"}
_STRICT_SHAPES = ["euliv", "eulive", "yuliv", "yulive", "uliv", "euleev", "euleve"]
_OBJECT_WORDS = {"it", "that", "this", "them", "those", "these", "me", "him", "her", "us", "alone", "here", "there", "with", "in",
                 "on", "at", "for", "to", "out", "off", "up", "forever", "is", "was", "and", "of"}
_QUESTION_START = {"what", "whats", "how", "show", "why", "which", "who", "when", "where", "can", "could", "give", "tell", "are", "did",
                   "do", "does", "compare", "list", "open", "pull", "find", "please"}


def _squeeze(w: str) -> str:
    return re.sub(r"(.)\1+", r"\1", w)


def _clean(w: str) -> str:
    return _squeeze(re.sub(r"[^a-z]", "", (w or "").lower()))


def _lev(a: str, b: str) -> int:
    if abs(len(a) - len(b)) > 3:
        return 9
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _outline(w: str) -> tuple[str, str]:
    core = re.sub(r"^[hyjw]+", "", w)
    skel = _squeeze(re.sub(r"[fbw]", "v", re.sub(r"[aeiouy]", "", core.replace("ph", "v"))))
    return core, skel


def _near_name(word: str) -> bool:
    c = _clean(word)
    return bool(_NAME_SOUND.match(c)) or c in _BARE_NAMES or (len(c) >= 5 and any(_lev(c, x) <= 1 for x in _CORE_SHAPES))


def sounds_like_euliv(word: str, strict: bool = False) -> bool:
    """The same sound match as the browser (thread/voice.ts soundsLikeEuliv)."""
    w = _clean(word)
    if strict:
        return 4 <= len(w) <= 10 and any(_lev(w, x) <= 1 for x in _STRICT_SHAPES)
    if len(w) < 3 or len(w) > 11:
        return False
    if _near_name(w):
        return True
    core, skel = _outline(w)
    if skel == "lv":
        return len(core) <= 8
    if skel == "l":
        return bool(re.match(r"^[aeiou]", core)) and len(core) <= 6
    return False


def _is_greeting(word: str) -> bool:
    raw = re.sub(r"[^a-z]", "", (word or "").lower())
    return _clean(word) in _GREETING_WORDS or bool(re.fullmatch(r"h+e+y+|h+i+|he+l+o+|h+a+i+", raw))


def wake_split(text: str) -> tuple[bool, str]:
    """(woke, what came after the name) - "hiii euliv, sales today" -> (True, "sales today")."""
    raw = (text or "").strip()
    parts = raw.split()
    if not parts:
        return False, ""

    def rest_from(k: int) -> str:
        return re.sub(r"^[\s,.!?:;-]+", "", " ".join(parts[k:])).strip()

    def fits(i: int, n: int, strict: bool) -> bool:
        if i + n > len(parts):
            return False
        if n > 1 and _clean(parts[i]) in ("i", "a", "the", "to", "my", "our"):
            return False
        joined = "".join(parts[i:i + n])
        if len(_clean(joined)) > 11 or not sounds_like_euliv(joined, strict):
            return False
        nxt = _clean(parts[i + n]) if i + n < len(parts) else ""
        if not strict and not _near_name(joined):
            if nxt in _OBJECT_WORDS:
                return False
            if re.match(r"^l", re.sub(r"^[hyjw]+", "", _clean(joined))) and nxt and nxt not in _QUESTION_START:
                return False
        return True

    def name_at(i: int, strict: bool) -> int:
        # a close spelling of the name wins at its own length ("Euliv, I want ..." is not "Euliv I");
        # otherwise the longest reading ("eli v" is one name)
        top = 1 if strict else 3
        for n in range(1, top + 1):
            if fits(i, n, strict) and _near_name("".join(parts[i:i + n])):
                return n
        for n in range(top, 0, -1):
            if fits(i, n, strict):
                return n
        return 0

    for i, p in enumerate(parts[:4]):
        if _is_greeting(p):
            for j in range(i + 1, min(i + 2, len(parts) - 1) + 1):
                if _clean(parts[j]) in ("i", "a", "the", "my"):
                    break
                n = name_at(j, False)
                if n:
                    return True, rest_from(j + n)
                if not _is_greeting(parts[j]) and _clean(parts[j]) != "there":
                    break
    if len(parts) >= 2 and _clean(parts[0]) in _WEAK_GREETINGS:
        n = name_at(1, False)
        if n and 1 + n == len(parts):
            return True, ""
    n0 = name_at(0, True)
    if n0:
        return True, rest_from(n0)
    if len(parts) <= 2:
        j = _clean("".join(parts))
        if re.match(r"^[aeiouyj]", j) and len(j) >= 4 and sounds_like_euliv(j) and _outline(j)[1] == "lv":
            return True, ""
    return False, ""


# round 27: Euliv's own phrases - when these come back as "what the person said", the mic heard Euliv
_OWN_PHRASES = [
    "didn t catch that", "say it again", "which data should i use", "here s what you have", "how can i help", "shall i go ahead",
    "to hear them", "talk soon", "just to confirm", "in your sources", "pick one a few", "i couldn t find", "one moment",
    "working it out", "the data from your last answer", "anything else i can look at", "i m not sure what you d like",
]


_OWN_PHRASES += ["would you like to change the question", "so i ll look at", "i ll stay with", "anything to add"]
_STOP = {"the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "it", "i", "you", "your", "my", "me", "that",
         "this", "can", "could", "would", "should", "do", "did", "be", "with", "from", "at", "by", "so", "s", "t", "ll", "ve", "what",
         "which", "how", "shall", "will", "just", "here", "have", "has", "if", "as", "all", "there", "m", "d", "re"}
_ANSWER = {"yes", "yeah", "yep", "yup", "sure", "okay", "ok", "correct", "perfect", "stop", "wait", "no", "nope", "cancel", "first",
           "second", "third", "fourth", "number", "both", "none", "instead", "great", "exactly", "right", "actually"}
_ASK_START = re.compile(r"^(?:no|yes|yeah|ok|okay|actually|wait|and|also|now|so)?\s*(?:what|whats|how|why|which|who|when|where|show|give|"
                        r"tell|compare|list|can|could|break|split|pull|find)\b")


def _wds(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower())).strip()


def _vocab(s: str) -> set[str]:
    ws = _wds(s).split()
    return set(ws) | {ws[i] + ws[i + 1] for i in range(len(ws) - 1)}


def heard_euliv(heard: str, said: str | None) -> bool:
    """Round 28 (same rules as thread/voice.ts heardEuliv, after Euliv finished speaking): is `heard` just
    Euliv's own last words (`said`) coming back through the mic? The person's quoted question is kept apart
    from Euliv's own framing words, so a person refining their question is never mistaken for echo."""
    h = _wds(heard)
    if not h or not said:
        return False
    unq = re.sub(r"[“\"][^“”\"]*[”\"]", " ", said)
    q = " ".join(re.findall(r"[“\"][^“”\"]*[”\"]", said))
    full, frame = f" {_wds(said)} ", f" {_wds(unq)} "
    hw = h.split()
    if len(hw) >= 3 and f" {h} " in full:
        return True
    mine_all, mine_frame, quote = _vocab(said), _vocab(unq), _vocab(q)
    # 4 of Euliv's own words in a row - not the person's own question words it repeated back
    for i in range(len(hw) - 3):
        gram = hw[i:i + 4]
        if f" {' '.join(gram)} " in frame and any(w not in quote and w not in _STOP for w in gram):
            return True
    cw = [w for w in hw if w not in _STOP]
    if not cw or _ASK_START.match(h) or any(w in _ANSWER and w not in mine_frame for w in cw):
        return False
    novel = sum(1 for w in cw if w not in mine_all and w not in quote)
    framing = sum(1 for w in cw if w in mine_frame) / len(cw)
    return len(cw) >= 4 and novel <= (1 if len(cw) >= 8 else 0) and framing >= 0.5


def is_own_words(text: str) -> bool:
    """Euliv hearing itself (speakers, no headset): its own stock phrases in what came back."""
    h = " " + re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", (text or "").lower())).strip() + " "
    return any(f" {p} " in h for p in _OWN_PHRASES)


def strip_wake(text: str) -> str:
    woke, rest = wake_split(text)
    if woke:
        return rest
    return (text or "").strip()


# ---- intents -----------------------------------------------------------------

_END = re.compile(r"^(?:bye|bye bye|goodbye|good bye|see (?:you|ya)|stop|stop listening|that'?s (?:all|it)|that is (?:all|it)|"
                  r"nothing else|no thanks|no thank you|close|exit|cancel|i'?m done|im done|we'?re done|done|goodnight|good night|"
                  r"thanks,? that'?s (?:all|it)|thank you,? that'?s (?:all|it)|end|quit)\b[\s.!]*$", re.I)
_THANKS = re.compile(r"^(?:thanks|thank you|thank u|cheers|great,? thanks|perfect|awesome|nice|cool|got it|okay thanks|ok thanks)\b[\s.!]*$", re.I)
# "no, you're good" / "I'm good" / "nope, that's all" / "all set" - the person is done (2026-10-11, round 25:
# "no you are good" used to be taken as a follow-up and the last answer was read out again)
_CLOSING = re.compile(
    r"^(?:no|nope|nah|nothing|not really|i'?m|im|i am|we'?re|we are|all|that'?s|thats|that is|it'?s|its|ok|okay|fine)\b"
    r"(?:[\s,.!]+(?:no|nope|thanks|thank you|thank u|you'?re|you are|youre|i'?m|im|i am|we'?re|we are|it'?s|its|that'?s|thats|"
    r"all|for now|really|more|else|need|needed|nothing|just|so|totally|pretty|very|set|fine|good|great|ok|okay|done|it|"
    r"right|perfect|sorted|cool|then|bye|enough|that|is|for|today|now|anything|i|we|am|are|be|will|ll|all good|all set))*[\s.!]*$",
    re.I)
_QUESTIONISH = re.compile(r"\?|\b(why|how|what|which|who|whom|when|where|show|compare|break|split|explain|tell|give|list|"
                          r"top|bottom|best|worst|trend|change|changed|drop|dropped|rise|rose|grow|grew|fell|increase|decrease|"
                          r"by|per|vs|versus|between|since|last|this|next|more|less|total|average|sum|count|forecast|predict)\b", re.I)


_FIRM_END = re.compile(r"^(?:bye|bye bye|goodbye|good bye|see (?:you|ya)|stop|stop listening|close|exit|cancel|quit|"
                       r"goodnight|good night|forget it|never ?mind,? (?:bye|stop))\b[\s.!]*$", re.I)


# round 26: "close the voice tab", "thank you, you can close it now", "please close Euliv", "end the chat"
_CLOSE = re.compile(
    r"^(?:(?:ok|okay|alright|great|perfect|cool|thanks|thank you|thank u|cheers|please|you can|can you|could you|just|now|so|and)[\s,.!]+)*"
    r"(?:close|exit|quit|shut|end|stop|dismiss|hang up|turn off)"
    r"(?:\s+(?:it|this|that|now|the|a|voice|euliv|you|assistant|chat|tab|window|panel|popup|pop up|pop-up|box|screen|"
    r"conversation|talk|session|down|off|up|please|for now|listening|mode|thing|thanks|thank you))*[\s.!]*$", re.I)


def wants_close(text: str) -> bool:
    t = re.sub(rf"[\s,]+(?:{EXACT_NAMES})[\s.!?]*$", "", (text or "").strip(), flags=re.I).strip()
    return bool(_CLOSE.match(t))


def firm_end(text: str) -> bool:
    """bye / stop / cancel - the only ways to leave while Euliv waits on an answer ("that's it" and "done"
    mean "go ahead" during a read-back)."""
    t = re.sub(rf"[\s,]+(?:{EXACT_NAMES})[\s.!?]*$", "", (text or "").strip(), flags=re.I).strip()
    core = _POLITE.sub("", t).strip()
    return bool(_FIRM_END.match(t) or (core and _FIRM_END.match(core)) or wants_close(text))


def hard_end(text: str) -> bool:
    """bye / stop / that's all - ends the talk whatever Euliv was waiting for."""
    t = re.sub(rf"[\s,]+(?:{EXACT_NAMES})[\s.!?]*$", "", (text or "").strip(), flags=re.I).strip()
    core = _POLITE.sub("", t).strip()
    return bool(_END.match(t) or (core and _END.match(core)))


def questionish(text: str) -> bool:
    return bool(_QUESTIONISH.search(text or ""))


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
    if wants_close(t):
        return "end"
    if _END.match(t):
        return "end"
    if re.fullmatch(r"(?:ok|okay|alright|all right|fine|great|good|right|sure|hmm+|mm+|uh huh)[\s.!]*", t, re.I):
        return "ack"
    if _CLOSING.match(core or t) and not questionish(core or t):
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


# ---- picking data by voice (round 24) ------------------------------------------------
#
# "the first and third"   -> exactly those          "add Shopify" / "the second too" -> plus that
# "remove the first"      -> without it              "only the third" / "just Meta"   -> only that
# "drop both, use the 4th" / "swap Meta for Shopify" / "Shopify instead of Meta"
# "all of them" / "both" / "all except Meta"         "none" / "start over"
# "that's it" / "yes, go ahead"  -> confirm           "what else do I have?" -> show everything
# "which is best?" / "I'm not sure" -> Euliv recommends

_ORDINALS = {"first": 1, "1st": 1, "second": 2, "2nd": 2, "third": 3, "3rd": 3, "fourth": 4, "4th": 4, "fifth": 5,
             "5th": 5, "sixth": 6, "6th": 6, "seventh": 7, "7th": 7, "eighth": 8, "8th": 8, "ninth": 9, "9th": 9,
             "tenth": 10, "10th": 10}
_CARDINALS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
              "ten": 10, "won": 1, "to": None, "too": None, "for": None}
_NOT_COUNT = r"(?:months?|days?|weeks?|years?|quarters?|sources?|thousand|hundred|million|percent|%|of them|of those|hours?|minutes?)"
_VERBS = [
    ("remove", r"remove|drop|without|except|excluding|exclude|unselect|deselect|untick|uncheck|take out|take off|skip|minus|"
               r"leave out|get rid of|forget|not|no|but not|instead of"),
    ("add", r"add|also|plus|include|including|as well as|along with|put in|bring in|and also|with|together with"),
    ("only", r"only|just|switch to|change to|use only|only use|go with|going with|go for|stick with|stick to|let'?s use"),
    ("swap_from", r"replace|swap|change|switch"),
]
_POST_ADD = re.compile(r"^\s*(?:too|as well|also)\b")
_CONFIRM = re.compile(r"^(?:yes|yeah|yep|yup|sure|ok|okay|go ahead|go|do it|perfect|correct|right|that'?s (?:it|all|right|correct|fine|good)|"
                      r"thats (?:it|all|right)|done|sounds good|confirm(?:ed)?|great|good|fine|run it|start|proceed|let'?s go|"
                      r"go for it|that works|use (?:those|these|that|them|it)|exactly)\b", re.I)
_MORE = re.compile(r"\b(show (?:me )?(?:all|everything|more|the rest|others?|other sources|all (?:my|the) data)|what (?:else|other)|"
                   r"more options|other (?:sources|data|options)|anything else|list (?:them|all|everything)|what do i have|"
                   r"what data do i have|which data do i have|all my data|show all)\b", re.I)
_UNSURE = re.compile(r"\b(not sure|don'?t know|dont know|no idea|which (?:one )?(?:is best|is better|should i|do you recommend|would you)|"
                     r"you (?:choose|pick|decide)|recommend|suggest|help me (?:choose|pick|decide)|confused|whatever you think|"
                     r"what do you (?:think|suggest)|best one|which is right)\b", re.I)
_NONE = re.compile(r"\b(none|nothing|clear (?:it|all|them)?|start over|unselect all|deselect all|remove all|remove both|"
                   r"drop all|drop both|neither|(?:drop|remove|unselect|deselect|forget|skip|untick|lose)\s+"
                   r"(?:it|that|this|them|those|these|that one|this one|everything))\b", re.I)
_ALL = re.compile(r"\b(all|both|every one|everything|each of them|all of them)\b", re.I)


def _mentions(t: str, options: list[dict]) -> list[tuple[int, int, str]]:
    """(start, end, option id) for every option named or numbered in `t`."""
    out: list[tuple[int, int, str]] = []
    spans: list[tuple[int, int]] = []
    firsts: dict[str, int] = {}
    for o in options:
        for n in {o.get("name"), o.get("label")}:
            w = _norm(n).split()[:1]
            if w:
                firsts[w[0]] = firsts.get(w[0], 0) + 1
    for o in options:
        variants = {_norm(o.get("name")).strip()}
        lab = _norm(o.get("label")).strip()
        if lab and sum(1 for x in options if _norm(x.get("label")).strip() == lab) == 1:
            variants.add(lab)
        variants |= {a for a, k in ALIASES.items() if k == o.get("kind")
                     and sum(1 for x in options if x.get("kind") == k) == 1}
        for n in (o.get("name"), o.get("label")):
            w = _norm(n).split()[:1]
            if w and len(w[0]) >= 4 and firsts.get(w[0]) == 1 and w[0] not in {"data", "file", "the", "main", "test", "sample"}:
                variants.add(w[0])
        best = None
        for v in sorted((v for v in variants if v and len(v) >= 3), key=len, reverse=True):
            i = t.find(f" {v} ")
            if i >= 0:
                best = (i + 1, i + 1 + len(v))
                break
            sq = v.replace(" ", "")
            if len(sq) >= 6:
                j = t.replace(" ", "").find(sq)
                if j >= 0:
                    # map back roughly: position of the first word of the variant
                    k = t.find(" " + v.split()[0][:3])
                    best = (max(0, k + 1), max(0, k + 1) + len(v))
                    break
        if best:
            out.append((best[0], best[1], o["id"]))
            spans.append(best)

    def free(a: int, b: int) -> bool:
        return not any(a < y and b > x for x, y in spans)

    n = len(options)
    for m in re.finditer(r"\b(?:number|option|no|#)\s*(\d{1,2}|" + "|".join(k for k, v in _CARDINALS.items() if v) + r")\b", t):
        k = m.group(1)
        idx = int(k) if k.isdigit() else _CARDINALS.get(k)
        if idx and 1 <= idx <= n and free(m.start(), m.end()):
            out.append((m.start(), m.end(), options[idx - 1]["id"]))
            spans.append((m.start(), m.end()))
    for m in re.finditer(r"\b(" + "|".join(_ORDINALS) + r"|last)\b(?:\s+(?:one|option|source))?", t):
        word = m.group(1)
        if word == "last":
            if not re.match(r"\s*(?:one|option|source|$)", t[m.end():]) and not m.group(0).strip().endswith(("one", "option", "source")):
                continue
            idx = n
        else:
            idx = _ORDINALS[word]
        if 1 <= idx <= n and free(m.start(), m.end()):
            out.append((m.start(), m.end(), options[idx - 1]["id"]))
            spans.append((m.start(), m.end()))
    for m in re.finditer(r"\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|won)\b", t):
        k = m.group(1)
        idx = int(k) if k.isdigit() else _CARDINALS.get(k)
        if not idx or not (1 <= idx <= n) or not free(m.start(), m.end()):
            continue
        if re.match(rf"\s*{_NOT_COUNT}\b", t[m.end():]):
            continue
        if k == "one" and re.search(r"\b(?:the|this|that|which|first|second|third|last|other|a)\s+$", t[:m.start()]):
            continue
        out.append((m.start(), m.end(), options[idx - 1]["id"]))
        spans.append((m.start(), m.end()))
    out.sort()
    return out


def select_sources(text: str, options: list[dict], selected: list[str]) -> dict:
    """What a spoken reply does to the picked sources - see the table above.
    {"op": set|change|all|none|confirm|more|recommend|unknown, "selected": [...], "changed": bool}"""
    t = _norm(text)
    # "no, the third" / "actually just Meta" / "sorry, I meant two": a correction, not a removal
    t = re.sub(r"^\s*(?:(?:no|nope|nah|sorry|actually|wait|hmm|umm?|uh|oh|well|ok|okay)\s+)+(?:i\s+(?:meant|mean|said)\s+)?", " ", t)
    t = re.sub(r"^\s*i\s+(?:meant|mean|said)\s+", " ", t)
    t = " " + t.strip() + " "
    ids = [o["id"] for o in options]
    sel = [i for i in selected if i in ids]
    found = _mentions(t, options)
    verbs = []
    for kind, pat in _VERBS:
        for m in re.finditer(rf"\b(?:{pat})\b", t):
            verbs.append((m.start(), m.end(), kind))
    # "swap/replace X with/for Y": X goes, Y comes in
    for m in re.finditer(r"\b(?:with|for|to)\b", t):
        if any(k == "swap_from" and s < m.start() for s, _e, k in verbs):
            verbs.append((m.start(), m.end(), "add"))
    # "go with Shopify": the longer phrase wins over the "with" inside it
    verbs.sort(key=lambda v: (v[0], -(v[1] - v[0])))
    kept = []
    for v in verbs:
        if not any(k[0] <= v[0] and v[1] <= k[1] and k is not v for k in kept):
            kept.append(v)
    verbs = sorted(kept)

    # "drop both and use the fourth": after a clear-all, what follows starts afresh
    cleared = _NONE.search(t)
    floor = cleared.end() if cleared else -1

    def mode_at(pos: int) -> str:
        mode = "set"
        for s, e, k in verbs:
            if s >= pos:
                break
            if pos > floor >= e:
                continue
            mode = "remove" if k == "swap_from" else k
        return mode

    sets, adds, removes, onlys = [], [], [], []
    # "swap that for X" / "replace it with X": what's picked now goes
    if re.search(r"\b(?:swap|replace|change|switch)\s+(?:that|it|this|them|those|these)\b", t):
        removes += sel
    for i, (s, e, oid) in enumerate(found):
        mode = mode_at(s)
        nxt = found[i + 1][0] if i + 1 < len(found) else len(t)
        if mode == "set" and _POST_ADD.match(t[e:nxt]):
            mode = "add"
        {"set": sets, "add": adds, "remove": removes, "only": onlys}.get(mode, sets).append(oid)
    # "use X instead of Y": X is kept with the rest
    if re.search(r"\binstead of\b", t) and sets and removes:
        adds += sets
        sets = []

    has_all = bool(_ALL.search(t)) and not re.search(r"\bnot all\b", t)
    if not found:
        if _NONE.search(t):
            return {"op": "none", "selected": [], "changed": bool(sel)}
        if has_all:
            new = ids if not re.search(r"\b(except|but not|apart from|other than)\b", t) else sel
            return {"op": "all", "selected": new, "changed": new != sel}
        if _UNSURE.search(t):
            return {"op": "recommend", "selected": sel, "changed": False}
        if _MORE.search(t) or re.search(r"\badd (?:more|another|others?|some)\b", t):
            return {"op": "more", "selected": sel, "changed": False}
        if _CONFIRM.match(t.strip()) or _CONFIRM.match((text or "").strip().lower()):
            return {"op": "confirm", "selected": sel, "changed": False}
        return {"op": "unknown", "selected": sel, "changed": False}

    if onlys:
        new = list(dict.fromkeys(onlys + adds))
    elif has_all and removes and not sets:
        new = [i for i in ids if i not in removes]
    elif cleared:
        new = [i for i in dict.fromkeys(sets + adds) if i not in removes]
    elif sets:
        new = [i for i in dict.fromkeys(sets + adds) if i not in removes]
    else:
        new = [i for i in dict.fromkeys(sel + adds) if i not in removes]
    new = [i for i in ids if i in new]  # keep the list's order
    return {"op": "set" if sets and not (adds or removes) else "change", "selected": new, "changed": new != sel}


def numbered(options: list[dict], limit: int = 4) -> str:
    """'One: Ecommerce_Data, in BigQuery. Two: ...' - for the ear."""
    words_ = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"]
    parts = []
    for i, o in enumerate(options[:limit]):
        bit = f"{words_[i]}: {o['name']}"
        lab = o.get("label") or ""
        if lab and lab.lower() not in o["name"].lower():
            if o.get("kind") in ("csv", "excel", "file"):
                bit += f", {'an' if lab[:1].lower() in 'aeiou' else 'a'} {lab}"
            elif o.get("kind") in CORE_KINDS:
                bit += f", in {lab}"
            elif o.get("kind"):
                bit += f", from {lab}"
        if o.get("note"):
            bit += f" - {o['note']}"
        parts.append(bit + ".")
    more = len(options) - limit
    if more > 0:
        parts.append(f"And {more} more - say 'show all' to hear them.")
    return " ".join(parts)

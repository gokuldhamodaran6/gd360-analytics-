"""From a sentence to sources, and from sources + their profile to a plan.

Deliberately rule-based: every step it proposes comes from something it
actually found in the data (a link, a mistake, an amount column), so the
plan never invents columns that are not there."""
from __future__ import annotations

import re

from sqlalchemy.orm import Session

from ... import models
from ..workspace_access import datasource_access_filter
from .profile import slug, table_names

_STOP = {"the", "and", "with", "every", "each", "into", "from", "that", "this", "show", "make", "data", "morning",
         "day", "daily", "combine", "join", "merge", "clean", "flag", "anything", "odd", "real", "our", "for",
         "dashboard", "sales", "sheet", "sheets", "table", "file", "then", "when", "what", "have", "will"}
_KIND_WORDS = {
    "shopify": ["shopify"], "woocommerce": ["woocommerce", "woo"], "stripe": ["stripe"], "hubspot": ["hubspot"],
    "google_sheets": ["sheet", "sheets", "spreadsheet", "google"], "microsoft_excel": ["excel", "onedrive"],
    "excel": ["excel", "xlsx", "spreadsheet"], "csv": ["csv", "file", "upload"], "postgres": ["postgres", "database"],
    "mysql": ["mysql", "database"], "bigquery": ["bigquery", "warehouse"], "snowflake": ["snowflake", "warehouse"],
}
_LEFT_AMOUNT = [r"^total$", r"total_?price", r"^total", r"(^|_)amount$", r"sales", r"revenue", r"(^|_)price$", r"value", r"gross"]
_RIGHT_AMOUNT = [r"refund", r"return", r"discount", r"credit", r"amount", r"value", r"₹|\$|€|£", r"paid", r"cost"]
_BRANDS = r"(shopify|stripe|hubspot|google|meta|facebook|instagram|amazon|woocommerce|salesforce|zoho|tally|razorpay|paypal|klaviyo|excel|quickbooks|xero)\b"
_SUBTRACT = re.compile(r"refund|return|discount|credit|cost|fee|chargeback", re.IGNORECASE)


def _stem(w: str) -> str:
    w = w.lower()
    return w[:-1] if len(w) > 3 and w.endswith("s") else w


def _tokens(text: str) -> set[str]:
    words = {_stem(w) for w in re.findall(r"[a-zA-Z][a-zA-Z0-9]{2,}", text or "")}
    return words | set(re.findall(r"\b\d{2,}\b", text or ""))


def source_options(db: Session, user: models.User, workspace_id: str | None) -> list[dict]:
    q = db.query(models.DataSource).filter(datasource_access_filter(db, user))
    if workspace_id:
        q = q.filter((models.DataSource.workspace_id == workspace_id) | (models.DataSource.workspace_id.is_(None) & (models.DataSource.owner_id == user.id)))
    out = []
    for ds in q.order_by(models.DataSource.created_at.desc()).limit(200).all():
        tables = [t for t in table_names(ds) if t]
        out.append({"id": ds.id, "name": ds.name, "kind": ds.kind, "tables": tables[:50],
                    "managed": bool((ds.connection_info or {}).get("managed_by_flow"))})
    return out


def _source_entry(opt: dict, table: str | None, used: set[str]) -> dict:
    label = opt["name"] + (f" · {table}" if table and len(opt["tables"]) > 1 else "")
    base = slug(table or re.sub(r"\b(20\d\d|19\d\d)\b", "", opt["name"]) or opt["name"])
    alias = base
    n = 2
    while alias in used or alias == "main":
        alias = f"{base}_{n}"
        n += 1
    used.add(alias)
    return {"alias": alias, "datasource_id": opt["id"], "table": table, "label": label, "kind": opt["kind"]}


def _pick_table(opt: dict, toks: set[str]) -> str | None:
    if not opt["tables"]:
        return None
    best, score = opt["tables"][0], -1
    for t in opt["tables"]:
        s = len(_tokens(t.replace("_", " ")) & toks)
        if s > score:
            best, score = t, s
    return best


def match_sources(text: str, options: list[dict], source_ids: list[str] | None = None) -> list[dict]:
    """The sources a request is about: picked ids first, otherwise the best
    matches by name, kind and table names."""
    toks = _tokens(text)
    used: set[str] = set()
    if source_ids:
        by_id = {o["id"]: o for o in options}
        out = []
        for sid in source_ids[:5]:
            if sid in by_id:
                out.append(_source_entry(by_id[sid], _pick_table(by_id[sid], toks), used))
        return out
    scored = []
    low = (text or "").lower()
    for o in options:
        name_t = _tokens(o["name"]) - {_stem(w) for w in _STOP}
        s = 2 * len(name_t & toks)
        for w in _KIND_WORDS.get(o["kind"], []):
            if re.search(rf"\b{w}", low):
                s += 3
                break
        tbl = {_stem(w) for t in o["tables"] for w in re.findall(r"[a-zA-Z]{3,}", t)}
        s += len(tbl & toks)
        if o.get("managed"):
            s -= 2  # a flow's own output only when it is clearly named
        if s > 0:
            scored.append((s, o))
    scored.sort(key=lambda x: -x[0])
    out: list[dict] = []
    seen_names: list[set[str]] = []
    for s, o in scored:
        if len(out) >= 3 or (out and s < scored[0][0] * 0.34):
            break
        core = {w for w in _tokens(o["name"]) if not w.isdigit()}
        if any(core == prev for prev in seen_names):
            continue  # the same source uploaded twice: keep the better match (newest on a tie)
        seen_names.append(core)
        out.append(_source_entry(o, _pick_table(o, toks), used))
    return out


def parse_time(text: str) -> str | None:
    low = (text or "").lower()
    m = re.search(r"\b(?:at|by|around)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?", low)
    if not m:
        m = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", low)
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2) or 0)
    ap = (m.group(3) or "").replace(".", "")
    if ap == "pm" and h < 12:
        h += 12
    if ap == "am" and h == 12:
        h = 0
    if h > 23 or mi > 59:
        return None
    return f"{h:02d}:{mi:02d}"


def parse_hold(text: str) -> int | None:
    m = re.search(r"(?:more than|over|above|>)\s*(\d{1,7})\s*(?:rows?|records?|orders?|lines?|fail|look|are)", (text or "").lower())
    return int(m.group(1)) if m else None


def parse_days(text: str) -> list[int] | None:
    low = (text or "").lower()
    if re.search(r"weekday|monday to friday|mon-fri|working day", low):
        return [0, 1, 2, 3, 4]
    return None


def _pick(cols: list[dict], patterns: list[str], allow: set[str]) -> str | None:
    for p in patterns:
        for c in cols:
            if c["kind"] in allow and re.search(p, c["name"], re.IGNORECASE):
                return c["name"]
    return None


def _short(alias: str) -> str:
    return re.sub(r"[_\d]+", " ", alias).strip() or alias


def add_minutes(t: str, minutes: int) -> str:
    h, m = map(int, t.split(":"))
    total = (h * 60 + m + minutes) % (24 * 60)
    return f"{total // 60:02d}:{total % 60:02d}"


def build_spec(request: str, sources: list[dict], prof: dict, *, timezone: str, owner_id: str) -> tuple[str, dict, list[str]]:
    """Returns (flow name, spec, notes for the person)."""
    notes: list[str] = []
    desc = {s["alias"]: s for s in prof["sources"]}
    link = prof.get("link")
    by_alias: dict[str, list[dict]] = {}
    for iss in prof.get("issues") or []:
        op = {"key_format": "tidy_key", "text_number": "to_number", "missing_key": "set_aside_missing"}.get(iss["kind"])
        if op:
            by_alias.setdefault(iss["alias"], []).append({"op": op, "column": iss["column"]})
    steps: list[dict] = []
    order = {"tidy_key": 0, "to_number": 1, "set_aside_missing": 2}
    for s in sources:
        ops = sorted(by_alias.get(s["alias"], []), key=lambda o: order[o["op"]])
        if link and s["alias"] in (link["left"], link["right"]):
            key = link["left_on"] if s["alias"] == link["left"] else link["right_on"]
            kd = next((c for c in desc[s["alias"]]["columns"] if c["name"] == key), None)
            if kd and kd["kind"] == "text" and not any(o["op"] == "tidy_key" for o in ops):
                ops.insert(0, {"op": "tidy_key", "column": key})
        if ops:
            steps.append({"id": f"clean_{s['alias']}"[:40], "kind": "clean", "source": s["alias"], "ops": ops})
    checks: list[dict] = []
    main_alias = sources[0]["alias"]
    compute_col = None
    if link:
        left, right = link["left"], link["right"]
        main_alias = left
        rcols = [c for c in desc[right]["columns"] if c["name"] != link["right_on"]]
        amount_r = _pick(rcols, _RIGHT_AMOUNT, {"number", "number as text"})
        numeric_r = [c["name"] for c in rcols if c["kind"] in ("number", "number as text")]
        bring = [amount_r] if amount_r else (numeric_r[:3] or [c["name"] for c in rcols[:5]])
        steps.append({"id": "combine", "kind": "combine", "left": left, "right": right, "left_on": link["left_on"],
                      "right_on": link["right_on"], "right_columns": bring, "aggregate": "sum", "fill": 0})
        amount_l = _pick(desc[left]["columns"], _LEFT_AMOUNT, {"number", "number as text"})
        wants_net = bool(re.search(r"\bnet\b|minus|less|subtract|after (refund|return|discount)", (request or "").lower()))
        if amount_l and amount_r and (_SUBTRACT.search(amount_r) or wants_net):
            compute_col = "net_sales" if re.search(r"total|sales|revenue|price|amount", amount_l, re.IGNORECASE) else f"net_{slug(amount_l)}"
            steps.append({"id": "net", "kind": "compute", "column": compute_col, "left": amount_l, "op": "-",
                          "right": amount_r, "fill": 0})
        checks.append({"id": "c_unique", "kind": "unique", "column": link["left_on"]})
        if compute_col:
            checks.append({"id": "c_min", "kind": "min", "column": compute_col, "value": 0})
        unused = [s["label"] for s in sources if s["alias"] not in (left, right)]
        if unused:
            notes.append("Not used yet (no shared column found): " + ", ".join(unused))
    elif len(sources) > 1:
        notes.append("Euliv could not find a column that links these sources, so only the first one is used. "
                     "Pick the matching columns in the plan to combine them.")
    time = parse_time(request) or "06:00"
    checks.append({"id": "c_ready", "kind": "ready_by", "time": add_minutes(time, 30)})
    hold = parse_hold(request)
    spec = {
        "sources": [{k: s[k] for k in ("alias", "datasource_id", "table", "label")} for s in sources],
        "steps": steps,
        "checks": checks,
        "output": {"name": f"{main_alias}_clean"},
        "schedule": {"time": time, "days": parse_days(request) or list(range(7)), "timezone": timezone or "UTC",
                     "on_change": True},
        "policy": {"hold_above": hold if hold is not None else 50, "flag_to": [owner_id], "alert_to": [owner_id],
                   "daily_summary": True},
    }
    if link:  # the "one row per thing" source first, so the plan reads naturally
        spec["sources"].sort(key=lambda s: 0 if s["alias"] == link["left"] else 1 if s["alias"] == link["right"] else 2)
    used = [link["left"], link["right"]] if link else [main_alias]
    labels = {s["alias"]: s.get("label") or s["alias"] for s in sources}
    parts = []
    for i, a in enumerate(used):
        t = re.sub(r"\s+", " ", re.sub(r"\b\d{2,}\b", "", labels.get(a, a))).strip(" ·-_") or _short(a)
        if i > 0 and t[:1].isupper() and not re.match(_BRANDS, t, re.IGNORECASE) and not t[:2].isupper():
            t = t[:1].lower() + t[1:]
        parts.append(t)
    name = "Daily " + " and ".join(parts)
    return name[:80], spec, notes

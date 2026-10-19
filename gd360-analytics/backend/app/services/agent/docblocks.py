"""2026-10-15 (R51): block documents - "write a one-page retention brief for the board from this analysis".

A document is a list of typed blocks (title, byline, heading, paragraph, callout, figure, table, sources), built
from what the conversation already computed: the analysis (its prose was checked against its findings in R48),
answered questions, world answers with their sources, the dashboard and the alerts made here. Nothing is invented:
every number a block states must be in the findings (project_engine.numbers), figures are computed from the table
itself, and each paragraph carries source chips that point at the step that produced it.

One block can then be changed on its own - "add a graph for this below", "make it shorter", "rewrite: ...",
remove - or typed over; the whole document can be made shorter, renamed, undone. Word, PDF and Markdown are built
from the same blocks (docexport.py).
"""
from __future__ import annotations

import copy
import json
import re
import uuid
from datetime import date, datetime

import pandas as pd
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from ... import models
from .. import ai_engine
from ..project_engine import numbers
from . import analysis, board

MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
SHORT = re.compile(r"\b(one[- ]?page(r)?|1[- ]page|short|brief(ly)?|concise|quick|summary)\b", re.I)


class DocError(Exception):
    pass


def _bid() -> str:
    return "b" + uuid.uuid4().hex[:10]


def _cap(s: str) -> str:
    return s[:1].upper() + s[1:] if s else s


_NUM_BOLD = re.compile(r"(?<![\w*])((?:[$€£₹])?\d[\d,]*(?:\.\d+)?%?(?:\s(?:customers|rows|points|pp|clients|orders|bookings|accounts|users|records))?)(?![\w*])")


def bold_numbers(text: str) -> str:
    """Key figures in bold: "of whom **1,651** churned, a **16.3%** churn rate"."""
    def rep(m: re.Match) -> str:
        tok = m.group(1)
        if re.fullmatch(r"\d{1,2}", tok) or re.fullmatch(r"(19|20)\d\d", tok):
            return tok  # small counting numbers and years stay plain
        return f"**{tok}**"
    return _NUM_BOLD.sub(rep, text or "")


def plain(text: str) -> str:
    return re.sub(r"\*\*(.+?)\*\*", r"\1", text or "")


# ---- what the conversation holds ------------------------------------------------------------

def material(db: Session, user: models.User, conv: models.Conversation) -> dict:
    """The analyses, answered questions, world answers, dashboards and alerts of a conversation."""
    from . import turns as T
    msgs = (db.query(models.Message).filter(models.Message.conversation_id == conv.id, models.Message.action.like("v2:%"))
            .order_by(models.Message.created_at.asc()).all())
    analyses, know, alerts = [], [], []
    pending = []
    for m in msgs:
        st = T._state(m)
        if st.get("kind") == "automation" and st.get("status") == "confirm" and st.get("confirm"):
            pending.append({"turn_id": m.id, "name": ((st["confirm"].get("body") or {}).get("name")) or "the alert"})
        if st.get("status") != "done":
            continue
        if st.get("kind") == "analysis" and st.get("analysis"):
            analyses.append({"turn_id": m.id, "r": st["analysis"]})
        elif st.get("kind") == "knowledge" and st.get("text"):
            know.append({"turn_id": m.id, "question": st.get("question"), "text": st.get("text"), "sources": st.get("sources") or []})
        elif st.get("kind") == "automation":
            a = next((x for x in st.get("artifacts") or [] if x.get("type") == "automation"), None)
            if a:
                alerts.append({"turn_id": m.id, "name": a.get("name"), "when": (a.get("sentence") or {}).get("when"), "id": a.get("id")})
    runs = T._done_runs(db, conv)
    dashes = (db.query(models.Dashboard).filter(models.Dashboard.source_conversation_id == conv.id)
              .order_by(models.Dashboard.created_at.desc()).all())
    return {"analyses": analyses, "runs": runs, "knowledge": know, "alerts": alerts, "dashboards": dashes, "pending_alerts": pending}


# ---- figures computed from the table itself ---------------------------------------------------

def _rate_by(df: pd.DataFrame, r: dict, column: str) -> tuple[list[dict], str] | None:
    """The outcome rate in the bands (number) or groups (category) of one column."""
    t = r["target"]
    if column not in df.columns or t["column"] not in df.columns:
        return None
    y = (df[t["column"]].astype(str) == str(t["positive"]))
    s = df[column]
    lab = board.short(column)
    sig = next((x for x in r.get("signals") or [] if x["column"] == column), None)
    bars: list[dict] = []
    if pd.api.types.is_numeric_dtype(s):
        x = pd.to_numeric(s, errors="coerce")
        if sig and len(sig.get("threshold") or []) == 2:
            q1, q2 = sig["threshold"]
        else:
            q1, q2 = float(x.quantile(1 / 3)), float(x.quantile(2 / 3))
        integer = bool((x.dropna() % 1 == 0).all())
        f1, f2 = analysis._fmt_num(q1, integer), analysis._fmt_num(q2, integer)
        groups = [(f"Under {f1}", x < q1), (f"{f1} to under {f2}", (x >= q1) & (x < q2)), (f"{f2} or more", x >= q2)]
        for name, mask in groups:
            n = int(mask.sum())
            if n >= analysis.MIN_GROUP:
                bars.append({"label": name, "value": round(100 * float(y[mask].mean()), 1), "n": n})
        title = f"{_cap(r['target']['noun'])} rate by {lab}, %"
    else:
        g = pd.DataFrame({"g": s.astype(str), "y": y}).groupby("g")["y"].agg(["mean", "count"])
        g = g[g["count"] >= analysis.MIN_GROUP].sort_values("count", ascending=False).head(7)
        vals = sorted(g.index, key=board._natural)
        for v in vals:
            bars.append({"label": str(v), "value": round(100 * float(g.loc[v, "mean"]), 1), "n": int(g.loc[v, "count"])})
        title = f"{_cap(r['target']['noun'])} rate by {lab}, %"
    if len(bars) < 2:
        return None
    hi = max(b["value"] for b in bars)
    lo = min(b["value"] for b in bars)
    for b in bars:
        b["tone"] = "bad" if b["value"] == hi else "good" if b["value"] == lo else "neutral"
    return bars, title


def figure_for(db: Session, user: models.User, r: dict, column: str, cites: list[str]) -> dict | None:
    try:
        df, _ = board.frame(db, user, r["table"]["source_id"], r["table"]["table"])
    except Exception as e:  # noqa: BLE001
        print(f"[agent.docblocks] figure skipped: {e}")
        return None
    out = _rate_by(df, r, column)
    if not out:
        return None
    bars, title = out
    ent = r["table"]["entities"]
    return {"id": _bid(), "type": "figure", "kind": "bars", "title": title, "unit": "%", "bars": bars,
            "subtitle": f"{_cap(board.short(column))} · all {ent} {r['baseline']['rate']}%",
            "baseline": {"value": r["baseline"]["rate"], "label": f"All {ent} {r['baseline']['rate']}%"}, "cites": cites, "column": column}


def best_column(r: dict, text: str, used: set[str] | None = None) -> str | None:
    """The column a paragraph talks about: the signal whose words it uses most and that has no chart yet,
    else the strongest signal without one."""
    used = used or set()
    words = set(re.findall(r"[a-z]{3,}", (text or "").lower())) - {"the", "and", "with", "than", "who", "for", "customers", "rate", "churn"}
    cands = [s for s in r.get("signals") or [] if s["column"] not in used] or list(r.get("signals") or [])
    best, score = None, 0
    for s in cands:
        sw = set(re.findall(r"[a-z]{3,}", (s.get("label") or "").lower()))
        sc = len(words & sw)
        if sc > score:
            best, score = s["column"], sc
    if best:
        return best
    return (cands or [{}])[0].get("column")


# ---- composing a document -------------------------------------------------------------------

def _kind_word(request: str) -> str:
    for w, out in (("report", "report"), ("memo", "memo"), ("summary", "summary"), ("review", "review"), ("update", "update"), ("brief", "brief")):
        if re.search(rf"\b{w}\b", request or "", re.I):
            return out
    return "brief"


def _topic(r: dict | None, first_question: str | None) -> str:
    if r:
        noun = r["target"]["noun"]
        return {"churn": "Retention", "cancellation": "Cancellation", "conversion": "Conversion", "default": "Credit risk",
                "fraud": "Fraud"}.get(noun, _cap(noun.strip("“”")))
    q = (first_question or "").strip().rstrip("?")
    q = re.sub(r"^(what|why|how|which|who|show|give|tell)( me)?\s+(is|are|was|were|did|does|do)?\s*", "", q, flags=re.I)
    if len(q) > 48:
        # R56: cut at a word, never mid-word ("…transaction amou")
        q = q[:48].rsplit(" ", 1)[0].rstrip(",;:-") or q[:48]
    return _cap(q) or "Findings"


def _src(sources: list[dict], **kw) -> str:
    for s in sources:
        if all(s.get(k) == v for k, v in kw.items() if k in ("turn_id", "step", "kind")):
            return s["id"]
    sid = f"s{len(sources) + 1}"
    sources.append({"id": sid, **kw})
    return sid


def compose(db: Session, user: models.User, conv: models.Conversation, request: str, today: date | None = None) -> dict:
    """{title, blocks, sources, meta}. Raises DocError when the conversation holds nothing to write from."""
    today = today or date.today()
    mat = material(db, user, conv)
    an = mat["analyses"][-1] if mat["analyses"] else None
    r = an["r"] if an else None
    short = bool(SHORT.search(request or ""))
    kind = _kind_word(request)
    first_q = (mat["runs"][0].question if mat["runs"] else (mat["knowledge"][0]["question"] if mat["knowledge"] else None))
    if not r and not mat["runs"] and not mat["knowledge"]:
        raise DocError("There is nothing to write from yet. Ask a question or run an analysis first; the document is written from what this conversation found.")
    if r:
        title = f"{_topic(r, first_q)} {kind}, {MONTHS[today.month - 1]} {today.year}"
    else:
        tp = _topic(None, first_q)
        title = f"{_cap(kind)}: {tp[:1].lower() + tp[1:] if tp[:4].lower() == 'the ' else tp}"
    sources: list[dict] = []
    blocks: list[dict] = [{"id": _bid(), "type": "title", "text": title}]
    if not r:
        n = len(mat["runs"]) + len(mat["knowledge"])
        blocks.append({"id": _bid(), "type": "byline",
                       "text": f"Prepared {today.day} {MONTHS[today.month - 1]} {today.year} · from {n} answer{'s' if n != 1 else ''} in this conversation"})
    allowed: list[float] = []
    if r:
        allowed += analysis.allowed_numbers(r)
        ent, noun, verb = r["table"]["entities"], r["target"]["noun"], r["target"]["verb"]
        prose = r.get("prose") or {}
        steps = [s.get("label") for s in (r.get("method") or {}).get("steps") or []]
        aname = f"{_cap(noun.strip('“”'))} analysis"
        s_read = _src(sources, kind="analysis", turn_id=an["turn_id"], step="read", label=f"{aname} · step 1 · read {r['baseline']['n']:,} {ent}")
        s_sig = _src(sources, kind="analysis", turn_id=an["turn_id"], step="signals",
                     label=f"{aname} · step {steps.index('Compared every signal') + 1 if 'Compared every signal' in steps else 4} · signals")
        s_model = _src(sources, kind="analysis", turn_id=an["turn_id"], step="model", label=f"Model · held-out test · AP {r['model']['ap']}") if r.get("model") else None
        blocks.append({"id": _bid(), "type": "byline",
                       "text": f"Prepared {today.day} {MONTHS[today.month - 1]} {today.year} · {r['table']['source']} · {r['baseline']['n']:,} {ent}"
                               + (" · a fair sample" if r["table"].get("sampled") else "")})
        blocks.append({"id": _bid(), "type": "heading", "level": 2, "text": "Executive summary"})
        summ = [p for p in (prose.get("summary") or []) if p]
        if summ:
            blocks.append({"id": _bid(), "type": "paragraph", "text": bold_numbers(summ[0]), "cites": [s_read, s_sig]})
        if len(summ) > 1:
            blocks.append({"id": _bid(), "type": "paragraph", "text": bold_numbers(summ[1]), "cites": [s_model or s_sig]})
        if prose.get("limitation"):
            blocks.append({"id": _bid(), "type": "callout", "tone": "warn", "label": "Important limitation", "text": prose["limitation"], "cites": []})
        sigs = r.get("signals") or []
        if sigs:
            blocks.append({"id": _bid(), "type": "heading", "level": 2, "text": f"What separates the {ent} who {('leave' if noun == 'churn' else 'have the outcome')}"})
            s0 = sigs[0]
            txt = f"{_cap(ent)} with {s0['group']} {verb} at {s0['group_rate']}%, against {s0['compare_rate']}% for those with {s0['compare']}."
            if len(sigs) > 1:
                s1 = sigs[1]
                txt += f" {_cap(s1['group'])} is the next signal: {s1['group_rate']}% against {s1['compare_rate']}%."
            txt += " These groups overlap; their effects should not be added together."
            blocks.append({"id": _bid(), "type": "paragraph", "text": bold_numbers(txt), "cites": [s_sig]})
            fig = figure_for(db, user, r, s0["column"], [s_sig])
            if fig:
                blocks.append(fig)
                allowed += [b["value"] for b in fig["bars"]] + [b["n"] for b in fig["bars"]]
        if r.get("by_dimension") and r["by_dimension"].get("values"):
            d = r["by_dimension"]
            blocks.append({"id": _bid(), "type": "heading", "level": 2, "text": f"By {d['label']}"})
            blocks.append({"id": _bid(), "type": "table", "cites": [s_sig],
                           "columns": [{"key": "v", "label": _cap(d["label"])}, {"key": "n", "label": _cap(ent), "align": "right"},
                                       {"key": "p", "label": _cap(verb), "align": "right"}, {"key": "r", "label": "Rate", "align": "right"}],
                           "rows": [{"v": v["value"], "n": f"{v['n']:,}", "p": f"{v['positives']:,}", "r": f"{v['rate']}%"} for v in d["values"][:10]]})
        if r.get("tiers") and not short:
            blocks.append({"id": _bid(), "type": "heading", "level": 2, "text": "Who is likely to leave next" if noun == "churn" else "Who is most at risk"})
            if prose.get("tiers_note"):
                blocks.append({"id": _bid(), "type": "paragraph", "text": bold_numbers(prose["tiers_note"]), "cites": [s_model] if s_model else []})
            blocks.append({"id": _bid(), "type": "table", "cites": [s_model] if s_model else [],
                           "columns": [{"key": "t", "label": "Tier"}, {"key": "c", "label": f"Current {ent}", "align": "right"},
                                       {"key": "rule", "label": "Rule"}, {"key": "h", "label": f"Historically {verb}", "align": "right"}],
                           "rows": [{"t": t["label"], "c": f"{t['count']:,}", "rule": t["rule"], "h": f"{t['hist_rate']}%"} for t in r["tiers"]]})
        recs = r.get("recommendations") or []
        for x in recs:  # the expected-reach figures are computed by the analysis, in its own sentences
            allowed += [n for _t, n, _p in numbers.extract_numbers(" ".join(str(x.get(k) or "") for k in ("title", "body", "reach_note")))]
        if recs:
            blocks.append({"id": _bid(), "type": "heading", "level": 2, "text": "Recommendations"})
            blocks.append({"id": _bid(), "type": "table", "cites": [s_model or s_sig],
                           "columns": [{"key": "a", "label": "Action"}, {"key": "c", "label": _cap(ent), "align": "right"},
                                       {"key": "e", "label": "Expected, not guaranteed"}],
                           "rows": [{"a": x["title"], "c": f"{x['reach']:,}", "e": re.sub(r"^Expected, not guaranteed:\s*", "", x.get("reach_note") or "")}
                                    for x in recs[: 2 if short else 4]]})
    # answered questions and world answers
    for run in mat["runs"][: (2 if short else 4) if not r else (1 if not short else 0)]:
        res = run.result or {}
        ans = res.get("answer") or {}
        sid = _src(sources, kind="answer", turn_id=run.id, label=f"Answer · {str(run.question)[:60]}")
        from . import documents as legacy
        allowed += numbers.allowed_values(legacy._facts_of(run), [{"rows": v.get("rows")} for v in (res.get("visuals") or []) if isinstance(v, dict) and v.get("rows")], "")
        blocks.append({"id": _bid(), "type": "heading", "level": 2, "text": _cap(str(run.question).strip().rstrip("?"))[:90]})
        txt = " ".join(x for x in (ans.get("headline"), ans.get("answer")) if x) or "No written answer."
        blocks.append({"id": _bid(), "type": "paragraph", "text": bold_numbers(str(txt)[:900]), "cites": [sid]})
        vis = next((v for v in res.get("visuals") or [] if isinstance(v, dict) and v.get("rows")), None)
        if vis and not short:
            cols = list((vis["rows"][0] or {}).keys())[:5]
            blocks.append({"id": _bid(), "type": "table", "cites": [sid], "columns": [{"key": c, "label": _cap(str(c).replace("_", " "))} for c in cols],
                           "rows": [{c: (f"{row.get(c):,}" if isinstance(row.get(c), (int, float)) and not isinstance(row.get(c), bool) else row.get(c)) for c in cols}
                                    for row in vis["rows"][:8]]})
    for k in mat["knowledge"][: 0 if (r and short) else 2]:
        web = [s for s in k["sources"] if s.get("url")][:4]
        sids = [_src(sources, kind="web", turn_id=k["turn_id"], step=s.get("url"), label=f"{s.get('title') or s.get('domain')} · {s.get('domain') or ''}".strip(" ·"), url=s.get("url"))
                for s in web]
        allowed += [n for _t, n, _p in numbers.extract_numbers(str(k["text"]))]
        blocks.append({"id": _bid(), "type": "heading", "level": 2, "text": _cap(str(k["question"]).strip().rstrip("?"))[:90]})
        blocks.append({"id": _bid(), "type": "paragraph", "text": re.sub(r"\s*\[\d+\]", "", str(k["text"]))[:1200], "cites": sids})
    # next steps from what this conversation set up
    nxt, cites = [], []
    if r and r.get("tiers"):
        nxt.append(f"Approve the call list of the {r['tiers'][0]['count']:,} high-risk {r['table']['entities']} this week.")
    if mat["alerts"]:
        a = mat["alerts"][-1]
        nxt.append(f"The alert “{a['name']}” is watching: {(a.get('when') or 'on its schedule').lower()}.")
        cites.append(_src(sources, kind="alert", turn_id=a["turn_id"], label=f"Alert · {a['name']} · {a.get('when') or ''}".strip(" ·")))
    elif mat.get("pending_alerts"):
        a = mat["pending_alerts"][-1]
        nxt.append(f"Confirm the alert “{a['name']}” in this conversation so a change is seen the week it happens.")
        cites.append(_src(sources, kind="alert", turn_id=a["turn_id"], label=f"Alert · {a['name']} · waiting for your confirm"))
    elif r:
        nxt.append(f"Set an alert on {r['target']['noun']} by segment so a change is seen the week it happens.")
    if mat["dashboards"]:
        d = mat["dashboards"][0]
        nxt.append(f"“{d.name}” tracks these numbers live.")
        cites.append(_src(sources, kind="dashboard", turn_id=d.id, label=f"Dashboard · {d.name}"))
    if r:
        nxt.append("Re-run the analysis after the next data refresh and compare the tiers" + (
            f"; if the data gains dates, the {kind} can compare period with period." if not r.get("has_dates") else "."))
    if nxt:
        if not cites and r:
            cites = [_src(sources, kind="analysis", turn_id=an["turn_id"], step="signals")]
        blocks.append({"id": _bid(), "type": "heading", "level": 2, "text": "Next steps"})
        blocks.append({"id": _bid(), "type": "paragraph", "text": bold_numbers(" ".join(nxt)), "cites": cites})
    blocks.append({"id": _bid(), "type": "sources"})
    return {"title": title, "blocks": blocks, "sources": sources,
            "meta": {"allowed": sorted(set(round(float(a), 6) for a in allowed if a is not None))[:5000], "short": short, "kind": kind,
                     "analysis_turn": an["turn_id"] if an else None, "request": (request or "")[:300]}}


# ---- checking every figure -----------------------------------------------------------------------

def _texts(blocks: list[dict]) -> list[str]:
    out = []
    for b in blocks:
        if b["type"] in ("paragraph", "callout", "heading"):
            out.append(plain(b.get("text") or ""))
        elif b["type"] == "table":
            out += [" ".join(str(v) for v in row.values()) for row in b.get("rows") or []]
        elif b["type"] == "list":
            out += [plain(str(x)) for x in b.get("items") or []]
        elif b["type"] == "kpis":
            out += [str(k.get("value") or "") for k in b.get("items") or []]
    return out


def check(doc: models.DocDocument) -> dict:
    """{checked, flagged[]}: every number the blocks state, against the numbers the document was written from."""
    allowed = list((doc.meta or {}).get("allowed") or [])
    flagged, checked = [], 0
    for t in _texts(doc.blocks or []):
        toks = numbers.extract_numbers(t)
        bad = numbers.unsupported_numbers(t, allowed, None) if allowed else []
        flagged += bad
        checked += max(0, len([x for x in toks if not (not x[2] and abs(x[1]) <= 12 and float(x[1]).is_integer())]) - len(bad))
    checked += sum(len(b.get("bars") or []) for b in doc.blocks or [] if b["type"] == "figure")
    return {"checked": checked, "flagged": list(dict.fromkeys(flagged))[:10]}


# ---- storage, edits and undo ---------------------------------------------------------------------

def create(db: Session, user: models.User, conv: models.Conversation, message_id: str, request: str, today: date | None = None) -> models.DocDocument:
    c = compose(db, user, conv, request, today)
    doc = models.DocDocument(owner_id=user.id, workspace_id=conv.workspace_id, conversation_id=conv.id, message_id=message_id,
                             title=c["title"], blocks=c["blocks"], sources=c["sources"], meta=c["meta"], history=[])
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return doc


def _snapshot(doc: models.DocDocument, label: str) -> None:
    hist = list(doc.history or [])
    hist.append({"label": label, "title": doc.title, "blocks": copy.deepcopy(doc.blocks or []), "at": datetime.utcnow().isoformat() + "Z"})
    doc.history = hist[-15:]
    flag_modified(doc, "history")


def _save(db: Session, doc: models.DocDocument, person: bool = False) -> None:
    flag_modified(doc, "blocks")
    doc.updated_at = datetime.utcnow()
    if person:
        doc.edited_by_person = True
    db.commit()


def undo(db: Session, doc: models.DocDocument) -> str:
    hist = list(doc.history or [])
    if not hist:
        raise DocError("There is nothing to undo in this document yet.")
    prev = hist.pop()
    doc.blocks, doc.title, doc.history = prev["blocks"], prev.get("title") or doc.title, hist
    flag_modified(doc, "history")
    _save(db, doc)
    return prev.get("label") or "the last change"


def _find(doc: models.DocDocument, block_id: str) -> tuple[int, dict]:
    for i, b in enumerate(doc.blocks or []):
        if b.get("id") == block_id:
            return i, b
    raise DocError("That part of the document is not there any more.")


def _model_rewrite(text: str, instruction: str, allowed: list[float]) -> str | None:
    """A paragraph rewritten by the model, kept only when every number in it is in the findings."""
    try:
        raw = ai_engine._call_llm_resilient([
            {"role": "system", "content": "GD360 DOCUMENT EDITOR. Rewrite ONE paragraph of a business document as asked. Keep every number "
                                          "exactly as written; never add a number, a name or a claim that is not in the paragraph. Plain prose, "
                                          "no markdown. Reply with the new paragraph only."},
            {"role": "user", "content": f"Instruction: {instruction}\n\nParagraph:\n{plain(text)}"}], max_tokens=500)
    except Exception as e:  # noqa: BLE001
        print(f"[agent.docblocks] rewrite skipped: {e}")
        return None
    out = (raw or "").strip().strip('"')
    if not out or len(out) < 20 or out.lower().startswith(("test-fake", "i can't", "i cannot")):
        return None
    if numbers.unsupported_numbers(out, allowed, None):
        return None
    return out


def _shorter(text: str) -> str:
    """Half the sentences, the ones that carry numbers first; never cuts mid-sentence."""
    sents = re.split(r"(?<=[.!?])\s+(?=[A-Z“\"*])", (text or "").strip())
    if len(sents) <= 1:
        return text
    keep = max(1, (len(sents) + 1) // 2)
    ranked = sorted(range(len(sents)), key=lambda i: (0 if re.search(r"\d", sents[i]) else 1, i))[:keep]
    return " ".join(sents[i] for i in sorted(ranked))


def edit_block(db: Session, user: models.User, doc: models.DocDocument, block_id: str, instruction: str) -> dict:
    """{change, block_id?, inserted?}: one block changed by asking."""
    i, b = _find(doc, block_id)
    ins = (instruction or "").strip()
    il = ins.lower()
    allowed = list((doc.meta or {}).get("allowed") or [])
    if re.search(r"\b(graph|chart|figure|plot|visual)\b", il):
        r = _analysis_of(db, doc)
        if not r:
            raise DocError("There is no table behind this document to draw from; a chart needs an analysis in the conversation.")
        used = {x.get("column") for x in doc.blocks or [] if x.get("type") == "figure"}
        col = best_column(r, plain(b.get("text") or "") + " " + ins, used)
        sig_src = next((c for c in b.get("cites") or []), None)
        fig = figure_for(db, user, r, col, [sig_src] if sig_src else []) if col else None
        if not fig:
            raise DocError("I couldn't find numbers in the data for a chart of this part.")
        fig["pending"] = True
        _snapshot(doc, f"added “{fig['title']}”")
        blocks = list(doc.blocks)
        blocks.insert(i + 1, fig)
        doc.blocks = blocks
        meta = dict(doc.meta or {})
        meta["allowed"] = sorted(set(list(meta.get("allowed") or []) + [x["value"] for x in fig["bars"]] + [x["n"] for x in fig["bars"]]))
        doc.meta = meta
        flag_modified(doc, "meta")
        _save(db, doc)
        return {"change": f"added “{fig['title']}” below", "block_id": fig["id"], "inserted": True}
    if re.search(r"\b(remove|delete|drop)\b", il):
        if b["type"] in ("title", "sources"):
            raise DocError("The title and the sources stay; change the title instead.")
        _snapshot(doc, f"removed a {b['type']}")
        doc.blocks = [x for x in doc.blocks if x.get("id") != block_id]
        _save(db, doc)
        return {"change": f"removed the {b['type']}"}
    if b["type"] not in ("paragraph", "callout", "heading", "title"):
        raise DocError("This part can be removed, or a graph added below it; its words come from the data.")
    old = b.get("text") or ""
    if re.search(r"\b(shorter|shorten|trim|tighten|concise|cut)\b", il):
        new = _model_rewrite(old, "Make it about half as long, keeping the most important numbers.", allowed) or _shorter(plain(old))
        how = "made it shorter"
    else:
        new = _model_rewrite(old, ins or "Make it clearer for a business reader.", allowed)
        if not new:
            raise DocError("I couldn't rewrite that without changing its numbers. Type over it on the page, or ask for it shorter.")
        how = "rewrote it"
    if plain(new).strip() == plain(old).strip():
        raise DocError("That part is already as short as it can be without losing its numbers.")
    _snapshot(doc, how)
    blocks = copy.deepcopy(doc.blocks)
    blocks[i]["text"] = bold_numbers(plain(new)) if b["type"] in ("paragraph",) else plain(new)
    doc.blocks = blocks
    _save(db, doc)
    return {"change": how, "block_id": block_id}


def type_over(db: Session, doc: models.DocDocument, block_id: str, text: str) -> None:
    """The person typed over a block on the page."""
    i, b = _find(doc, block_id)
    if b["type"] not in ("paragraph", "callout", "heading", "title", "byline"):
        raise DocError("Only text can be typed over.")
    t = (text or "").strip()
    if not t:
        raise DocError("Type some words, or remove the part instead.")
    if t == plain(b.get("text") or "").strip():
        return
    _snapshot(doc, "your edit")
    blocks = copy.deepcopy(doc.blocks)
    blocks[i]["text"] = bold_numbers(t) if b["type"] == "paragraph" else t
    if b["type"] == "title":
        doc.title = t[:160]
    doc.blocks = blocks
    _save(db, doc, person=True)


def restyle(db: Session, doc: models.DocDocument, block_id: str, to: str) -> None:
    """R56 (Doc studio toolbar): a paragraph becomes a heading, or a heading a paragraph."""
    i, b = _find(doc, block_id)
    if to not in ("heading", "paragraph"):
        raise DocError("A part can be a heading or a paragraph.")
    if b["type"] not in ("paragraph", "heading"):
        raise DocError("Only a heading or a paragraph changes style.")
    if b["type"] == to:
        return
    _snapshot(doc, f"made it a {to}")
    blocks = copy.deepcopy(doc.blocks)
    text = plain(b.get("text") or "")
    if to == "heading":
        blocks[i] = {"id": b["id"], "type": "heading", "text": text[:160], "level": 2}
    else:
        blocks[i] = {"id": b["id"], "type": "paragraph", "text": bold_numbers(text), "cites": b.get("cites") or []}
    doc.blocks = blocks
    _save(db, doc, person=True)


def insert_text(db: Session, doc: models.DocDocument, after_id: str | None, kind: str, text: str) -> str:
    """R56: a heading or a paragraph the person writes, placed after a block (or before the sources)."""
    t = (text or "").strip()
    if not t:
        raise DocError("Write the words first.")
    if kind not in ("heading", "paragraph"):
        raise DocError("Add a heading or a paragraph.")
    blocks = list(copy.deepcopy(doc.blocks or []))
    if after_id:
        pos = _find(doc, after_id)[0] + 1
    else:
        pos = next((k for k, x in enumerate(blocks) if x.get("type") == "sources"), len(blocks))
    _snapshot(doc, f"added a {kind}")
    bid = _bid()
    blocks.insert(pos, {"id": bid, "type": "heading", "text": t[:160], "level": 2} if kind == "heading"
                  else {"id": bid, "type": "paragraph", "text": bold_numbers(t), "cites": []})
    doc.blocks = blocks
    _save(db, doc, person=True)
    return bid


def accept(db: Session, doc: models.DocDocument, block_id: str) -> None:
    i, b = _find(doc, block_id)
    if b.get("pending"):
        blocks = copy.deepcopy(doc.blocks)
        blocks[i].pop("pending", None)
        doc.blocks = blocks
        _save(db, doc)


def shorten_all(db: Session, doc: models.DocDocument) -> str:
    """'make it shorter' on the whole document: the summary, the limitation, the first figure, the recommendations,
    the next steps - every paragraph trimmed to its sentences with numbers."""
    _snapshot(doc, "made it shorter")
    out, seen_fig, skip = [], False, False
    for b in doc.blocks:
        t = b["type"]
        if t == "heading":
            skip = bool(re.match(r"^(who is (likely|most)|by )", b.get("text") or "", re.I))
            if skip:
                continue
        if skip and t != "heading":
            continue
        if t == "figure":
            if seen_fig:
                continue
            seen_fig = True
        if t == "paragraph":
            b = dict(b, text=bold_numbers(_shorter(plain(b.get("text") or ""))))
        if t == "table" and len(b.get("rows") or []) > 3:
            b = dict(b, rows=(b.get("rows") or [])[:3])
        out.append(b)
    if len(out) == len(doc.blocks) and all(json.dumps(a, sort_keys=True) == json.dumps(c, sort_keys=True) for a, c in zip(out, doc.blocks)):
        hist = list(doc.history or [])
        hist.pop()
        doc.history = hist
        raise DocError("The document is already as short as it can be without dropping its findings.")
    doc.blocks = out
    meta = dict(doc.meta or {})
    meta["short"] = True
    doc.meta = meta
    flag_modified(doc, "meta")
    _save(db, doc)
    return "made it shorter"


def rename(db: Session, doc: models.DocDocument, title: str) -> None:
    t = (title or "").strip()[:160]
    if not t:
        raise DocError("Give the document a name.")
    _snapshot(doc, "renamed it")
    blocks = copy.deepcopy(doc.blocks)
    for b in blocks:
        if b["type"] == "title":
            b["text"] = t
            break
    doc.blocks, doc.title = blocks, t
    _save(db, doc)


def _analysis_of(db: Session, doc: models.DocDocument) -> dict | None:
    from . import turns as T
    tid = (doc.meta or {}).get("analysis_turn")
    m = db.get(models.Message, tid) if tid else None
    return (T._state(m).get("analysis") if m is not None else None)


def summary(doc: models.DocDocument, user: models.User | None = None) -> dict:
    blocks = doc.blocks or []
    ck = check(doc)
    words = sum(len(plain(b.get("text") or "").split()) for b in blocks) + sum(
        len(" ".join(str(v) for v in row.values()).split()) for b in blocks if b["type"] == "table" for row in b.get("rows") or []) + sum(
        len(plain(str(x)).split()) for b in blocks if b["type"] == "list" for x in b.get("items") or [])
    return {"id": doc.id, "title": doc.title, "blocks": blocks, "sources": doc.sources or [], "conversation_id": doc.conversation_id,
            "message_id": doc.message_id, "created_at": doc.created_at, "updated_at": doc.updated_at, "edited_by_person": bool(doc.edited_by_person),
            "figures": sum(1 for b in blocks if b["type"] == "figure"), "tables": sum(1 for b in blocks if b["type"] == "table"),
            "words": words, "pages": max(1, round(words / 450 + 0.35 * sum(1 for b in blocks if b["type"] == "figure"))),
            "checked": ck["checked"], "flagged": ck["flagged"], "can_undo": bool(doc.history),
            # R57: a report written section by section - its length, the sections and where the writing is
            "report": {k: v for k, v in ((doc.meta or {}).get("report") or {}).items() if k in ("length", "status", "sections", "added", "flagged")} or None,
            "history": [{"label": h.get("label"), "at": h.get("at")} for h in (doc.history or [])][-8:]}


DOC_EDIT = re.compile(
    r"\b(make|keep)\s+(it|the (brief|doc|document|report|memo|summary))\s+(shorter|tighter|more concise|one page)\b"
    r"|\b(shorten|trim|tighten)\s+(it|the (brief|doc|document|report|memo|summary))\b"
    r"|\b(rename|call|title)\s+(it|the (brief|doc|document|report|memo|summary))\b"
    r"|^\s*undo\b", re.I)


def wants_edit(text: str) -> bool:
    return bool(DOC_EDIT.search(text or ""))

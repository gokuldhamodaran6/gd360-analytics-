"""2026-10-15 (R48): the Analysis writer - prose from typed findings, never the other way round.

The runner (analysis.py) computes; this module writes the headline, the summary, the limitation and the
section intros. The model is asked for them with the findings in front of it; every number it writes is
checked against the findings (project_engine.numbers) and any field that fails falls back to the template
sentence built from the same findings. Without a model the template prose stands on its own, so an
analysis never waits on a model to be readable.
"""
from __future__ import annotations

import json
import re

from ...config import get_settings
from .. import ai_engine
from ..project_engine import numbers
from . import analysis

settings = get_settings()

_SYSTEM = (
    "GD360 ANALYSIS WRITER. You write the prose of a data analysis for a business reader, from FINDINGS computed by code. "
    "Rules: every number you write must appear in FINDINGS exactly (same rounding); never invent, derive or round a number; "
    "lead with the finding, not the method; plain sentences, no markdown, no bullet lists, no headings; name groups the way "
    "FINDINGS names them; say 'historical' or 'associated with' - these are signals, not proven causes. "
    'Reply with JSON only: {"headline": "<one sentence, the main finding with its comparison>", '
    '"summary": ["<2-3 sentences: what the data holds and the main finding>", "<2-3 sentences: the model, how it was tested, who is at risk>"], '
    '"limitation": "<1-2 sentences on what the numbers are not>", "signals_note": "<1 sentence introducing the signal table>", '
    '"tiers_note": "<1 sentence introducing the risk tiers>"}'
)


def _cap(s: str) -> str:
    return s[:1].upper() + s[1:] if s else s


def _low_high(sig: dict) -> str:
    if sig.get("kind") == "numeric":
        return ("Low " if sig.get("direction") == "low" else "High ") + sig["label"]
    return sig["group"]


def template(r: dict) -> dict:
    """The deterministic prose for every field."""
    t, b, m = r["target"], r["baseline"], r.get("model")
    ent, verb, noun = r["table"]["entities"], t["verb"], t["noun"]
    sig = (r.get("signals") or [None])[0]
    tiers = r.get("tiers") or []
    out: dict = {}
    if r["recipe"] == "segment" and r.get("by_dimension") and r["by_dimension"]["values"]:
        vals = r["by_dimension"]["values"]
        by_rate = max(vals, key=lambda v: v["rate"])
        by_count = max(vals, key=lambda v: v["positives"])
        lab = r["by_dimension"]["label"]
        if by_rate["value"] == by_count["value"]:
            out["headline"] = f"{by_rate['value']} loses the most {ent}: {by_count['positives']:,} {verb} ({by_rate['rate']}% of its {by_rate['n']:,})."
        else:
            out["headline"] = (f"{by_count['value']} loses the most {ent} in number ({by_count['positives']:,} {verb}); "
                               f"{by_rate['value']} loses the most relative to its size ({by_rate['rate']}% of {by_rate['n']:,}).")
        out["summary"] = [
            f"Of the {b['n']:,} {ent} in {r['table']['table']}, {b['positives']:,} {verb}, a {b['rate']}% {noun} rate. Split by {lab}, the rate runs from "
            f"{min(v['rate'] for v in vals)}% to {max(v['rate'] for v in vals)}% across {len(vals)} groups.",
            (f"{by_rate['value']} sits {abs(by_rate['vs_all_pp'])} points {'above' if by_rate['vs_all_pp'] >= 0 else 'below'} the overall rate; "
             f"{min(vals, key=lambda v: v['rate'])['value']} is the lowest at {min(vals, key=lambda v: v['rate'])['rate']}%."),
        ]
        out["limitation"] = (f"Groups of under {analysis.MIN_GROUP} {ent} are not shown; a high rate on a small group is a weak signal. "
                             + ("The data has no dates, so this is a snapshot, not a trend." if not r.get("has_dates") else ""))
        out["signals_note"] = f"The strongest signals across all {ent}, for context:"
        out["tiers_note"] = ""
        return out
    if r["recipe"] == "signal" and r.get("focus"):
        f = r["focus"]
        rank = f.get("rank")
        strong = f.get("diff_pp", 0) >= 5
        out["headline"] = (f"{_cap(f['label'])} {'does separate' if strong else 'only weakly separates'} {noun}: {f['group_rate']}% of {ent} with {f['group']} {verb}, "
                           f"against {f['compare_rate']}% with {f['compare']}.") if f.get("kind") != "flat" else \
            f"{_cap(f['label'])} does not separate {noun}: the rate barely moves across its values."
        out["summary"] = [
            f"Of the {b['n']:,} {ent}, {b['positives']:,} {verb}, a {b['rate']}% {noun} rate. "
            + (f"The {f['group_n']:,} {ent} with {f['group']} {verb} at {f['group_rate']}%, the {f['compare_n']:,} with {f['compare']} at {f['compare_rate']}%." if f.get("kind") != "flat" else ""),
            (f"In a model built from every usable column, {f['label']} ranks {rank + 1} of {m['features']} signals" + (f" (held-out average precision {m['ap']} for the whole model)." if m else ".")
             if rank is not None and m else (f"The strongest signal overall is {sig['group']} ({sig['group_rate']}% against {sig['compare_rate']}%)." if sig else "")),
        ]
        out["limitation"] = f"A signal is an association in past data, not a cause. " + ("The data has no dates, so it cannot say what changed first." if not r.get("has_dates") else "")
        out["signals_note"] = f"How {f['label']} compares with the other signals:"
        out["tiers_note"] = f"Every current {ent[:-1] if ent.endswith('s') else ent} scored by a model that never saw it during training:" if tiers else ""
        return out
    # outcome
    if sig:
        out["headline"] = f"{_low_high(sig)} is the clearest {noun} signal: {sig['group_rate']}% of {ent} with {sig['group']} {verb}, against {sig['compare_rate']}% with {sig['compare']}."
    else:
        out["headline"] = f"No single column separates {noun} clearly; the overall rate is {b['rate']}%."
    p1 = f"The table holds {b['n']:,} {ent}, of whom {b['positives']:,} {verb}, a {b['rate']}% {noun} rate."
    if sig:
        p1 += f" {_cap(ent)} with {sig['group']} {verb} at {sig['group_rate']}%, against {sig['compare_rate']}% for those with {sig['compare']}."
    p2 = ""
    if m:
        p2 = (f"A model built on these signals holds up on {m['test_n']:,} {ent} it never saw (average precision {m['ap']}, against {m['baseline_ap']} for a random pick)")
        if tiers:
            p2 += f" and puts {tiers[0]['count']:,} current {ent} at high risk and {tiers[1]['count']:,} at medium risk."
        else:
            p2 += "."
    out["summary"] = [p1, p2] if p2 else [p1]
    out["limitation"] = ("These are historical risk signals, not proven reasons. "
                         + ("The data has no dates, so the scores say who resembles past cases, not when anyone will leave."
                            if not r.get("has_dates") else "Timing depends on the dates in the data; the scores rank likelihood, not timing."))
    imp = r.get("importance") or []
    out["signals_note"] = (f"{_cap(imp[0]['label'])} and {imp[1]['label']} were the strongest predictors in the model." if len(imp) >= 2
                           else f"The signals most associated with {noun}, each against its comparison group:")
    out["tiers_note"] = (f"Every current {ent[:-1] if ent.endswith('s') else ent} was scored by a model that never saw it during training; the tiers are cut where past {noun} concentrated."
                         if tiers else "")
    return out


def _findings_text(r: dict) -> str:
    lines = [f"table: {r['table']['table']} ({r['table']['source']}) · {r['baseline']['n']:,} {r['table']['entities']} · {r['baseline']['positives']:,} {r['target']['verb']} · {r['target']['noun']} rate {r['baseline']['rate']}%",
             f"outcome column: {r['target']['column']} = {r['target']['positive']} · dates in the data: {'yes' if r.get('has_dates') else 'no'}"]
    for s in r.get("signals") or []:
        lines.append(f"signal: {s['group']} → {s['group_rate']}% ({s['group_n']:,} rows) vs {s['compare']} → {s['compare_rate']}% ({s['compare_n']:,} rows)"
                     + (f" · model importance {s.get('importance')}" if s.get("importance") is not None else ""))
    if r.get("model"):
        m = r["model"]
        lines.append(f"model: {m['algorithm']} · tested on {m['test_n']:,} untouched rows · average precision {m['ap']} (random {m['baseline_ap']}) · AUC {m['auc']}")
    for t in r.get("tiers") or []:
        lines.append(f"tier: {t['label']} · {t['count']:,} current rows · {t['rule']} · historically {t['hist_rate']}% of this band {r['target']['verb']}")
    if r.get("by_dimension"):
        for v in r["by_dimension"]["values"]:
            lines.append(f"by {r['by_dimension']['label']}: {v['value']} → {v['rate']}% ({v['positives']:,} of {v['n']:,})")
    if r.get("focus"):
        f = r["focus"]
        lines.append(f"focus: {f['group']} → {f['group_rate']}% vs {f['compare']} → {f['compare_rate']}%" + (f" · rank {f['rank'] + 1}" if f.get("rank") is not None else ""))
    return "\n".join(lines)


def write(r: dict) -> dict:
    """{headline, summary[], limitation, signals_note, tiers_note, written_by, replaced[]}"""
    base = template(r)
    allowed = analysis.allowed_numbers(r)
    out = dict(base) | {"written_by": "template", "replaced": []}
    try:
        model = settings.GEMINI_MODEL if settings.AI_PROVIDER == "gemini" else None
        raw = ai_engine._call_llm_resilient(
            [{"role": "system", "content": _SYSTEM},
             {"role": "user", "content": f"Question: {r.get('question')}\nRecipe: {r['recipe']}\n\nFINDINGS:\n{_findings_text(r)}"}],
            max_tokens=900, model_override=model)
        m = re.search(r"\{.*\}", raw or "", re.S)
        data = json.loads(m.group(0)) if m else {}
    except Exception as e:  # noqa: BLE001 - the template is the answer
        print(f"[agent.writer] model prose skipped: {e}")
        return out
    if not isinstance(data, dict):
        return out
    used_model = False
    for key in ("headline", "limitation", "signals_note", "tiers_note"):
        v = data.get(key)
        if isinstance(v, str) and v.strip():
            bad = numbers.unsupported_numbers(v, allowed, None)
            if bad:
                out["replaced"].append({"field": key, "numbers": bad})
            else:
                out[key] = v.strip()
                used_model = True
    s = data.get("summary")
    if isinstance(s, list) and s and all(isinstance(x, str) for x in s):
        bad = [b for x in s for b in numbers.unsupported_numbers(x, allowed, None)]
        if bad:
            out["replaced"].append({"field": "summary", "numbers": bad})
        else:
            out["summary"] = [x.strip() for x in s if x.strip()][:3]
            used_model = True
    out["written_by"] = "model" if used_model else "template"
    return out


def title(r: dict) -> str:
    noun, ent = r["target"]["noun"], r["table"]["entities"]
    if r["recipe"] == "segment" and r.get("by_dimension"):
        return f"{_cap(noun)} by {r['by_dimension']['label']}"
    if r["recipe"] == "signal" and r.get("focus"):
        return f"{_cap(r['focus']['label'])} and {noun}"
    return f"Why {ent} {r['target']['verb'] if noun != 'churn' else 'churn'}, who leaves next, and what to do" if noun == "churn" else f"{_cap(noun)}: signals, risk and what to do"


def chat_text(r: dict, prose: dict) -> str:
    ent, m, tiers = r["table"]["entities"], r.get("model"), r.get("tiers")
    n = r["baseline"]["n"]
    read = f"I read all {n:,} {ent}" if not r["table"]["sampled"] else f"I read a fair sample of {n:,} {ent}"
    if r["recipe"] == "segment":
        return f"{prose['headline']} {read} and split them by {r['by_dimension']['label'] if r.get('by_dimension') else 'the group'}. The breakdown is on the right."
    if r["recipe"] == "signal":
        return f"{prose['headline']} {read} and ranked it against every other signal. The detail is on the right."
    parts = [read, f"compared {r.get('signals_total', len(r.get('signals') or []))} signals"]
    if m:
        parts.append("trained a model on held-out rows")
    if tiers:
        parts.append(f"scored every current {ent[:-1] if ent.endswith('s') else ent}")
    return f"{prose['headline']} {', '.join(parts[:-1])} and {parts[-1]}. The full analysis is on the right."


def markdown(r: dict, prose: dict, ttl: str) -> str:
    """The analysis as a document (download, 'save as document')."""
    ent, verb = r["table"]["entities"], r["target"]["verb"]
    lines = [f"# {ttl}", "", "## Executive summary", ""] + [p for p in prose["summary"]] + ["", f"**Important limitation.** {prose['limitation']}", ""]
    if r.get("signals"):
        lines += ["## The signals most associated with the outcome", "", prose.get("signals_note") or "", "", "| Signal group | Rate in this group | Comparison group |", "|---|---:|---|"]
        for s in r["signals"]:
            lines.append(f"| {s['group']} | {s['group_rate']}% | {s['compare_rate']}% with {s['compare']} |")
        lines += ["", "These groups overlap; their effects should not be added together.", ""]
    if r.get("by_dimension"):
        d = r["by_dimension"]
        lines += [f"## By {d['label']}", "", f"| {d['label']} | {ent} | {verb} | rate | vs all |", "|---|---:|---:|---:|---:|"]
        for v in d["values"]:
            lines.append(f"| {v['value']} | {v['n']:,} | {v['positives']:,} | {v['rate']}% | {v['vs_all_pp']:+} pp |")
        lines.append("")
    if r.get("tiers"):
        lines += ["## Who is likely to leave next", "", prose.get("tiers_note") or "", ""]
        for t in r["tiers"]:
            lines.append(f"- **{t['label']}** · {t['count']:,} current {ent} · {t['rule']} · {t['hist_rate']}% of this band {verb} historically · {t['action']}")
        lines.append("")
    if r.get("recommendations"):
        lines += ["## What to do", ""]
        for x in r["recommendations"]:
            lines += [f"**{x['n']}. {x['title']}** · {x['reach']:,} {ent}", "", x["body"], "", f"_{x['reach_note']}_", ""]
    lines += ["## How this was worked out", ""] + [f"- {f}" for f in r["method"]["formulas"] if f] + [""]
    return "\n".join(lines)

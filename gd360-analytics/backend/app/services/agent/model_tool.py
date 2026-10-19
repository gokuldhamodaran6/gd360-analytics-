"""2026-10-14 (R47): the Model tool - "predict which customers will churn", "train a model
for next month's demand" - the ML Studio engine (services/ml_studio.py) run from the
conversation. No studio page to learn: the sentence becomes the spec, the plan is
checked on the real data, training runs in the queue, and the conversation reports
the held-out score, the baseline it beat, the drivers and any leaking columns removed.
"""
from __future__ import annotations

import re

from sqlalchemy.orm import Session

from ... import models
from .. import ml_studio as svc

PREDICT = re.compile(
    r"\b(predict|prediction|propensity|likelihood|likely to (churn|leave|buy|convert|cancel|default|pay)|"
    r"which (customers|users|accounts|orders|leads|patients|employees|students) (will|are likely|might|would)|"
    r"train (a |an )?(model|classifier|predictor)|build (a |an )?(model|classifier|predictor)|"
    r"(churn|fraud|default|conversion|attrition) (model|risk score|scoring)|score (the |my |our )?(customers|accounts|leads|table)|"
    r"machine learning|classif(y|ier)|anomal(y|ies) detection|cluster (the |my |our )?(customers|users|accounts)|segment (the |my |our )?(customers|users))\b", re.I)


def wants_model(text: str) -> bool:
    t = text or ""
    if re.search(r"\bforecast\b|\bnext (month|quarter|year|week)\b", t, re.I) and not re.search(r"\b(model|predict|train)\b", t, re.I):
        return False  # a forecast of a series is the project engine's job
    return bool(PREDICT.search(t))


def start(db: Session, user: models.User, text: str, conv: models.Conversation) -> dict:
    """{ok, model_id, name, spec, plan, issue}."""
    source_id = (conv.source_ids or [None])[0]
    try:
        spec = svc.understand(db, user, text, None, source_id, None, conv.space_id, None)
        plan = svc.make_plan(db, user, dict(spec))
    except svc.StudioError as e:
        return {"ok": False, "issue": str(e)}
    if plan.get("needs_prep"):
        return {"ok": False, "issue": (plan["needs_prep"].get("text") if isinstance(plan.get("needs_prep"), dict) else str(plan["needs_prep"]))
                + " Open the model page to add the data step, or say which table and target to use.", "spec": spec, "plan": plan}
    name = (spec.get("goal") or text).strip()[:80]
    try:
        m = svc.start(db, user, spec, name, text)
    except svc.StudioError as e:
        return {"ok": False, "issue": str(e), "spec": spec, "plan": plan}
    return {"ok": True, "model_id": m.id, "name": m.name, "spec": {k: spec.get(k) for k in ("problem_type", "table", "target", "time_column", "positive_value")},
            "plan": {k: plan.get(k) for k in ("rows_text", "engine", "problem_type") if plan.get(k) is not None}}


def _fmt(v) -> str:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    return f"{f:.3f}" if abs(f) < 10 else f"{f:,.1f}"


def status(db: Session, user: models.User, model_id: str) -> dict:
    """{status, text, chips, summary, artifact} from the model row as the page would read it."""
    from ...routers.ml_studio import _out
    m = db.get(models.MLModel, model_id)
    if m is None:
        return {"status": "failed", "text": "The model is gone.", "chips": []}
    out = _out(db, m, user, full=True)
    st = out.get("status")
    prog = out.get("progress") or {}
    if st == "training":
        msg = prog.get("message") or "Training"
        done, total = prog.get("trials_done"), prog.get("trials_total")
        return {"status": "working", "text": f"{msg}{f' · trial {done} of {total}' if done is not None and total else ''}", "chips": [],
                "trail": [{"label": str(s.get("label") or s.get("name") or s), "status": s.get("status") if isinstance(s, dict) else None}
                          for s in (prog.get("stages") or [])[:8] if s]}
    if st == "failed":
        return {"status": "failed", "text": out.get("error") or "Training failed.", "chips": []}
    r = out.get("results") or {}
    label = r.get("label") or out.get("problem_type") or "model"
    if isinstance(label, dict):  # R55: the label can be the target description, never print the raw dict
        kind = str(label.get("kind") or out.get("problem_type") or "")
        label = {"binary": "a yes/no model", "multiclass": "a category model", "regression": "a number model"}.get(kind, "the model")
    label = str(label)
    metric = r.get("metric") or (out.get("metrics") or {}).get("metric") or "score"
    test = r.get("test_score")
    base = r.get("baseline") or {}
    drivers = [d.get("feature") or d.get("name") or str(d) for d in (r.get("drivers") or [])[:5] if d]
    leaks = r.get("leaks") or []
    leak_names = [str(l.get("column") if isinstance(l, dict) else l) for l in leaks]
    leak_names = [n if len(n) <= 40 else n[:37] + "…" for n in leak_names]
    parts = [f"The model is ready: {label} on “{out.get('target')}” from {out.get('table') or 'your data'}."]
    if test is not None:
        parts.append(f"On {int(r.get('test_rows') or 0):,} rows it never saw, {metric} is {_fmt(test)}"
                     + (f", against {_fmt(base.get('score'))} for the {base.get('name') or 'baseline'}" if base.get("score") is not None else "") + ".")
    if drivers:
        parts.append("What drives it most: " + ", ".join(drivers) + ".")
    if leak_names:
        parts.append(f"I removed {len(leak_names)} column{'s' if len(leak_names) != 1 else ''} that would have leaked the answer ({', '.join(leak_names[:4])}).")
    parts.append("Say “score the table” to add a prediction to every row, or ask who is most at risk.")
    chips = []
    if test is not None:
        chips.append({"key": "validation", "ok": True, "label": f"Validated on {int(r.get('test_rows') or 0):,} held-out rows", "detail": f"{metric} {_fmt(test)}"})
    if base.get("score") is not None:
        chips.append({"key": "baseline", "ok": bool(r.get("beats_baseline", True)), "label": "Beats the baseline" if r.get("beats_baseline", True) else "Does not beat the baseline",
                      "detail": f"{base.get('name')}: {_fmt(base.get('score'))}"})
    chips.append({"key": "leaks", "ok": True, "label": f"{len(leak_names)} leaking column{'s' if len(leak_names) != 1 else ''} removed" if leak_names else "No leaking columns found",
                  "detail": ", ".join(leak_names[:6]) or None})
    return {"status": "done", "text": " ".join(parts), "chips": chips,
            "summary": {"label": label, "metric": metric, "test_score": test, "baseline": base, "drivers": drivers, "leaks": leak_names,
                        "rows": out.get("rows"), "target": out.get("target"), "table": out.get("table")},
            "artifact": {"type": "model", "id": m.id, "name": out.get("name") or name_of(m), "url": f"/ml-studio/{m.id}",
                         "score": f"{metric} {_fmt(test)}" if test is not None else None}}


def name_of(m: models.MLModel) -> str:
    return m.name or "Model"

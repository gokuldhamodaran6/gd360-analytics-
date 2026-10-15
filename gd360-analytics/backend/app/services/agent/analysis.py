"""2026-10-15 (R48): the Analysis runner - "why are customers leaving, who will leave next, what do we do".

Deterministic recipes in pandas / scikit-learn over the person's table, run in-process with a time budget.
The model never computes a number here: it only chooses the recipe (intents.py) and, later, writes prose
from the typed findings this module returns (writer.py), every number of which is checked back against
them. Recipes:

- outcome   a yes/no outcome column (churn, attrition, cancelled, converted ...): baseline rate, the
            signals most associated with it (each group vs its comparison group), a gradient-boosting
            model scored on an untouched test set, out-of-fold scores for every row -> risk tiers, the
            rows to act on first, and recommendations built from the signals.
- segment   the same outcome by one categorical dimension ("which card category loses the most").
- signal    one column against the outcome ("does inactivity predict attrition").

The result is plain JSON (dicts, lists, floats) so it can live in a Message's chart_spec and be rendered
by frontend/src/chat/AnalysisView.tsx.
"""
from __future__ import annotations

import math
import re
import time

import numpy as np
import pandas as pd
from sqlalchemy.orm import Session

from ... import models
from .. import ml_studio

MAX_ROWS = 150_000
BUDGET_S = 110
MIN_GROUP = 30

POSITIVE_WORDS = ("attrit", "churn", "left", "cancel", "exited", "exit", "lost", "closed", "yes", "true", "1", "fraud", "late",
                  "default", "converted", "won", "returned", "inactive", "lapsed")
OUTCOME_NAMES = re.compile(r"churn|attrit|exit|cancel|lost|left|retain|status|flag|outcome|default|fraud|convert|renew|active|lapse|closed", re.I)
ID_NAMES = re.compile(r"(^|_)(id|num|number|key|code|no)$|clientnum|customer_?id|client_?id|account", re.I)
DATE_NAMES = re.compile(r"date|time|_at$|month$|year$|day$|period", re.I)

_ABBR = {"ct": "count", "cnt": "count", "amt": "amount", "trans": "transaction", "chng": "change", "bal": "balance", "avg": "average",
         "mon": "months", "num": "number", "pct": "percent", "rel": "relationship", "util": "utilization", "qty": "quantity",
         "tot": "total", "mths": "months", "yrs": "years", "acct": "account", "cust": "customer", "txn": "transaction", "freq": "frequency"}


class AnalysisError(Exception):
    pass


# ---- words ------------------------------------------------------------------------

def label_of(col: str) -> str:
    """Total_Trans_Ct -> "total transaction count"; Months_Inactive_12_mon -> "months inactive 12 months"."""
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", str(col)).replace("_", " ").replace("-", " ")
    words = []
    for w in s.split():
        lw = w.lower()
        words.append(_ABBR.get(lw, lw) if not re.fullmatch(r"q\d", lw) else lw.upper())
    out = " ".join(words)
    out = re.sub(r"\bQ4 Q1\b", "Q4 ÷ Q1", out)
    out = re.sub(r"\b12 months\b", "in 12 months", out)
    return out.strip() or str(col)


_STOP = {"total", "count", "number", "flag", "category", "level", "status", "type", "months", "average", "ratio", "data", "customer", "customers"}


def word_score(question: str, col: str) -> int:
    """How many words of the column's label the question uses (stems of 5 letters: inactivity ~ inactive)."""
    qw = {w[:5] for w in re.findall(r"[a-z]{4,}", (question or "").lower())}
    score = 0
    for w in re.findall(r"[a-z]{3,}", label_of(col).lower()):
        if w in _STOP:
            continue
        if w[:5] in qw:
            score += 1
    return score


def _fmt_num(v: float, integer: bool) -> str:
    if integer or float(v).is_integer():
        return f"{int(round(v)):,}"
    if abs(v) >= 100:
        return f"{v:,.0f}"
    if abs(v) >= 10:
        return f"{v:,.1f}"
    return f"{v:,.2f}"


def _pct(v: float) -> float:
    return round(float(v) * 100, 1)


def _entities(columns: list[str], table: str) -> str:
    """What one row is: the table name decides, else the word most columns mention."""
    words = (("booking", "bookings"), ("order", "orders"), ("customer", "customers"), ("client", "customers"), ("employee", "employees"),
             ("user", "users"), ("patient", "patients"), ("student", "students"), ("subscriber", "subscribers"), ("account", "accounts"),
             ("member", "members"), ("guest", "guests"), ("lead", "leads"), ("ticket", "tickets"), ("loan", "loans"), ("policy", "policies"))
    t = (table or "").lower()
    for word, plural in words:
        if word in t:
            return plural
    cols = " ".join(columns).lower()
    best = max(words, key=lambda w: cols.count(w[0]))
    return best[1] if cols.count(best[0]) else "records"


def _outcome_words(target: str, positive: str) -> tuple[str, str]:
    """(verb in past tense, noun): "churned", "churn"."""
    t = f"{target} {positive}".lower()
    if re.search(r"churn|attrit|lapse", t):
        return "churned", "churn"
    if re.search(r"cancel", t):
        return "cancelled", "cancellation"
    if re.search(r"exit|left|leave|closed", t):
        return "left", "leaving"
    if re.search(r"fraud", t):
        return "were fraudulent", "fraud"
    if re.search(r"convert", t):
        return "converted", "conversion"
    if re.search(r"default", t):
        return "defaulted", "default"
    if re.search(r"renew", t):
        return "renewed", "renewal"
    return f"were “{positive}”", f"“{positive}”"


# ---- choosing the table, the outcome and the columns ------------------------------------

def pick_table(db: Session, user: models.User, source_ids: list[str], question: str, wanted: str | None = None) -> dict:
    tables = ml_studio.source_tables(db, user, source_ids or None)
    if not tables:
        raise AnalysisError("Connect a table first; there is nothing to analyse yet.")
    if wanted:
        for t in tables:
            if t["table"] == wanted or t.get("key") == wanted:
                return t
    q = (question or "").lower()

    def score(t: dict) -> float:
        cols = [c["name"] for c in t["columns"]]
        s = sum(1 for c in cols if OUTCOME_NAMES.search(c)) * 3
        s += sum(1 for w in re.findall(r"[a-z]{4,}", q) if w in (t["table"] or "").lower() or any(w in c.lower() for c in cols))
        s += min(len(cols), 40) / 40
        return s
    return max(tables, key=score)


def _binary_candidates(df: pd.DataFrame) -> list[tuple[str, float]]:
    out = []
    for c in df.columns:
        s = df[c].dropna()
        if len(s) < MIN_GROUP * 2:
            continue
        vals = s.astype(str).value_counts()
        if len(vals) != 2:
            continue
        rate = float(vals.min() / vals.sum())
        if rate < 0.005:
            continue
        name_hit = 2.0 if OUTCOME_NAMES.search(c) else 0.0
        out.append((c, name_hit + min(rate, 0.5)))
    out.sort(key=lambda x: -x[1])
    return out


def pick_target(df: pd.DataFrame, wanted: str | None, question: str) -> tuple[str, str]:
    """(column, positive value)."""
    if wanted and wanted in df.columns:
        col = wanted
    else:
        cands = _binary_candidates(df)
        if not cands:
            raise AnalysisError("I couldn't find a yes/no outcome column (like churned / attrited / cancelled) in this table. "
                                "Tell me which column marks the outcome and I'll run it.")
        named = sorted(((word_score(question, c), i) for i, (c, _) in enumerate(cands)), key=lambda x: (-x[0], x[1]))
        col = cands[named[0][1]][0] if named and named[0][0] > 0 else cands[0][0]
    vals = list(df[col].dropna().astype(str).value_counts().index)
    if len(vals) != 2:
        raise AnalysisError(f"{col} has {len(vals)} different values; an outcome column needs exactly two.")
    low = [v.lower() for v in vals]
    pos = None
    for w in POSITIVE_WORDS:
        for i, v in enumerate(low):
            if w in v:
                pos = vals[i]
                break
        if pos:
            break
    if pos is None:
        counts = df[col].astype(str).value_counts()
        pos = str(counts.index[-1])  # the rarer value is the event
    return col, pos


def _id_column(df: pd.DataFrame) -> str | None:
    n = len(df)
    best = None
    for c in df.columns:
        s = df[c]
        if s.nunique(dropna=True) >= 0.98 * n and n > 50:
            if ID_NAMES.search(str(c)):
                return c
            best = best or c
    return best


def _has_dates(df: pd.DataFrame) -> bool:
    for c in df.columns:
        s = df[c]
        if pd.api.types.is_datetime64_any_dtype(s):
            return True
        if DATE_NAMES.search(str(c)) and s.dtype == object:
            try:
                parsed = pd.to_datetime(s.dropna().astype(str).head(200), errors="coerce")
                if parsed.notna().mean() > 0.8:
                    return True
            except Exception:  # noqa: BLE001
                continue
    return False


# ---- the signals ----------------------------------------------------------------------

def _numeric_signal(df: pd.DataFrame, col: str, y: pd.Series, base_rate: float, verb: str) -> dict | None:
    x = pd.to_numeric(df[col], errors="coerce")
    ok = x.notna() & y.notna()
    if ok.sum() < MIN_GROUP * 3 or x[ok].nunique() < 3:
        return None
    xs, ys = x[ok], y[ok].astype(int)
    q1, q2 = float(xs.quantile(1 / 3)), float(xs.quantile(2 / 3))
    if q1 == q2:
        # a column with a few values: compare the lowest value with the rest
        low_mask = xs <= q1
        high_mask = xs > q1
    else:
        low_mask, high_mask = xs < q1, xs >= q2
    if low_mask.sum() < MIN_GROUP or high_mask.sum() < MIN_GROUP:
        return None
    r_low, r_high = float(ys[low_mask].mean()), float(ys[high_mask].mean())
    integer = bool((xs.dropna() % 1 == 0).all())
    lab = label_of(col)
    if r_low >= r_high:
        group = f"{lab} under {_fmt_num(q1, integer)}" if q1 != q2 else f"{lab} of {_fmt_num(q1, integer)} or less"
        compare = f"{lab} of {_fmt_num(q2, integer)} or more" if q1 != q2 else f"{lab} above {_fmt_num(q1, integer)}"
        g_n, g_r, c_n, c_r, direction = int(low_mask.sum()), r_low, int(high_mask.sum()), r_high, "low"
        mask_group = x < q1 if q1 != q2 else x <= q1
    else:
        group = f"{lab} of {_fmt_num(q2, integer)} or more" if q1 != q2 else f"{lab} above {_fmt_num(q1, integer)}"
        compare = f"{lab} under {_fmt_num(q1, integer)}" if q1 != q2 else f"{lab} of {_fmt_num(q1, integer)} or less"
        g_n, g_r, c_n, c_r, direction = int(high_mask.sum()), r_high, int(low_mask.sum()), r_low, "high"
        mask_group = x >= q2 if q1 != q2 else x > q1
    diff = abs(g_r - c_r)
    if diff < 0.02:
        return None
    return {"column": col, "label": lab, "kind": "numeric", "direction": direction,
            "group": group, "group_n": g_n, "group_rate": _pct(g_r), "compare": compare, "compare_n": c_n, "compare_rate": _pct(c_r),
            "lift": round(g_r / c_r, 1) if c_r > 0 else None, "diff_pp": round(diff * 100, 1), "threshold": [q1, q2],
            "_mask": mask_group.fillna(False)}


def _categorical_signal(df: pd.DataFrame, col: str, y: pd.Series, base_rate: float, verb: str) -> dict | None:
    s = df[col].astype(str).where(df[col].notna())
    ok = s.notna() & y.notna()
    if ok.sum() < MIN_GROUP * 2:
        return None
    grp = y[ok].astype(int).groupby(s[ok])
    stats = pd.DataFrame({"n": grp.size(), "rate": grp.mean()})
    stats = stats[stats["n"] >= MIN_GROUP]
    if len(stats) < 2:
        return None
    hi, lo = stats["rate"].idxmax(), stats["rate"].idxmin()
    diff = float(stats.loc[hi, "rate"] - stats.loc[lo, "rate"])
    if diff < 0.02:
        return None
    lab = label_of(col)
    return {"column": col, "label": lab, "kind": "categorical", "direction": "category",
            "value": str(hi), "compare_value": str(lo),
            "group": f"{lab} = {hi}", "group_n": int(stats.loc[hi, "n"]), "group_rate": _pct(stats.loc[hi, "rate"]),
            "compare": f"{lab} = {lo}", "compare_n": int(stats.loc[lo, "n"]), "compare_rate": _pct(stats.loc[lo, "rate"]),
            "lift": round(float(stats.loc[hi, "rate"] / stats.loc[lo, "rate"]), 1) if stats.loc[lo, "rate"] > 0 else None,
            "diff_pp": round(diff * 100, 1), "values": [{"value": str(k), "n": int(r.n), "rate": _pct(r.rate)} for k, r in stats.sort_values("n", ascending=False).head(12).iterrows()],
            "_mask": (s == hi).fillna(False)}


def _by_dimension(df: pd.DataFrame, col: str, y: pd.Series, base_rate: float) -> list[dict]:
    s = df[col].astype(str).where(df[col].notna())
    ok = s.notna() & y.notna()
    grp = y[ok].astype(int).groupby(s[ok])
    stats = pd.DataFrame({"n": grp.size(), "positives": grp.sum(), "rate": grp.mean()}).sort_values("n", ascending=False).head(14)
    return [{"value": str(k), "n": int(r.n), "positives": int(r.positives), "rate": _pct(r.rate), "vs_all_pp": round((float(r.rate) - base_rate) * 100, 1)}
            for k, r in stats.iterrows()]


# ---- the model --------------------------------------------------------------------------

def _fit_model(df: pd.DataFrame, feats: list[str], y: pd.Series, budget_left: float) -> dict:
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.inspection import permutation_importance
    from sklearn.metrics import average_precision_score, precision_recall_curve, roc_auc_score
    from sklearn.model_selection import StratifiedKFold, cross_val_predict, train_test_split
    from sklearn.preprocessing import OrdinalEncoder

    X = pd.DataFrame(index=df.index)
    cat_mask = []
    for c in feats:
        s = df[c]
        if pd.api.types.is_numeric_dtype(s) or pd.api.types.is_bool_dtype(s):
            X[c] = pd.to_numeric(s, errors="coerce").astype(float)
            cat_mask.append(False)
        elif pd.api.types.is_datetime64_any_dtype(s):
            X[c] = (s - s.min()).dt.days.astype(float)
            cat_mask.append(False)
        else:
            sv = s.astype(str).where(s.notna(), None)
            top = sv.value_counts().index[:200]
            sv = sv.where(sv.isna() | sv.isin(top), "other")  # gradient boosting takes at most 255 categories
            enc = OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1, encoded_missing_value=-1)
            X[c] = enc.fit_transform(sv.to_frame())[:, 0]
            cat_mask.append(True)
    yv = y.astype(int).values
    Xv = X.values
    big = len(df) > 60_000
    X_tr, X_te, y_tr, y_te = train_test_split(Xv, yv, test_size=0.2, random_state=48, stratify=yv)
    clf = HistGradientBoostingClassifier(max_iter=150 if big else 300, learning_rate=0.08, max_leaf_nodes=31, categorical_features=cat_mask,
                                         early_stopping=True, validation_fraction=0.15, random_state=48)
    clf.fit(X_tr, y_tr)
    p_te = clf.predict_proba(X_te)[:, 1]
    ap = float(average_precision_score(y_te, p_te))
    auc = float(roc_auc_score(y_te, p_te))
    prec, rec, thr = precision_recall_curve(y_te, p_te)
    pts = list(zip(rec.tolist(), prec.tolist()))
    step = max(1, len(pts) // 60)
    curve = [[round(r, 3), round(p, 3)] for r, p in pts[::step]] + [[round(pts[-1][0], 3), round(pts[-1][1], 3)]]
    # the operating point: recall closest to 0.8
    k = int(np.argmin(np.abs(rec - 0.8)))
    point = {"recall": round(float(rec[k]), 2), "precision": round(float(prec[k]), 2)}
    # importance: average precision lost on the test set when a column is shuffled
    imp = []
    if budget_left > 20:
        n_rep = 2 if big else 3
        sample = slice(None) if len(X_te) <= 4000 else slice(0, 4000)
        r = permutation_importance(clf, X_te[sample], y_te[sample], scoring="average_precision", n_repeats=n_rep, random_state=48, n_jobs=1)
        for i, c in enumerate(feats):
            imp.append({"column": c, "label": label_of(c), "value": round(max(float(r.importances_mean[i]), 0.0), 3)})
        imp.sort(key=lambda d: -d["value"])
    # out-of-fold scores for every row (the person's rows never scored by a model that saw them)
    oof = None
    if budget_left > 30:
        folds = 3 if big else 5
        cv = StratifiedKFold(n_splits=folds, shuffle=True, random_state=48)
        clf2 = HistGradientBoostingClassifier(max_iter=120 if big else 200, learning_rate=0.08, max_leaf_nodes=31, categorical_features=cat_mask,
                                              early_stopping=True, validation_fraction=0.15, random_state=48)
        oof = cross_val_predict(clf2, Xv, yv, cv=cv, method="predict_proba")[:, 1]
    return {"algorithm": "gradient boosting (HistGradientBoostingClassifier)", "test_n": int(len(y_te)), "train_n": int(len(y_tr)),
            "ap": round(ap, 3), "auc": round(auc, 3), "baseline_ap": round(float(yv.mean()), 3), "pr_curve": curve, "point": point,
            "importance": imp, "oof": oof, "features": len(feats), "folds": 5 if not big else 3}


def _tiers(df: pd.DataFrame, y: pd.Series, oof: np.ndarray, id_col: str | None, signals: list[dict], entities: str, verb: str) -> tuple[list[dict], dict]:
    score = pd.Series(oof, index=df.index)
    yv = y.astype(int)
    bands = [("high", "High risk", 0.70, 1.01), ("medium", "Medium risk", 0.30, 0.70), ("low", "Low risk", -0.01, 0.30)]
    existing = yv == 0
    tiers = []
    for key, label, lo, hi in bands:
        m = (score >= lo) & (score < hi)
        n_exist = int((m & existing).sum())
        hist = float(yv[m].mean()) if m.sum() else 0.0
        rule = "Score ≥ 0.70" if key == "high" else "Score 0.30 – 0.70" if key == "medium" else "Score under 0.30"
        tiers.append({"key": key, "label": label, "count": n_exist, "rule": rule, "hist_rate": _pct(hist), "band_n": int(m.sum()),
                      "action": ("review this week" if key == "high" else "targeted offer" if key == "medium" else "no action")})
    # the rows to act on first: existing rows by score, with the signals they trip
    top_signals = [s for s in signals[:4] if "_mask" in s]
    order = score[existing].sort_values(ascending=False).head(50).index
    cols = ["id", "score"] + [s["label"] for s in top_signals]
    rows = []
    for idx in order:
        row = {"id": str(df.at[idx, id_col]) if id_col else str(idx), "score": round(float(score[idx]), 2), "signals": []}
        for s in top_signals:
            try:
                v = df.at[idx, s["column"]]
            except KeyError:
                continue
            tripped = bool(s["_mask"].get(idx, False))
            row[s["label"]] = (float(v) if isinstance(v, (int, float, np.integer, np.floating)) and not pd.isna(v) else str(v))
            if tripped:
                row["signals"].append(s["group"])
        rows.append(row)
    return tiers, {"columns": cols, "rows": rows, "total_high": tiers[0]["count"]}


# ---- recommendations ------------------------------------------------------------------

def _recommendations(signals: list[dict], tiers: list[dict] | None, df: pd.DataFrame, y: pd.Series, entities: str, verb: str, noun: str) -> list[dict]:
    recs = []
    existing = (y.astype(int) == 0)
    if tiers:
        high = tiers[0]
        if high["count"] > 0:
            top = ", ".join(s["group"] for s in signals[:2]) or "the top signals"
            expected = int(round(high["count"] * high["hist_rate"] / 100))
            recs.append({"n": "01", "title": f"Contact the {high['count']:,} high-risk {entities} first",
                         "body": f"They score 0.70 or more and mostly share the strongest signals ({top}). Lead with what the signal points at, not a generic offer.",
                         "reach": high["count"], "reach_note": f"Expected, not guaranteed: at this band's historical {high['hist_rate']}% rate, about {expected:,} would otherwise {'churn' if noun == 'churn' else 'have the outcome'}."})
    for s in signals:
        if len(recs) >= 3:
            break
        if "_mask" not in s:
            continue
        n_exist = int((s["_mask"] & existing).sum())
        if n_exist < MIN_GROUP:
            continue
        if s["kind"] == "numeric" and s["direction"] == "low":
            title = f"Re-engage {entities} with {s['group']}"
            body = f"{n_exist:,} current {entities} are in this group; {s['group_rate']}% of similar {entities} {verb}, against {s['compare_rate']}% with {s['compare']}. A nudge tied to this measure targets the signal itself."
        elif s["kind"] == "numeric":
            title = f"Watch {entities} with {s['group']}"
            body = f"{n_exist:,} current {entities} are in this group; {s['group_rate']}% of similar {entities} {verb}, against {s['compare_rate']}% with {s['compare']}."
        else:
            title = f"Treat {s['group']} as a priority group"
            body = f"{n_exist:,} current {entities} are in it; {s['group_rate']}% of them {verb} historically, against {s['compare_rate']}% for {s['compare']}."
        recs.append({"n": f"{len(recs) + 1:02d}", "title": title, "body": body, "reach": n_exist,
                     "reach_note": "Overlaps the other groups. Measure with a holdout group, or the effect can't be proven."})
    return recs


# ---- findings and allowed numbers ---------------------------------------------------------

def allowed_numbers(result: dict) -> list[float]:
    """Every number the prose may use: the findings, not the curve points (a PR curve would allow almost any percentage)."""
    vals: list[float] = []

    def walk(v):
        if isinstance(v, bool):
            return
        if isinstance(v, (int, float)) and math.isfinite(float(v)):
            f = float(v)
            vals.append(f)
            if 0 <= f <= 1:
                vals.append(round(f * 100, 1))
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, (list, tuple)):
            for x in v:
                walk(x)
    for key in ("baseline", "signals", "tiers", "by_dimension", "focus", "importance", "segments", "findings"):
        walk(result.get(key))
    walk([x.get("reach") for x in (result.get("recommendations") or [])])
    m = result.get("model") or {}
    walk({k: m.get(k) for k in ("ap", "auc", "baseline_ap", "test_n", "train_n", "features", "folds", "point")})
    walk((result.get("risk_list") or {}).get("total_high"))
    walk((result.get("table") or {}).get("rows_used"))
    walk(len(result.get("signals") or []))
    walk(result.get("signals_total"))
    return vals


# ---- the runner ---------------------------------------------------------------------------

def run(db: Session, user: models.User, conv: models.Conversation, question: str, spec: dict | None = None) -> dict:
    """spec: {recipe: outcome|segment|signal, table?, target?, dimension?, feature?}."""
    spec = dict(spec or {})
    entry = pick_table(db, user, list(conv.source_ids or []), question, spec.get("table"))
    df, _entry, sampled = ml_studio.load_frame(db, user, entry["source_id"], entry["table"], cap=MAX_ROWS)
    return analyse(df, entry, sampled, question, spec)


def analyse(df: pd.DataFrame, entry: dict, sampled: bool, question: str, spec: dict | None = None, keep_scores: bool = False) -> dict:
    """The recipe on a frame already loaded (tests call this directly). keep_scores=True adds "_scores", the
    out-of-fold score of every row (aligned with df), for the dashboard builder - never stored in a turn."""
    spec = dict(spec or {})
    t0 = time.time()
    steps: list[dict] = []

    def step(label: str, detail: str = "") -> None:
        steps.append({"label": label, "detail": detail, "ms": int((time.time() - t0) * 1000)})

    if len(df) < MIN_GROUP * 3:
        raise AnalysisError(f"{entry['table']} has only {len(df)} rows; an analysis needs at least {MIN_GROUP * 3}.")
    rows_used = int(len(df))
    step("Read the table", f"{entry['source']} · {entry['table']} · {rows_used:,} rows · {len(df.columns)} columns")
    target, positive = pick_target(df, spec.get("target"), question)
    y = (df[target].astype(str) == positive).where(df[target].notna())
    base_rate = float(y.dropna().astype(int).mean())
    positives = int(y.dropna().astype(int).sum())
    verb, noun = _outcome_words(target, positive)
    entities = _entities([str(c) for c in df.columns], entry["table"])
    step("Found the outcome", f"{target} = “{positive}” · {positives:,} of {rows_used:,} ({_pct(base_rate)}%)")

    feats, excluded, _dates = ml_studio._feature_columns(df, {"target": target})
    info = {"kind": "binary", "positive": positive, "target": target}
    leaks = ml_studio._leak_suspects(df, df[target].astype(str).where(df[target].notna()), feats, info)
    leak_cols = {l["column"] for l in leaks}
    feats = [f for f in feats if f not in leak_cols]
    if not feats:
        raise AnalysisError("Every other column either identifies a row or gives the outcome away, so there is nothing to learn from.")
    step("Chose the columns", f"{len(feats)} usable · {len(excluded)} left out (ids, empty, text) · {len(leaks)} leaking removed")

    recipe = spec.get("recipe") or "outcome"
    signals: list[dict] = []
    for c in feats:
        s = df[c]
        if pd.api.types.is_datetime64_any_dtype(s):
            continue
        sig = _numeric_signal(df, c, y, base_rate, verb) if pd.api.types.is_numeric_dtype(s) else _categorical_signal(df, c, y, base_rate, verb)
        if sig:
            signals.append(sig)
    signals.sort(key=lambda d: -d["diff_pp"])
    step("Compared every signal", f"{len(signals)} signals with a difference of 2 points or more, each group against its comparison group")

    model = None
    if recipe in ("outcome", "signal") and len(df) >= 200:
        model = _fit_model(df, feats, y.fillna(False), BUDGET_S - (time.time() - t0))
        rank = {d["column"]: i for i, d in enumerate(model["importance"])}
        for sgl in signals:
            sgl["importance"] = next((d["value"] for d in model["importance"] if d["column"] == sgl["column"]), None)
            sgl["rank"] = rank.get(sgl["column"])
        # the signal order follows the model where it has an opinion, the raw difference otherwise
        signals.sort(key=lambda d: (d.get("rank") if d.get("rank") is not None else 99, -d["diff_pp"]))
        step("Trained and tested a model", f"{model['algorithm']} · {model['train_n']:,} rows to learn, {model['test_n']:,} untouched rows to test · AP {model['ap']} (random {model['baseline_ap']})")

    id_col = _id_column(df)
    tiers, risk_list = (None, None)
    if model and model.get("oof") is not None:
        tiers, risk_list = _tiers(df, y.fillna(False), model["oof"], id_col, signals, entities, verb)
        step("Scored every row out of fold", f"{model['folds']} folds · tiers at 0.70 and 0.30 · {tiers[0]['count']:,} high-risk current {entities}")

    dimension = spec.get("dimension")
    by_dim = None
    if recipe == "segment":
        if not dimension or dimension not in df.columns:
            cats = [c for c in feats if not pd.api.types.is_numeric_dtype(df[c]) and df[c].nunique() <= 30]
            scored = sorted(((word_score(question, c), i, c) for i, c in enumerate(cats)), key=lambda x: (-x[0], x[1]))
            dimension = scored[0][2] if scored and scored[0][0] > 0 else (cats[0] if cats else None)
        if dimension:
            by_dim = {"column": dimension, "label": label_of(dimension), "values": _by_dimension(df, dimension, y, base_rate)}
            step("Split by the dimension", f"{label_of(dimension)} · {len(by_dim['values'])} groups")

    focus = None
    if recipe == "signal":
        feature = spec.get("feature")
        if not feature or feature not in df.columns:
            scored = sorted(((word_score(question, c), i, c) for i, c in enumerate(feats)), key=lambda x: (-x[0], x[1]))
            feature = scored[0][2] if scored and scored[0][0] > 0 else None
        if feature:
            focus = next((s for s in signals if s["column"] == feature), None)
            if focus is None:
                s = df[feature]
                focus = (_numeric_signal(df, feature, y, base_rate, verb) if pd.api.types.is_numeric_dtype(s) else _categorical_signal(df, feature, y, base_rate, verb))
                if focus is None:
                    focus = {"column": feature, "label": label_of(feature), "kind": "flat", "diff_pp": 0.0, "group": label_of(feature), "group_rate": _pct(base_rate),
                             "compare": "the rest", "compare_rate": _pct(base_rate), "group_n": 0, "compare_n": 0}
                if model:
                    focus["importance"] = next((d["value"] for d in model["importance"] if d["column"] == feature), 0.0)
                    focus["rank"] = next((i for i, d in enumerate(model["importance"]) if d["column"] == feature), None)

    recs = _recommendations(signals, tiers, df, y.fillna(False), entities, verb, noun) if recipe != "segment" else []

    has_dates = _has_dates(df)
    top_sig = signals[:8]
    segments_fig = []
    for s in top_sig[:3]:
        segments_fig.append({"label": s["group"], "rate": s["group_rate"], "n": s["group_n"], "highlight": True})
        segments_fig.append({"label": s["compare"], "rate": s["compare_rate"], "n": s["compare_n"], "highlight": False})

    def clean(s: dict) -> dict:
        return {k: v for k, v in s.items() if not k.startswith("_")}

    result = {
        "recipe": recipe, "question": question,
        "table": {"source_id": entry["source_id"], "source": entry["source"], "table": entry["table"], "rows_used": rows_used, "sampled": bool(sampled),
                  "columns": int(len(df.columns)), "entities": entities},
        "target": {"column": target, "positive": positive, "verb": verb, "noun": noun, "label": label_of(target)},
        "baseline": {"n": rows_used, "positives": positives, "rate": _pct(base_rate), "existing": rows_used - positives},
        "has_dates": has_dates, "id_column": id_col,
        "signals": [clean(s) for s in top_sig], "signals_total": len(signals),
        "importance": (model["importance"][:8] if model else []),
        "segments": segments_fig,
        "model": ({k: v for k, v in model.items() if k not in ("oof", "importance")} | {"leaks": leaks[:6], "excluded": len(excluded)}) if model else None,
        "tiers": tiers, "risk_list": risk_list, "by_dimension": by_dim, "focus": clean(focus) if focus else None,
        "recommendations": recs,
        "method": {"steps": steps, "formulas": [
            f"{noun} rate = {entities} with {target} = “{positive}” ÷ {entities} in the group",
            "signal groups = the lowest third vs the highest third of a number column; for a category, its highest-rate value vs its lowest",
            "signal strength = average precision lost on the untouched test rows when that column is shuffled (not causal)" if model else "signal strength = difference in rate between the two groups",
            "risk tiers = out-of-fold model score: high ≥ 0.70, medium 0.30–0.70, low under 0.30" if tiers else "",
        ], "code": _code_listing(entry, target, positive, feats, model is not None)},
        "elapsed_s": round(time.time() - t0, 1),
    }
    result["findings"] = _findings(result)
    if keep_scores and model and model.get("oof") is not None:
        result["_scores"] = model["oof"]
    return result


def _findings(r: dict) -> list[dict]:
    out = [{"id": "rows", "label": f"{r['table']['entities']} read", "value": r["baseline"]["n"]},
           {"id": "positives", "label": f"{r['target']['noun']} count", "value": r["baseline"]["positives"]},
           {"id": "rate", "label": f"{r['target']['noun']} rate", "value": r["baseline"]["rate"], "unit": "%"}]
    for i, s in enumerate(r["signals"]):
        out.append({"id": f"sig{i}", "label": s["group"], "value": s["group_rate"], "unit": "%", "n": s["group_n"]})
        out.append({"id": f"cmp{i}", "label": s["compare"], "value": s["compare_rate"], "unit": "%", "n": s["compare_n"]})
    if r.get("model"):
        out.append({"id": "ap", "label": "held-out average precision", "value": r["model"]["ap"]})
        out.append({"id": "auc", "label": "held-out AUC", "value": r["model"]["auc"]})
    for t in r.get("tiers") or []:
        out.append({"id": f"tier_{t['key']}", "label": t["label"], "value": t["count"], "rate": t["hist_rate"]})
    for v in (r.get("by_dimension") or {}).get("values") or []:
        out.append({"id": f"dim_{v['value']}", "label": v["value"], "value": v["rate"], "unit": "%", "n": v["n"], "positives": v["positives"]})
    return out


def _code_listing(entry: dict, target: str, positive: str, feats: list[str], with_model: bool) -> str:
    lines = [
        "import pandas as pd",
        f"df = load_table({entry['source']!r}, {entry['table']!r})            # every row you may see, up to {MAX_ROWS:,}",
        f"y = (df[{target!r}].astype(str) == {positive!r})",
        "base_rate = y.mean()",
        "",
        "# each signal: the lowest third vs the highest third (numbers), highest vs lowest value (categories)",
        "for col in features:",
        "    q1, q2 = df[col].quantile(1/3), df[col].quantile(2/3)",
        "    low, high = y[df[col] < q1].mean(), y[df[col] >= q2].mean()",
    ]
    if with_model:
        lines += [
            "",
            "from sklearn.ensemble import HistGradientBoostingClassifier",
            "from sklearn.model_selection import train_test_split, cross_val_predict, StratifiedKFold",
            "from sklearn.inspection import permutation_importance",
            "X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.2, stratify=y, random_state=48)",
            "clf = HistGradientBoostingClassifier(early_stopping=True, random_state=48).fit(X_tr, y_tr)",
            "ap = average_precision_score(y_te, clf.predict_proba(X_te)[:, 1])          # the untouched 20%",
            "importance = permutation_importance(clf, X_te, y_te, scoring='average_precision')",
            "oof = cross_val_predict(clf, X, y, cv=StratifiedKFold(5, shuffle=True), method='predict_proba')[:, 1]",
            "tiers = pd.cut(oof, [-0.01, 0.30, 0.70, 1.01], labels=['low', 'medium', 'high'])",
        ]
    lines += ["", f"features = {feats[:12]}" + (" + …" if len(feats) > 12 else "")]
    return "\n".join(lines)

"""
2026-10-09 (round 15): the methods behind ML Studio's newer problem types,
as plain functions on arrays and DataFrames - no database, no job - so each
one can be tested on data with a known answer. services/ml_studio.py wires
them into plans, background jobs, results and per-row scoring.

Everything here is deterministic numpy / pandas / scipy / scikit-learn,
single-threaded, and bounded in memory (item and row caps are explicit).

  kaplan_meier ............ survival curve with Greenwood 95% band, median
  marketing_mix ........... geometric adstock + log saturation, channels'
                            coefficients kept >= 0, decay chosen on a
                            validation slice, R² on the last 20% of weeks
  basket_pairs ............ support / confidence / lift for item pairs
  cohort_table ............ monthly first-purchase cohorts, retention and
                            revenue per customer by month since first
  item_similarity / recommend / recommend_eval ... item-item cosine
                            recommendations and an offline hit-rate check
  diff_ci / smd ........... difference in means with a 95% interval and the
                            balance check used by the uplift readout
  elasticity .............. log-log OLS with a 95% interval
  journeys / attribution .. first / last / linear / 40-20-40 / Markov
  lexicon_sentiment ....... the no-AI fallback for sentiment
  nmf_themes .............. TF-IDF + NMF, k chosen by topic coherence
  regex_facts ............. the no-AI fallback for pulling fields from text

Result building blocks (kpi, sec_*) produce the section shapes the ML Studio
page renders: table, bars, line, matrix and text.
"""
from __future__ import annotations

import math
import re
from collections import Counter, defaultdict

import numpy as np
import pandas as pd
from scipy import sparse, stats
from scipy.optimize import lsq_linear


class MethodError(ValueError):
    """The data doesn't fit the method - said plainly."""


# ------------------------------------------------------------ results ----

def clean(o):
    """JSON-safe: numpy scalars to Python, NaN/inf to None, timestamps to text."""
    if o is None or o is pd.NaT:
        return None
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return clean(o.tolist())
    if isinstance(o, (bool, np.bool_)):
        return bool(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (float, np.floating)):
        f = float(o)
        return f if math.isfinite(f) else None
    if isinstance(o, pd.Timestamp):
        return o.isoformat()[:19]
    if isinstance(o, (pd.Period,)):
        return str(o)
    try:
        if pd.isna(o):
            return None
    except (TypeError, ValueError):
        pass
    return o


def num(v) -> str:
    try:
        v = float(v)
    except (TypeError, ValueError):
        return "—" if v is None else str(v)
    if not math.isfinite(v):
        return "—"
    a = abs(v)
    if a >= 1e9:
        return f"{v / 1e9:.1f}B"
    if a >= 1e6:
        return f"{v / 1e6:.1f}M"
    if a >= 1e4:
        return f"{v / 1e3:.1f}k"
    if v.is_integer():
        return f"{int(v):,}"
    if a >= 100:
        return f"{v:,.0f}"
    if a >= 1:
        return f"{v:,.2f}"
    return f"{v:.3g}"


def show(v, fmt: str = "number") -> str:
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return "—"
    if fmt == "percent":
        return f"{float(v) * 100:.1f}%"
    if fmt == "integer":
        return f"{int(round(float(v))):,}"
    if fmt in ("number", "currency"):
        return num(v)
    return str(v)


def kpi(label: str, value, fmt: str = "number", note: str | None = None, display: str | None = None) -> dict:
    return {"label": label, "value": clean(value), "display": display if display is not None else show(value, fmt), "note": note}


def column(name: str, label: str | None = None, fmt: str = "text") -> dict:
    return {"name": name, "label": label or name.replace("_", " ").capitalize(), "format": fmt}


def sec_table(title: str, columns: list[dict], rows: list[dict], note: str | None = None) -> dict:
    out = {"type": "table", "title": title, "columns": columns, "rows": clean(rows)}
    if note:
        out["note"] = note
    return out


def bar(label, value, fmt: str = "number", note: str | None = None, tone: str | None = None, display: str | None = None) -> dict:
    out = {"label": str(label), "value": clean(value), "display": display if display is not None else show(value, fmt)}
    if note:
        out["note"] = note
    if tone:
        out["tone"] = tone
    return out


def sec_bars(title: str, items: list[dict], fmt: str = "number", note: str | None = None) -> dict:
    out = {"type": "bars", "title": title, "format": fmt, "items": items}
    if note:
        out["note"] = note
    return out


def sec_line(title: str, x: list, series: list[dict], fmt: str = "number", band: dict | None = None, note: str | None = None) -> dict:
    out = {"type": "line", "title": title, "format": fmt, "x": [str(v) for v in x], "series": clean(series)}
    if band:
        out["band"] = clean(band)
    if note:
        out["note"] = note
    return out


def sec_matrix(title: str, row_labels: list, col_labels: list, values: list[list], fmt: str = "percent", note: str | None = None) -> dict:
    out = {"type": "matrix", "title": title, "row_labels": [str(r) for r in row_labels], "col_labels": [str(c) for c in col_labels],
           "values": clean(values), "format": fmt}
    if note:
        out["note"] = note
    return out


def sec_text(title: str, body: str) -> dict:
    return {"type": "text", "title": title, "body": body}


# ------------------------------------------------------- shared helpers ----

TRUE_WORDS = {"1", "1.0", "true", "t", "yes", "y", "happened", "event", "churned", "churn", "left", "cancelled", "canceled",
              "failed", "failure", "paid", "closed", "done", "converted", "dead", "lost", "ended", "terminated", "resolved"}
FALSE_WORDS = {"0", "0.0", "false", "f", "no", "n", "", "none", "nan", "null", "active", "open", "waiting", "pending", "censored",
               "alive", "ongoing", "current", "retained", "unpaid", "running"}


def flags(s: pd.Series, what: str) -> pd.Series:
    """1/0 from a yes/no-like column (empty counts as 0)."""
    if pd.api.types.is_bool_dtype(s):
        return s.fillna(False).astype(int)
    if pd.api.types.is_numeric_dtype(s):
        return (pd.to_numeric(s, errors="coerce").fillna(0) > 0).astype(int)
    st = s.astype("string").str.strip().str.lower().fillna("")
    vals = set(st.unique())
    unknown = vals - TRUE_WORDS - FALSE_WORDS
    if not unknown:
        return st.isin(TRUE_WORDS).astype(int)
    if len(vals - {""}) == 2:
        a, b = sorted(vals - {""})
        pos = a if a in TRUE_WORDS or b in FALSE_WORDS else b if b in TRUE_WORDS or a in FALSE_WORDS else None
        if pos is not None:
            return (st == pos).astype(int)
    raise MethodError(f"Can't tell which values of {what} mean it happened ({', '.join(sorted(map(str, unknown))[:4])}). "
                      "Use 1 / 0 or yes / no in that column.")


def to_time(s: pd.Series) -> pd.Series:
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        t = pd.to_datetime(s, errors="coerce", utc=True)
    return t.dt.tz_localize(None)


# ------------------------------------------------- time to event (KM) ----

def kaplan_meier(durations, events) -> dict:
    """Kaplan-Meier survival S(t) at each distinct event time, a Greenwood
    95% band and the median (None when fewer than half had the event)."""
    d = np.asarray(durations, dtype=float)
    e = np.asarray(events, dtype=float)
    ok = np.isfinite(d) & (d >= 0) & np.isfinite(e)
    d, e = d[ok], (e[ok] > 0).astype(int)
    n = len(d)
    if n == 0:
        return {"n": 0, "events": 0, "times": np.array([]), "surv": np.array([]), "lo": np.array([]), "hi": np.array([]),
                "median": None, "max_time": 0.0}
    d_sorted = np.sort(d)
    ev = np.sort(d[e == 1])
    times = np.unique(ev)
    at_risk = n - np.searchsorted(d_sorted, times, side="left")
    deaths = np.searchsorted(ev, times, side="right") - np.searchsorted(ev, times, side="left")
    surv = np.cumprod(1.0 - deaths / at_risk)
    with np.errstate(divide="ignore", invalid="ignore"):
        term = np.where(at_risk - deaths > 0, deaths / (at_risk * np.maximum(at_risk - deaths, 1)), 0.0)
    se = surv * np.sqrt(np.cumsum(term))
    below = np.nonzero(surv <= 0.5)[0]
    return {"n": int(n), "events": int(e.sum()), "times": times, "surv": surv, "lo": np.clip(surv - 1.96 * se, 0, 1),
            "hi": np.clip(surv + 1.96 * se, 0, 1), "median": float(times[below[0]]) if len(below) else None,
            "max_time": float(d.max())}


def survival_at(km: dict, grid, key: str = "surv") -> np.ndarray:
    grid = np.asarray(grid, dtype=float)
    t = km["times"]
    if not len(t):
        return np.ones(len(grid))
    idx = np.searchsorted(t, grid, side="right") - 1
    v = km[key]
    return np.where(idx < 0, 1.0, v[np.clip(idx, 0, None)])


# ----------------------------------------------------- marketing mix ----

def adstock(x: np.ndarray, decay: float) -> np.ndarray:
    out = np.empty(len(x), dtype=float)
    carry = 0.0
    for i, v in enumerate(x):
        carry = float(v) + decay * carry
        out[i] = carry
    return out


def _controls(n: int, woy: np.ndarray) -> np.ndarray:
    t = np.arange(n) / max(n - 1, 1)
    w = 2 * np.pi * np.asarray(woy, dtype=float) / 52.18
    return np.column_stack([np.ones(n), t, np.sin(w), np.cos(w), np.sin(2 * w), np.cos(2 * w)])


def _channel_feats(S: np.ndarray, decays, scales) -> np.ndarray:
    return np.column_stack([np.log1p(adstock(S[:, j], decays[j]) / scales[j]) for j in range(S.shape[1])])


def _scales(S: np.ndarray, decays, upto: int) -> list[float]:
    out = []
    for j in range(S.shape[1]):
        a = adstock(S[:upto, j], decays[j])
        pos = a[a > 0]
        out.append(float(pos.mean()) if len(pos) else 1.0)
    return out


def _nnls(F: np.ndarray, C: np.ndarray, y: np.ndarray) -> np.ndarray:
    A = np.hstack([F, C])
    lb = np.r_[np.zeros(F.shape[1]), np.full(C.shape[1], -np.inf)]
    ub = np.full(A.shape[1], np.inf)
    return lsq_linear(A, y, bounds=(lb, ub), lsmr_tol="auto", max_iter=2000).x


def r2(y, p) -> float:
    y, p = np.asarray(y, float), np.asarray(p, float)
    ss = float(((y - y.mean()) ** 2).sum())
    return float(1 - ((y - p) ** 2).sum() / ss) if ss > 0 else float("nan")


DECAYS = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]


def marketing_mix(y: np.ndarray, S: np.ndarray, woy: np.ndarray, names: list[str], on_trial=None) -> dict:
    """Weekly sales y on weekly channel spends S (weeks × channels).

    Adstock decay per channel is chosen on a validation slice (fit on the
    first 64% of weeks, judged on 64-80%), coordinate by coordinate over
    DECAYS; the honest score is R² on the last 20% of weeks for a model fit
    on the first 80%. Contributions, ROI and marginal ROI come from a final
    fit on every week."""
    y = np.asarray(y, dtype=float)
    S = np.asarray(S, dtype=float)
    n, C = S.shape
    Ctrl = _controls(n, woy)
    fit_end, val_end = max(int(n * 0.64), 8), int(n * 0.8)

    def evaluate(decays, end_fit, end_eval):
        sc = _scales(S, decays, end_fit)
        F = _channel_feats(S, decays, sc)
        coef = _nnls(F[:end_fit], Ctrl[:end_fit], y[:end_fit])
        pred = np.hstack([F, Ctrl]) @ coef
        return r2(y[end_fit:end_eval], pred[end_fit:end_eval]), pred

    decays = [0.4] * C
    best = evaluate(decays, fit_end, val_end)[0]
    best = -1e9 if not math.isfinite(best) else best
    trial = 0
    trials = []
    for _pass in range(2):
        changed = False
        for j in range(C):
            for g in DECAYS:
                if g == decays[j]:
                    continue
                cand = list(decays)
                cand[j] = g
                sc = evaluate(cand, fit_end, val_end)[0]
                trial += 1
                if math.isfinite(sc) and sc > best + 1e-6:
                    best, decays, changed = sc, cand, True
                trials.append({"trial": trial, "score": sc, "best": best, "channel": names[j], "decay": g})
                if on_trial:
                    on_trial(trial, sc, best, names[j], g)
        if not changed:
            break
    test_r2, pred_test = evaluate(decays, val_end, n)
    sc = _scales(S, decays, n)
    F = _channel_feats(S, decays, sc)
    coef = _nnls(F, Ctrl, y)
    beta = coef[:C]
    fitted = np.hstack([F, Ctrl]) @ coef
    contrib = F * beta
    spend = S.sum(axis=0)
    channels = []
    for j in range(C):
        S2 = S.copy()
        S2[:, j] *= 1.01
        F2 = _channel_feats(S2, decays, sc)
        extra = float(((F2 - F) @ beta).sum())
        extra_spend = 0.01 * spend[j]
        channels.append({
            "channel": names[j], "spend": float(spend[j]), "contribution": float(contrib[:, j].sum()),
            "share_of_sales": float(contrib[:, j].sum() / max(y.sum(), 1e-9)),
            "roi": float(contrib[:, j].sum() / spend[j]) if spend[j] > 0 else None,
            "marginal_roi": extra / extra_spend if extra_spend > 0 else None,
            "decay": decays[j], "coefficient": float(beta[j]),
        })
    live = [c for c in channels if c["marginal_roi"] is not None and c["spend"] > 0]
    realloc = None
    if len(live) >= 2:
        lo = min(live, key=lambda c: c["marginal_roi"])
        hi = max(live, key=lambda c: c["marginal_roi"])
        if lo["channel"] != hi["channel"]:
            jl, jh = names.index(lo["channel"]), names.index(hi["channel"])
            S3 = S.copy()
            moved = 0.1 * S3[:, jl]
            S3[:, jl] -= moved
            S3[:, jh] += moved
            F3 = _channel_feats(S3, decays, sc)
            delta = float(((F3 - F) @ beta).sum())
            realloc = {"from": lo["channel"], "to": hi["channel"], "moved": float(moved.sum()), "change": delta,
                       "change_pct": delta / max(fitted.sum(), 1e-9)}
    return {"weeks": int(n), "test_r2": test_r2, "validation_r2": best, "decays": dict(zip(names, decays)), "channels": channels,
            "fitted": fitted, "base": float(fitted.sum() - contrib.sum()), "realloc": realloc, "trials": trials,
            "test_from": int(val_end), "pred_test": pred_test}


# --------------------------------------------------- bought together ----

def basket_pairs(orders: pd.Series, items: pd.Series, max_items: int = 2000, top: int = 50) -> dict:
    d = pd.DataFrame({"o": orders.astype(str).where(orders.notna()), "i": items.astype(str).where(items.notna())}).dropna()
    d = d.drop_duplicates()
    if d.empty:
        raise MethodError("No order has both an order id and an item.")
    o_codes, o_uni = pd.factorize(d["o"])
    i_codes, i_uni = pd.factorize(d["i"])
    N = len(o_uni)
    counts = np.bincount(i_codes, minlength=len(i_uni))
    size = np.bincount(o_codes, minlength=N)
    threshold = max(3, min(int(math.ceil(0.005 * N)), 20))
    keep = np.nonzero(counts >= threshold)[0]
    keep = keep[np.argsort(-counts[keep], kind="stable")][:max_items]
    remap = np.full(len(i_uni), -1)
    remap[keep] = np.arange(len(keep))
    sel = remap[i_codes] >= 0
    K = len(keep)
    pairs = []
    partners: dict[str, list] = {}
    if K >= 2:
        X = sparse.csr_matrix((np.ones(int(sel.sum()), dtype=np.int32), (o_codes[sel], remap[i_codes[sel]])), shape=(N, K))
        co = (X.T @ X).tocoo()
        m = (co.row < co.col) & (co.data >= threshold)
        a, b, c = co.row[m], co.col[m], co.data[m].astype(float)
        ca, cb = counts[keep][a].astype(float), counts[keep][b].astype(float)
        lift = c * N / (ca * cb)
        order = np.lexsort((-c, -lift))
        names = i_uni[keep]
        for k in order:
            pairs.append({"item_a": names[a[k]], "item_b": names[b[k]], "orders_together": int(c[k]), "support": c[k] / N,
                          "confidence_a_to_b": c[k] / ca[k], "confidence_b_to_a": c[k] / cb[k], "lift": float(lift[k])})
        by_item: dict[str, list] = defaultdict(list)
        for p in pairs:
            if p["lift"] > 1:
                by_item[p["item_a"]].append((p["lift"], p["item_b"]))
                by_item[p["item_b"]].append((p["lift"], p["item_a"]))
        partners = {k: [x[1] for x in sorted(v, key=lambda t: -t[0])[:3]] for k, v in by_item.items()}
    return {"orders": int(N), "products": int(len(i_uni)), "multi_share": float((size >= 2).mean()), "threshold": int(threshold),
            "frequent_items": int(K), "pairs_found": len(pairs), "pairs": pairs[:top], "partners": partners}


# ------------------------------------------------------------ cohorts ----

def _month_label(m: int) -> str:
    return pd.Timestamp(year=m // 12, month=m % 12 + 1, day=1).strftime("%b %Y")


def cohort_table(entity: pd.Series, when: pd.Series, value: pd.Series | None = None, max_k: int = 12, max_cohorts: int = 18) -> dict:
    t = to_time(when)
    d = pd.DataFrame({"e": entity.astype(str).where(entity.notna()), "t": t})
    if value is not None:
        d["v"] = pd.to_numeric(value, errors="coerce").fillna(0.0)
    d = d.dropna(subset=["e", "t"])
    if d.empty:
        raise MethodError("No row has both a customer and a date.")
    d["m"] = d["t"].dt.year * 12 + d["t"].dt.month - 1
    d["c"] = d.groupby("e")["m"].transform("min")
    d["k"] = d["m"] - d["c"]
    last = int(d["m"].max())
    active = d.drop_duplicates(["e", "m"])
    sizes = active[active["k"] == 0].groupby("c")["e"].nunique()
    counts = active[active["k"] <= max_k].groupby(["c", "k"])["e"].nunique()
    cnt = counts.to_dict()
    rev = d[d["k"] <= max_k].groupby(["c", "k"])["v"].sum().to_dict() if value is not None else {}
    cohorts = sorted(int(c) for c in sizes.index)
    shown = cohorts[-max_cohorts:]
    matrix = [[(cnt.get((c, k), 0) / sizes[c]) if c + k <= last else None for k in range(max_k + 1)] for c in shown]
    avg, avg_rev, n_obs = [], [], []
    for k in range(max_k + 1):
        obs = [c for c in cohorts if c + k <= last]
        tot = sum(int(sizes[c]) for c in obs)
        n_obs.append(len(obs))
        avg.append(sum(cnt.get((c, k), 0) for c in obs) / tot if tot else None)
        if value is not None:
            avg_rev.append(sum(rev.get((c, k), 0.0) for c in obs) / tot if tot else None)
    cum = []
    run = 0.0
    for v in avg_rev:
        if v is None:
            cum.append(None)
        else:
            run += v
            cum.append(run)
    return {"customers": int(d["e"].nunique()), "cohorts": len(cohorts), "first_month": _month_label(cohorts[0]),
            "last_month": _month_label(last), "row_labels": [f"{_month_label(c)} ({int(sizes[c]):,})" for c in shown],
            "cohort_sizes": [int(sizes[c]) for c in shown], "matrix": matrix, "avg": avg, "avg_revenue": avg_rev or None,
            "cum_revenue": cum or None, "cohorts_observed": n_obs, "max_k": max_k}


# ---------------------------------------------------- recommendations ----

def user_item_matrix(users: pd.Series, items: pd.Series, weights: pd.Series | None = None, max_items: int = 2000):
    d = pd.DataFrame({"u": users.astype(str).where(users.notna()), "i": items.astype(str).where(items.notna())})
    d["w"] = pd.to_numeric(weights, errors="coerce").fillna(0).clip(lower=0).values if weights is not None else 1.0
    d = d.dropna(subset=["u", "i"])
    pop = d.groupby("i")["u"].nunique().sort_values(ascending=False, kind="stable")
    keep = list(pop.index[:max_items])
    d = d[d["i"].isin(set(keep))]
    u_codes, u_uni = pd.factorize(d["u"])
    item_index = {it: k for k, it in enumerate(keep)}
    i_codes = d["i"].map(item_index).values
    X = sparse.csr_matrix((d["w"].astype(float).values, (u_codes, i_codes)), shape=(len(u_uni), len(keep)))
    X.sum_duplicates()
    X.data = np.log1p(X.data)
    return X, list(u_uni), keep, d


def item_similarity(X: sparse.csr_matrix, k: int = 50) -> sparse.csr_matrix:
    """Cosine similarity between item columns, keeping the k closest per item."""
    X = X.tocsc()
    norms = np.sqrt(np.asarray(X.multiply(X).sum(axis=0)).ravel())
    norms[norms == 0] = 1.0
    Xn = X @ sparse.diags(1.0 / norms)
    Sm = (Xn.T @ Xn).tocsr()
    Sm.setdiag(0)
    Sm.eliminate_zeros()
    indptr, indices, data = [0], [], []
    for r in range(Sm.shape[0]):
        a, b = Sm.indptr[r], Sm.indptr[r + 1]
        idx, val = Sm.indices[a:b], Sm.data[a:b]
        if len(val) > k:
            top = np.argpartition(-val, k)[:k]
            idx, val = idx[top], val[top]
        indices.extend(idx.tolist())
        data.extend(val.tolist())
        indptr.append(len(indices))
    return sparse.csr_matrix((np.array(data, dtype=float), np.array(indices, dtype=np.int64), np.array(indptr)), shape=Sm.shape)


def recommend(X_rows: sparse.csr_matrix, Sim: sparse.csr_matrix, n: int = 5, chunk: int = 1000) -> list[list[int]]:
    out = []
    for s in range(0, X_rows.shape[0], chunk):
        part = X_rows[s:s + chunk]
        sc = (part @ Sim).toarray()
        seen = part.toarray() > 0
        sc[seen] = -np.inf
        for r in range(sc.shape[0]):
            row = sc[r]
            k = min(n, len(row))
            top = np.argpartition(-row, k - 1)[:k] if k else []
            top = [int(t) for t in sorted(top, key=lambda t: -row[t]) if row[t] > 0]
            out.append(top)
    return out


def recommend_eval(d: pd.DataFrame, keep_items: list, time_values: pd.Series | None, n: int = 5, max_users: int = 5000, seed: int = 0) -> dict:
    """Hide each eligible user's last item (by time) - or, with no time
    column, a random 20% of their items - fit on the rest, and count how
    often a hidden item is in the top n, against the n most popular items."""
    rng = np.random.RandomState(seed)
    d = d.copy()
    if time_values is not None:
        d["t"] = to_time(time_values.loc[d.index])
    per_user = d.groupby("u")["i"].nunique()
    eligible = per_user[per_user >= 2].index
    if len(eligible) > max_users:
        eligible = pd.Index(rng.choice(np.asarray(eligible), size=max_users, replace=False))
    elig = set(eligible)
    hidden: dict[str, set] = {}
    if time_values is not None and d["t"].notna().mean() > 0.9:
        last = d[d["u"].isin(elig)].sort_values("t", kind="stable").groupby("u").tail(1)
        for u, i in zip(last["u"], last["i"]):
            hidden[u] = {i}
        how = "each person's most recent item was hidden"
    else:
        for u, items in d[d["u"].isin(elig)].groupby("u")["i"]:
            uniq = sorted(set(items))
            k = max(1, int(round(len(uniq) * 0.2)))
            hidden[u] = set(rng.choice(uniq, size=k, replace=False).tolist())
        how = "a random 20% of each person's items were hidden"
    mask = np.array([i in hidden.get(u, ()) for u, i in zip(d["u"], d["i"])], dtype=bool)
    train = d[~mask]
    u_codes, u_uni = pd.factorize(train["u"])
    item_index = {it: k for k, it in enumerate(keep_items)}
    X = sparse.csr_matrix((np.ones(len(train)), (u_codes, train["i"].map(item_index).values)), shape=(len(u_uni), len(keep_items)))
    X.sum_duplicates()
    X.data = np.log1p(X.data)
    Sim = item_similarity(X)
    known = set(u_uni)
    users = [u for u in hidden if u in known]
    rows = X[pd.Index(u_uni).get_indexer(users)]
    recs = recommend(rows, Sim, n=n)
    pop_order = np.argsort(-np.asarray((X > 0).sum(axis=0)).ravel(), kind="stable")
    hits = pop_hits = 0
    for r, u in enumerate(users):
        hid = {item_index[i] for i in hidden[u] if i in item_index}
        if hid & set(recs[r]):
            hits += 1
        seen = set(rows[r].indices.tolist())
        pop = [int(i) for i in pop_order if int(i) not in seen][:n]
        if hid & set(pop):
            pop_hits += 1
    m = max(len(users), 1)
    return {"users_tested": len(users), "hit_rate": hits / m, "popular_hit_rate": pop_hits / m, "how": how}


# ------------------------------------------------------------- uplift ----

def diff_ci(a: np.ndarray, b: np.ndarray) -> dict:
    """Mean of a minus mean of b, with a normal-approximation 95% interval."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    diff = float(a.mean() - b.mean())
    se = float(math.sqrt(a.var(ddof=1) / max(len(a), 1) + b.var(ddof=1) / max(len(b), 1))) if len(a) > 1 and len(b) > 1 else float("nan")
    return {"diff": diff, "lo": diff - 1.96 * se, "hi": diff + 1.96 * se, "se": se,
            "p": float(2 * (1 - stats.norm.cdf(abs(diff) / se))) if se and math.isfinite(se) and se > 0 else None}


def smd(df: pd.DataFrame, treated: np.ndarray, feats: list[str]) -> list[dict]:
    """How different the two groups are before treatment: standardised mean
    difference for numbers, largest share difference for categories."""
    out = []
    for c in feats:
        s = df[c]
        try:
            if pd.api.types.is_numeric_dtype(s):
                x = pd.to_numeric(s, errors="coerce")
                a, b = x[treated], x[~treated]
                sd = math.sqrt((a.var() + b.var()) / 2) if a.notna().sum() > 1 and b.notna().sum() > 1 else 0
                if sd and math.isfinite(sd):
                    out.append({"feature": c, "difference": float((a.mean() - b.mean()) / sd), "kind": "standardised mean difference"})
            elif s.nunique() <= 50:
                sa = s[treated].astype(str).value_counts(normalize=True)
                sb = s[~treated].astype(str).value_counts(normalize=True)
                diff = (sa.reindex(sa.index.union(sb.index), fill_value=0) - sb.reindex(sa.index.union(sb.index), fill_value=0)).abs()
                if len(diff):
                    out.append({"feature": c, "difference": float(diff.max()), "kind": f"share of “{diff.idxmax()}”"})
        except Exception:  # noqa: BLE001 - a check that can't run is skipped
            continue
    out.sort(key=lambda r: -abs(r["difference"]))
    return out


# -------------------------------------------------------------- price ----

def elasticity(price: np.ndarray, units: np.ndarray, month: np.ndarray | None = None) -> dict:
    """log(units) = a + b·log(price) [+ month effects]; b is the elasticity."""
    p, u = np.asarray(price, float), np.asarray(units, float)
    ok = np.isfinite(p) & np.isfinite(u) & (p > 0) & (u > 0)
    p, u = p[ok], u[ok]
    cols = [np.ones(len(p)), np.log(p)]
    seasonal = False
    if month is not None:
        mo = np.asarray(month)[ok]
        levels = sorted(set(int(x) for x in mo if np.isfinite(x)))
        if len(levels) > 1 and len(p) >= 24 + len(levels):
            for lv in levels[1:]:
                cols.append((mo == lv).astype(float))
            seasonal = True
    X = np.column_stack(cols)
    y = np.log(u)
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    dof = len(y) - X.shape[1]
    if dof <= 2:
        raise MethodError("too few rows")
    sigma2 = float(resid @ resid / dof)
    cov = sigma2 * np.linalg.pinv(X.T @ X)
    se = float(math.sqrt(max(cov[1, 1], 0)))
    tq = float(stats.t.ppf(0.975, dof))
    b = float(beta[1])
    return {"elasticity": b, "lo": b - tq * se, "hi": b + tq * se, "se": se, "rows": int(len(y)), "r2": r2(y, X @ beta),
            "seasonal": seasonal, "distinct_prices": int(len(np.unique(np.round(p, 4))))}


# -------------------------------------------------------- attribution ----

def journeys(entity: pd.Series, when: pd.Series, channel: pd.Series, converted: pd.Series, value: pd.Series | None = None,
             include_converting_touch: bool = True, max_len: int = 30) -> dict:
    """Paths of channels per person, cut at each conversion. Touches after
    a person's last conversion (or a person who never converted) form a
    journey that didn't convert."""
    d = pd.DataFrame({"e": entity.astype(str).where(entity.notna()), "t": to_time(when),
                      "c": channel.astype(str).where(channel.notna() & (channel.astype(str).str.strip() != "")),
                      "y": np.asarray(converted, dtype=int)})
    d["v"] = pd.to_numeric(value, errors="coerce").fillna(0.0).values if value is not None else 0.0
    d = d.dropna(subset=["e", "t"]).sort_values(["e", "t"], kind="stable")
    conv, nulls = [], []
    for _e, g in d.groupby("e", sort=False):
        path: list[str] = []
        for c, y, v in zip(g["c"].values, g["y"].values, g["v"].values):
            if y:
                if c is not None and isinstance(c, str) and (include_converting_touch or not path):
                    path.append(c)
                if path:
                    conv.append((path[-max_len:], float(v)))
                path = []
            elif isinstance(c, str):
                path.append(c)
        if path:
            nulls.append(path[-max_len:])
    return {"converting": conv, "non_converting": nulls}


def _collapse(path: list[str]) -> list[str]:
    out = []
    for c in path:
        if not out or out[-1] != c:
            out.append(c)
    return out


def markov_credit(conv_paths: list[list[str]], null_paths: list[list[str]]) -> dict[str, float]:
    """Removal effect from a first-order chain start -> channels -> conversion / null."""
    channels = sorted({c for p in conv_paths + null_paths for c in p})
    if not channels:
        return {}
    states = ["(start)"] + channels
    idx = {s: i for i, s in enumerate(states)}
    nT = len(states)
    T = np.zeros((nT, nT + 2))  # last two columns: conversion, null
    for paths, end in ((conv_paths, nT), (null_paths, nT + 1)):
        for p in paths:
            seq = ["(start)"] + _collapse(p)
            for a, b in zip(seq[:-1], seq[1:]):
                T[idx[a], idx[b]] += 1
            T[idx[seq[-1]], end] += 1
    rows = T.sum(axis=1, keepdims=True)
    rows[rows == 0] = 1
    P = T / rows

    def p_conv(removed: int | None) -> float:
        Q = P[:, :nT].copy()
        R = P[:, nT].copy()
        if removed is not None:
            Q[:, removed] = 0.0  # moving into the removed channel ends the journey without a sale
            Q[removed, :] = 0.0
            R[removed] = 0.0
        try:
            b = np.linalg.solve(np.eye(nT) - Q, R)
        except np.linalg.LinAlgError:
            b = np.linalg.lstsq(np.eye(nT) - Q, R, rcond=None)[0]
        return float(b[0])

    base = p_conv(None)
    if base <= 0:
        return {c: 0.0 for c in channels}
    eff = {c: max(0.0, 1 - p_conv(idx[c]) / base) for c in channels}
    tot = sum(eff.values()) or 1.0
    return {c: v / tot for c, v in eff.items()}


def attribution(conv: list[tuple[list[str], float]], nulls: list[list[str]]) -> dict:
    """Conversions (and value) credited to each channel by five models."""
    models = ("first_touch", "last_touch", "linear", "position", "markov")
    credit = {m: Counter() for m in models}
    value = {m: Counter() for m in models}
    for path, v in conv:
        k = len(path)
        w = {}
        w_first = Counter({path[0]: 1.0})
        w_last = Counter({path[-1]: 1.0})
        w_lin = Counter()
        for c in path:
            w_lin[c] += 1.0 / k
        w_pos = Counter()
        if k == 1:
            w_pos[path[0]] += 1.0
        elif k == 2:
            w_pos[path[0]] += 0.5
            w_pos[path[1]] += 0.5
        else:
            w_pos[path[0]] += 0.4
            w_pos[path[-1]] += 0.4
            for c in path[1:-1]:
                w_pos[c] += 0.2 / (k - 2)
        w = {"first_touch": w_first, "last_touch": w_last, "linear": w_lin, "position": w_pos}
        for m, ws in w.items():
            for c, x in ws.items():
                credit[m][c] += x
                value[m][c] += x * v
    total = len(conv)
    total_value = sum(v for _, v in conv)
    shares = markov_credit([p for p, _ in conv], nulls)
    for c, s in shares.items():
        credit["markov"][c] = s * total
        value["markov"][c] = s * total_value
    channels = sorted({c for p, _ in conv for c in p} | set(shares))
    return {"channels": channels, "credit": {m: dict(credit[m]) for m in models}, "value": {m: dict(value[m]) for m in models},
            "conversions": total, "total_value": total_value, "journeys": total + len(nulls),
            "avg_touches": float(np.mean([len(p) for p, _ in conv])) if conv else None}


# ---------------------------------------------------------- language ----

POSITIVE = set("""
love loved loving lovely great excellent amazing awesome fantastic wonderful perfect best good nice happy pleased delighted
helpful friendly fast quick easy smooth recommend recommended thanks thank brilliant superb outstanding impressed enjoy enjoyed
beautiful comfortable reliable satisfied glad favourite favorite fabulous incredible exceptional pleasant clean tasty fresh
""".split())
NEGATIVE = set("""
bad terrible awful horrible worst poor broken broke damaged late delay delayed slow rude disappointed disappointing
angry annoyed frustrated frustrating useless refund wrong missing never problem problems issue issues complaint complain
dirty cold unhelpful waste expensive overpriced faulty defective crashed crash error errors fail failed failure cancel
cancelled canceled lost unacceptable horrendous hate hated nightmare scam ridiculous worse leaking leak stuck mess
""".split())
NEGATORS = {"not", "no", "never", "isn't", "wasn't", "don't", "didn't", "doesn't", "aren't", "weren't", "cannot", "can't", "won't", "hardly"}
QUESTION_START = ("how ", "what ", "why ", "when ", "where ", "can ", "could ", "is ", "are ", "do ", "does ", "will ", "should ",
                  "which ", "who ", "any ", "would ", "may ", "did ")
SENTIMENT_TAGS = ["praise", "question", "complaint", "neutral"]


def lexicon_sentiment(texts) -> tuple[list[str], list[int]]:
    """praise / question / complaint / neutral from a built-in word list -
    the fallback when the AI isn't available. Returns (tags, net score)."""
    tags, scores = [], []
    for t in texts:
        s = str(t or "").lower()
        words = re.findall(r"[a-z']+", s)
        pos = neg = 0
        for i, w in enumerate(words):
            negated = any(x in NEGATORS for x in words[max(0, i - 2):i])
            if w in POSITIVE:
                if negated:
                    neg += 1
                else:
                    pos += 1
            elif w in NEGATIVE:
                if negated:
                    pos += 0  # "not bad" is not praise either
                else:
                    neg += 1
        question = "?" in s or s.strip().startswith(QUESTION_START)
        if neg > pos:
            tag = "complaint"
        elif pos > neg:
            tag = "praise"
        elif question:
            tag = "question"
        else:
            tag = "neutral"
        tags.append(tag)
        scores.append(pos - neg)
    return tags, scores


def tfidf(max_features: int = 20000, stop_words=None, min_df: int = 2, max_df: float = 1.0):
    from sklearn.feature_extraction.text import TfidfVectorizer
    return TfidfVectorizer(ngram_range=(1, 2), max_features=max_features, min_df=min_df, max_df=max_df, sublinear_tf=True,
                           stop_words=stop_words, token_pattern=r"(?u)\b[a-zA-Z][a-zA-Z0-9']+\b", dtype=np.float32)


def slim(vec):
    """Drops the vectorizer's list of every pruned word (sklearn keeps it as
    stop_words_ only for inspection) - it can be most of the memory and of
    the saved model."""
    if hasattr(vec, "stop_words_"):
        vec.stop_words_ = None
    return vec


def transform_chunks(fn, texts, chunk: int = 5000):
    """fn(list of texts) -> array, applied in slices so a large table never
    becomes one large matrix."""
    parts = [fn(list(texts[s:s + chunk])) for s in range(0, len(texts), chunk)]
    return np.vstack(parts) if parts else np.zeros((0, 0))


def _umass(B: sparse.csr_matrix, top: np.ndarray) -> float:
    D = B[:, top]
    co = (D.T @ D).toarray().astype(float)
    df = np.diag(co)
    vals = []
    for i in range(1, len(top)):
        for j in range(i):
            if df[j] > 0:
                vals.append(math.log((co[i, j] + 1) / df[j]))
    return float(np.mean(vals)) if vals else -1e9


def nmf_themes(texts: list[str], k_min: int = 4, k_max: int = 10, on_trial=None, seed: int = 0, max_fit: int = 8000) -> dict:
    from sklearn.decomposition import NMF
    vec = tfidf(stop_words="english", min_df=2, max_df=0.6)
    rng = np.random.RandomState(seed)
    # words and themes are learnt on at most max_fit texts (bounded memory and
    # time on a small server); every text is then read with them, in slices
    fit_idx = np.sort(rng.choice(len(texts), size=max_fit, replace=False)) if len(texts) > max_fit else np.arange(len(texts))
    X = vec.fit_transform([texts[i] for i in fit_idx])
    slim(vec)
    terms = np.asarray(vec.get_feature_names_out())
    if X.shape[1] < 12:
        raise MethodError("There are too few repeated words in this text to find themes - at least a few hundred words that recur are needed.")
    sample = rng.choice(X.shape[0], size=min(X.shape[0], 5000), replace=False)
    Xs = X[sample]
    B = (Xs > 0).astype(np.float32).tocsr()
    k_hi = max(k_min, min(k_max, X.shape[0] // 15, X.shape[1] // 3))
    board = []
    best = None
    for k in range(k_min, k_hi + 1):
        nmf = NMF(n_components=k, init="nndsvd", random_state=seed, max_iter=300)
        nmf.fit(Xs)
        coh = float(np.mean([_umass(B, np.argsort(-h)[:10]) for h in nmf.components_]))
        board.append({"k": k, "coherence": coh, "error": float(nmf.reconstruction_err_)})
        if on_trial:
            on_trial(k, coh, nmf.reconstruction_err_)
        if best is None or coh > best[1] + 1e-9:
            best = (k, coh)
    k = best[0]
    nmf = NMF(n_components=k, init="nndsvd", random_state=seed, max_iter=400)
    nmf.fit(X)
    del X, Xs, B
    W = transform_chunks(lambda part: nmf.transform(vec.transform(part)), texts)
    H = nmf.components_
    top_terms = [[str(terms[i]) for i in np.argsort(-h)[:10]] for h in H]
    return {"k": k, "board": board, "W": W, "top_terms": top_terms, "vectorizer": vec, "model": nmf}


# --------------------------------------------------------- doc facts ----

_MON = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?"
DATE_PATTERNS = [
    re.compile(r"\b(\d{4}-\d{2}-\d{2})\b"),
    re.compile(rf"\b(\d{{1,2}}\s+{_MON}\s+\d{{4}})\b", re.I),
    re.compile(rf"\b({_MON}\s+\d{{1,2}},?\s+\d{{4}})\b", re.I),
    re.compile(r"\b(\d{1,2}[/.]\d{1,2}[/.]\d{2,4})\b"),
]
_NUM = r"\d{1,3}(?:[,\s]\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?"
AMOUNT_PATTERNS = [
    re.compile(rf"(?P<cur>[$€£¥₹]|\b(?:USD|EUR|GBP|INR|AUD|CAD|JPY|CHF|SGD|AED)\b)\s?(?P<num>{_NUM})"),
    re.compile(rf"(?P<num>{_NUM})\s?(?P<cur>\b(?:USD|EUR|GBP|INR|AUD|CAD|JPY|CHF|SGD|AED)\b|[$€£])"),
]
TOTAL_RE = re.compile(rf"(?:grand\s+total|total\s+due|amount\s+due|balance\s+due|total|amount)\s*[:=]?\s*(?P<cur>[$€£¥₹]|USD|EUR|GBP|INR)?\s?(?P<num>{_NUM})", re.I)
EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
REF_RE = re.compile(r"\b(?:invoice|inv|ref(?:erence)?|order|po|receipt|contract|quote|bill)\s*(?:no\.?|number|num|#|id)?\s*[:#]?\s*(?P<ref>[A-Z0-9][A-Z0-9\-/]{2,})", re.I)
CODE_RE = re.compile(r"\b(?P<ref>[A-Z]{2,5}-?\d{3,}(?:-\d+)?)\b")
PARTY_RE = re.compile(r"(?:^|\n|\b)(?:from|bill(?:ed)?\s+to|vendor|supplier|customer|client|seller|buyer|company|payee|sold\s+to|issued\s+by)\s*[:\-]\s*(?P<party>[^\n,;|]{2,60})", re.I)
PHONE_RE = re.compile(r"(?<![\w.])(\+?\(?\d[\d\s().-]{5,18}\d)(?![\w.])")
SYMBOL_CURRENCY = {"$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR"}


def field_kind(name: str) -> str | None:
    n = re.sub(r"[^a-z]", "", name.lower())
    if "email" in n:
        return "email"
    if "date" in n or n in ("due", "issued", "day"):
        return "date"
    if "currency" in n:
        return "currency"
    if any(w in n for w in ("amount", "total", "price", "sum", "value", "cost", "fee", "balance")):
        return "amount"
    if "phone" in n or n.startswith("tel"):
        return "phone"
    if any(w in n for w in ("ref", "invoice", "number", "order", "po", "id", "code")):
        return "reference"
    if any(w in n for w in ("party", "vendor", "supplier", "customer", "client", "company", "name", "from", "seller", "buyer", "payee")):
        return "party"
    return None


def _to_float(s: str) -> float | None:
    try:
        return float(re.sub(r"[,\s]", "", s))
    except (TypeError, ValueError):
        return None


def _iso_date(s: str) -> str:
    try:
        if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
            return s
        d = pd.to_datetime(s, errors="coerce", dayfirst=bool(re.match(r"^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$", s)
                                                                and int(re.split(r"[/.]", s)[0]) > 12))
        return d.date().isoformat() if pd.notna(d) else s
    except Exception:  # noqa: BLE001
        return s


def regex_facts(text: str, fields: list[str]) -> dict:
    """The no-AI fallback: dates, amounts with currency, emails, reference
    numbers, parties and phone numbers by pattern. A field with no rule is
    left empty."""
    t = str(text or "")
    out: dict = {}
    amount = currency = None
    m = TOTAL_RE.search(t)
    if m and _to_float(m.group("num")) is not None:
        amount, currency = _to_float(m.group("num")), m.group("cur")
    else:
        found = []
        for pat in AMOUNT_PATTERNS:
            for mm in pat.finditer(t):
                v = _to_float(mm.group("num"))
                if v is not None:
                    found.append((v, mm.group("cur")))
        if found:
            amount, currency = max(found, key=lambda x: x[0])
    if currency is None:
        mm = None
        for pat in AMOUNT_PATTERNS:
            mm = mm or pat.search(t)
        currency = mm.group("cur") if mm else None
    if currency:
        currency = SYMBOL_CURRENCY.get(currency.strip(), currency.strip().upper())
    for f in fields:
        kind = field_kind(f)
        v = None
        if kind == "date":
            for pat in DATE_PATTERNS:
                mm = pat.search(t)
                if mm:
                    v = _iso_date(mm.group(1))
                    break
        elif kind == "amount":
            v = amount
        elif kind == "currency":
            v = currency
        elif kind == "email":
            mm = EMAIL_RE.search(t)
            v = mm.group(0) if mm else None
        elif kind == "reference":
            mm = REF_RE.search(t)
            if mm and re.search(r"\d", mm.group("ref")):
                v = mm.group("ref").strip(" .:")
            else:
                mm = CODE_RE.search(t)
                v = mm.group("ref") if mm else None
        elif kind == "party":
            mm = PARTY_RE.search(t)
            v = mm.group("party").strip(" .:") if mm else None
        elif kind == "phone":
            for mm in PHONE_RE.finditer(t):
                cand = mm.group(1).strip()
                digits = len(re.sub(r"\D", "", cand))
                if 7 <= digits <= 15 and not re.fullmatch(r"\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4}|[\d,]+\.\d{1,2}", cand) \
                        and (cand.startswith(("+", "(")) or re.search(r"[\s-]", cand)):
                    v = cand
                    break
        out[f] = v
    return out

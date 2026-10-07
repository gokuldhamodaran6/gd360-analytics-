"""
Forecasts and anomalies for a dashboard time series (2026-10-07).

WHAT IS FORECAST
  A block's AGGREGATED series - the tens of (period, value) rows its one
  warehouse query (or a file block's group-by) returned. Never raw rows,
  never a sample. Everything here is numpy; no row leaves the warehouse
  for it and nothing is random: the same series gives the same forecast.

THE METHOD (defensible with numpy alone - requirements.txt has no
statsmodels and gains nothing for this)
  Additive exponential smoothing in its error-correction (state space)
  form, Hyndman et al. 2008:
      l_t = l_{t-1} + phi b_{t-1} + alpha e_t
      b_t = phi b_{t-1} + beta e_t
      s_t = s_{t-m} + gamma e_t
      e_t = y_t - (l_{t-1} + phi b_{t-1} + s_{t-m})
  Three rungs, chosen by a rolling-origin backtest:
    1. damped-trend Holt-Winters, season length m (12 for months, 4 for
       quarters, 7 for days, 52 for weeks) - only when at least two full
       seasons (plus the backtest's hold-out) exist;
    2. damped Holt (no season) otherwise;
    3. seasonal naive ("the same month last year") as the FLOOR: when a
       season exists and neither smoother beats it in the backtest, it is
       the forecast.
  Parameters minimise the sum of squared ONE-STEP-AHEAD errors, found by a
  deterministic vectorised grid search with two zoom-in rounds (alpha in
  (0, 1), beta < alpha, gamma < 1 - alpha, phi in [0.8, 0.98]) - no
  optimiser start values, no randomness. Initial states come from a
  classical decomposition of the training window.

PREDICTION INTERVALS
  From the EMPIRICAL distribution of the model's own OUT-OF-SAMPLE errors:
  the chosen model is refitted at each of the last (up to) 24 origins and
  its 1..h step forecasts compared with what actually followed. The band
  at horizon h is
      sigma x sqrt(1 + sum_{j<h} c_j^2) x r_h x Q_p
  sigma  the fit's one-step error scale; the square root the model's own
         forecast-variance multiplier (c_j = alpha + beta (phi + .. +
         phi^j) + gamma [m | j]; seasonal naive: sqrt(floor((h-1)/m) + 1));
  r_h    how much larger the out-of-sample errors at horizon h really were
         than that formula says (in-sample fit always flatters a model);
  Q_p    the 10th/90th and 2.5th/97.5th percentiles of those standardised
         errors, with the finite-sample correction of split-conformal
         prediction, never tighter than 60% of a normal quantile.
  A band never narrows as the horizon grows. Coverage is checked against
  held-out data in a 300-series simulation in test_charts_forecast.py.

THE BACKTEST
  Rolling origin, up to 6 folds one period apart, each fold refitted on
  its own training window and scored on the next h periods: MAPE, sMAPE
  and MASE (mean absolute error scaled by the in-sample mean absolute
  error of the seasonal naive, Hyndman & Koehler 2006). The baseline's own
  scores are reported beside the model's.

WHEN THERE IS NO FORECAST (each with a plain sentence, never a guess)
  - fewer complete periods than MIN_HISTORY for the grain;
  - more than 20% of the periods have no value (a non-additive measure) -
    gaps of an additive measure are zeros, not gaps;
  - the series is constant-free of information (fewer than 3 distinct values);
  - no season exists and damped Holt is worse than repeating the last
    value in the backtest (by more than 5%);
  - more than MAX_SERIES series on one chart.

PARTIAL PERIODS
  A bucket the data only partly covers (the current month, or the first
  month when the data starts mid-month) is found from the date bounds of
  the time column and EXCLUDED from the fit; it is reported so the chart
  can draw it dashed and say "partial period".

BOUNDS
  A series that was never negative is never forecast below zero; a rate
  stays within [0, 1]. Both bounds apply to the intervals as well.

ANOMALIES
  The same model's one-step errors, scored with a robust z (median / MAD,
  threshold 3.5 - Iglewicz & Hoaglin). Isolated spikes are set aside and
  the model refitted once without them, so a spike neither bends the
  forecast nor makes its own neighbours look unusual; a run of three or
  more in one direction is a level shift, kept in the fit.
"""
from __future__ import annotations

import calendar
import hashlib
import json
import math
from datetime import date, timedelta

import numpy as np

GRAINS = ("day", "week", "month", "quarter", "year")
SEASON_LENGTH = {"day": 7, "week": 52, "month": 12, "quarter": 4, "year": 1}
MIN_HISTORY = {"day": 14, "week": 12, "month": 12, "quarter": 8, "year": 5}
DEFAULT_HORIZON = {"day": 14, "week": 8, "month": 6, "quarter": 4, "year": 3}
MAX_HORIZON = {"day": 90, "week": 26, "month": 24, "quarter": 8, "year": 5}
GRAIN_PLURAL = {"day": "days", "week": "weeks", "month": "months", "quarter": "quarters", "year": "years"}
MAX_SERIES = 4
MAX_FOLDS = 6
MAX_GAP_SHARE = 0.2
BASELINE_TOLERANCE = 1.05
SEASONAL_PREFERENCE = 1.05
ANOMALY_Z = 3.5
INTERVALS = ("80", "95", "both")
METHOD_LABEL = {"hw": "damped Holt-Winters", "holt": "damped Holt", "snaive": "seasonal naive", "naive": "last value"}

_Z80, _Z95 = 1.2815515655446004, 1.959963984540054


# ---- periods ---------------------------------------------------------------------

def parse_period(text) -> date | None:
    if isinstance(text, date):
        return text
    if not isinstance(text, str) or len(text) < 7:
        return None
    try:
        y, m = int(text[0:4]), int(text[5:7])
        d = int(text[8:10]) if len(text) >= 10 and text[8:10].isdigit() else 1
        return date(y, m, d)
    except (ValueError, TypeError):
        return None


def next_period(d: date, grain: str, steps: int = 1) -> date:
    if grain == "day":
        return d + timedelta(days=steps)
    if grain == "week":
        return d + timedelta(days=7 * steps)
    months = {"month": 1, "quarter": 3, "year": 12}[grain] * steps
    index = d.year * 12 + (d.month - 1) + months
    y, m = divmod(index, 12)
    return date(y, m + 1, min(d.day, calendar.monthrange(y, m + 1)[1]))


def period_end(d: date, grain: str) -> date:
    """The last day the bucket starting at `d` covers."""
    return next_period(d, grain) - timedelta(days=1)


def grain_word(grain: str, n: int) -> str:
    return grain if n == 1 else GRAIN_PLURAL.get(grain, f"{grain}s")


def partial_periods(periods: list[str], grain: str, bounds: dict | None, today: date | None = None) -> dict:
    """{"first": {...} | None, "last": {...} | None}: buckets the data only
    partly covers. `bounds` = {"min": "YYYY-MM-DD", "max": "YYYY-MM-DD"} of
    the time column (already narrowed to the page's date range). Without
    bounds, only a bucket that contains `today` is known to be partial."""
    out: dict = {"first": None, "last": None}
    if not periods or grain == "day":
        return out
    first, last = parse_period(periods[0]), parse_period(periods[-1])
    if first is None or last is None:
        return out
    lo = parse_period((bounds or {}).get("min")) if bounds else None
    hi = parse_period((bounds or {}).get("max")) if bounds else None
    end = period_end(last, grain)
    total = (end - last).days + 1
    if hi is not None and last <= hi < end:
        out["last"] = {"period": periods[-1], "through": hi.isoformat(), "days": (hi - last).days + 1, "of": total}
    elif hi is None and today is not None and last <= today < end:
        out["last"] = {"period": periods[-1], "through": today.isoformat(), "days": (today - last).days + 1, "of": total}
    if lo is not None and len(periods) > 1:
        first_end = period_end(first, grain)
        if first < lo <= first_end:
            out["first"] = {"period": periods[0], "from": lo.isoformat(), "days": (first_end - lo).days + 1, "of": (first_end - first).days + 1}
    return out


# ---- exponential smoothing, vectorised over parameter sets ---------------------------

def _initial_states(y: np.ndarray, m: int, seasonal: bool) -> tuple[float, float, np.ndarray | None]:
    """(level, trend, seasonal indices) to start the recursion from: a
    classical additive decomposition (centred moving average) for the
    seasonal indices, then a straight line through the first deseasoned
    points for level and trend."""
    n = len(y)
    s0 = None
    des = y
    if seasonal:
        if m % 2 == 0:
            w = np.concatenate(([0.5], np.ones(m - 1), [0.5])) / m
        else:
            w = np.ones(m) / m
        trend = np.convolve(y, w, mode="valid")
        offset = (len(w) - 1) // 2
        detr = y[offset: offset + len(trend)] - trend
        pos = (np.arange(len(detr)) + offset) % m
        s0 = np.array([detr[pos == j].mean() if np.any(pos == j) else 0.0 for j in range(m)], dtype=float)
        s0 = s0 - s0.mean()
        des = y - s0[np.arange(n) % m]
    k = int(min(n, max(10, m if seasonal else 10)))
    if k >= 2:
        slope, intercept = np.polyfit(np.arange(k, dtype=float), des[:k], 1)
    else:
        slope, intercept = 0.0, float(des[0])
    return float(intercept - slope), float(slope), s0


def _ets_filter(y: np.ndarray, m: int, alpha, beta, gamma, phi, init, want_errors: bool = False):
    """Runs the recursion for G parameter sets at once (alpha .. phi are
    arrays of length G; gamma None = no season). Returns (sse[G], errors
    [G, n] | None, (level[G], trend[G], season[G, m] | None))."""
    alpha = np.atleast_1d(np.asarray(alpha, dtype=float))
    G = alpha.shape[0]
    beta = np.broadcast_to(np.asarray(beta, dtype=float), (G,))
    phi = np.broadcast_to(np.asarray(phi, dtype=float), (G,))
    l0, b0, s0 = init
    level = np.full(G, l0, dtype=float)
    trend = np.full(G, b0, dtype=float)
    seasonal = gamma is not None and s0 is not None
    season = np.tile(s0, (G, 1)) if seasonal else None
    if seasonal:
        gamma = np.broadcast_to(np.asarray(gamma, dtype=float), (G,))
    sse = np.zeros(G, dtype=float)
    errors = np.empty((G, len(y)), dtype=float) if want_errors else None
    for t in range(len(y)):
        damped = phi * trend
        pred = level + damped
        if seasonal:
            j = t % m
            pred = pred + season[:, j]
        e = y[t] - pred
        level = level + damped + alpha * e
        trend = damped + beta * e
        if seasonal:
            season[:, j] = season[:, j] + gamma * e
        sse += e * e
        if want_errors:
            errors[:, t] = e
    return sse, errors, (level, trend, season)


_ALPHAS = np.array([0.02, 0.05, 0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 0.95])
_BETA_FR = np.array([0.0, 0.05, 0.15, 0.3, 0.6])       # beta = fraction x alpha
_GAMMA_FR = np.array([0.0, 0.05, 0.15, 0.3, 0.6])      # gamma = fraction x (1 - alpha)
_PHIS = np.array([0.8, 0.9, 0.98])


def _grid(seasonal: bool) -> np.ndarray:
    axes = [_ALPHAS, _BETA_FR, _GAMMA_FR if seasonal else np.array([0.0]), _PHIS]
    mesh = np.meshgrid(*axes, indexing="ij")
    return np.stack([a.ravel() for a in mesh], axis=1)


def _refine(center: np.ndarray, widths: np.ndarray, seasonal: bool) -> np.ndarray:
    steps = np.array([-1.0, 0.0, 1.0])
    axes = []
    bounds = [(0.01, 0.99), (0.0, 0.95), (0.0, 0.95), (0.8, 0.98)]
    for i in range(4):
        if i == 2 and not seasonal:
            axes.append(np.array([0.0]))
            continue
        lo, hi = bounds[i]
        axes.append(np.unique(np.clip(center[i] + steps * widths[i], lo, hi)))
    mesh = np.meshgrid(*axes, indexing="ij")
    return np.stack([a.ravel() for a in mesh], axis=1)


def fit_ets(y: np.ndarray, m: int, seasonal: bool) -> dict:
    """Fits damped Holt (seasonal False) or damped Holt-Winters to `y` by
    minimising the one-step-ahead SSE. Returns the parameters, the final
    states and the one-step errors."""
    y = np.asarray(y, dtype=float)
    init = _initial_states(y, m, seasonal)

    def score(grid: np.ndarray) -> np.ndarray:
        a = grid[:, 0]
        sse, _e, _s = _ets_filter(y, m, a, grid[:, 1] * a, grid[:, 2] * (1 - a) if seasonal else None, grid[:, 3], init)
        return sse

    grid = _grid(seasonal)
    sse = score(grid)
    best_i = int(np.argmin(sse))
    best, best_sse = grid[best_i], float(sse[best_i])
    widths = np.array([0.05, 0.08, 0.08, 0.04])
    for _round in range(2):
        local = _refine(best, widths, seasonal)
        s = score(local)
        i = int(np.argmin(s))
        if float(s[i]) < best_sse:
            best, best_sse = local[i], float(s[i])
        widths = widths / 2.5
    a, bf, gf, phi = (float(v) for v in best)
    alpha, beta, gamma = a, bf * a, (gf * (1 - a) if seasonal else 0.0)
    sse1, errors, (level, trend, season) = _ets_filter(
        y, m, np.array([alpha]), np.array([beta]), np.array([gamma]) if seasonal else None, np.array([phi]), init, want_errors=True,
    )
    return {
        "method": "hw" if seasonal else "holt", "m": m if seasonal else 1,
        "alpha": alpha, "beta": beta, "gamma": gamma, "phi": phi,
        "level": float(level[0]), "trend": float(trend[0]), "season": season[0].copy() if season is not None else None,
        "errors": errors[0], "n": len(y), "sse": float(sse1[0]),
    }


def _phi_sums(phi: float, h: int) -> np.ndarray:
    """phi + phi^2 + .. + phi^j for j = 1..h."""
    return np.cumsum(phi ** np.arange(1, h + 1))


def forecast_mean(fit: dict, h: int, y: np.ndarray | None = None) -> np.ndarray:
    """The point forecast for steps 1..h."""
    if fit["method"] in ("snaive", "naive"):
        m = fit["m"]
        tail = np.asarray(y, dtype=float)[-m:]
        return np.array([tail[(k % m)] for k in range(h)], dtype=float)
    out = fit["level"] + _phi_sums(fit["phi"], h) * fit["trend"]
    if fit.get("season") is not None:
        m, n = fit["m"], fit["n"]
        out = out + np.array([fit["season"][(n + k) % m] for k in range(h)])
    return out


def variance_multipliers(fit: dict, h: int) -> np.ndarray:
    """sqrt of the h-step forecast-variance multiplier, for h = 1..h."""
    if fit["method"] in ("snaive", "naive"):
        m = fit["m"]
        return np.sqrt(np.floor(np.arange(h) / m) + 1.0)
    alpha, beta, gamma, phi, m = fit["alpha"], fit["beta"], fit["gamma"], fit["phi"], fit["m"]
    c = alpha + beta * _phi_sums(phi, max(h, 1))
    if fit.get("season") is not None and m > 1:
        j = np.arange(1, len(c) + 1)
        c = c + gamma * (j % m == 0)
    cum = np.concatenate(([0.0], np.cumsum(c * c)))[:h]
    return np.sqrt(1.0 + cum)


def fit_naive(y: np.ndarray, m: int) -> dict:
    """Seasonal naive (m > 1) or last-value naive (m == 1): the errors are
    the (seasonal) differences."""
    y = np.asarray(y, dtype=float)
    errors = y[m:] - y[:-m] if len(y) > m else np.array([], dtype=float)
    return {"method": "snaive" if m > 1 else "naive", "m": m, "errors": errors, "n": len(y)}


def _fit(method: str, y: np.ndarray, m: int) -> dict:
    if method == "hw":
        return fit_ets(y, m, True)
    if method == "holt":
        return fit_ets(y, m, False)
    if method == "snaive":
        return fit_naive(y, m)
    return fit_naive(y, 1)


# ---- backtest ------------------------------------------------------------------------

def backtest_plan(n: int, m: int, horizon: int, seasonal: bool) -> dict | None:
    """Fold origins for a rolling-origin backtest of a series of n points,
    or None when fewer than two folds fit. The hold-out is `horizon`
    periods (at most a fifth of the history), shortened when that is what
    it takes to get three folds."""
    min_train = max(2 * m, 8) if seasonal else 8
    target = max(1, min(horizon, n // 5 if n >= 10 else 1))
    best = None
    for h in range(target, 0, -1):
        folds = min(MAX_FOLDS, n - min_train - h + 1)
        if folds >= 3:
            best = (h, folds)
            break
        if folds >= 2 and best is None:
            best = (h, folds)
    if best is None:
        return None
    h, folds = best
    last_origin = n - h
    return {"h": h, "origins": [last_origin - (folds - 1 - i) for i in range(folds)]}


def backtest(y, m: int, method: str, plan: dict) -> dict:
    """Refits `method` on each fold's training window and scores the next
    plan["h"] periods. MAPE and sMAPE are fractions (0.084 = 8.4%); MASE
    scales by the training window's in-sample MAE of the seasonal naive at
    lag `m` (the plain naive when m is 1) - the same scale for every
    method compared."""
    y = np.asarray(y, dtype=float)
    lag = m if m > 1 else 1
    abs_err: list[float] = []
    ape: list[float] = []
    sape: list[float] = []
    scaled: list[float] = []
    for origin in plan["origins"]:
        train, actual = y[:origin], y[origin: origin + plan["h"]]
        fit = _fit(method, train, m if method in ("hw", "snaive") else 1)
        pred = forecast_mean(fit, len(actual), train)
        diffs = np.abs(train[lag:] - train[:-lag]) if len(train) > lag else np.array([])
        scale = float(diffs.mean()) if len(diffs) and diffs.mean() > 0 else None
        for a, p in zip(actual, pred):
            err = abs(float(a) - float(p))
            abs_err.append(err)
            if a != 0:
                ape.append(err / abs(float(a)))
            denom = abs(float(a)) + abs(float(p))
            sape.append(0.0 if denom == 0 else 2.0 * err / denom)
            if scale:
                scaled.append(err / scale)
    return {
        "mae": float(np.mean(abs_err)) if abs_err else None,
        "mape": float(np.mean(ape)) if ape else None,
        "smape": float(np.mean(sape)) if sape else None,
        "mase": float(np.mean(scaled)) if scaled else None,
        "folds": len(plan["origins"]), "horizon": plan["h"], "points": len(abs_err),
    }


# ---- intervals -----------------------------------------------------------------------------

def _quantile(sorted_values: np.ndarray, level: float) -> float:
    """The `level` quantile by linear interpolation between order statistics."""
    return float(np.quantile(sorted_values, min(1.0, max(0.0, level))))


def _sigma(fit: dict) -> float:
    """The one-step error scale of a fitted model (root mean square, with
    the degrees of freedom its parameters used up)."""
    e = np.asarray(fit["errors"], dtype=float)
    e = e[np.isfinite(e)]
    if not len(e):
        return 0.0
    params = 0 if fit["method"] in ("snaive", "naive") else (4 if fit["method"] == "hw" else 3)
    return math.sqrt(float(np.sum(e * e)) / max(1, len(e) - params))


CALIBRATION_ORIGINS = 24
CALIBRATION_MIN_POINTS = 8


def out_of_sample_errors(y: np.ndarray, m: int, method: str, horizon: int, max_origins: int = CALIBRATION_ORIGINS) -> list[list[float]]:
    """Standardised out-of-sample errors by horizon: the model is REFITTED
    on y[:o] for each of the last `max_origins` origins o and its 1..h
    step forecasts compared with what followed; each error is divided by
    that fit's own one-step scale times its variance multiplier, so a
    well-specified model gives values around a standard normal and an
    over-confident one gives larger ones."""
    y = np.asarray(y, dtype=float)
    n = len(y)
    mm = m if method in ("hw", "snaive") else 1
    min_train = max(2 * mm, 8) if mm > 1 else 8
    z: list[list[float]] = [[] for _ in range(horizon)]
    for origin in range(max(min_train, n - max_origins), n):
        train = y[:origin]
        fit = _fit(method, train, mm)
        sigma = _sigma(fit)
        if not sigma > 0:
            continue
        steps = min(horizon, n - origin)
        pred = forecast_mean(fit, steps, train)
        mult = variance_multipliers(fit, steps)
        for h in range(steps):
            z[h].append(float((y[origin + h] - pred[h]) / (sigma * mult[h])))
    return z


def interval_factors(fit: dict, y: np.ndarray, m: int, horizon: int) -> dict:
    """What turns a point forecast into bands: for h = 1..horizon the
    signed offsets {"lo80", "hi80", "lo95", "hi95"} (arrays), built from
    the EMPIRICAL distribution of the model's own out-of-sample errors.

      scale   sigma (the fit's one-step error scale) x the model's
              variance multiplier at h x r_h, where r_h is the root mean
              square of the standardised out-of-sample errors at that
              horizon (smoothed over neighbouring horizons, and carried
              forward past the horizons the history can test) - the
              factor by which in-sample fit understates real forecast
              error;
      shape   the 10th / 90th and 2.5th / 97.5th percentiles of those
              errors pooled over horizons (each divided by its r_h), with
              the split-conformal finite-sample correction ((K + 1) / K
              for K origins tested) and never tighter than 60% of the
              normal quantile;
      widening  a band never narrows as the horizon grows.

    With too little history to test (fewer than 12 out-of-sample errors)
    the in-sample one-step errors give the shape and r_h is 1.15."""
    sigma = _sigma(fit)
    mult = variance_multipliers(fit, horizon)
    z = out_of_sample_errors(y, m, fit["method"], horizon)
    pooled_n = sum(len(v) for v in z)
    r = np.full(horizon, 1.15)
    shape: np.ndarray
    source = "in-sample"
    if pooled_n >= 12 and len(z[0]) >= CALIBRATION_MIN_POINTS:
        raw = np.array([math.sqrt(float(np.mean(np.square(v)))) if len(v) >= CALIBRATION_MIN_POINTS else np.nan for v in z])
        known = np.nonzero(np.isfinite(raw))[0]
        last = int(known[-1])
        raw[last + 1:] = raw[last]
        raw = np.where(np.isfinite(raw), raw, raw[last])
        padded = np.concatenate(([raw[0]], raw, [raw[-1]]))
        r = np.clip((padded[:-2] + padded[1:-1] + padded[2:]) / 3.0, 0.8, 3.0)
        shape = np.concatenate([np.asarray(v, dtype=float) / r[h] for h, v in enumerate(z) if len(v)])
        source = "out-of-sample"
    else:
        e = np.asarray(fit["errors"], dtype=float)
        shape = e[np.isfinite(e)] / sigma if sigma > 0 else np.zeros(1)
    k = len(shape)
    srt = np.sort(shape)
    # The finite-sample correction counts INDEPENDENT looks at the future:
    # the origins tested (errors at different horizons from one origin
    # overlap), or the residuals themselves when there was no test.
    looks = len(z[0]) if source == "out-of-sample" else k
    adj = (looks + 1) / looks if looks else 1.0
    q = {}
    for name, p, zq in (("80", 0.10, _Z80), ("95", 0.025, _Z95)):
        lo = _quantile(srt, 1 - (1 - p) * adj) if k >= 3 else -zq
        hi = _quantile(srt, (1 - p) * adj) if k >= 3 else zq
        q[f"lo{name}"] = min(lo, -0.6 * zq)
        q[f"hi{name}"] = max(hi, 0.6 * zq)
    # The 80% band is the well-estimated one; a 95% band is at least as
    # much wider than it as a normal law would make it (1.53x), because a
    # 2.5% tail read off a few dozen errors is the weakest number here.
    q["lo95"] = min(q["lo95"], q["lo80"] * (_Z95 / _Z80))
    q["hi95"] = max(q["hi95"], q["hi80"] * (_Z95 / _Z80))
    width = sigma * mult * r
    out = {"source": source, "errors": int(k), "inflation": [round(float(v), 3) for v in r]}
    for key, value in q.items():
        band = value * width
        out[key] = np.minimum.accumulate(band) if key.startswith("lo") else np.maximum.accumulate(band)
    return out


# ---- anomalies -------------------------------------------------------------------------------

def robust_scale(errors: np.ndarray) -> tuple[float, float]:
    """(median, scale) of the errors: scale = 1.4826 x MAD, falling back to
    1.2533 x the mean absolute deviation when more than half are equal."""
    e = np.asarray(errors, dtype=float)
    e = e[np.isfinite(e)]
    if not len(e):
        return 0.0, 0.0
    med = float(np.median(e))
    mad = float(np.median(np.abs(e - med)))
    scale = 1.4826 * mad
    if scale <= 0:
        scale = 1.2533 * float(np.mean(np.abs(e - med)))
    return med, scale


def _flags(errors: np.ndarray, start: int, threshold: float = ANOMALY_Z) -> tuple[np.ndarray, float, float]:
    """Boolean flags (aligned to `errors`) of |robust z| > threshold,
    ignoring the first `start` warm-up errors."""
    flags = np.zeros(len(errors), dtype=bool)
    if len(errors) - start < 6:
        return flags, 0.0, 0.0
    med, scale = robust_scale(errors[start:])
    if scale <= 0:
        return flags, med, scale
    z = (errors - med) / scale
    flags[start:] = np.abs(z[start:]) > threshold
    return flags, med, scale


def _isolated(flags: np.ndarray, errors: np.ndarray) -> np.ndarray:
    """Flagged points that are spikes (runs of one or two in a direction),
    not the start of a level shift (three or more in a row, same sign)."""
    out = np.zeros(len(flags), dtype=bool)
    i = 0
    n = len(flags)
    while i < n:
        if not flags[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and flags[j + 1] and (errors[j + 1] > 0) == (errors[i] > 0):
            j += 1
        if j - i + 1 <= 2:
            out[i: j + 1] = True
        i = j + 1
    return out


# ---- one series ---------------------------------------------------------------------------------

def _refuse(reason: str, **extra) -> dict:
    return {"status": "refused", "reason": reason, "points": [], "method": None, "method_key": None, "season_length": None,
            "backtest": None, "notes": [], "anomalies": [], **extra}


def forecast_series(
    periods: list[str], values: list, grain: str = "month", horizon: int | None = None, interval: str = "both",
    additive: bool = True, lower: float | None = None, upper: float | None = None, partial: dict | None = None,
    want_anomalies: bool = True,
) -> dict:
    """The forecast of ONE series. `periods` are ISO bucket starts in
    order; `values` the numbers (None = no row for that bucket).
    `additive`: a count or a sum, so a missing bucket is a zero.
    `lower` / `upper`: hard bounds (0 for a never-negative series is
    applied automatically; pass 0 and 1 for a rate). `partial`: the result
    of partial_periods() - those buckets are left out of the fit.

    Returns {"status": "ok" | "refused", "reason", "points": [{period,
    value, lo80, hi80, lo95, hi95}], "method", "method_key",
    "season_length", "backtest", "notes", "anomalies", "fitted_through",
    "excluded": [periods], "params"}."""
    grain = grain if grain in GRAINS else "month"
    m_full = SEASON_LENGTH[grain]
    plural = GRAIN_PLURAL[grain]
    notes: list[str] = []

    # 1. The regular calendar between the first and last complete bucket.
    pairs = [(parse_period(p), v, p) for p, v in zip(periods, values)]
    pairs = [(d, v, p) for d, v, p in pairs if d is not None]
    pairs.sort(key=lambda x: x[0])
    excluded: list[str] = []
    if partial:
        for key in ("first", "last"):
            info = partial.get(key)
            if info and pairs and info.get("period") in (pairs[0][2], pairs[-1][2]):
                excluded.append(info["period"])
        pairs = [x for x in pairs if x[2] not in excluded]
        if partial.get("last") and partial["last"].get("period") in excluded:
            info = partial["last"]
            notes.append(f"The last {grain} is incomplete (data through {info.get('through')}), so it is left out of the fit.")
        if partial.get("first") and partial["first"].get("period") in excluded:
            notes.append(f"The first {grain} is incomplete, so it is left out of the fit.")
    if not pairs:
        return _refuse(f"Not enough history to forecast: 0 {plural}; at least {MIN_HISTORY[grain]} are needed.", excluded=excluded)
    by_date = {d: v for d, v, _p in pairs}
    calendar_dates: list[date] = []
    cursor, end = pairs[0][0], pairs[-1][0]
    guard = 0
    while cursor <= end and guard < 5000:
        calendar_dates.append(cursor)
        cursor = next_period(cursor, grain)
        guard += 1
    raw = [by_date.get(d) for d in calendar_dates]
    y = np.array([float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else np.nan for v in raw])
    n = len(y)
    need = MIN_HISTORY[grain]
    if n < need:
        return _refuse(f"Not enough history to forecast: {n} {grain_word(grain, n)}; at least {need} are needed.", excluded=excluded)

    # 2. Gaps: zeros for an additive measure, a bounded interpolation otherwise.
    missing = np.isnan(y)
    gaps = int(missing.sum())
    if gaps:
        if additive:
            y = np.where(missing, 0.0, y)
            notes.append(f"{gaps} {grain_word(grain, gaps)} with no rows {'counts' if gaps == 1 else 'count'} as zero.")
        else:
            if gaps / n > MAX_GAP_SHARE:
                return _refuse(f"Too many gaps to forecast: {gaps} of {n} {plural} have no value.", excluded=excluded)
            idx = np.arange(n)
            y = np.interp(idx, idx[~missing], y[~missing])
            notes.append(f"{gaps} {grain_word(grain, gaps)} with no value {'was' if gaps == 1 else 'were'} filled in between {'its' if gaps == 1 else 'their'} neighbours.")
    # Long daily / weekly histories: the most recent stretch is what a
    # smoother learns from anyway, and it keeps a run in milliseconds.
    cap = max(240, 5 * m_full)
    if n > cap:
        y, calendar_dates, missing = y[-cap:], calendar_dates[-cap:], missing[-cap:]
        n = cap
        notes.append(f"Fitted on the latest {cap} {plural}.")
    if len(np.unique(np.round(y, 12))) < 3:
        return _refuse("Nothing to forecast: this series has fewer than three different values.", excluded=excluded)

    lo_bound = lower if lower is not None else (0.0 if float(np.min(y)) >= 0 else None)
    hi_bound = upper
    horizon = int(horizon) if isinstance(horizon, (int, float)) and horizon else DEFAULT_HORIZON[grain]
    horizon = max(1, min(horizon, MAX_HORIZON[grain], max(1, n // 2)))

    # 3. Which models can be compared: a season needs two full seasons in
    #    the EARLIEST backtest fold.
    seasonal_ok = m_full > 1 and n >= 2 * m_full
    plan = backtest_plan(n, m_full, horizon, seasonal_ok) if seasonal_ok else None
    if seasonal_ok and (plan is None or plan["origins"][0] < 2 * m_full):
        seasonal_ok = False
        plan = None
    if not seasonal_ok:
        plan = backtest_plan(n, 1, horizon, False)
        if m_full > 1 and grain != "year":
            notes.append(f"Less than two full seasons of {plural} to learn a seasonal pattern from, so none is assumed.")
    m = m_full if seasonal_ok else 1
    candidates = (["hw"] if seasonal_ok else []) + ["holt"]
    baseline = "snaive" if seasonal_ok else "naive"

    def run(series: np.ndarray) -> dict:
        scores: dict[str, dict] = {}
        if plan is not None:
            for method in candidates + [baseline]:
                scores[method] = backtest(series, m, method, plan)
        chosen = candidates[0]
        refused = None
        if plan is not None:
            # Ties go to the plainer model: the seasonal one must be clearly
            # better (5%) than damped Holt to be preferred.
            def cost(c: str) -> float:
                mae = scores[c]["mae"]
                return math.inf if mae is None else mae * (1.0 if c == "holt" else SEASONAL_PREFERENCE)
            best = min(candidates, key=lambda c: (cost(c), candidates.index(c)))
            base_mae = scores[baseline]["mae"]
            best_mae = scores[best]["mae"]
            chosen = best
            if base_mae is not None and best_mae is not None and best_mae > BASELINE_TOLERANCE * base_mae:
                if baseline == "snaive":
                    chosen = "snaive"
                else:
                    refused = (
                        "No forecast: in a backtest a trend model was no better than repeating the last value "
                        f"(mean error {best_mae:,.4g} against {base_mae:,.4g}), so a projection would not be trustworthy."
                    )
        fit = _fit(chosen, series, m if chosen in ("hw", "snaive") else 1)
        return {"scores": scores, "chosen": chosen, "refused": refused, "fit": fit}

    first = run(y)
    fit_y = y
    result = first
    # 4. Anomalies: score the one-step errors; refit once without isolated spikes.
    anomalies: list[dict] = []
    cleaned = 0
    if want_anomalies and first["refused"] is None:
        fit0 = first["fit"]
        offset0 = n - len(fit0["errors"])
        warm = 0 if fit0["method"] in ("snaive", "naive") else min(max(2, fit0["m"]), max(0, len(fit0["errors"]) - 6))
        flags0, _med0, _scale0 = _flags(fit0["errors"], warm)
        spikes = _isolated(flags0, fit0["errors"])
        if spikes.any():
            expected0 = y[offset0:] - fit0["errors"]
            clean = y.copy()
            clean[offset0:][spikes] = expected0[spikes]
            cleaned = int(spikes.sum())
            fit_y = clean
            result = run(clean)
            if result["refused"] is not None:
                fit_y, result, cleaned = y, first, 0
    if result["refused"] is not None:
        return _refuse(result["refused"], excluded=excluded, backtest=_public_backtest(result["scores"], result["chosen"], baseline))
    fit = result["fit"]
    chosen = result["chosen"]

    # One-step expectations of the final model for the ORIGINAL values.
    offset = n - len(fit["errors"])
    expected = fit_y[offset:] - fit["errors"]
    residual = y[offset:] - expected
    warm = 0 if fit["method"] in ("snaive", "naive") else min(max(2, fit["m"]), max(0, len(residual) - 6))
    if want_anomalies:
        flags, med, scale = _flags(residual, warm)
        # At most one point in ten: more than that is the model, not the data.
        if flags.sum() > max(1, len(residual) // 10):
            order = np.argsort(-np.abs(residual - med))
            keep = np.zeros(len(flags), dtype=bool)
            keep[order[: max(1, len(residual) // 10)]] = True
            flags &= keep
        for i in np.nonzero(flags)[0]:
            t = offset + int(i)
            if missing[t]:
                continue
            exp = float(expected[i])
            band = ANOMALY_Z * scale
            anomalies.append({
                "period": calendar_dates[t].isoformat(), "value": float(y[t]), "expected": _bound(exp, lo_bound, hi_bound),
                "lo": _bound(exp + med - band, lo_bound, hi_bound), "hi": _bound(exp + med + band, lo_bound, hi_bound),
                "direction": "up" if y[t] > exp else "down",
            })
    if cleaned:
        notes.append(f"{cleaned} unusual {grain_word(grain, cleaned)} {'was' if cleaned == 1 else 'were'} set aside when fitting.")

    # 5. Point forecast and intervals.
    mean = forecast_mean(fit, horizon, fit_y)
    off = interval_factors(fit, fit_y, m, horizon)
    points = []
    cursor = calendar_dates[-1]
    for k in range(horizon):
        cursor = next_period(cursor, grain)
        v = _bound(float(mean[k]), lo_bound, hi_bound)
        point = {"period": cursor.isoformat(), "value": v}
        for name in ("80", "95"):
            lo = _bound(float(mean[k] + off[f"lo{name}"][k]), lo_bound, hi_bound)
            hi = _bound(float(mean[k] + off[f"hi{name}"][k]), lo_bound, hi_bound)
            point[f"lo{name}"] = min(lo, v)
            point[f"hi{name}"] = max(hi, v)
        points.append(point)
    if interval == "80":
        for p in points:
            p.pop("lo95", None)
            p.pop("hi95", None)
    elif interval == "95":
        for p in points:
            p.pop("lo80", None)
            p.pop("hi80", None)

    scores = result["scores"]
    if chosen == "snaive":
        notes.append(f"Exponential smoothing did not beat \"the same {grain} one season earlier\" in the backtest, so the forecast repeats the last season.")
    if plan is None:
        notes.append("Too little history for a backtest, so no error is reported.")
    if lo_bound == 0 and any(p["value"] == 0 for p in points):
        notes.append("This series is never negative, so the forecast is held at zero.")
    return {
        "status": "ok", "reason": None, "points": points, "method": METHOD_LABEL[chosen], "method_key": chosen,
        "season_length": m if chosen in ("hw", "snaive") and m > 1 else None,
        "backtest": _public_backtest(scores, chosen, baseline), "notes": notes, "anomalies": anomalies,
        "fitted_through": calendar_dates[-1].isoformat(), "history_points": n, "excluded": excluded, "horizon": horizon,
        "params": {k: round(float(fit[k]), 4) for k in ("alpha", "beta", "gamma", "phi") if k in fit},
        "bounds": {"lower": lo_bound, "upper": hi_bound},
        "intervals": {"source": off["source"], "errors": off["errors"], "inflation": off["inflation"]},
    }


def _bound(v: float, lo: float | None, hi: float | None) -> float:
    if lo is not None and v < lo:
        v = lo
    if hi is not None and v > hi:
        v = hi
    return float(v)


def _round(v, digits: int = 6):
    return None if v is None else round(float(v), digits)


def _public_backtest(scores: dict, chosen: str, baseline: str) -> dict | None:
    s = scores.get(chosen)
    if not s:
        return None
    b = scores.get(baseline) or {}
    return {
        "mape": _round(s.get("mape")), "smape": _round(s.get("smape")), "mase": _round(s.get("mase")), "mae": _round(s.get("mae")),
        "folds": s.get("folds"), "horizon": s.get("horizon"),
        "baseline": {"method": METHOD_LABEL[baseline], "method_key": baseline, "mape": _round(b.get("mape")),
                     "smape": _round(b.get("smape")), "mae": _round(b.get("mae"))},
    }


# ---- a block's result ---------------------------------------------------------------------------

def normalize_options(raw, grain: str = "month") -> dict | None:
    """config.forecast as stored -> {"horizon", "interval", "anomalies"},
    or None when forecasting is off / the value is not usable."""
    if raw is True:
        raw = {}
    if not isinstance(raw, dict) or raw.get("enabled") is False:
        return None
    grain = grain if grain in GRAINS else "month"
    horizon = raw.get("horizon")
    try:
        horizon = int(horizon) if horizon is not None else DEFAULT_HORIZON[grain]
    except (TypeError, ValueError):
        horizon = DEFAULT_HORIZON[grain]
    horizon = max(1, min(MAX_HORIZON[grain], horizon))
    interval = str(raw.get("interval") or "both")
    if interval not in INTERVALS:
        interval = "both"
    return {"horizon": horizon, "interval": interval, "anomalies": bool(raw.get("anomalies", False))}


def fingerprint(*parts) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def forecast_result(
    rows: list[dict], time_column: str, measures: list[dict], series_column: str | None, grain: str, options: dict,
    bounds: dict | None = None, today: date | None = None, partial: dict | None = None,
) -> dict:
    """The forecast of a block's result: `rows` are its aggregated rows,
    `measures` [{alias, additive, rate}] the measure columns, and
    `series_column` the group-by column a multi-series line is split by
    (None for one line per measure).

    Returns {"status", "reason", "horizon", "interval", "grain",
    "series": [{"key", "measure", <forecast_series fields>}], "partial",
    and - for the first series - "points", "method", "season_length",
    "backtest", "notes" at the top level} plus "anomalies" (a list across
    series, each with "series")."""
    grain = grain if grain in GRAINS else "month"
    periods = sorted({str(r.get(time_column)) for r in rows if r.get(time_column) is not None})
    if partial is None:
        partial = partial_periods(periods, grain, bounds, today)
    base = {"horizon": options["horizon"], "interval": options["interval"], "grain": grain, "partial": partial}
    if not periods or not measures:
        return {**base, "status": "refused", "reason": "A forecast needs a measure over time.", "series": [], "points": [], "notes": [],
                "method": None, "season_length": None, "backtest": None, "anomalies": []}
    specs: list[tuple[str, dict, list[dict]]] = []
    if series_column:
        m = measures[0]
        keys: list = []
        for r in rows:
            k = r.get(series_column)
            if k not in keys:
                keys.append(k)
        for k in keys:
            specs.append(("(Blanks)" if k is None else str(k), m, [r for r in rows if r.get(series_column) == k]))
    else:
        for m in measures:
            specs.append((m["alias"], m, rows))
    if len(specs) > MAX_SERIES:
        reason = (
            f"Forecasts are drawn for up to {MAX_SERIES} series on one chart; this one has {len(specs)}. "
            "Filter it, or remove the breakdown, to forecast."
        )
        return {**base, "status": "refused", "reason": reason, "series": [], "points": [], "notes": [], "method": None,
                "season_length": None, "backtest": None, "anomalies": []}
    series_out: list[dict] = []
    anomalies: list[dict] = []
    for key, m, subset in specs:
        by_period = {str(r.get(time_column)): r.get(m["alias"]) for r in subset if r.get(time_column) is not None}
        own = [p for p in periods if p in by_period] if not m.get("additive", True) else periods
        if m.get("additive", True) and by_period:
            # An additive series spans the chart's whole range from its own first period on.
            first_own = min(by_period)
            own = [p for p in periods if p >= first_own]
        f = forecast_series(
            own, [by_period.get(p) for p in own], grain=grain, horizon=options["horizon"], interval=options["interval"],
            additive=bool(m.get("additive", True)), lower=0.0 if m.get("rate") else None, upper=1.0 if m.get("rate") else None,
            partial=partial, want_anomalies=bool(options.get("anomalies")),
        )
        for a in f.pop("anomalies", []) or []:
            anomalies.append({**a, "series": key, "measure": m["alias"]})
        series_out.append({"key": key, "measure": m["alias"], **f})
    ok = [s for s in series_out if s["status"] == "ok"]
    head = ok[0] if ok else series_out[0]
    out = {
        **base,
        "status": "ok" if ok else "refused",
        "reason": None if ok else head.get("reason"),
        "series": series_out,
        "points": head.get("points") or [], "method": head.get("method"), "season_length": head.get("season_length"),
        "backtest": head.get("backtest"), "notes": head.get("notes") or [],
        "anomalies": anomalies if options.get("anomalies") else [],
    }
    return out

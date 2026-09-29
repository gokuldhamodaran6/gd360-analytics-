"""
Turns a pandas result (DataFrame/Series) + a chart spec into a fully
JSON-serializable Plotly figure (data + layout) that the frontend renders
with react-plotly.js. Using Plotly (not static PNGs) is what makes charts
interactive - zoom, hover, export - like Tableau/Power BI, and it natively
supports the full range of chart types a data analyst reaches for, from a
simple bar chart to radar, sankey, candlestick and geo maps.

`build_figure` accepts a wide vocabulary of chart_type values (the same
catalog the frontend Style picker "More chart types" search lists).
A handful of the more specialized types (sankey, candlestick/ohlc, gauge,
choropleth, parallel coordinates, 3D scatter, density heatmap) need the
underlying result to have a particular shape - e.g. sankey needs
source/target/value columns. When the result does not have that shape, we
raise a clear, descriptive ValueError rather than silently substituting a
different chart; the caller (ai_engine._run_analyze) already treats that as
a retryable failure, so the AI gets a chance to reshape its own code to fit,
or the person is told plainly what is missing - never a silent switch to
something else.

Two chart shapes get extra analytical depth automatically, with no chart_type
of their own to ask for - the AI just needs to hand back a normal scatter or
bar result, and this file does the rest, the way a working data analyst
would reach for these by reflex rather than plotting the bare numbers:

  - "scatter" always tries to fit and draw a linear trend line with a shaded
    confidence band on top of the raw points (see `_fit_regression`), plus a
    plain-English read of the relationship's strength/direction/significance
    in the corner - a bare cloud of dots answers "what are the values" but
    not "is there a relationship here", which is almost always the real
    question behind a scatter plot request.
  - "bar"/"column" against a result that actually carries TWO numeric
    metrics per category (e.g. an average transaction count next to an
    average dollar amount) automatically becomes a dual-axis combo instead
    of a single flat bar - metric one as bars on the left axis, metric two
    as an annotated line on its own right-hand axis (see
    `_build_dual_axis_combo`). Forcing two differently-scaled metrics onto
    one shared axis is how a $72 line and a 5.7 count end up looking like a
    flat line at the bottom of the chart; giving the second metric its own
    axis is what makes both readable at once.
"""
from __future__ import annotations

import json
import re
import warnings
from typing import Any

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import plotly.express as px
from plotly.subplots import make_subplots
from scipy import stats as scipy_stats

DARK_TEMPLATE = "plotly_dark"

# 2026-09-29 (visual redesign, round 1): replaces the previous 10-hue set
# (led by a violet that never matched GD360's own "no violet, no teal, one
# signature hue" brand rule in index.css, and never checked for
# colorblind-safety at all) with the 8 hues from this codebase's own dataviz
# skill reference palette (dark-surface column), in their documented,
# already-validated order. Run against the skill's validator
# (scripts/validate_palette.js) at these exact 8 values/order: adjacent-pair
# worst-case colorblind separation (protan/deutan/tritan) Delta E 8.4,
# worst-case normal-vision separation Delta E 19.3 - both clear the
# published floors, which the old palette did not (its worst adjacent pair,
# aqua-vs-magenta-equivalent, sat at Delta E 1.8, unreadable to someone with
# deuteranopia). A chart with 9+ real categories folds the extras into
# "Other" or a facet grid rather than reusing an unvalidated 9th/10th hue -
# see the dataviz skill's own non-negotiables on this. Index mapping is
# unchanged from before: PALETTE[i % len(PALETTE)] for a multi-series loop,
# and a handful of call sites below still reach for one fixed index (e.g.
# PALETTE[3] for every single-series line chart) purely so each chart TYPE
# keeps a stable, recognizable hue across the app - not because that slot
# means anything more than "the line-chart color".
PALETTE = [
    "#3987e5",  # 1 blue
    "#d95926",  # 2 orange
    "#199e70",  # 3 aqua
    "#c98500",  # 4 yellow
    "#d55181",  # 5 magenta
    "#008300",  # 6 green
    "#9085e9",  # 7 violet
    "#e66767",  # 8 red
]

# A single branded blue ramp (built from the same validated hue family as
# PALETTE[0]) for every chart that colors by magnitude rather than by
# category - heatmap, density heatmap, contour, choropleth, and the ordinal
# per-row tint on parallel coordinates. Ordered dark -> light so the low end
# recedes into this app's own dark chart surface and the high end is the
# brightest, most "hot" value, matching how every dashboard card actually
# renders (transparent plot background over a near-black card - see
# ChartCanvas.tsx). Replaces the generic Plotly "Viridis" default (a
# green-to-yellow scale with no relationship to GD360's own palette) at
# every one of its previous call sites below.
SEQUENTIAL_SCALE = [
    [0.0, "#0d366b"],
    [0.25, "#184f95"],
    [0.5, "#256abf"],
    [0.75, "#3987e5"],
    [1.0, "#9ec5f4"],
]

# The color used for an automatic regression trend line and its confidence
# band on a scatter plot - deliberately NOT one of the categorical PALETTE
# colors above, so it always reads as "analysis drawn on top of the data"
# rather than "one more data series", regardless of which palette the
# person later picks in the frontend Style panel (see chartStyle.ts -
# marker.meta.role is how that file recognizes and protects this trace from
# being recolored or captioned like a real series).
TREND_COLOR = "#E24C4C"

# The color used for an anomaly marker's ring + "!" badge (see
# apply_analysis_overlays below) - the same hex as TREND_COLOR above, but
# named separately on purpose: a trend line and a flagged unusual point are
# conceptually different overlays (one describes the whole series' shape,
# the other calls out one specific point that breaks it) that only
# coincidentally look right in the same red. If either color is ever tuned
# independently later, keeping these as two named constants means that
# change doesn't silently drag the other one along with it.
ANOMALY_COLOR = "#E24C4C"

# meta.role values apply_analysis_overlays adds/removes - kept as one set so
# both the "strip anything I added before" idempotency step and any future
# caller that needs to recognize these traces (see chartStyle.ts's
# isDecorativeTrace) have one place that lists them.
_ANALYSIS_OVERLAY_ROLES = {"forecast_line", "forecast_band", "anomaly_markers"}

# Chart types that render as a continuous color gradient rather than
# discrete series colors - used by chartStyle.ts on the frontend too, but
# also useful here as documentation of which build_figure branches use a
# colorscale instead of PALETTE.
GRADIENT_CHART_TYPES = {"heatmap", "contour", "density_heatmap", "choropleth"}


def _numeric_cols(frame: Any) -> list:
    if not isinstance(frame, pd.DataFrame):
        return []
    return [c for c in frame.columns if pd.api.types.is_numeric_dtype(frame[c])]


def _find_col(columns, *keywords) -> Any | None:
    """Case-insensitive best-effort match of a column name against any of
    the given keywords (substring match), used for chart types that need a
    specific semantic column (e.g. sankey source/target/value, or
    candlestick open/high/low/close) that a generic 2-column pipeline
    would not otherwise identify."""
    for c in columns:
        lc = str(c).lower()
        if any(k in lc for k in keywords):
            return c
    return None


def _series_or_first_col(obj: pd.DataFrame | pd.Series) -> pd.Series:
    if isinstance(obj, pd.Series):
        return obj
    return obj.iloc[:, 0]


def _fit_regression(x_raw: Any, y_raw: Any):
    """Fits a simple linear trend line through (x, y) with a 95% confidence
    band, the same statistical picture a working analyst would sanity-check
    a scatter plot with before calling a pattern "real". Returns None
    (never raises) whenever there is not enough clean, varying numeric data
    to fit anything meaningful - fewer than 4 usable points, or every x the
    same value - so the caller can just fall back to a plain, undecorated
    scatter rather than showing a misleading or broken trend line.

    Returns (fit_x, fit_y, upper, lower, r_value, p_value, slope) as plain
    numpy arrays / floats, ready to drop straight into Plotly traces."""
    x = pd.to_numeric(pd.Series(x_raw), errors="coerce")
    y = pd.to_numeric(pd.Series(y_raw), errors="coerce")
    mask = x.notna() & y.notna()
    x = x[mask].to_numpy(dtype=float)
    y = y[mask].to_numpy(dtype=float)
    n = len(x)
    if n < 4 or np.unique(x).size < 2:
        return None
    try:
        slope, intercept, r_value, p_value, _std_err = scipy_stats.linregress(x, y)
    except Exception:
        return None
    if not np.isfinite([slope, intercept, r_value, p_value]).all():
        return None

    fit_x = np.linspace(float(x.min()), float(x.max()), 60)
    fit_y = slope * fit_x + intercept

    mean_x = float(x.mean())
    sxx = float(np.sum((x - mean_x) ** 2))
    dof = n - 2
    if dof > 0 and sxx > 0:
        residuals = y - (slope * x + intercept)
        mse = float(np.sum(residuals ** 2) / dof)
        s = mse ** 0.5
        try:
            t_val = float(scipy_stats.t.ppf(0.975, dof))
        except Exception:
            t_val = 1.96
        se_fit = s * np.sqrt(1.0 / n + (fit_x - mean_x) ** 2 / sxx)
        band = t_val * se_fit
    else:
        band = np.zeros_like(fit_x)

    return fit_x, fit_y, fit_y + band, fit_y - band, float(r_value), float(p_value), float(slope)


def _add_trend_overlay(fig: go.Figure, x_raw: Any, y_raw: Any) -> None:
    """Adds the confidence band and trend line traces (in that order, so
    the band sits visually behind the line) plus a plain-English summary
    annotation to a scatter figure already holding the raw data trace. Both
    added traces carry meta.role so chartStyle.ts on the frontend knows to
    leave their color, hover and legend alone rather than treating them as
    another real data series - see the note on TREND_COLOR above."""
    reg = _fit_regression(x_raw, y_raw)
    if reg is None:
        return
    fit_x, fit_y, upper, lower, r_value, p_value, slope = reg

    band_x = list(fit_x) + list(fit_x[::-1])
    band_y = list(upper) + list(lower[::-1])
    fig.add_trace(go.Scatter(
        x=band_x, y=band_y, fill="toself",
        fillcolor="rgba(226, 76, 76, 0.15)",
        line=dict(width=0),
        hoverinfo="skip", showlegend=False,
        meta={"role": "trend_band"},
    ))
    fig.add_trace(go.Scatter(
        x=list(fit_x), y=list(fit_y), mode="lines",
        line=dict(color=TREND_COLOR, width=2.5),
        hoverinfo="skip", showlegend=False,
        meta={"role": "trend_line"},
    ))

    direction = "positive" if slope > 0 else "negative" if slope < 0 else "flat"
    strength = "strong" if abs(r_value) >= 0.6 else "moderate" if abs(r_value) >= 0.3 else "weak"
    significance = "statistically significant" if p_value < 0.05 else "not statistically significant at this sample size"
    fig.add_annotation(
        xref="paper", yref="paper", x=0.99, y=0.03,
        xanchor="right", yanchor="bottom", showarrow=False, align="right",
        text=f"Trend: {strength} {direction} relationship  (r = {r_value:.2f}, {significance})",
        font=dict(size=12, color=TREND_COLOR),
    )


def _fit_forecast(pos: np.ndarray, y: np.ndarray, future_pos: np.ndarray):
    """Fits the same simple linear trend `_fit_regression` does (on ordinal
    POSITION, not raw x - see apply_analysis_overlays for why), but returns
    the WIDER *prediction interval* for the requested `future_pos` values
    instead of the narrower *confidence interval for the mean* that
    `_fit_regression`'s own in-sample band uses. The two formulas differ by
    exactly the leading "1 +" term inside the square root (`se_pred` here
    vs `se_fit` there) - a real statistical distinction, not a rounding
    nuance: a confidence interval only bounds uncertainty about where the
    AVERAGE line sits, while a prediction interval also has to account for
    the natural scatter of any one individual future point around that
    average - which is strictly wider, and is the honest thing to show for
    "where might a real future value actually land" rather than merely
    "where does the line best go." Reusing `_fit_regression` unmodified
    here would understate that uncertainty.

    Returns None (never raises) when there isn't enough clean, varying
    data to fit anything meaningful - same convention as `_fit_regression`.
    Otherwise returns (forecast_y, upper, lower, slope, intercept) as plain
    numpy arrays / floats for `future_pos`."""
    n = len(pos)
    if n < 4 or np.unique(pos).size < 2:
        return None
    try:
        slope, intercept, r_value, p_value, _std_err = scipy_stats.linregress(pos, y)
    except Exception:
        return None
    if not np.isfinite([slope, intercept, r_value, p_value]).all():
        return None

    forecast_y = slope * future_pos + intercept
    mean_x = float(pos.mean())
    sxx = float(np.sum((pos - mean_x) ** 2))
    dof = n - 2
    if dof > 0 and sxx > 0:
        residuals = y - (slope * pos + intercept)
        mse = float(np.sum(residuals ** 2) / dof)
        s = mse ** 0.5
        try:
            t_val = float(scipy_stats.t.ppf(0.975, dof))
        except Exception:
            t_val = 1.96
        # Note the "1 +" here - this is the whole difference from
        # _fit_regression's se_fit, and it's deliberate (see docstring).
        se_pred = s * np.sqrt(1.0 + 1.0 / n + (future_pos - mean_x) ** 2 / sxx)
        band = t_val * se_pred
    else:
        band = np.zeros_like(future_pos, dtype=float)

    return forecast_y, forecast_y + band, forecast_y - band, float(slope), float(intercept)


def _color_to_rgba(color: Any, alpha: float) -> str:
    """Converts a plain "#RRGGBB" hex color - what PALETTE and every
    build_figure branch above hands a trace's line/marker color as - into
    an rgba() string at the given alpha, for the forecast band's fill.
    This has to be generic (unlike _add_trend_overlay's hardcoded
    "rgba(226, 76, 76, 0.15)") because the forecast band must match
    whichever color the PRIMARY trace actually has, not one fixed color.
    Anything that isn't a plain 6-digit hex string (already an rgba()
    string, a CSS color name, etc) falls back to a neutral gray at the
    requested alpha, rather than raising over what is ultimately a
    cosmetic detail - a chart is still fully honest with a plain-gray band."""
    if isinstance(color, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        r, g, b = int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)
        return f"rgba({r}, {g}, {b}, {alpha})"
    return f"rgba(160, 160, 160, {alpha})"


def _infer_future_x(x_raw: list, periods: int) -> list:
    """Honestly extends a chart's x-axis `periods` steps past its last real
    point, for the forecast overlay's projected x values - never a guessed
    or arbitrary label sequence. Tries dates first (the common case for
    anything worth forecasting), then plain numbers, and raises a clear
    ValueError when neither fits, rather than emitting a misleading
    continuation of what are really just unordered category labels (e.g.
    product names) that have no honest "next value."

    Both paths infer the step size as the MEDIAN of consecutive
    differences (robust to one irregular gap) and then repeatedly add that
    step from the last real x value - so periods=3 after a monthly series
    keeps landing on month boundaries, not an arbitrary interpolation."""
    if len(x_raw) >= 2:
        # Genuine category strings (e.g. product names) will never parse as
        # dates - that's an expected, handled outcome here (falls through
        # to the numeric attempt, then to the honest ValueError below), not
        # a bug, so the noisy "could not infer format" warning pandas emits
        # for that case is deliberately silenced (same idiom
        # chart_suggester.py's profile_dataframe already uses for the same
        # reason).
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            as_dates = pd.to_datetime(pd.Series(x_raw), errors="coerce")
        if as_dates.notna().all():
            diffs = as_dates.diff().dropna()
            if len(diffs) > 0:
                step = diffs.median()
                last = as_dates.iloc[-1]
                return [(last + step * (i + 1)).isoformat() for i in range(periods)]

        as_numbers = pd.to_numeric(pd.Series(x_raw), errors="coerce")
        if as_numbers.notna().all():
            diffs = as_numbers.diff().dropna()
            if len(diffs) > 0:
                step = float(diffs.median())
                last = float(as_numbers.iloc[-1])
                return [last + step * (i + 1) for i in range(periods)]

    raise ValueError("This chart's x-axis isn't a date or number sequence, so GD360 can't project it forward.")


def apply_analysis_overlays(chart_spec: dict, forecast_enabled: bool, anomalies_enabled: bool):
    """Adds or removes the two optional, purely-presentational analysis
    overlays a chart block's kebab menu can toggle - "Show forecast" and
    "Show anomalies" - on top of an already-built chart_spec (the same
    go.Figure-shaped dict build_figure/restyle_block already produce).
    Neither overlay recomputes or reshapes the chart's real data; both
    read directly off the PRIMARY trace's own already-computed x/y arrays -
    the same honesty rule this whole module holds elsewhere: every
    projection and every flagged point comes from a real statistical
    computation on the chart's own numbers, never a fabricated one.

    IDEMPOTENT: any trace a PRIOR call to this function added is stripped
    first (tagged via meta.role - see _ANALYSIS_OVERLAY_ROLES), so toggling
    a switch off removes exactly what toggling it on added, and toggling it
    back on never leaves duplicate traces behind.

    The PRIMARY trace is the first trace in the figure whose meta.role is
    NOT set at all - this correctly skips over another feature's own
    decorative traces (e.g. a scatter chart's automatic trend_line/
    trend_band, or a faceted bar's facet_panel traces), which already carry
    a role of their own. When no such trace exists (an empty or entirely
    decorative figure), both toggles are no-ops - not an error, since there
    is genuinely nothing here to analyze.

    Returns a (chart_spec, anomaly_count) TUPLE, not just the spec:
      - anomaly_count is None when anomalies_enabled is False - the toggle
        wasn't requested, so there is nothing to report.
      - anomaly_count is an int (possibly 0) whenever anomalies_enabled is
        True. 0 is an honest "checked, found none" result, not a failure -
        the endpoint/frontend use it to show a plain "no unusual points
        detected" hint instead of silence.

    Raises ValueError (never anything else) with a clear, person-facing
    message whenever a requested overlay genuinely cannot be computed for
    this chart (wrong chart type/mode for forecasting, too few points, an
    x-axis with no honest way to project forward, or a chart shape with no
    y values to test at all for anomalies). Never fabricates a projection
    or a flagged point to paper over one of those cases."""
    fig = go.Figure(chart_spec)

    # Idempotency: strip whatever a previous call to this function added,
    # before doing anything else - so re-running with new toggle values
    # always starts from the figure's own real data, never from a
    # previously-drawn projection or anomaly marker.
    fig.data = tuple(
        t for t in fig.data
        if not (isinstance(t.meta, dict) and t.meta.get("role") in _ANALYSIS_OVERLAY_ROLES)
    )

    primary = None
    for t in fig.data:
        role = t.meta.get("role") if isinstance(t.meta, dict) else None
        if role is None:
            primary = t
            break

    if primary is None:
        # Nothing here to analyze (an empty figure, or one made up entirely
        # of other features' own tagged decorative traces) - both toggles
        # are honest no-ops, not errors.
        return json.loads(fig.to_json()), (0 if anomalies_enabled else None)

    if forecast_enabled:
        # Not every trace type has a .mode attribute at all (e.g. go.Bar) -
        # getattr with a default avoids an AttributeError for those rather
        # than crashing before we even get to the honest "wrong chart type"
        # ValueError below.
        mode = getattr(primary, "mode", None) or ""
        if primary.type != "scatter" or "lines" not in mode:
            raise ValueError("Forecasting only works on a line, area, or step chart.")

        x_raw = list(primary.x) if primary.x is not None else []
        y_raw = list(primary.y) if primary.y is not None else []

        y_series = pd.to_numeric(pd.Series(y_raw), errors="coerce")
        valid_mask = y_series.notna()
        valid_y = y_series[valid_mask].to_numpy(dtype=float)
        n = len(valid_y)
        if n < 4:
            raise ValueError("Not enough data points to forecast (need at least 4).")

        # Fit on ordinal POSITION among the valid points, not the raw x
        # values - raw x is very often a date or a category label, not a
        # number linregress can fit against.
        pos = np.arange(n, dtype=float)
        periods = max(2, min(8, round(n * 0.25)))
        future_pos = np.arange(n, n + periods, dtype=float)

        fit = _fit_forecast(pos, valid_y, future_pos)
        if fit is None:
            raise ValueError("Not enough data points to forecast (need at least 4).")
        forecast_y, upper, lower, _slope, _intercept = fit

        # Honest future x labels - dates/numbers only, real category labels
        # raise rather than being silently extended (see _infer_future_x).
        future_x = _infer_future_x(x_raw, periods)

        # The real last raw point, used to connect the dashed projection
        # visually to the real line (the band's width is exactly 0 there,
        # widening outward after it). If the raw series' very last point
        # happened to be the one dropped for a NaN y (a trailing gap), fall
        # back to the last VALID y value instead, so the junction is still
        # a real, honest number rather than NaN.
        last_x = x_raw[-1] if x_raw else n - 1
        last_y_raw = pd.to_numeric(pd.Series([y_raw[-1]]), errors="coerce").iloc[0] if y_raw else np.nan
        last_y = float(last_y_raw) if pd.notna(last_y_raw) else float(valid_y[-1])

        forecast_x = [last_x] + future_x
        forecast_y_full = [last_y] + list(forecast_y)
        band_x = [last_x] + future_x
        band_upper = [last_y] + list(upper)
        band_lower = [last_y] + list(lower)

        color = None
        if primary.line is not None and primary.line.color:
            color = primary.line.color
        elif getattr(primary, "marker", None) is not None and primary.marker.color:
            color = primary.marker.color
        if not color:
            color = PALETTE[0]

        band_x_full = list(band_x) + list(band_x[::-1])
        band_y_full = list(band_upper) + list(band_lower[::-1])
        # Band first, so it renders behind the dashed line (same ordering
        # _add_trend_overlay uses for its own confidence band).
        fig.add_trace(go.Scatter(
            x=band_x_full, y=band_y_full, fill="toself",
            fillcolor=_color_to_rgba(color, 0.15),
            line=dict(width=0),
            hoverinfo="skip", showlegend=False,
            meta={"role": "forecast_band"},
        ))
        fig.add_trace(go.Scatter(
            x=forecast_x, y=forecast_y_full, mode="lines",
            line=dict(color=color, width=2.5, dash="dash"),
            opacity=0.55,
            hovertemplate="Projected: %{y:.2f}<extra></extra>",
            showlegend=False,
            meta={"role": "forecast_line"},
        ))

    anomaly_count = None
    if anomalies_enabled:
        # Not every trace type even HAS an x/y array at all - a pie/donut/
        # sankey uses labels/values instead, and go.Pie has no .y attribute
        # whatsoever (not just None) - getattr with a default catches that
        # rather than crashing before the honest ValueError below.
        y_attr = getattr(primary, "y", None)
        y_raw = list(y_attr) if y_attr is not None else None
        if y_raw is None:
            raise ValueError("Anomaly detection isn't available on this chart type.")
        x_attr = getattr(primary, "x", None)
        x_raw = list(x_attr) if x_attr is not None else list(range(len(y_raw)))

        y_series = pd.to_numeric(pd.Series(y_raw), errors="coerce")
        valid_mask = y_series.notna()
        y = y_series[valid_mask].to_numpy(dtype=float)
        x_valid = [x_raw[i] for i in range(len(y_raw)) if valid_mask.iloc[i]]
        if len(y) == 0:
            raise ValueError("Anomaly detection isn't available on this chart type.")

        # Robust modified z-score (Iglewicz & Hoaglin) - median-based, so a
        # single extreme point can't drag the "normal" baseline toward
        # itself the way a mean/std-based z-score would.
        median = float(np.median(y))
        mad = float(np.median(np.abs(y - median)))
        scale = mad if mad != 0 else float(np.std(y))

        if scale == 0:
            # A perfectly flat series genuinely has no anomalies - an
            # honest, correct "0", not a failure.
            anomaly_count = 0
        else:
            modified_z = 0.6745 * (y - median) / scale
            flagged = np.abs(modified_z) > 3.5
            flagged_x = [x_valid[i] for i in range(len(y)) if flagged[i]]
            flagged_y = [float(y[i]) for i in range(len(y)) if flagged[i]]
            anomaly_count = len(flagged_y)

            if anomaly_count > 0:
                fig.add_trace(go.Scatter(
                    x=flagged_x, y=flagged_y, mode="markers+text",
                    marker=dict(symbol="circle-open", size=15, color=ANOMALY_COLOR, line=dict(width=2.5)),
                    text=["!"] * anomaly_count, textposition="top center",
                    textfont=dict(color=ANOMALY_COLOR, size=10),
                    hovertemplate="Unusual value: %{y}<extra></extra>",
                    showlegend=False,
                    meta={"role": "anomaly_markers"},
                ))

    return json.loads(fig.to_json()), anomaly_count


def _build_dual_axis_combo(result: pd.DataFrame, cols: list) -> go.Figure:
    """When a result naturally carries two numeric metrics per category
    (e.g. an average transaction count alongside an average dollar spend),
    a single shared axis is nearly always the wrong call - whichever metric
    has the smaller scale ends up a sliver next to the other, or a flat
    line along the bottom. This is the fix: metric one draws as bars on the
    left axis, metric two as an annotated line on its own right-hand axis -
    the same combo-chart pattern a working analyst reaches for whenever two
    related-but-differently-scaled numbers need to be read side by side
    against the same categories."""
    metric_a, metric_b = cols[0], cols[1]
    categories = [str(v) for v in result.index]
    a_vals = pd.to_numeric(result[metric_a], errors="coerce")
    b_vals = pd.to_numeric(result[metric_b], errors="coerce")

    # 2026-09-29 (visual redesign, round 1): both traces used to carry an
    # always-on text label on EVERY bar/point (texttemplate + textposition
    # "outside"/"top center") on top of the usual hover tooltip - which is
    # exactly what produced the jumbled, overlapping numbers on this chart
    # type in practice (two dense label sets fighting for the same vertical
    # space, worst on categories with many bars). The dataviz skill this
    # project follows is explicit on this: never a number on every point:
    # a chart page's job is to read the shape at a glance, and the exact
    # value for any one bar/point is what hover is for. Both traces keep
    # their real value in hover (Plotly's default hovertemplate already
    # shows it); neither draws permanent on-chart text anymore.
    fig = go.Figure()
    fig.add_trace(go.Bar(
        name=str(metric_a), x=categories, y=a_vals,
        marker_color=PALETTE[0], yaxis="y",
    ))
    fig.add_trace(go.Scatter(
        name=str(metric_b), x=categories, y=b_vals, yaxis="y2",
        mode="lines+markers",
        line=dict(color=PALETTE[2], width=3),
        marker=dict(size=9, color=PALETTE[2]),
    ))
    fig.update_layout(
        yaxis=dict(title=dict(text=str(metric_a)), rangemode="tozero"),
        yaxis2=dict(title=dict(text=str(metric_b)), overlaying="y", side="right", showgrid=False, rangemode="tozero"),
    )
    return fig


def _build_faceted_bar(result: pd.DataFrame) -> go.Figure:
    """Small multiples / facet grid: the "X by Y, in each Z" shape a working
    analyst reaches for constantly (e.g. "profit by sub-category in each
    market") and that, before this, GD360 had no way to draw at all - every
    other branch in this file draws exactly one set of axes, never a grid of
    them. One horizontal-bar panel is drawn per distinct value of the facet
    column, all panels sharing the same category order down the left side so
    they stay visually comparable at a glance, with a red zero-reference
    line through every panel - the same read as a ggplot facet_wrap chart.

    `result` MUST be a 3-column DataFrame/table in this exact order: (1) the
    column whose distinct values become the separate panels, (2) the
    category column shown as bars within every panel, (3) the numeric
    value. This shape is deliberately different from every other chart type
    in this file (which normalize down to at most 2 columns) because a
    facet grid genuinely needs a third dimension - which panel a row
    belongs to - that a 2-column result has no room to carry.
    """
    if not isinstance(result, pd.DataFrame) or result.shape[1] < 3:
        raise ValueError(
            "Faceted bar needs a result with three columns in this exact order: the column to split into "
            "separate panels (the \"in each ___\" column), the category column for the bars within every "
            "panel, and the numeric value - this result does not have all three."
        )
    cols = list(result.columns)
    facet_col, cat_col, val_col = cols[0], cols[1], cols[2]
    frame = result[[facet_col, cat_col, val_col]].copy()
    frame[val_col] = pd.to_numeric(frame[val_col], errors="coerce")

    facet_values = [str(v) for v in pd.unique(frame[facet_col])]
    if len(facet_values) < 2:
        raise ValueError(
            "Faceted bar needs at least two distinct panel values in the first column - a single value is "
            "not worth splitting into separate panels; use a plain bar chart instead."
        )
    if len(facet_values) > 24:
        raise ValueError(f"Faceted bar supports up to 24 panels; this result would need {len(facet_values)}.")

    # The same category order in every panel - the order categories first
    # appear in the result, not re-sorted alphabetically - so a caller that
    # already ordered them meaningfully (e.g. by total value) keeps that
    # order, and every panel reads the same top-to-bottom, which is what
    # makes a facet grid actually comparable at a glance.
    category_order = list(dict.fromkeys(str(v) for v in frame[cat_col]))

    n_cols = min(3, len(facet_values))
    n_rows = -(-len(facet_values) // n_cols)  # ceil division
    total_cells = n_rows * n_cols
    subplot_titles = facet_values + [""] * (total_cells - len(facet_values))

    fig = make_subplots(
        rows=n_rows, cols=n_cols, subplot_titles=subplot_titles,
        horizontal_spacing=0.09, vertical_spacing=0.16,
    )

    for i, facet_value in enumerate(facet_values):
        row, col = i // n_cols + 1, i % n_cols + 1
        panel = frame[frame[facet_col].astype(str) == facet_value]
        by_cat = panel.groupby(panel[cat_col].astype(str))[val_col].sum()
        values = [float(by_cat.get(c, 0.0)) for c in category_order]
        fig.add_trace(
            go.Bar(
                x=values, y=category_order, orientation="h",
                marker_color=PALETTE[0], name=facet_value, showlegend=False,
                meta={"role": "facet_panel", "facet": facet_value},
            ),
            row=row, col=col,
        )
        fig.add_vline(x=0, line_color=TREND_COLOR, line_width=1.5, row=row, col=col)

    # Unused grid cells (e.g. 7 panels in a 3x3 grid leaves 2 empty) get
    # their axes hidden entirely rather than left as empty, distracting box
    # outlines with no data in them.
    for i in range(len(facet_values), total_cells):
        row, col = i // n_cols + 1, i % n_cols + 1
        fig.update_xaxes(visible=False, row=row, col=col)
        fig.update_yaxes(visible=False, row=row, col=col)

    fig.update_yaxes(categoryorder="array", categoryarray=category_order)
    return fig


def build_figure(result: Any, chart_type: str, title: str = "", x_label: str | None = None, y_label: str | None = None) -> dict:
    chart_type = (chart_type or "bar").lower().strip()

    # Faceted bar needs its own three-column shape (facet column, category
    # column, value column) rather than the generic <=2-column "x"/"y"
    # normalization every other chart type below shares - so it is handled
    # entirely separately, before that normalization ever runs, and skips
    # straight to the shared closing layout block further down.
    if chart_type == "faceted_bar":
        fig = _build_faceted_bar(result)
        fig.update_layout(
            template=DARK_TEMPLATE,
            title=title or "",
            paper_bgcolor="rgba(0,0,0,0)",
            plot_bgcolor="rgba(0,0,0,0)",
            font=dict(family="Geist, Inter, system-ui, sans-serif", size=13, color="#E8E8F0"),
            margin=dict(l=76, r=28, t=72, b=68),
            hoverlabel=dict(bgcolor="#1E1E2E", font_size=13),
            legend=dict(bgcolor="rgba(0,0,0,0)", orientation="h", yanchor="bottom", y=1.02, xanchor="left", x=0),
        )
        # 2026-09-29 (visual redesign, round 1): every panel's own axis used
        # to keep Plotly's default fixed tick-label margin, which is exactly
        # why a panel's own category label (e.g. a division name like
        # "Sugar" on the left edge) could get clipped by the plot border -
        # there was no room reserved for it once it ran longer than Plotly's
        # guess. automargin makes every panel measure its own tick labels
        # and grow its margin to fit them, the same fix applied to every
        # other chart type in this file's closing layout block below.
        fig.update_xaxes(automargin=True)
        fig.update_yaxes(automargin=True)
        # A facet grid has no single shared axis pair to title - each panel
        # has its own - so instead of xaxis_title/yaxis_title (meaningless
        # here), the requested labels become one shared caption centered
        # under, and to the left of, the whole grid, the same read as the
        # R/ggplot reference chart's outer axis labels.
        if x_label:
            fig.add_annotation(
                text=x_label, xref="paper", yref="paper", x=0.5, y=-0.16,
                showarrow=False, font=dict(size=13),
            )
        if y_label:
            fig.add_annotation(
                text=y_label, xref="paper", yref="paper", x=-0.12, y=0.5,
                showarrow=False, textangle=-90, font=dict(size=13),
            )
        return json.loads(fig.to_json())

    numeric_cols = _numeric_cols(result)

    if isinstance(result, pd.Series):
        df = result.reset_index()
        df.columns = ["x", "y"]
    elif isinstance(result, pd.DataFrame):
        df = result.copy()
        if df.shape[1] == 1:
            df = df.reset_index()
            df.columns = ["x", "y"]
        else:
            cols = list(df.columns)
            df = df.rename(columns={cols[0]: "x", cols[1]: "y"})
    else:
        # scalar or unsupported -> wrap into a single-value bar
        df = pd.DataFrame({"x": ["value"], "y": [result]})

    fig = None
    barmode = None
    # Set when the dual-axis combo path below is used - its two axes each
    # already carry their own meaningful title (the metric name), so the
    # generic yaxis_title=y_label applied near the bottom of this function
    # must be skipped for it rather than blanking the left axis title out.
    dual_axis_combo_used = False

    # ---- Core / everyday chart types (unchanged from the original set) ----
    if chart_type in ("bar", "column"):
        # A result that genuinely carries two numeric metrics per category
        # (not just a single value plus its own index) gets the dual-axis
        # combo treatment automatically - see _build_dual_axis_combo above.
        # A single numeric column (the overwhelmingly common case) renders
        # exactly as before.
        if isinstance(result, pd.DataFrame) and len(numeric_cols) >= 2:
            fig = _build_dual_axis_combo(result, numeric_cols[:2])
            dual_axis_combo_used = True
        else:
            fig = go.Figure(go.Bar(x=df["x"], y=df["y"], marker_color=PALETTE[0]))
    elif chart_type == "line":
        fig = go.Figure(go.Scatter(x=df["x"], y=df["y"], mode="lines+markers", line=dict(color=PALETTE[3], width=3)))
    elif chart_type == "area":
        fig = go.Figure(go.Scatter(x=df["x"], y=df["y"], mode="lines", fill="tozeroy", line=dict(color=PALETTE[1])))
    elif chart_type == "pie":
        fig = go.Figure(go.Pie(labels=df["x"], values=df["y"], marker=dict(colors=PALETTE), hole=0.45))
    elif chart_type == "scatter":
        fig = go.Figure(go.Scatter(
            x=df["x"], y=df["y"], mode="markers",
            marker=dict(color=PALETTE[4], size=9, opacity=0.8, line=dict(width=1, color="rgba(255,255,255,0.35)")),
            meta={"role": "primary"},
        ))
        # A trend line only means something once the raw points are on the
        # chart - added on top of, never instead of, the actual data.
        _add_trend_overlay(fig, df["x"], df["y"])
    elif chart_type == "histogram":
        fig = go.Figure(go.Histogram(x=df["x"] if df["x"].dtype != object else df["y"], marker_color=PALETTE[2]))
    elif chart_type == "box":
        fig = go.Figure(go.Box(y=df["y"], x=df.get("x"), marker_color=PALETTE[5]))
    elif chart_type == "heatmap":
        # expects a wide-format numeric dataframe (e.g. a correlation matrix)
        fig = go.Figure(go.Heatmap(z=result.values, x=list(result.columns), y=list(result.index), colorscale=SEQUENTIAL_SCALE))
    elif chart_type == "waterfall":
        fig = go.Figure(go.Waterfall(
            x=df["x"], y=df["y"],
            connector={"line": {"color": "rgba(255,255,255,0.3)"}},
            increasing={"marker": {"color": PALETTE[2]}},
            decreasing={"marker": {"color": PALETTE[7]}},
            totals={"marker": {"color": PALETTE[0]}},
        ))
    elif chart_type == "funnel":
        fig = go.Figure(go.Funnel(x=df["y"], y=df["x"], marker=dict(color=PALETTE)))
    elif chart_type == "treemap":
        fig = go.Figure(go.Treemap(labels=df["x"], values=df["y"], parents=[""] * len(df), marker=dict(colors=PALETTE)))

    # ---- Comparison ----
    elif chart_type == "horizontal_bar":
        fig = go.Figure(go.Bar(x=df["y"], y=df["x"], orientation="h", marker_color=PALETTE[0]))
    elif chart_type in ("grouped_bar", "stacked_bar"):
        if len(numeric_cols) < 2:
            pretty_name = chart_type.replace("_", " ").title()
            raise ValueError(
                f"{pretty_name} needs at least two numeric columns to compare "
                f"side by side; this result only has {len(numeric_cols)}."
            )
        fig = go.Figure()
        for i, col in enumerate(numeric_cols):
            fig.add_trace(go.Bar(
                name=str(col), x=[str(v) for v in result.index],
                y=pd.to_numeric(result[col], errors="coerce"), marker_color=PALETTE[i % len(PALETTE)],
            ))
        barmode = "stack" if chart_type == "stacked_bar" else "group"
    elif chart_type == "radar":
        categories = [str(v) for v in result.index] if isinstance(result, (pd.Series, pd.DataFrame)) else [str(v) for v in df["x"]]
        if len(categories) < 3:
            raise ValueError(f"Radar needs at least 3 categories to plot around the circle; this result only has {len(categories)}.")
        fig = go.Figure()
        if numeric_cols:
            for i, col in enumerate(numeric_cols):
                values = list(pd.to_numeric(result[col], errors="coerce").fillna(0))
                fig.add_trace(go.Scatterpolar(
                    r=values + [values[0]], theta=categories + [categories[0]], fill="toself",
                    name=str(col), line=dict(color=PALETTE[i % len(PALETTE)]),
                ))
        else:
            values = list(pd.to_numeric(df["y"], errors="coerce").fillna(0))
            fig.add_trace(go.Scatterpolar(
                r=values + [values[0]], theta=categories + [categories[0]], fill="toself",
                name=title or "Series 1", line=dict(color=PALETTE[0]),
            ))
        fig.update_layout(polar=dict(radialaxis=dict(visible=True)))
    elif chart_type == "polar_bar":
        categories = [str(v) for v in result.index] if isinstance(result, (pd.Series, pd.DataFrame)) else [str(v) for v in df["x"]]
        if len(categories) < 3:
            raise ValueError(f"Polar bar needs at least 3 categories; this result only has {len(categories)}.")
        fig = go.Figure()
        if numeric_cols:
            for i, col in enumerate(numeric_cols):
                fig.add_trace(go.Barpolar(
                    r=list(pd.to_numeric(result[col], errors="coerce").fillna(0)), theta=categories,
                    name=str(col), marker_color=PALETTE[i % len(PALETTE)],
                ))
        else:
            fig.add_trace(go.Barpolar(r=list(pd.to_numeric(df["y"], errors="coerce").fillna(0)), theta=categories, marker_color=PALETTE[0]))
        fig.update_layout(polar=dict(radialaxis=dict(visible=True)))

    # ---- Trend over time ----
    elif chart_type == "stacked_area":
        fig = go.Figure()
        if numeric_cols:
            for i, col in enumerate(numeric_cols):
                fig.add_trace(go.Scatter(
                    name=str(col), x=[str(v) for v in result.index], y=pd.to_numeric(result[col], errors="coerce"),
                    mode="lines", stackgroup="one", line=dict(color=PALETTE[i % len(PALETTE)]),
                ))
        else:
            fig.add_trace(go.Scatter(x=df["x"], y=df["y"], mode="lines", stackgroup="one", line=dict(color=PALETTE[1])))
    elif chart_type == "step_line":
        fig = go.Figure(go.Scatter(x=df["x"], y=df["y"], mode="lines+markers", line=dict(color=PALETTE[3], width=3, shape="hv")))
    elif chart_type in ("candlestick", "ohlc"):
        if not isinstance(result, pd.DataFrame):
            raise ValueError(f"{chart_type.title()} needs Open, High, Low and Close columns - this result is not a table.")
        cols = list(result.columns)
        o, h, l, c = _find_col(cols, "open"), _find_col(cols, "high"), _find_col(cols, "low"), _find_col(cols, "close")
        if not (o and h and l and c):
            raise ValueError(f"{chart_type.title()} needs Open, High, Low and Close columns - this result does not have all four.")
        trace_cls = go.Candlestick if chart_type == "candlestick" else go.Ohlc
        fig = go.Figure(trace_cls(
            x=[str(v) for v in result.index], open=result[o], high=result[h], low=result[l], close=result[c],
        ))

    # ---- Distribution ----
    elif chart_type == "violin":
        if len(numeric_cols) >= 2:
            fig = go.Figure()
            for i, col in enumerate(numeric_cols):
                fig.add_trace(go.Violin(
                    y=pd.to_numeric(result[col], errors="coerce"), name=str(col),
                    box_visible=True, meanline_visible=True, line_color=PALETTE[i % len(PALETTE)],
                ))
        else:
            fig = go.Figure(go.Violin(
                y=pd.to_numeric(df["y"], errors="coerce"), name=title or "Distribution",
                box_visible=True, meanline_visible=True, line_color=PALETTE[5],
            ))
    elif chart_type == "dot_plot":
        fig = go.Figure(go.Scatter(x=df["y"], y=df["x"], mode="markers", marker=dict(size=11, color=PALETTE[4])))
    elif chart_type == "density_heatmap":
        if len(numeric_cols) < 2:
            raise ValueError(
                f"Density heatmap needs two numeric columns of raw, unaggregated values; this result has {len(numeric_cols)}."
            )
        fig = go.Figure(go.Histogram2d(
            x=pd.to_numeric(result[numeric_cols[0]], errors="coerce"),
            y=pd.to_numeric(result[numeric_cols[1]], errors="coerce"), colorscale=SEQUENTIAL_SCALE,
        ))

    # ---- Relationship ----
    elif chart_type == "bubble":
        if len(numeric_cols) < 2:
            raise ValueError("Bubble chart needs an x value and a y value (both numeric), and ideally a third numeric column for bubble size.")
        x_vals = pd.to_numeric(result[numeric_cols[0]], errors="coerce")
        y_vals = pd.to_numeric(result[numeric_cols[1]], errors="coerce")
        if len(numeric_cols) >= 3:
            size_vals = pd.to_numeric(result[numeric_cols[2]], errors="coerce").fillna(0)
            max_size = float(size_vals.max()) or 1.0
            sizes = (size_vals / max_size * 40 + 8).tolist()
        else:
            sizes = 18
        fig = go.Figure(go.Scatter(x=x_vals, y=y_vals, mode="markers", marker=dict(size=sizes, color=PALETTE[4], sizemode="diameter")))
    elif chart_type == "contour":
        if not isinstance(result, pd.DataFrame) or result.shape[1] < 2 or len(numeric_cols) != result.shape[1]:
            raise ValueError("Contour needs a fully numeric grid (e.g. a correlation or pivot matrix), the same as heatmap.")
        fig = go.Figure(go.Contour(z=result.values, x=[str(c) for c in result.columns], y=[str(i) for i in result.index], colorscale=SEQUENTIAL_SCALE))
    elif chart_type == "scatter_3d":
        if len(numeric_cols) < 3:
            raise ValueError(f"3D scatter needs three numeric columns (x, y and z); this result only has {len(numeric_cols)}.")
        fig = go.Figure(go.Scatter3d(
            x=pd.to_numeric(result[numeric_cols[0]], errors="coerce"),
            y=pd.to_numeric(result[numeric_cols[1]], errors="coerce"),
            z=pd.to_numeric(result[numeric_cols[2]], errors="coerce"),
            mode="markers", marker=dict(size=5, color=PALETTE[0]),
        ))
    elif chart_type == "error_bar":
        cols = list(result.columns) if isinstance(result, pd.DataFrame) else []
        err_col = cols[2] if len(cols) >= 3 else None
        if not err_col:
            raise ValueError("Error bar needs a value column plus a third numeric column to use as the margin of error / standard deviation.")
        fig = go.Figure(go.Scatter(
            x=df["x"], y=df["y"], mode="markers", marker=dict(size=10, color=PALETTE[4]),
            error_y=dict(type="data", array=list(pd.to_numeric(df[err_col], errors="coerce").fillna(0)), visible=True),
        ))

    # ---- Part-to-whole ----
    elif chart_type == "donut":
        fig = go.Figure(go.Pie(labels=df["x"], values=df["y"], marker=dict(colors=PALETTE), hole=0.65))
    elif chart_type == "sunburst":
        fig = go.Figure(go.Sunburst(labels=df["x"], values=df["y"], parents=[""] * len(df), marker=dict(colors=PALETTE)))
    elif chart_type == "icicle":
        fig = go.Figure(go.Icicle(labels=df["x"], values=df["y"], parents=[""] * len(df), marker=dict(colors=PALETTE)))
    elif chart_type == "funnel_area":
        fig = go.Figure(go.Funnelarea(labels=df["x"], values=df["y"], marker=dict(colors=PALETTE)))

    # ---- Flow & process ----
    elif chart_type == "sankey":
        if not isinstance(result, pd.DataFrame):
            raise ValueError("Sankey needs source, target and value columns (e.g. from/to/amount) - this result is not a table.")
        cols = list(result.columns)
        src_col = _find_col(cols, "source", "from")
        tgt_col = _find_col(cols, "target", "to")
        val_col = _find_col(cols, "value", "amount", "count", "weight")
        if not (src_col and tgt_col and val_col):
            raise ValueError("Sankey needs source, target and value columns (e.g. from/to/amount) - this result does not have them.")
        nodes = list(pd.unique(pd.concat([result[src_col], result[tgt_col]])))
        index = {n: i for i, n in enumerate(nodes)}
        fig = go.Figure(go.Sankey(
            node=dict(label=[str(n) for n in nodes], color=PALETTE[0], pad=15, thickness=16),
            link=dict(
                source=[index[v] for v in result[src_col]],
                target=[index[v] for v in result[tgt_col]],
                value=list(pd.to_numeric(result[val_col], errors="coerce").fillna(0)),
            ),
        ))

    # ---- Specialized ----
    elif chart_type == "gauge":
        try:
            if isinstance(result, pd.Series):
                value = float(pd.to_numeric(result, errors="coerce").dropna().iloc[0])
            elif isinstance(result, pd.DataFrame):
                value = float(pd.to_numeric(result.select_dtypes("number").iloc[:, 0], errors="coerce").dropna().iloc[0])
            else:
                value = float(result)
        except Exception:
            raise ValueError("Gauge needs a single numeric value - this result has more than one row or is not numeric.")
        fig = go.Figure(go.Indicator(
            mode="gauge+number", value=value,
            gauge=dict(axis=dict(range=[0, max(value * 1.5, value + 1, 1)]), bar=dict(color=PALETTE[0])),
        ))
    elif chart_type == "parallel_coordinates":
        if len(numeric_cols) < 2:
            raise ValueError(f"Parallel coordinates needs at least two numeric columns; this result only has {len(numeric_cols)}.")
        fig = go.Figure(go.Parcoords(
            line=dict(color=list(range(len(result))), colorscale=SEQUENTIAL_SCALE),
            dimensions=[
                dict(label=str(c), values=list(pd.to_numeric(result[c], errors="coerce").fillna(0)))
                for c in numeric_cols
            ],
        ))
    elif chart_type == "choropleth":
        if not isinstance(result, pd.DataFrame):
            raise ValueError("Choropleth needs a country/region column and a numeric value column - this result is not a table.")
        cols = list(result.columns)
        loc_col = _find_col(cols, "country", "iso", "region", "state", "code")
        val_col = next((c for c in numeric_cols if c != loc_col), None)
        if not (loc_col and val_col):
            raise ValueError("Choropleth needs a country/region column and a numeric value column - this result does not have both.")
        fig = go.Figure(go.Choropleth(
            locations=result[loc_col].astype(str), z=pd.to_numeric(result[val_col], errors="coerce"),
            locationmode="country names", colorscale=SEQUENTIAL_SCALE, marker_line_color="white",
        ))

    else:
        fig = go.Figure(go.Bar(x=df["x"], y=df["y"], marker_color=PALETTE[0]))

    if barmode:
        fig.update_layout(barmode=barmode)

    # 2026-09-29 (visual redesign, round 1): this whole block used to set
    # only a fixed 40/20/50/40px margin and no `automargin`, so a long axis
    # title or a wide tick label (a long category name, a currency-formatted
    # number) had nowhere to grow into and either overlapped the tick
    # labels next to it or got clipped at the card edge - the concrete bug
    # behind "Total Gross Profit ($)" overlapping its own "20k" tick, and
    # a heatmap category label getting cut off at the card border.
    # `automargin=True` makes Plotly measure the actual rendered text and
    # grow the margin to fit it every time; `title.standoff` adds a fixed
    # gap between the axis title and its tick labels so the two never touch
    # even once automargin has done its job. Also: the legend used to keep
    # Plotly's default placement (inside the top-right of the plot area),
    # which is exactly why a legend could sit on top of the tallest bars or
    # data points - moving it to a horizontal row above the plot (the same
    # placement used throughout the reference dashboards this round was
    # measured against) means it never overlaps a mark again. None of this
    # touches chart TYPE selection, data, or layout math - purely chrome.
    fig.update_layout(
        template=DARK_TEMPLATE,
        title=title or "",
        xaxis=dict(automargin=True, title=dict(text=x_label or "", standoff=10)),
        yaxis=dict(automargin=True, title=dict(standoff=12)),
        yaxis2=dict(automargin=True, title=dict(standoff=12)),
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font=dict(family="Geist, Inter, system-ui, sans-serif", size=13, color="#E8E8F0"),
        margin=dict(l=56, r=28, t=68, b=56),
        hoverlabel=dict(bgcolor="#1E1E2E", font_size=13),
        legend=dict(bgcolor="rgba(0,0,0,0)", orientation="h", yanchor="bottom", y=1.02, xanchor="left", x=0),
    )
    if not dual_axis_combo_used:
        # The normal case: one shared y axis, titled from the AI's own
        # y_label (or blank). The dual-axis combo above already gave each
        # of its two axes its own meaningful title (the metric name), so
        # it deliberately skips this generic overwrite (and never touches
        # automargin/standoff, both already set unconditionally above).
        fig.update_layout(yaxis=dict(title=dict(text=y_label or "")))

    # fig.to_json() guarantees full JSON-safety (numpy types, NaT, etc handled)
    return json.loads(fig.to_json())


def build_cleaning_summary_chart(
    rows_before: int, rows_after: int, nulls_before: int, nulls_after: int, title: str = "Data preparation summary"
) -> dict:
    """A small before/after chart shown whenever GD360 cleans or prepares
    data, so the effect of a cleaning step is visible at a glance rather
    than just described in text."""
    fig = go.Figure()
    fig.add_trace(go.Bar(name="Before", x=["Rows", "Missing values"], y=[rows_before, nulls_before], marker_color=PALETTE[2]))
    fig.add_trace(go.Bar(name="After", x=["Rows", "Missing values"], y=[rows_after, nulls_after], marker_color=PALETTE[1]))
    fig.update_layout(
        barmode="group",
        template=DARK_TEMPLATE,
        title=title,
        xaxis=dict(automargin=True),
        yaxis=dict(automargin=True, title=dict(standoff=12)),
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font=dict(family="Geist, Inter, system-ui, sans-serif", size=13, color="#E8E8F0"),
        margin=dict(l=56, r=28, t=68, b=56),
        legend=dict(bgcolor="rgba(0,0,0,0)", orientation="h", yanchor="bottom", y=1.02, xanchor="left", x=0),
    )
    return json.loads(fig.to_json())


def result_to_tidy(result: Any, max_rows: int = 4000) -> dict | None:
    """Serializes an analysis result (DataFrame/Series) into tidy JSON rows
    plus per-column metadata (name, dtype, dimension/measure role).

    This is what makes the frontend's "Explore" panel possible: instead of
    only ever receiving the one, already-built Plotly figure for whatever
    chart_type the AI picked, the client also gets the real underlying
    numbers this answer was computed from, so a person can switch chart
    type, remap X/Y/series/facet fields, or add a filter and see it
    re-plotted INSTANTLY in the browser - no new AI/pandas round trip - the
    same way Hex's own Explore panel re-plots a result cell.

    Returns None for anything that isn't meaningfully tabular (a bare
    scalar, or an empty/columnless frame) - those results have nothing for
    an Explore panel to remap, and the frontend falls back to the existing
    fixed-chart behavior for them.
    """
    if isinstance(result, pd.Series):
        df = result.reset_index()
        if df.shape[1] == 2:
            df.columns = ["label", "value"]
    elif isinstance(result, pd.DataFrame):
        # A named index (e.g. the result of a groupby) carries real
        # dimension data a person would want to plot by - pull it back into
        # an ordinary column rather than losing it. An unnamed default
        # RangeIndex carries nothing worth keeping.
        df = result.reset_index() if result.index.name else result.copy()
    else:
        return None

    if df.empty or df.shape[1] == 0:
        return None

    df.columns = [str(c) for c in df.columns]
    row_count = int(len(df))
    truncated = row_count > max_rows
    sample = df.head(max_rows)

    columns = []
    for col in df.columns:
        series = df[col]
        if pd.api.types.is_datetime64_any_dtype(series):
            dtype, role = "date", "dimension"
        elif pd.api.types.is_bool_dtype(series):
            dtype, role = "boolean", "dimension"
        elif pd.api.types.is_numeric_dtype(series):
            dtype, role = "number", "measure"
        else:
            dtype, role = "string", "dimension"
        columns.append({"name": col, "dtype": dtype, "role": role})

    try:
        rows = json.loads(sample.to_json(orient="records", date_format="iso"))
    except Exception:
        return None

    return {"columns": columns, "rows": rows, "row_count": row_count, "truncated": truncated}


def result_to_dataframe(result: Any) -> pd.DataFrame | None:
    """The full-fidelity counterpart to result_to_tidy above, for when a
    result needs to become a real saved table (see routers/chat.py's
    _save_named_results, 2026-09-28 named-results round) rather than a
    JSON preview: same normalization (a Series' index becomes a real
    "label" column instead of being dropped; a DataFrame's named index -
    e.g. the result of a groupby - is pulled back into an ordinary column
    too), but returns every row, not just the first max_rows, and skips
    the JSON round-trip entirely since this is going straight into a CSV
    snapshot, not a chat response. Returns None for the same "nothing
    meaningfully tabular here" cases result_to_tidy does (a bare scalar, or
    an empty/columnless frame) - there is nothing a real table could be
    made from those."""
    if isinstance(result, pd.Series):
        df = result.reset_index()
        if df.shape[1] == 2:
            df.columns = ["label", "value"]
    elif isinstance(result, pd.DataFrame):
        df = result.reset_index() if result.index.name else result.copy()
    else:
        return None

    if df.empty or df.shape[1] == 0:
        return None

    df.columns = [str(c) for c in df.columns]
    return df


def result_to_summary(result: Any, max_rows: int = 15) -> dict:
    """Compact, LLM-friendly summary of an analysis result, used for insight generation."""
    if isinstance(result, pd.Series):
        df = result.reset_index()
        df.columns = ["label", "value"]
    elif isinstance(result, pd.DataFrame):
        df = result
    else:
        return {"scalar_result": result}

    return {
        "shape": list(df.shape),
        "columns": list(map(str, df.columns)),
        "preview": json.loads(df.head(max_rows).to_json(orient="records")),
        "describe": json.loads(df.describe(include="all").to_json()) if not df.empty else {},
    }

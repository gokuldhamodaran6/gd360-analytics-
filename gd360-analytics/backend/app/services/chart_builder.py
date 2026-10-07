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
    metrics per category (e.g. total sales next to a customer count)
    automatically becomes a two-panel small-multiples comparison instead of
    a single flat bar - metric one in the left panel, metric two in the
    right panel, each on its own correctly-scaled axis, both panels sharing
    the same category order (see `_build_metric_comparison_panels`).

    2026-09-29 (round 5, real-bug fix): this used to be a DUAL-AXIS combo
    (one bar trace + one line trace sharing the same plot, metric two on a
    secondary y2 axis) - the standard "combo chart" pattern, but one this
    codebase's own dataviz skill explicitly flags as a non-negotiable
    anti-pattern ("Never a dual-axis chart... two measures of different
    scale -> two charts, small multiples, or indexed to a common base").
    Diagnosed directly against a live, already-broken dashboard: the old
    dual-axis version (a) pulled its category labels from `result.index`
    instead of the actual dimension column, so a normal 0..n RangeIndex
    silently replaced real category names ("At Risk", "Champions") with
    "0", "1", "2", "3" on the x-axis, and (b) with data labels on (which
    `defaultChartStyle` in chartStyle.ts turns on by default for exactly
    this chart shape), the bar's "outside" label and the line's "top
    center" label land at nearly the same pixel position for a category
    where both metrics are near their own axis's max - producing the
    garbled, overlapping numbers a real dashboard was showing in
    production. Small multiples sidesteps both: each panel has only one
    trace (no label collision is even possible) and real category labels
    straight from the dimension column, never the row index.
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

from .dtype_utils import coerce_dates_for_json

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

# 2026-10-05 (chart-TYPE selection audit): this codebase's own dataviz skill
# is explicit that a pie/donut is "part-to-whole at a glance only, <=6
# segments" (references/choosing-a-form.md) and separately flags "a
# donut/pie for comparing close values" and "more than ~7 color classes
# carrying meaning" as named anti-patterns. Before this fix, pie/donut built
# straight from whatever rows `result` had - a 12- or 20-category result
# (e.g. "revenue share by customer") drew a 12-/20-wedge pie with only the 8
# PALETTE hues to cycle through, so slice 9 silently reused slice 1's color
# (indistinguishable identity, not just a crowded chart) - exactly the
# "generated/cycled 9th hue" case the PALETTE comment above and the skill's
# own non-negotiables call out. _fold_small_slices_into_other keeps this a
# pie/donut (build_figure never silently substitutes a different chart type
# the AI/person asked for - see the module docstring) but folds every slice
# past the top 5 into one "Other" wedge first, the same "fold the tail"
# treatment the skill prescribes for an over-full categorical legend.
_MAX_PIE_SLICES = 6


def _fold_small_slices_into_other(labels: list, values: list, max_slices: int = _MAX_PIE_SLICES) -> tuple[list, list]:
    """For a pie/donut with more than `max_slices` categories, keeps the
    (max_slices - 1) largest-by-magnitude slices as-is and sums every
    remaining one into a single trailing "Other" slice - see _MAX_PIE_SLICES
    above for why. A no-op (returns labels/values unchanged, in their
    original order) when there are already max_slices or fewer."""
    pairs = list(zip(list(labels), list(values)))
    if len(pairs) <= max_slices:
        return labels, values

    def _as_float(v: Any) -> float:
        n = pd.to_numeric(v, errors="coerce")
        return float(n) if pd.notna(n) else 0.0

    numeric_pairs = [(lbl, _as_float(val)) for lbl, val in pairs]
    numeric_pairs.sort(key=lambda p: abs(p[1]), reverse=True)
    kept = numeric_pairs[: max_slices - 1]
    folded = numeric_pairs[max_slices - 1:]
    other_total = sum(v for _, v in folded)
    kept.append((f"Other ({len(folded)})", other_total))
    return [lbl for lbl, _ in kept], [v for _, v in kept]


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


# 2026-09-29 (round 6): the real 50 US states + DC, full name -> the
# 2-letter USPS abbreviation Plotly's locationmode="USA-states" actually
# requires. This exists specifically so a choropleth's location column is
# NEVER handed to Plotly's locationmode="country names" without first being
# checked against this table - see _resolve_us_state and the choropleth
# branch of build_figure below for the real, live bug this prevents: Plotly's
# "country names" matching is not a strict exact match the way its own docs
# imply, it silently does a loose/partial match, so a real US state name that
# happens to resemble a country's name gets SILENTLY drawn on that country
# instead. Confirmed live on Gokul's own "Unique Customers by State"
# dashboard block: "Indiana" (a state) rendered on India (the country)
# because "Indiana" contains "India" as a substring, and "New Mexico" /
# "Mexico" both landed on the country of Mexico the same way. This is a
# documented, widely-reported quirk of Plotly's country-name matching, not
# something specific to this app - the only real fix is to never let a
# non-country string reach that locationmode at all.
_US_STATE_NAMES: dict[str, str] = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
    "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
    "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
    "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
    "wisconsin": "WI", "wyoming": "WY", "district of columbia": "DC",
    "washington dc": "DC", "washington, dc": "DC",
}
_US_STATE_ABBRS = set(_US_STATE_NAMES.values())


def _resolve_us_state(value: Any) -> str | None:
    """EXACT (never fuzzy, never substring) match of a location string
    against the real 50 US states + DC, by full name or by its own 2-letter
    USPS abbreviation. Returns the 2-letter code Plotly's
    locationmode="USA-states" requires, or None if `value` isn't
    recognizably a US state at all - the caller never guesses past that
    None (a non-match is always excluded from the map, never mismapped onto
    the nearest-sounding place), which is the whole point of this
    function existing separately from Plotly's own loose matching."""
    s = str(value or "").strip()
    if not s:
        return None
    key = s.lower().replace(".", "")
    if key in _US_STATE_NAMES:
        return _US_STATE_NAMES[key]
    upper = s.upper()
    if upper in _US_STATE_ABBRS:
        return upper
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


def _build_metric_comparison_panels(result: pd.DataFrame, cols: list) -> go.Figure:
    """When a result naturally carries two numeric metrics per category
    (e.g. a customer count alongside a total-sales figure), a single shared
    axis is nearly always the wrong call - whichever metric has the smaller
    scale ends up a sliver next to the other. This used to reach for a
    dual-axis combo (bars + a secondary-axis line); it now draws two small
    side-by-side single-axis panels instead, one metric per panel, real
    category labels down/across both - the dataviz skill's own recommended
    fix for two differently-scaled measures ("two charts, small multiples,
    or indexed to a common base"), and the only version of this chart that
    cannot produce an overlapping data label, since each panel only ever
    has one trace.

    Categories come from the DataFrame's own first non-numeric column when
    one exists (the real dimension - e.g. "Segment") rather than
    `result.index`, which is almost always just a default 0..n RangeIndex
    after a groupby().reset_index() - reading the index here is exactly
    what silently turned real category names into "0", "1", "2", "3" in
    the dual-axis version this replaces."""
    metric_a, metric_b = cols[0], cols[1]
    dimension_col = next((c for c in result.columns if c not in (metric_a, metric_b)), None)
    if dimension_col is not None and not pd.api.types.is_numeric_dtype(result[dimension_col]):
        categories = [str(v) for v in result[dimension_col]]
    else:
        categories = [str(v) for v in result.index]
    a_vals = pd.to_numeric(result[metric_a], errors="coerce")
    b_vals = pd.to_numeric(result[metric_b], errors="coerce")

    fig = make_subplots(rows=1, cols=2, subplot_titles=[str(metric_a), str(metric_b)], horizontal_spacing=0.12)
    fig.add_trace(
        go.Bar(name=str(metric_a), x=categories, y=a_vals, marker_color=PALETTE[0], showlegend=False),
        row=1, col=1,
    )
    fig.add_trace(
        go.Bar(name=str(metric_b), x=categories, y=b_vals, marker_color=PALETTE[2], showlegend=False),
        row=1, col=2,
    )
    fig.update_yaxes(automargin=True, rangemode="tozero")
    fig.update_xaxes(automargin=True)
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
        # 2026-10-02 fix: bumped from 0.09 - still tight, but every panel
        # past the first no longer prints its own y-axis labels (see the
        # showticklabels pass below), so this gap only has to separate bars
        # from the panel beside them, not labels from bars.
        horizontal_spacing=0.12, vertical_spacing=0.16,
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
        # 2026-10-02 fix: only the leftmost panel in each row now prints its
        # y-axis category labels - every panel already shares the exact
        # same category order top-to-bottom (category_order above), so
        # repeating the same (often long) labels on every panel's own
        # y-axis, with barely any gap between panels, visually smeared them
        # together into unreadable text (e.g. "Senior Software Engineer"
        # bleeding into the panel to its left). This is also the standard
        # small-multiples convention, not just a fix for the overlap.
        # automargin=True on that one labeled column so long text gets real
        # room instead of being clipped.
        if col == 1:
            fig.update_yaxes(automargin=True, row=row, col=col)
        else:
            fig.update_yaxes(showticklabels=False, row=row, col=col)

    # Unused grid cells (e.g. 7 panels in a 3x3 grid leaves 2 empty) get
    # their axes hidden entirely rather than left as empty, distracting box
    # outlines with no data in them.
    for i in range(len(facet_values), total_cells):
        row, col = i // n_cols + 1, i % n_cols + 1
        fig.update_xaxes(visible=False, row=row, col=col)
        fig.update_yaxes(visible=False, row=row, col=col)

    fig.update_yaxes(categoryorder="array", categoryarray=category_order)
    return fig


def _whole_number_axis(x: Any, max_span: int = 30) -> dict:
    """2026-10-07 (real end-to-end run, "overall bookings every year"):
    axis settings for an x column of whole numbers used as a DIMENSION -
    years, a week number, a party size. Plotly sees numbers and draws a
    continuous axis, so three bars at 2015/2016/2017 got ticks at
    "2,014.5", "2015", "2,015.5"... - half-years that do not exist, with a
    thousands separator on a year. When every x value is a whole number
    and they span at most `max_span`, tick exactly on the whole numbers
    and print them plainly. Returns {} (change nothing) for text, dates,
    fractional numbers, or a wide numeric range, where Plotly's own tick
    choice is the right one."""
    try:
        values = pd.Series(x)
        if pd.api.types.is_bool_dtype(values) or not pd.api.types.is_numeric_dtype(values):
            return {}
        values = values.dropna().astype(float)
        if values.empty or not np.isfinite(values).all() or not (values == values.round()).all():
            return {}
        low, high = int(values.min()), int(values.max())
        if high - low > max_span:
            return {}
        return {"tickmode": "linear", "tick0": low, "dtick": 1, "tickformat": "d"}
    except Exception:
        return {}


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
    # True for a genuine [category, value] (or wider) tidy table - the shape
    # every chart type in this app normally works from, and the signal the
    # "histogram" branch below uses to tell an already-aggregated result
    # (must never be re-counted by Plotly) apart from genuinely raw,
    # unbinned data (a single value column, safe to hand to a real
    # Plotly Histogram trace for it to bin itself) - see that branch's own
    # comment for the concrete bug this was diagnosed against.
    is_pretidied_table = isinstance(result, pd.DataFrame) and result.shape[1] >= 2

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
    # Set when the two-panel metric-comparison path below is used - each of
    # its panels already carries its own heading (the metric name, drawn as
    # a subplot title), so the generic yaxis_title=y_label applied near the
    # bottom of this function would be meaningless for a 2-panel figure (it
    # would only ever label the left panel) and must be skipped entirely.
    # (Named for what it draws now - two side-by-side single-axis panels,
    # never a shared/secondary axis - see _build_metric_comparison_panels's
    # own docstring for why the old dual-axis version was replaced.)
    multi_panel_used = False

    # ---- Core / everyday chart types (unchanged from the original set) ----
    if chart_type in ("bar", "column"):
        # A result that genuinely carries two numeric METRICS per a
        # separate, real CATEGORY (e.g. "Segment" + "Customer Count" +
        # "Total Sales" - three columns, one of them the dimension) gets
        # the two-panel comparison treatment automatically - see
        # _build_metric_comparison_panels above.
        #
        # 2026-09-29 (round 5, real-bug fix): this used to trigger off
        # `len(numeric_cols) >= 2` alone, which also fired on a plain
        # 2-column [x, y] table where BOTH columns happen to be numeric -
        # e.g. "Units" (1, 2, 3...) against "Average Gross Profit" per
        # unit, where "Units" is really the x-axis dimension, not a
        # second metric to plot side by side. With no non-numeric column
        # left over once the two "metrics" are named,
        # _build_metric_comparison_panels' own dimension_col lookup found
        # nothing and fell back to result.index (0, 1, 2...) - silently
        # replacing the real Units values with a meaningless row-position
        # count, live-DB-confirmed on two production blocks ("Gross
        # Profit vs Units Sold", "Average Gross Profit by Order Volume
        # (Units)"). Requiring a genuine leftover non-numeric column
        # before treating this as a two-METRIC comparison at all sends a
        # plain two-numeric-column table down the ordinary single-series
        # bar path below instead, where "Units" renders as the real x-axis
        # it always was.
        has_real_dimension_column = isinstance(result, pd.DataFrame) and any(
            not pd.api.types.is_numeric_dtype(result[c]) for c in result.columns if c not in numeric_cols[:2]
        )
        if isinstance(result, pd.DataFrame) and len(numeric_cols) >= 2 and has_real_dimension_column:
            fig = _build_metric_comparison_panels(result, numeric_cols[:2])
            multi_panel_used = True
        else:
            fig = go.Figure(go.Bar(x=df["x"], y=df["y"], marker_color=PALETTE[0]))
    elif chart_type == "line":
        fig = go.Figure(go.Scatter(x=df["x"], y=df["y"], mode="lines+markers", line=dict(color=PALETTE[3], width=3)))
    elif chart_type == "area":
        fig = go.Figure(go.Scatter(x=df["x"], y=df["y"], mode="lines", fill="tozeroy", line=dict(color=PALETTE[1])))
    elif chart_type == "pie":
        pie_labels, pie_values = _fold_small_slices_into_other(list(df["x"]), list(df["y"]))
        fig = go.Figure(go.Pie(labels=pie_labels, values=pie_values, marker=dict(colors=PALETTE), hole=0.45))
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
        # 2026-09-29 (round 5, real-bug fix): a real Plotly Histogram trace
        # only ever accepts raw, unbinned values and does its OWN counting/
        # binning client-side - it has no way to accept a pre-computed
        # count. Diagnosed directly against a live, already-broken
        # dashboard: the AI's own pandas code, asked for a "distribution",
        # had already bucketed the data itself (into meaningfully-named
        # bins like "0-30 days") and computed the real count per bucket -
        # exactly the pre-tidied 2-column [category, value] shape every
        # other chart type in this app works from. Handing that to
        # go.Histogram(x=<the 4 bucket-name strings>) made Plotly re-count
        # occurrences of each bucket NAME in that 4-row array - which is
        # always exactly 1, since each bucket appears once - silently
        # replacing every real count (245, 400, 451, 3948 in the diagnosed
        # case) with a flat bar of height 1. A genuine histogram (binning
        # many raw individual values Plotly has not seen counted yet) is
        # only possible when the caller handed back a single value column
        # with no separate count/category pairing - `is_pretidied_table`
        # (computed above from the ORIGINAL result, before the x/y
        # normalization every chart type shares) is exactly that check.
        if is_pretidied_table:
            fig = go.Figure(go.Bar(x=df["x"], y=df["y"], marker_color=PALETTE[2]))
        else:
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
        donut_labels, donut_values = _fold_small_slices_into_other(list(df["x"]), list(df["y"]))
        fig = go.Figure(go.Pie(labels=donut_labels, values=donut_values, marker=dict(colors=PALETTE), hole=0.65))
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

        raw_locations = result[loc_col].astype(str).tolist()
        raw_values = pd.to_numeric(result[val_col], errors="coerce").tolist()
        resolved_states = [_resolve_us_state(v) for v in raw_locations]
        us_state_count = sum(1 for s in resolved_states if s)

        # Routing on whether the MAJORITY (not necessarily every single row)
        # of real values are recognizable US states - not just "not 100%
        # US" - is what still correctly renders a real US-states map for a
        # column that also has a handful of genuinely non-US rows mixed in
        # (e.g. a few Canadian provinces alongside 50 real US states, exactly
        # what Gokul's own "State/Province" data has), rather than falling
        # all the way back to the broken world/country path just because the
        # data isn't 100% pure US.
        if raw_locations and us_state_count / len(raw_locations) >= 0.5:
            us_rows = [
                (abbr, loc, val)
                for abbr, loc, val in zip(resolved_states, raw_locations, raw_values)
                if abbr is not None
            ]
            excluded = len(raw_locations) - len(us_rows)
            fig = go.Figure(go.Choropleth(
                locations=[r[0] for r in us_rows],
                z=[r[2] for r in us_rows],
                text=[r[1] for r in us_rows],
                locationmode="USA-states",
                colorscale=SEQUENTIAL_SCALE,
                marker_line_color="#3A4560",
                marker_line_width=0.6,
                hovertemplate=f"<b>%{{text}}</b><br>{val_col}: %{{z:,.2~f}}<extra></extra>",
                colorbar=dict(
                    title=dict(text=val_col, font=dict(color="#E8E8F0", size=12)),
                    outlinewidth=0, tickfont=dict(color="#E8E8F0", size=11), thickness=14,
                ),
            ))
            # "albers usa" is the modern, purpose-built US projection every
            # real BI tool (PowerBI, Hex, Tableau) uses for a states map -
            # not the flat equirectangular default, which is what made the
            # old world-scoped map look like a near-empty, low-effort globe
            # for data that only ever had US (+ a few Canadian) locations in
            # it. scope="usa" also means the map is never wasting space on
            # the rest of the planet in the first place.
            fig.update_geos(
                scope="usa", projection_type="albers usa",
                bgcolor="rgba(0,0,0,0)", landcolor="#161B29", showland=True,
                showsubunits=True, subunitcolor="#3A4560",
                showlakes=True, lakecolor="#161B29",
            )
            if excluded:
                # Never silently drops real data - a location that isn't one
                # of the 50 US states (a Canadian province, say) genuinely
                # can't be drawn on a USA-scoped map, so this says so plainly
                # instead of pretending the map is showing everything.
                fig.add_annotation(
                    text=f"+{excluded} location{'s' if excluded != 1 else ''} outside the 50 US states not shown on this map",
                    xref="paper", yref="paper", x=0.5, y=-0.12, showarrow=False,
                    font=dict(size=11, color="#8B93A8"),
                )
        else:
            # Not state-level data (or too few resolvable US states for that
            # to be the real shape) - treat this as a genuine country-level
            # breakdown. A real US state name/abbreviation is always
            # excluded from this path rather than ever being handed to
            # locationmode="country names" - the exact substring-mismatch
            # bug this whole branch exists to prevent, just in the other
            # direction.
            country_rows = [
                (loc, val)
                for abbr, loc, val in zip(resolved_states, raw_locations, raw_values)
                if abbr is None
            ]
            if not country_rows:
                raise ValueError("Choropleth needs at least one real country or US state name to plot - none of these values resolved to either.")
            fig = go.Figure(go.Choropleth(
                locations=[r[0] for r in country_rows],
                z=[r[1] for r in country_rows],
                locationmode="country names",
                colorscale=SEQUENTIAL_SCALE,
                marker_line_color="#3A4560",
                marker_line_width=0.6,
                hovertemplate=f"<b>%{{location}}</b><br>{val_col}: %{{z:,.2~f}}<extra></extra>",
                colorbar=dict(
                    title=dict(text=val_col, font=dict(color="#E8E8F0", size=12)),
                    outlinewidth=0, tickfont=dict(color="#E8E8F0", size=11), thickness=14,
                ),
            ))
            # fitbounds="locations" auto-zooms the projection to wherever the
            # real data actually is, instead of always rendering the entire
            # globe at a fixed zoom - the same "looks empty/low-effort" issue
            # as the states case above, just for a country-level chart with
            # only a handful of real countries in it.
            fig.update_geos(
                scope="world", projection_type="natural earth", fitbounds="locations",
                bgcolor="rgba(0,0,0,0)", landcolor="#161B29", showland=True,
                showcountries=True, countrycolor="#3A4560",
                showlakes=True, lakecolor="#161B29",
            )

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
    # even once automargin has done its job. None of this touches chart
    # TYPE selection, data, or layout math - purely chrome.
    #
    # 2026-09-29 (round 5, legend position): moved from a horizontal row
    # ABOVE the plot to one BELOW it, centered - the same placement Gokul's
    # own reference dashboard (a Hex data app) uses on every one of its
    # charts. The old above-plot position had a real, concrete failure mode
    # on a two-metric-per-category chart: a legend with two long entries,
    # left-anchored at the top, could run rightward into that same region's
    # own axis furniture (a secondary axis's tick labels/title, or a wide
    # right-margin number) - exactly the "legend overlapping the 70k label"
    # bug seen on a live dual-axis chart. A bottom-centered legend has nothing
    # else competing for that space on any chart type, dual-axis or not.
    fig.update_layout(
        template=DARK_TEMPLATE,
        title=title or "",
        xaxis=dict(automargin=True, title=dict(text=x_label or "", standoff=10)),
        yaxis=dict(automargin=True, title=dict(standoff=12)),
        yaxis2=dict(automargin=True, title=dict(standoff=12)),
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font=dict(family="Geist, Inter, system-ui, sans-serif", size=13, color="#E8E8F0"),
        margin=dict(l=56, r=28, t=68, b=64),
        hoverlabel=dict(bgcolor="#1E1E2E", font_size=13),
        legend=dict(bgcolor="rgba(0,0,0,0)", orientation="h", yanchor="top", y=-0.22, xanchor="center", x=0.5),
    )
    if not multi_panel_used and chart_type in ("bar", "column", "line", "area"):
        fig.update_layout(xaxis=_whole_number_axis(df["x"]))
    if not multi_panel_used:
        # The normal case: one shared y axis, titled from the AI's own
        # y_label (or blank). The two-panel comparison chart above already
        # gives each panel its own heading (the metric name, as a subplot
        # title), so it deliberately skips this generic single-axis
        # overwrite (and never touches automargin/standoff, both already
        # set unconditionally above for every panel).
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

    # coerce_dates_for_json so a date/timestamp column shows up as a real
    # date in the AI's own summary of its result, instead of the raw
    # epoch-millisecond number pandas' to_json would otherwise produce
    # (same underlying bug as the Data tab preview - see dtype_utils.py).
    # Left untouched for "describe" below: those are already-aggregated
    # stats (mean/min/max as summary figures), a lower-stakes, separate
    # case not changed in this round.
    return {
        "shape": list(df.shape),
        "columns": list(map(str, df.columns)),
        "preview": json.loads(coerce_dates_for_json(df.head(max_rows)).to_json(orient="records")),
        "describe": json.loads(df.describe(include="all").to_json()) if not df.empty else {},
    }

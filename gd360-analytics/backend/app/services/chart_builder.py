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

from . import chart_model
from .chart_model import ChartNotDrawable
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
    or arbitrary label sequence. Numbers (and numbers written as text - a
    year axis is the categories "2015", "2016", "2017") continue as
    numbers in the same spelling; dates continue as dates; anything else
    raises a clear ValueError rather than emitting a misleading
    continuation of what are really unordered category labels (product
    names have no honest "next value").

    The step is the MEDIAN of consecutive differences (robust to one
    irregular gap). A series of month starts steps by whole calendar months
    so it keeps landing on the 1st (a fixed 30/31-day step drifts).

    2026-10-07 (chart-integrity round): numbers are tried BEFORE dates.
    pandas reads the integer 2015 as "2015 nanoseconds after 1970", so a
    year axis used to be projected to timestamps a few nanoseconds apart;
    and the projected labels now match the spelling of the real ones
    ("2018" after "2017", "2017-09-01" after "2017-08-01") so they land on
    the same category / date axis the chart model draws."""
    if len(x_raw) >= 2:
        def _numeric_like(v: Any) -> bool:
            if isinstance(v, bool):
                return False
            if isinstance(v, (int, float, np.integer, np.floating)):
                return bool(np.isfinite(v))
            return isinstance(v, str) and bool(re.fullmatch(r"-?\d+(?:\.\d+)?", v.strip()))

        if all(_numeric_like(v) for v in x_raw):
            as_numbers = pd.to_numeric(pd.Series(x_raw), errors="coerce")
            diffs = as_numbers.diff().dropna()
            if len(diffs) > 0:
                step = float(diffs.median())
                last = float(as_numbers.iloc[-1])
                future = [last + step * (i + 1) for i in range(periods)]
                as_text = all(isinstance(v, str) for v in x_raw)
                whole = all(float(v).is_integer() for v in future)
                if as_text:
                    return [str(int(v)) if whole else repr(float(v)) for v in future]
                return [int(v) if whole and all(isinstance(v0, (int, np.integer)) for v0 in x_raw) else v for v in future]

        # Genuine category strings (e.g. product names) will never parse as
        # dates - that's an expected, handled outcome here, so the noisy
        # "could not infer format" warning pandas emits is silenced.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            as_dates = pd.to_datetime(pd.Series(x_raw), errors="coerce")
        if as_dates.notna().all():
            diffs = as_dates.diff().dropna()
            if len(diffs) > 0:
                last = as_dates.iloc[-1]
                if (as_dates.dt.day == 1).all() and (as_dates.dt.normalize() == as_dates).all():
                    months = (as_dates.dt.year * 12 + as_dates.dt.month).diff().dropna()
                    month_step = int(round(float(months.median()))) or 1
                    future_dates = [last + pd.DateOffset(months=month_step * (i + 1)) for i in range(periods)]
                else:
                    step = diffs.median()
                    future_dates = [last + step * (i + 1) for i in range(periods)]
                date_only = all(isinstance(v, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", v.strip()) for v in x_raw)
                month_only = all(isinstance(v, str) and re.fullmatch(r"\d{4}-\d{2}", v.strip()) for v in x_raw)
                if date_only:
                    return [d.strftime("%Y-%m-%d") for d in future_dates]
                if month_only:
                    return [d.strftime("%Y-%m") for d in future_dates]
                return [d.isoformat() for d in future_dates]

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


# ---------------------------------------------------------------------------
# 2026-10-07 (chart-integrity round): one shape for every result, one model
# for every standard chart, one audit for every figure.
#
# ROOT CAUSE this replaces. build_figure used to open with
#
#     cols = list(df.columns)
#     df = df.rename(columns={cols[0]: "x", cols[1]: "y"})
#
# - "the first two columns are x and y" - and every simple branch below
# (line, area, bar, horizontal_bar, pie, donut, step_line, waterfall,
# funnel, treemap, sunburst, icicle, funnel_area, dot_plot, error_bar, the
# pre-tidied histogram and the unknown-type fallback) drew df["x"] against
# df["y"]. For a WIDE frame - a pivot whose row index is the dimension and
# whose columns are measures - the first two columns are two MEASURES: the
# founder's "revenue by year, one line per hotel" drew City Hotel revenue on
# the x axis against Resort Hotel revenue on the y axis. The index (the
# years) was never read. The branches that did read the index
# (grouped_bar, stacked_bar, stacked_area, radar, polar_bar, candlestick)
# had the mirror-image flaw: handed a frame whose dimension is a COLUMN
# they plotted the row numbers 0, 1, 2 and, for a numeric dimension, drew
# the dimension itself as a series.
#
# Now: normalize_result_frame() turns any result into ONE tidy table
# (index levels become real, named columns flagged as dimensions),
# chart_model.derive_chart_model() says which column is the axis and which
# are the series, the standard chart types are built from that model only
# (figure_from_model), and audit_figure() refuses a figure whose traces are
# not the model's series. The specialised types keep their own branches,
# but take their labels and values from the same model instead of from
# "column 0 and column 1".
# ---------------------------------------------------------------------------

humanize = chart_model.humanize


def _flat_name(c: Any) -> str:
    """A column label as text. A pivot with several value columns has tuple
    labels (("total_revenue", "City Hotel")): the parts are joined."""
    if isinstance(c, tuple):
        parts = [str(p) for p in c if p is not None and str(p) != ""]
        return " · ".join(parts) if parts else "value"
    return str(c)


def _unique_names(names: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    out = []
    for n in names:
        if n in seen:
            seen[n] += 1
            out.append(f"{n}_{seen[n]}")
        else:
            seen[n] = 1
            out.append(n)
    return out


def _index_is_informative(index: pd.Index) -> bool:
    """Does an UNNAMED index carry labels worth keeping? A default 0..n-1
    row counter does not, and neither do the leftover row numbers of a
    filtered / sorted frame. Text, dates and categories do; whole numbers
    only when they read as distinct years."""
    if isinstance(index, pd.RangeIndex):
        return False
    if pd.api.types.is_integer_dtype(index) or pd.api.types.is_float_dtype(index):
        try:
            vals = [float(v) for v in index]
        except Exception:
            return False
        return bool(vals) and index.is_unique and all(v.is_integer() and 1900 <= v <= 2100 for v in vals)
    return True


def normalize_result_frame(result: Any) -> tuple[pd.DataFrame, list[str]] | None:
    """Any tabular result as ONE flat table plus the names of the columns
    that came from its index - the single normalisation every consumer of
    a result shares (the chart model, the stored tidy rows, the saved
    table, the insight summary), so they can no longer disagree about what
    the result's dimension is.

      Series           index level(s) -> column(s) named after the level
                       ("label" when it has no name), values -> a column
                       named after the Series ("value" when it has none)
      DataFrame        a named index / a MultiIndex / an unnamed index of
                       labels is moved into columns; a plain row counter
                       is dropped; tuple column labels are flattened

    Returns None for anything that is not tabular (a scalar) or has no
    columns. Never mutates `result` - and may return `result` itself when
    nothing needed changing, so the returned frame is read-only too."""
    if isinstance(result, pd.Series):
        value_name = _flat_name(result.name) if result.name is not None else "value"
        frame = result.to_frame(name="__value__")
    elif isinstance(result, pd.DataFrame):
        value_name = None
        frame = result
        flat = _unique_names([_flat_name(c) for c in frame.columns])
        if list(frame.columns) != flat:
            # A new frame object over the same data - `result` keeps its labels.
            frame = frame.copy(deep=False)
            frame.columns = flat
    else:
        return None

    index = frame.index
    index_cols: list[str] = []
    keep_index = isinstance(result, pd.Series) or isinstance(index, pd.MultiIndex) or index.name is not None or _index_is_informative(index)
    if keep_index:
        level_names = list(index.names) if isinstance(index, pd.MultiIndex) else [index.name]
        taken = set(map(str, frame.columns))
        if value_name:
            taken.add(value_name)
        for i, n in enumerate(level_names):
            base = _flat_name(n) if n is not None else ("label" if i == 0 else f"label_{i + 1}")
            name = base
            k = 2
            while name in taken:
                name = f"{base}_{k}"
                k += 1
            taken.add(name)
            index_cols.append(name)
        frame = frame.rename_axis(index=index_cols if isinstance(index, pd.MultiIndex) else index_cols[0]).reset_index()
    # (A frame whose index is a plain row counter is returned as it is: the
    # index is simply never read. No copy of a large cleaned table is made.)
    if value_name is not None:
        frame = frame.rename(columns={"__value__": value_name})
    if frame.shape[1] == 0:
        return None
    return frame, index_cols


def _tidy_from_frame(frame: pd.DataFrame, index_cols: list[str], max_rows: int) -> dict | None:
    row_count = int(len(frame))
    sample = frame.head(max_rows)
    columns = []
    for col in frame.columns:
        series = frame[col]
        if pd.api.types.is_datetime64_any_dtype(series):
            dtype, role = "date", "dimension"
        elif pd.api.types.is_bool_dtype(series):
            dtype, role = "boolean", "dimension"
        elif pd.api.types.is_numeric_dtype(series):
            # A column that came from the result's own index (a groupby key,
            # a pivot's rows) is a dimension even when it holds numbers.
            dtype, role = "number", ("dimension" if col in index_cols else "measure")
        else:
            dtype, role = "string", "dimension"
        columns.append({"name": col, "dtype": dtype, "role": role})
    try:
        rows = json.loads(sample.to_json(orient="records", date_format="iso"))
    except Exception:
        return None
    return {"columns": columns, "rows": rows, "row_count": row_count, "truncated": row_count > max_rows}


def _scalar_tidy(result: Any) -> dict | None:
    """A bare number as a one-row, one-column table (for the chart model
    only - result_to_tidy still returns None for a scalar)."""
    try:
        value = float(result)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(value):
        return None
    return {"columns": [{"name": "value", "dtype": "number", "role": "measure"}], "rows": [{"value": value}], "row_count": 1, "truncated": False}


_MODEL_MAX_ROWS = 4000


def _panel_split(model: dict) -> bool:
    """Do this chart's measures need one panel each? Only a WIDE result's
    measures (never the values of a series dimension, never an explicit
    grouped / stacked chart - those are one quantity by definition) and
    only when they are more than 8x apart: on one axis the smaller one
    would be a flat line at zero. Never a second y scale."""
    series = model.get("series") or []
    if len(series) < 2 or model.get("series_by") or model["chart_type"] in ("grouped_bar", "stacked_bar", "stacked_area"):
        return False
    sizes = []
    for s in series:
        vals = [abs(v) for v in s["values"] if v is not None]
        if vals and max(vals) > 0:
            sizes.append(max(vals))
    return len(sizes) > 1 and max(sizes) / min(sizes) > 8


_MAX_PANELS = 4


def _series_trace(model: dict, s: dict, i: int, n: int):
    ct = model["chart_type"]
    labels = model["x"]["labels"]
    values = s["values"]
    name = str(s["name"])
    if ct in ("bar", "horizontal_bar", "grouped_bar", "stacked_bar"):
        color = PALETTE[i % len(PALETTE)] if n > 1 else PALETTE[0]
        if model.get("horizontal"):
            return go.Bar(name=name, x=values, y=labels, orientation="h", marker_color=color)
        return go.Bar(name=name, x=labels, y=values, marker_color=color)
    # Lines and areas: straight segments between the real points, always.
    # A smoothed curve passes through values that are not in the table.
    shape = "hv" if ct == "step_line" else "linear"
    if ct == "line" or ct == "step_line":
        color = PALETTE[i % len(PALETTE)] if n > 1 else PALETTE[3]
        return go.Scatter(name=name, x=labels, y=values, mode="lines+markers", line=dict(color=color, width=3, shape=shape), connectgaps=False)
    color = PALETTE[i % len(PALETTE)] if n > 1 else PALETTE[1]
    if ct == "stacked_area":
        return go.Scatter(name=name, x=labels, y=values, mode="lines", stackgroup="one", line=dict(color=color, shape=shape))
    return go.Scatter(name=name, x=labels, y=values, mode="lines", fill="tozeroy", line=dict(color=color, shape=shape), connectgaps=False)


def _axis_titles(model: dict, x_label: str | None, y_label: str | None) -> tuple[str, str]:
    """The axis titles a figure may carry: the caller's own wording when
    it names the column(s) actually on that axis, otherwise the column's
    own (humanised) name - or nothing, for a result whose columns have no
    real names. A title that names a different column is never drawn."""
    xname = model["x"]["name"]
    measure_names = chart_model.y_axis_names(model)
    xl = (x_label or "").strip()
    if xl and not chart_model.axis_label_ok(xl, [xname], measure_names):
        xl = "" if chart_model._is_placeholder(xname) else humanize(xname)
    yl = (y_label or "").strip()
    if yl and not chart_model.value_axis_label_ok(yl, model):
        single = model.get("measure") or (model["series"][0]["name"] if len(model["series"]) == 1 and not model.get("series_by") else None)
        yl = humanize(single) if single and not chart_model._is_placeholder(single) else ""
    return xl, yl


def _base_layout(title: str) -> dict:
    return dict(
        template=DARK_TEMPLATE,
        title=title or "",
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font=dict(family="Geist, Inter, system-ui, sans-serif", size=13, color="#E8E8F0"),
        margin=dict(l=56, r=28, t=68, b=64),
        hoverlabel=dict(bgcolor="#1E1E2E", font_size=13),
        legend=dict(bgcolor="rgba(0,0,0,0)", orientation="h", yanchor="top", y=-0.22, xanchor="center", x=0.5),
    )


def figure_from_model(model: dict, title: str = "", x_label: str | None = None, y_label: str | None = None) -> dict:
    """The Plotly figure of a chart model (kind cartesian / pie / kpi) -
    the only place a standard chart's traces are written. x is always the
    model's dimension on a CATEGORY axis (a real date axis for a line over
    dates): a year is a tick labelled "2015", never a point on a number
    line with ticks at 2,015.5. One trace per series, straight segments."""
    kind = model.get("kind")
    if kind == "kpi":
        shown = [s for s in model["series"] if s["values"] and s["values"][0] is not None]
        if not shown:
            raise ChartNotDrawable("The result is a single empty value, so there is nothing to draw.")
        fig = go.Figure()
        for i, s in enumerate(shown):
            label = "" if chart_model._is_placeholder(s["name"]) else humanize(s["name"])
            fig.add_trace(go.Indicator(
                mode="number", value=s["values"][0], title=dict(text=label),
                domain=dict(x=[i / len(shown), (i + 1) / len(shown)], y=[0, 1]),
            ))
        fig.update_layout(**_base_layout(title))
        return json.loads(fig.to_json())

    if kind == "pie":
        labels = model["x"]["labels"]
        values = model["series"][0]["values"]
        pairs = [(lab, v) for lab, v in zip(labels, values) if v is not None]
        pie_labels, pie_values = _fold_small_slices_into_other([p[0] for p in pairs], [p[1] for p in pairs])
        hole = 0.65 if model["chart_type"] == "donut" else 0.45
        fig = go.Figure(go.Pie(labels=list(pie_labels), values=list(pie_values), marker=dict(colors=PALETTE), hole=hole))
        fig.update_layout(**_base_layout(title))
        return json.loads(fig.to_json())

    if kind != "cartesian":
        raise ChartNotDrawable(model.get("reason") or "This result cannot be drawn as a chart.")

    series = model["series"]
    n = len(series)
    ct = model["chart_type"]
    horizontal = bool(model.get("horizontal"))
    labels = model["x"]["labels"]
    # A line over real dates keeps a date axis (true spacing between
    # periods); everything else is one tick per value.
    category_axis_type = "date" if model["x"]["axis"] == "time" and ct in chart_model.LINE_TYPES else "category"
    category_axis = dict(type=category_axis_type, automargin=True)
    if category_axis_type == "category":
        category_axis.update(categoryorder="array", categoryarray=list(labels))
    xl, yl = _axis_titles(model, x_label, y_label)

    if _panel_split(model):
        if n > _MAX_PANELS:
            raise ChartNotDrawable(f"{n} measures on very different scales read best as a table.")
        names = [humanize(s["name"]) for s in series]
        if horizontal:
            fig = make_subplots(rows=1, cols=n, subplot_titles=names, shared_yaxes=True, horizontal_spacing=0.08)
        else:
            fig = make_subplots(rows=n, cols=1, subplot_titles=names, shared_xaxes=True, vertical_spacing=min(0.12, 0.3 / n))
        for i, s in enumerate(series):
            trace = _series_trace(model, s, 0, 1)
            trace.showlegend = False
            fig.add_trace(trace, row=1 if horizontal else i + 1, col=i + 1 if horizontal else 1)
        fig.update_layout(**_base_layout(title))
        if horizontal:
            fig.update_yaxes(**category_axis, autorange="reversed")
            fig.update_xaxes(automargin=True)
        else:
            fig.update_xaxes(**category_axis)
            fig.update_yaxes(automargin=True, rangemode="tozero" if ct in chart_model.BAR_TYPES else "normal")
            if xl:
                fig.update_xaxes(title=dict(text=xl, standoff=10), row=n, col=1)
        return json.loads(fig.to_json())

    fig = go.Figure()
    for i, s in enumerate(series):
        fig.add_trace(_series_trace(model, s, i, n))
    fig.update_layout(**_base_layout(title))
    if ct == "stacked_bar":
        fig.update_layout(barmode="stack")
    elif ct in chart_model.BAR_TYPES and n > 1:
        fig.update_layout(barmode="group")
    value_axis = dict(automargin=True, title=dict(text=yl, standoff=12))
    if horizontal:
        fig.update_layout(
            yaxis=dict(**category_axis, autorange="reversed", title=dict(text=xl, standoff=10)),
            xaxis=value_axis,
        )
    else:
        fig.update_layout(xaxis=dict(**category_axis, title=dict(text=xl, standoff=10)), yaxis=value_axis)
    return json.loads(fig.to_json())


def _spec_title(spec: Any, key: str | None = None) -> str:
    layout = spec.get("layout") if isinstance(spec, dict) and isinstance(spec.get("layout"), dict) else {}
    t = (layout.get(key) or {}).get("title") if key else layout.get("title")
    if isinstance(t, str):
        return t
    if isinstance(t, dict) and isinstance(t.get("text"), str):
        return t["text"]
    return ""


def checked_chart_spec(
    chart_spec: Any, result_columns: list | None, result_rows: list | None, chart_type: str | None,
    context: str = "", truncated: bool = False, quiet: bool = False,
) -> tuple[Any, str | None, list[str]]:
    """THE AUDIT. Verifies a figure against the table it claims to draw.

    Returns (chart_spec, table_reason, problems):
      - the figure unchanged when it draws exactly the chart model of
        (result_columns, result_rows, chart_type) - or when there is
        nothing to check it against (no rows stored; a specialised chart
        type the model does not describe);
      - a figure REBUILT deterministically from the chart model when it
        does not (every mismatch is logged on one `[chart_audit]` line with
        `context` - the message id / block id - and the chart type), keeping
        the original's title and any axis title that names its column;
      - (None, sentence, problems) when the table cannot be drawn as that
        chart at all: the caller shows the table and the sentence. Never a
        wrong chart.

    Applied where a figure is built (build_figure), where it is stored
    (routers/chat.py _persist_and_respond), where a stored one is read back
    (routers/conversations.py) and where one is copied onto a dashboard."""
    if not chart_spec or not result_columns or not isinstance(result_rows, list) or not result_rows:
        return chart_spec, None, []
    model = chart_model.derive_chart_model(result_columns, result_rows, chart_type)
    kind = model["kind"]
    if kind == "passthrough":
        return chart_spec, None, []
    tag = f"[chart_audit] {context or 'figure'} chart_type={model['chart_type']}"

    def log(text: str) -> None:
        # `quiet`: the caller logs the returned problems itself (it knows
        # the message id only after the row is written).
        if not quiet:
            print(f"{tag} {text}")

    generic = "This result could not be drawn as a chart without misrepresenting it, so it is shown as a table."
    if truncated:
        reason = f"This result has more than {len(result_rows):,} rows; a chart of only the first {len(result_rows):,} would be misleading, so it is shown as a table."
        log("not drawable: the stored rows are truncated")
        return None, reason, ["the stored rows are truncated"]
    if kind == "table":
        reason = model.get("reason")
        log(f"not drawable: {reason or 'a table was asked for'}")
        return None, reason, [reason or "the result is a table, not a chart"]
    problems = chart_model.audit_figure(chart_spec, model)
    if not problems:
        return chart_spec, None, []
    log(f"MISMATCH ({len(problems)}): " + " | ".join(problems[:6]) + " -> rebuilt from the result table")
    horizontal = bool(model.get("horizontal"))
    try:
        rebuilt = figure_from_model(
            model, _spec_title(chart_spec),
            _spec_title(chart_spec, "yaxis" if horizontal else "xaxis"), _spec_title(chart_spec, "xaxis" if horizontal else "yaxis"),
        )
        still = chart_model.audit_figure(rebuilt, model)
    except ChartNotDrawable as e:
        log(f"rebuild not drawable: {e}")
        return None, str(e) or generic, problems
    except Exception as e:  # never let the audit take the answer down
        log(f"rebuild FAILED: {e}")
        return None, generic, problems
    if still:
        log("rebuild still mismatched: " + " | ".join(still[:6]))
        return None, generic, problems + still
    return rebuilt, None, problems


def _whole_number_axis(x: Any, max_span: int = 30) -> dict:
    """Axis settings for an x column of whole numbers on a NUMERIC axis:
    tick exactly on the whole numbers, printed plainly. Standard charts no
    longer need it (their dimension is always a category axis - see
    figure_from_model); kept for the specialised branches below."""
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


# Specialised chart types that are still "one value per category": their
# branch draws its own trace, but the labels and the values come from the
# chart model (never from "column 0 and column 1"), and the result is
# audited against it.
_LABEL_VALUE_TYPES = {"waterfall", "funnel", "treemap", "sunburst", "icicle", "funnel_area", "dot_plot", "error_bar"}


def _audit_label_value(figure: dict, base: dict, chart_type: str, context: str | None) -> None:
    """The light audit of a label/value specialised chart: its one trace's
    categories are the dimension's values and its numbers are the first
    measure's. Raises ChartNotDrawable on a mismatch (these types have no
    second, model-built form to fall back to)."""
    traces = [t for t in figure.get("data") or [] if isinstance(t, dict)]
    if not traces:
        return
    t = traces[0]
    pairs = [("labels", "values"), ("y", "x"), ("x", "y")] if chart_type in ("funnel", "dot_plot") else [("labels", "values"), ("x", "y")]
    cats = vals = None
    for ck, vk in pairs:
        if isinstance(t.get(ck), list) and isinstance(t.get(vk), list):
            cats, vals = t[ck], t[vk]
            break
    if cats is None:
        return
    labels = base["x"]["labels"]
    want = dict(zip(labels, base["series"][0]["values"]))
    for c, v in zip(cats, vals):
        key = chart_model.value_label(c)
        if key not in want or not chart_model.numbers_equal(v, want[key]):
            print(f"[chart_audit] {context or 'figure'} chart_type={chart_type} MISMATCH: {key!r} -> {v!r} is not a row of the result table")
            raise ChartNotDrawable(f"This result could not be drawn as a {chart_type.replace('_', ' ')} chart without misrepresenting it, so it is shown as a table.")


def build_figure(
    result: Any, chart_type: str, title: str = "", x_label: str | None = None, y_label: str | None = None,
    context: str | None = None,
) -> dict:
    """result + chart type -> an audited Plotly figure.

    Standard chart types (line, area, stacked_area, step_line, bar /
    column, horizontal_bar, grouped_bar, stacked_bar, pie, donut, a single
    value) are built from the chart model and nothing else. Raises
    ChartNotDrawable (a ValueError whose text is a plain sentence) when the
    result cannot be drawn as the requested chart without misrepresenting
    it - the caller shows the table with that sentence. `context` (a
    message / block id) is only used on the `[chart_audit]` log line."""
    chart_type = chart_model.normalize_chart_type(chart_type)
    normalized = normalize_result_frame(result)
    frame, index_cols = normalized if normalized is not None else (None, [])

    # Faceted bar needs its own three-column shape (facet column, category
    # column, value column), so it is handled entirely separately and skips
    # straight to its own closing layout block.
    if chart_type == "faceted_bar":
        fig = _build_faceted_bar(frame if frame is not None else result)
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
        # Every panel measures its own tick labels and grows its margin to
        # fit them (a long category name is never clipped by the border).
        fig.update_xaxes(automargin=True)
        fig.update_yaxes(automargin=True)
        # A facet grid has no single shared axis pair to title, so the
        # requested labels become one shared caption under / beside the grid.
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

    tidy = _tidy_from_frame(frame, index_cols, _MODEL_MAX_ROWS) if frame is not None else _scalar_tidy(result)
    if tidy is None:
        raise ChartNotDrawable("This result is not a table or a number, so there is nothing to draw.")

    # ---- Standard chart types: the chart model, and only the chart model ----
    if chart_type in chart_model.STANDARD_TYPES:
        if chart_type == "table":
            raise ChartNotDrawable("")
        model = chart_model.derive_chart_model(tidy["columns"], tidy["rows"], chart_type)
        if model["kind"] == "table":
            raise ChartNotDrawable(model.get("reason") or "This result cannot be drawn as a chart, so it is shown as a table.")
        if tidy["truncated"]:
            raise ChartNotDrawable(
                f"This result has {tidy['row_count']:,} rows; a chart of only the first {_MODEL_MAX_ROWS:,} would be misleading, "
                "so it is shown as a table."
            )
        if model["kind"] == "cartesian" and chart_type in ("grouped_bar", "stacked_bar") and len(model["series"]) < 2:
            pretty_name = chart_type.replace("_", " ").title()
            raise ValueError(
                f"{pretty_name} needs at least two numeric columns to compare "
                f"side by side; this result only has {len(model['series'])}."
            )
        figure = figure_from_model(model, title, x_label, y_label)
        problems = chart_model.audit_figure(figure, model)
        if problems:
            # The builder and the model disagree: a bug in this file, not in
            # the data. Refuse to return the figure.
            print(f"[chart_audit] {context or 'build_figure'} chart_type={chart_type} BUILDER MISMATCH: " + " | ".join(problems[:6]))
            raise ChartNotDrawable("This result could not be drawn as a chart without misrepresenting it, so it is shown as a table.")
        return figure

    # ---- Specialised chart types ------------------------------------------
    # `base` is the result read as "one value per category" (a bar-shaped
    # chart model): the dimension's labels and each measure's values. A
    # branch that needs labels + values takes them from it. `df` (x, y) is
    # that same pair as a frame; for a result with no such reading (raw
    # rows for a histogram / box / scatter) it is the first two columns.
    numeric_cols = _numeric_cols(frame)
    base = None
    if frame is not None and not tidy["truncated"]:
        candidate = chart_model.derive_chart_model(tidy["columns"], tidy["rows"], "bar")
        if candidate["kind"] == "cartesian":
            base = candidate
    roles = chart_model.classify_columns(tidy["columns"], tidy["rows"][:2000]) if frame is not None else []
    measure_cols = [c["name"] for c in roles if c["role"] == "measure" and c["why"] != "empty"]
    dimension_cols = [c["name"] for c in roles if c["role"] == "dimension"]
    # True for a genuine [category, value] (or wider) tidy table - the signal
    # the "histogram" branch uses to tell an already-aggregated result (must
    # never be re-counted by Plotly) apart from raw, unbinned values.
    is_pretidied_table = isinstance(result, pd.DataFrame) and frame is not None and frame.shape[1] >= 2

    if base is not None:
        df = pd.DataFrame({"x": base["x"]["labels"], "y": base["series"][0]["values"]})
    elif frame is not None:
        df = frame.copy()
        if df.shape[1] == 1:
            df = df.reset_index()
            df.columns = ["x", "y"]
        else:
            cols = list(df.columns)
            df = df.rename(columns={cols[0]: "x", cols[1]: "y"})
    else:
        df = pd.DataFrame({"x": ["value"], "y": [result]})

    def _need_base(pretty: str) -> dict:
        if base is None:
            raise ChartNotDrawable(
                f"A {pretty} chart needs one row per category with a numeric value; this result does not have that shape, "
                "so it is shown as a table."
            )
        return base

    fig = None

    if chart_type == "scatter":
        # Numeric-vs-numeric is what a scatter IS: with two or more measures
        # the first two are x and y. With one measure the dimension is x.
        if len(measure_cols) >= 2:
            sx, sy = frame[measure_cols[0]], frame[measure_cols[1]]
            x_default, y_default = measure_cols[0], measure_cols[1]
        else:
            sx, sy = df["x"], df["y"]
            x_default = y_default = None
        fig = go.Figure(go.Scatter(
            x=sx, y=sy, mode="markers",
            marker=dict(color=PALETTE[4], size=9, opacity=0.8, line=dict(width=1, color="rgba(255,255,255,0.35)")),
            meta={"role": "primary"},
        ))
        # A trend line only means something once the raw points are on the
        # chart - added on top of, never instead of, the actual data.
        _add_trend_overlay(fig, sx, sy)
        if x_default and not x_label:
            x_label = humanize(x_default)
        if y_default and not y_label:
            y_label = humanize(y_default)
    elif chart_type == "histogram":
        # A real Plotly Histogram trace only accepts raw, unbinned values and
        # does its own counting. A result that was already bucketed and
        # counted ([bucket, count]) is drawn as the bars it already is.
        if is_pretidied_table and base is not None:
            fig = go.Figure(go.Bar(x=df["x"], y=df["y"], marker_color=PALETTE[2]))
            fig.update_layout(xaxis=dict(type="category"))
        elif is_pretidied_table:
            raise ChartNotDrawable(
                "A histogram needs either one column of raw values or one row per bucket with its count; this result is "
                "neither, so it is shown as a table."
            )
        else:
            raw = frame[measure_cols[0]] if measure_cols else df["y"]
            fig = go.Figure(go.Histogram(x=raw, marker_color=PALETTE[2]))
    elif chart_type == "box":
        if measure_cols and dimension_cols:
            fig = go.Figure(go.Box(y=frame[measure_cols[0]], x=frame[dimension_cols[0]].astype(str), marker_color=PALETTE[5]))
        elif measure_cols:
            fig = go.Figure(go.Box(y=frame[measure_cols[0]], marker_color=PALETTE[5]))
        else:
            fig = go.Figure(go.Box(y=df["y"], x=df.get("x"), marker_color=PALETTE[5]))
    elif chart_type == "heatmap":
        # expects a wide-format numeric dataframe (e.g. a correlation matrix)
        fig = go.Figure(go.Heatmap(z=result.values, x=[str(c) for c in result.columns], y=[str(i) for i in result.index], colorscale=SEQUENTIAL_SCALE))
    elif chart_type == "waterfall":
        _need_base("waterfall")
        fig = go.Figure(go.Waterfall(
            x=list(df["x"]), y=list(df["y"]),
            connector={"line": {"color": "rgba(255,255,255,0.3)"}},
            increasing={"marker": {"color": PALETTE[2]}},
            decreasing={"marker": {"color": PALETTE[7]}},
            totals={"marker": {"color": PALETTE[0]}},
        ))
        fig.update_layout(xaxis=dict(type="category"))
    elif chart_type == "funnel":
        _need_base("funnel")
        fig = go.Figure(go.Funnel(x=list(df["y"]), y=list(df["x"]), marker=dict(color=PALETTE)))
    elif chart_type == "treemap":
        _need_base("treemap")
        fig = go.Figure(go.Treemap(labels=list(df["x"]), values=list(df["y"]), parents=[""] * len(df), marker=dict(colors=PALETTE)))
    elif chart_type == "radar":
        b = _need_base("radar")
        categories = list(b["x"]["labels"])
        if len(categories) < 3:
            raise ValueError(f"Radar needs at least 3 categories to plot around the circle; this result only has {len(categories)}.")
        fig = go.Figure()
        for i, s in enumerate(b["series"]):
            values = [0 if v is None else v for v in s["values"]]
            fig.add_trace(go.Scatterpolar(
                r=values + [values[0]], theta=categories + [categories[0]], fill="toself",
                name=str(s["name"]) if len(b["series"]) > 1 or not chart_model._is_placeholder(s["name"]) else (title or "Series 1"),
                line=dict(color=PALETTE[i % len(PALETTE)]),
            ))
        fig.update_layout(polar=dict(radialaxis=dict(visible=True)))
    elif chart_type == "polar_bar":
        b = _need_base("polar bar")
        categories = list(b["x"]["labels"])
        if len(categories) < 3:
            raise ValueError(f"Polar bar needs at least 3 categories; this result only has {len(categories)}.")
        fig = go.Figure()
        for i, s in enumerate(b["series"]):
            fig.add_trace(go.Barpolar(
                r=[0 if v is None else v for v in s["values"]], theta=categories,
                name=str(s["name"]), marker_color=PALETTE[i % len(PALETTE)],
            ))
        fig.update_layout(polar=dict(radialaxis=dict(visible=True)))
    elif chart_type in ("candlestick", "ohlc"):
        if frame is None or not isinstance(result, pd.DataFrame):
            raise ValueError(f"{chart_type.title()} needs Open, High, Low and Close columns - this result is not a table.")
        cols = list(frame.columns)
        o, h, l, c = _find_col(cols, "open"), _find_col(cols, "high"), _find_col(cols, "low"), _find_col(cols, "close")
        if not (o and h and l and c):
            raise ValueError(f"{chart_type.title()} needs Open, High, Low and Close columns - this result does not have all four.")
        trace_cls = go.Candlestick if chart_type == "candlestick" else go.Ohlc
        time_col = next((d for d in dimension_cols if d not in (o, h, l, c)), None)
        x_values = [chart_model.value_label(v) for v in frame[time_col]] if time_col else [str(v) for v in result.index]
        fig = go.Figure(trace_cls(x=x_values, open=frame[o], high=frame[h], low=frame[l], close=frame[c]))
    elif chart_type == "violin":
        if len(measure_cols) >= 2:
            fig = go.Figure()
            for i, col in enumerate(measure_cols):
                fig.add_trace(go.Violin(
                    y=pd.to_numeric(frame[col], errors="coerce"), name=str(col),
                    box_visible=True, meanline_visible=True, line_color=PALETTE[i % len(PALETTE)],
                ))
        else:
            raw = frame[measure_cols[0]] if measure_cols else df["y"]
            fig = go.Figure(go.Violin(
                y=pd.to_numeric(raw, errors="coerce"), name=title or "Distribution",
                box_visible=True, meanline_visible=True, line_color=PALETTE[5],
            ))
    elif chart_type == "dot_plot":
        _need_base("dot plot")
        fig = go.Figure(go.Scatter(x=list(df["y"]), y=list(df["x"]), mode="markers", marker=dict(size=11, color=PALETTE[4])))
        fig.update_layout(yaxis=dict(type="category"))
    elif chart_type == "density_heatmap":
        pair = measure_cols if len(measure_cols) >= 2 else numeric_cols
        if len(pair) < 2:
            raise ValueError(
                f"Density heatmap needs two numeric columns of raw, unaggregated values; this result has {len(pair)}."
            )
        fig = go.Figure(go.Histogram2d(
            x=pd.to_numeric(frame[pair[0]], errors="coerce"),
            y=pd.to_numeric(frame[pair[1]], errors="coerce"), colorscale=SEQUENTIAL_SCALE,
        ))
    elif chart_type == "bubble":
        pair = measure_cols if len(measure_cols) >= 2 else numeric_cols
        if len(pair) < 2:
            raise ValueError("Bubble chart needs an x value and a y value (both numeric), and ideally a third numeric column for bubble size.")
        x_vals = pd.to_numeric(frame[pair[0]], errors="coerce")
        y_vals = pd.to_numeric(frame[pair[1]], errors="coerce")
        if len(pair) >= 3:
            size_vals = pd.to_numeric(frame[pair[2]], errors="coerce").fillna(0)
            max_size = float(size_vals.max()) or 1.0
            sizes = (size_vals / max_size * 40 + 8).tolist()
        else:
            sizes = 18
        fig = go.Figure(go.Scatter(x=x_vals, y=y_vals, mode="markers", marker=dict(size=sizes, color=PALETTE[4], sizemode="diameter")))
    elif chart_type == "contour":
        if not isinstance(result, pd.DataFrame) or result.shape[1] < 2 or len(_numeric_cols(result)) != result.shape[1]:
            raise ValueError("Contour needs a fully numeric grid (e.g. a correlation or pivot matrix), the same as heatmap.")
        fig = go.Figure(go.Contour(z=result.values, x=[str(c) for c in result.columns], y=[str(i) for i in result.index], colorscale=SEQUENTIAL_SCALE))
    elif chart_type == "scatter_3d":
        trio = measure_cols if len(measure_cols) >= 3 else numeric_cols
        if len(trio) < 3:
            raise ValueError(f"3D scatter needs three numeric columns (x, y and z); this result only has {len(trio)}.")
        fig = go.Figure(go.Scatter3d(
            x=pd.to_numeric(frame[trio[0]], errors="coerce"),
            y=pd.to_numeric(frame[trio[1]], errors="coerce"),
            z=pd.to_numeric(frame[trio[2]], errors="coerce"),
            mode="markers", marker=dict(size=5, color=PALETTE[0]),
        ))
    elif chart_type == "error_bar":
        b = _need_base("error bar")
        if len(b["series"]) < 2:
            raise ValueError("Error bar needs a value column plus a second numeric column to use as the margin of error / standard deviation.")
        errors = [0 if v is None else v for v in b["series"][1]["values"]]
        fig = go.Figure(go.Scatter(
            x=list(df["x"]), y=list(df["y"]), mode="markers", marker=dict(size=10, color=PALETTE[4]),
            error_y=dict(type="data", array=errors, visible=True),
        ))
        fig.update_layout(xaxis=dict(type="category"))
    elif chart_type == "sunburst":
        _need_base("sunburst")
        fig = go.Figure(go.Sunburst(labels=list(df["x"]), values=list(df["y"]), parents=[""] * len(df), marker=dict(colors=PALETTE)))
    elif chart_type == "icicle":
        _need_base("icicle")
        fig = go.Figure(go.Icicle(labels=list(df["x"]), values=list(df["y"]), parents=[""] * len(df), marker=dict(colors=PALETTE)))
    elif chart_type == "funnel_area":
        _need_base("funnel area")
        fig = go.Figure(go.Funnelarea(labels=list(df["x"]), values=list(df["y"]), marker=dict(colors=PALETTE)))

    # ---- Flow & process ----
    elif chart_type == "sankey":
        if frame is None or not isinstance(result, pd.DataFrame):
            raise ValueError("Sankey needs source, target and value columns (e.g. from/to/amount) - this result is not a table.")
        cols = list(frame.columns)
        src_col = _find_col(cols, "source", "from")
        tgt_col = _find_col(cols, "target", "to")
        val_col = _find_col(cols, "value", "amount", "count", "weight")
        if not (src_col and tgt_col and val_col):
            raise ValueError("Sankey needs source, target and value columns (e.g. from/to/amount) - this result does not have them.")
        nodes = list(pd.unique(pd.concat([frame[src_col], frame[tgt_col]])))
        index = {n: i for i, n in enumerate(nodes)}
        fig = go.Figure(go.Sankey(
            node=dict(label=[str(n) for n in nodes], color=PALETTE[0], pad=15, thickness=16),
            link=dict(
                source=[index[v] for v in frame[src_col]],
                target=[index[v] for v in frame[tgt_col]],
                value=list(pd.to_numeric(frame[val_col], errors="coerce").fillna(0)),
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
            line=dict(color=list(range(len(frame))), colorscale=SEQUENTIAL_SCALE),
            dimensions=[
                dict(label=str(c), values=list(pd.to_numeric(frame[c], errors="coerce").fillna(0)))
                for c in numeric_cols
            ],
        ))
    elif chart_type == "choropleth":
        if frame is None or not isinstance(result, pd.DataFrame):
            raise ValueError("Choropleth needs a country/region column and a numeric value column - this result is not a table.")
        cols = list(frame.columns)
        loc_col = _find_col(cols, "country", "iso", "region", "state", "code")
        val_col = next((c for c in numeric_cols if c != loc_col), None)
        if not (loc_col and val_col):
            raise ValueError("Choropleth needs a country/region column and a numeric value column - this result does not have both.")

        raw_locations = frame[loc_col].astype(str).tolist()
        raw_values = pd.to_numeric(frame[val_col], errors="coerce").tolist()
        resolved_states = [_resolve_us_state(v) for v in raw_locations]
        us_state_count = sum(1 for s in resolved_states if s)

        # Routing on whether the MAJORITY of real values are recognizable US
        # states is what still renders a real US-states map for a column
        # that also has a handful of genuinely non-US rows mixed in.
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
            fig.update_geos(
                scope="usa", projection_type="albers usa",
                bgcolor="rgba(0,0,0,0)", landcolor="#161B29", showland=True,
                showsubunits=True, subunitcolor="#3A4560",
                showlakes=True, lakecolor="#161B29",
            )
            if excluded:
                # Never silently drops real data - a location that isn't one
                # of the 50 US states cannot be drawn on a USA-scoped map, so
                # this says so plainly.
                fig.add_annotation(
                    text=f"+{excluded} location{'s' if excluded != 1 else ''} outside the 50 US states not shown on this map",
                    xref="paper", yref="paper", x=0.5, y=-0.12, showarrow=False,
                    font=dict(size=11, color="#8B93A8"),
                )
        else:
            # A genuine country-level breakdown. A real US state name is
            # always excluded from this path rather than ever being handed
            # to locationmode="country names" (its loose matching draws
            # "Indiana" on India).
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
            fig.update_geos(
                scope="world", projection_type="natural earth", fitbounds="locations",
                bgcolor="rgba(0,0,0,0)", landcolor="#161B29", showland=True,
                showcountries=True, countrycolor="#3A4560",
                showlakes=True, lakecolor="#161B29",
            )

    else:
        # A chart type this file does not know: drawn as the plain bar chart
        # of the result's chart model (audited like any other), never as
        # "column 0 against column 1".
        model = chart_model.derive_chart_model(tidy["columns"], tidy["rows"], "bar")
        if model["kind"] not in ("cartesian", "kpi") or tidy["truncated"]:
            raise ChartNotDrawable(model.get("reason") or "This result cannot be drawn as a chart, so it is shown as a table.")
        figure = figure_from_model(model, title, x_label, y_label)
        if chart_model.audit_figure(figure, model):
            raise ChartNotDrawable("This result could not be drawn as a chart without misrepresenting it, so it is shown as a table.")
        return figure

    # automargin makes Plotly measure the rendered text and grow the margin
    # to fit it; title.standoff keeps an axis title off its tick labels. The
    # legend sits below the plot, centred, where nothing competes with it.
    fig.update_layout(
        template=DARK_TEMPLATE,
        title=title or "",
        xaxis=dict(automargin=True, title=dict(text=x_label or "", standoff=10)),
        yaxis=dict(automargin=True, title=dict(text=y_label or "", standoff=12)),
        yaxis2=dict(automargin=True, title=dict(standoff=12)),
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font=dict(family="Geist, Inter, system-ui, sans-serif", size=13, color="#E8E8F0"),
        margin=dict(l=56, r=28, t=68, b=64),
        hoverlabel=dict(bgcolor="#1E1E2E", font_size=13),
        legend=dict(bgcolor="rgba(0,0,0,0)", orientation="h", yanchor="top", y=-0.22, xanchor="center", x=0.5),
    )

    # fig.to_json() guarantees full JSON-safety (numpy types, NaT, etc handled)
    figure = json.loads(fig.to_json())
    if base is not None and chart_type in _LABEL_VALUE_TYPES:
        _audit_label_value(figure, base, chart_type, context)
    return figure


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

    These rows ARE the chart's contract: the figure stored next to them is
    audited against the chart model derived from exactly this table (see
    chart_model.derive_chart_model / checked_chart_spec), and the frontend
    draws its chart from them, not from the stored figure. They are also
    what lets the "Edit chart" panel switch chart type, remap fields or add
    a filter instantly in the browser.

    2026-10-07 (chart-integrity round): built on normalize_result_frame, so
      - every index level is kept as a real column (a MultiIndex used to be
        dropped whole; an unnamed index of labels used to be dropped),
      - a column that came from the index is role "dimension" even when it
        holds numbers (a year, an id) - its dtype stays "number",
      - a Series keeps its own names (its index name and its own name;
        "label" / "value" only when it has none).

    Returns None for anything that isn't meaningfully tabular (a bare
    scalar, or an empty/columnless frame)."""
    normalized = normalize_result_frame(result)
    if normalized is None:
        return None
    frame, index_cols = normalized
    if frame.empty or frame.shape[1] == 0:
        return None
    return _tidy_from_frame(frame, index_cols, max_rows)


def result_to_dataframe(result: Any) -> pd.DataFrame | None:
    """The full-fidelity counterpart to result_to_tidy above, for when a
    result needs to become a real saved table (see routers/chat.py's
    _save_named_results) rather than a JSON preview: the same
    normalisation (normalize_result_frame - index levels become real
    columns), but every row and no JSON round-trip. Returns None for the
    same "nothing meaningfully tabular here" cases result_to_tidy does."""
    normalized = normalize_result_frame(result)
    if normalized is None:
        return None
    frame, _index_cols = normalized
    if frame.empty or frame.shape[1] == 0:
        return None
    # The caller saves / mutates what it gets back: never hand it `result`.
    return frame.copy() if frame is result else frame


def result_to_summary(result: Any, max_rows: int = 15) -> dict:
    """Compact, LLM-friendly summary of an analysis result, used for insight generation.

    2026-10-07 (chart-integrity round): the preview is taken from the same
    normalised table the chart and the stored rows use. It used to be
    `df.head()` of the raw result - for a pivot that is the measure
    columns WITHOUT the index, so the insight writer was shown
    {"City Hotel": 3291100.55, "Resort Hotel": 3526408.51} with no year in
    sight and "ranked" one hotel's revenue as the label of the other's."""
    normalized = normalize_result_frame(result)
    if normalized is None:
        return {"scalar_result": result}
    df, _index_cols = normalized

    # coerce_dates_for_json so a date/timestamp column shows up as a real
    # date in the AI's own summary of its result, instead of the raw
    # epoch-millisecond number pandas' to_json would otherwise produce
    # (same underlying bug as the Data tab preview - see dtype_utils.py).
    return {
        "shape": list(df.shape),
        "columns": list(map(str, df.columns)),
        "preview": json.loads(coerce_dates_for_json(df.head(max_rows)).to_json(orient="records")),
        "describe": json.loads(df.describe(include="all").to_json()) if not df.empty else {},
    }

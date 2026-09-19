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
from typing import Any

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import plotly.express as px
from scipy import stats as scipy_stats

DARK_TEMPLATE = "plotly_dark"

PALETTE = [
    "#6C5CE7", "#00D1B2", "#FF6B6B", "#FFD166", "#4D96FF",
    "#F72585", "#43AA8B", "#F8961E", "#90BE6D", "#577590",
]

# The color used for an automatic regression trend line and its confidence
# band on a scatter plot - deliberately NOT one of the categorical PALETTE
# colors above, so it always reads as "analysis drawn on top of the data"
# rather than "one more data series", regardless of which palette the
# person later picks in the frontend Style panel (see chartStyle.ts -
# marker.meta.role is how that file recognizes and protects this trace from
# being recolored or captioned like a real series).
TREND_COLOR = "#E24C4C"

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

    fig = go.Figure()
    fig.add_trace(go.Bar(
        name=str(metric_a), x=categories, y=a_vals,
        marker_color=PALETTE[0], yaxis="y",
        texttemplate="%{y:,.2~f}", textposition="outside",
        textfont=dict(color=PALETTE[0]),
    ))
    fig.add_trace(go.Scatter(
        name=str(metric_b), x=categories, y=b_vals, yaxis="y2",
        mode="lines+markers+text",
        line=dict(color=PALETTE[2], width=3),
        marker=dict(size=9, color=PALETTE[2]),
        texttemplate="%{y:,.2~f}", textposition="top center",
        textfont=dict(color=PALETTE[2]),
    ))
    fig.update_layout(
        yaxis=dict(title=str(metric_a), rangemode="tozero"),
        yaxis2=dict(title=str(metric_b), overlaying="y", side="right", showgrid=False, rangemode="tozero"),
    )
    return fig


def build_figure(result: Any, chart_type: str, title: str = "", x_label: str | None = None, y_label: str | None = None) -> dict:
    chart_type = (chart_type or "bar").lower().strip()
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
        fig = go.Figure(go.Heatmap(z=result.values, x=list(result.columns), y=list(result.index), colorscale="Viridis"))
    elif chart_type == "waterfall":
        fig = go.Figure(go.Waterfall(
            x=df["x"], y=df["y"],
            connector={"line": {"color": "rgba(255,255,255,0.3)"}},
            increasing={"marker": {"color": "#00D1B2"}},
            decreasing={"marker": {"color": "#FF6B6B"}},
            totals={"marker": {"color": "#6C5CE7"}},
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
            y=pd.to_numeric(result[numeric_cols[1]], errors="coerce"), colorscale="Viridis",
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
        fig = go.Figure(go.Contour(z=result.values, x=[str(c) for c in result.columns], y=[str(i) for i in result.index], colorscale="Viridis"))
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
            line=dict(color=list(range(len(result))), colorscale="Viridis"),
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
            locationmode="country names", colorscale="Viridis", marker_line_color="white",
        ))

    else:
        fig = go.Figure(go.Bar(x=df["x"], y=df["y"], marker_color=PALETTE[0]))

    if barmode:
        fig.update_layout(barmode=barmode)

    fig.update_layout(
        template=DARK_TEMPLATE,
        title=title or "",
        xaxis_title=x_label or "",
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font=dict(family="Inter, system-ui, sans-serif", size=13, color="#E8E8F0"),
        margin=dict(l=40, r=20, t=50, b=40),
        hoverlabel=dict(bgcolor="#1E1E2E", font_size=13),
        legend=dict(bgcolor="rgba(0,0,0,0)"),
    )
    if not dual_axis_combo_used:
        # The normal case: one shared y axis, titled from the AI's own
        # y_label (or blank). The dual-axis combo above already gave each
        # of its two axes its own meaningful title (the metric name), so
        # it deliberately skips this generic overwrite.
        fig.update_layout(yaxis_title=y_label or "")

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
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font=dict(family="Inter, system-ui, sans-serif", size=13, color="#E8E8F0"),
        margin=dict(l=40, r=20, t=50, b=40),
        legend=dict(bgcolor="rgba(0,0,0,0)"),
    )
    return json.loads(fig.to_json())


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

"""
Turns a pandas result (DataFrame/Series) + a chart spec into a fully
JSON-serializable Plotly figure (data + layout) that the frontend renders
with react-plotly.js. Using Plotly (not static PNGs) is what makes charts
interactive - zoom, hover, export - like Tableau/Power BI, and it natively
supports things like waterfall charts.
"""
from __future__ import annotations

import json
from typing import Any

import pandas as pd
import plotly.graph_objects as go
import plotly.express as px

DARK_TEMPLATE = "plotly_dark"

PALETTE = [
    "#6C5CE7", "#00D1B2", "#FF6B6B", "#FFD166", "#4D96FF",
    "#F72585", "#43AA8B", "#F8961E", "#90BE6D", "#577590",
]


def _series_or_first_col(obj: pd.DataFrame | pd.Series) -> pd.Series:
    if isinstance(obj, pd.Series):
        return obj
    return obj.iloc[:, 0]


def build_figure(result: Any, chart_type: str, title: str = "", x_label: str | None = None, y_label: str | None = None) -> dict:
    chart_type = (chart_type or "bar").lower()

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

    if chart_type in ("bar", "column"):
        fig = go.Figure(go.Bar(x=df["x"], y=df["y"], marker_color=PALETTE[0]))
    elif chart_type == "line":
        fig = go.Figure(go.Scatter(x=df["x"], y=df["y"], mode="lines+markers", line=dict(color=PALETTE[3], width=3)))
    elif chart_type == "area":
        fig = go.Figure(go.Scatter(x=df["x"], y=df["y"], mode="lines", fill="tozeroy", line=dict(color=PALETTE[1])))
    elif chart_type == "pie":
        fig = go.Figure(go.Pie(labels=df["x"], values=df["y"], marker=dict(colors=PALETTE), hole=0.45))
    elif chart_type == "scatter":
        fig = go.Figure(go.Scatter(x=df["x"], y=df["y"], mode="markers", marker=dict(color=PALETTE[4], size=9)))
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
    else:
        fig = go.Figure(go.Bar(x=df["x"], y=df["y"], marker_color=PALETTE[0]))

    fig.update_layout(
        template=DARK_TEMPLATE,
        title=title or "",
        xaxis_title=x_label or "",
        yaxis_title=y_label or "",
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font=dict(family="Inter, system-ui, sans-serif", size=13, color="#E8E8F0"),
        margin=dict(l=40, r=20, t=50, b=40),
        hoverlabel=dict(bgcolor="#1E1E2E", font_size=13),
        legend=dict(bgcolor="rgba(0,0,0,0)"),
    )

    # fig.to_json() guarantees full JSON-safety (numpy types, NaT, etc handled)
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

"""
Rule-based chart & statistical-method suggestions, used to (a) seed the
AI's own suggestions and (b) give the user a reliable "suggested charts"
list even before they type a prompt.
"""
from __future__ import annotations

import warnings

import pandas as pd


def profile_dataframe(df: pd.DataFrame, max_cols: int = 40) -> dict:
    numeric_cols, categorical_cols, datetime_cols = [], [], []
    for col in list(df.columns)[:max_cols]:
        series = df[col]
        if pd.api.types.is_datetime64_any_dtype(series):
            datetime_cols.append(col)
        elif pd.api.types.is_numeric_dtype(series):
            numeric_cols.append(col)
        else:
            # try parse as date
            try:
                sample = series.dropna().head(20)
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    pd.to_datetime(sample, errors="raise")
                datetime_cols.append(col)
            except Exception:
                categorical_cols.append(col)

    return {
        "row_count": int(len(df)),
        "numeric_columns": numeric_cols,
        "categorical_columns": categorical_cols,
        "datetime_columns": datetime_cols,
        "null_counts": {c: int(df[c].isna().sum()) for c in df.columns[:max_cols]},
    }


def suggest_charts(profile: dict) -> list[dict]:
    suggestions = []
    num = profile["numeric_columns"]
    cat = profile["categorical_columns"]
    dt = profile["datetime_columns"]

    if dt and num:
        suggestions.append({
            "chart_type": "line",
            "title": f"Trend of {num[0]} over {dt[0]}",
            "reason": "Time-based numeric trends are best read as a line chart.",
        })
    if cat and num:
        suggestions.append({
            "chart_type": "bar",
            "title": f"{num[0]} by {cat[0]}",
            "reason": "Comparing a numeric measure across categories reads best as a bar chart.",
        })
        if len(profile.get("categorical_columns", [])) and profile["row_count"] <= 12:
            suggestions.append({
                "chart_type": "pie",
                "title": f"Share of {num[0]} by {cat[0]}",
                "reason": "Small number of categories - good candidate for a proportion/share view.",
            })
    if len(num) >= 2:
        suggestions.append({
            "chart_type": "scatter",
            "title": f"{num[0]} vs {num[1]}",
            "reason": "Two numeric columns - worth checking for correlation.",
        })
        suggestions.append({
            "chart_type": "heatmap",
            "title": "Correlation heatmap",
            "reason": "See how all numeric columns relate to each other at a glance.",
        })
    if num:
        suggestions.append({
            "chart_type": "histogram",
            "title": f"Distribution of {num[0]}",
            "reason": "Understand the spread/skew of a numeric column before deeper analysis.",
        })
        suggestions.append({
            "chart_type": "waterfall",
            "title": f"Cumulative build-up of {num[0]}",
            "reason": "Waterfall charts are ideal for showing sequential positive/negative contributions to a total.",
        })
    return suggestions[:6]


def suggest_stats(profile: dict) -> list[dict]:
    suggestions = []
    num = profile["numeric_columns"]
    cat = profile["categorical_columns"]

    if len(num) >= 2:
        suggestions.append({"method": "Pearson correlation", "reason": f"Quantify the linear relationship between {num[0]} and {num[1]}."})
        suggestions.append({"method": "Linear regression", "reason": f"Model how {num[1]} changes with {num[0]}."})
    if num:
        suggestions.append({"method": "Descriptive statistics (mean/median/std/quartiles)", "reason": f"Summarize the shape of {num[0]}."})
        suggestions.append({"method": "Outlier detection (IQR / z-score)", "reason": "Flag unusual values that could skew results."})
    if cat and num:
        suggestions.append({"method": "Group-by aggregation with ANOVA", "reason": f"Test whether {num[0]} differs significantly across {cat[0]} groups."})
    if profile["row_count"] and profile["row_count"] < 5000 and num:
        suggestions.append({"method": "Shapiro-Wilk normality test", "reason": "Check if a numeric column is normally distributed before choosing further tests."})
    return suggestions[:5]

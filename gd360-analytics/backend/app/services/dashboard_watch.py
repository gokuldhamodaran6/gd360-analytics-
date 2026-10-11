"""
Watching a number on a dashboard (2026-10-11, Explain & Alerts).

"Alert me if profit margin goes below 20%" on a dashboard becomes an
ordinary threshold automation whose target is

    {"kind": "board", "dashboard_id", "page_id", "block_id",
     "den_block_id": None | <id>,          # a ratio of two KPI tiles
     "window": "last_30_days" | "last_7_days" | "total",
     "label": "Profit margin"}

and whose KPI key is "value". This module computes that number exactly the
way the dashboard does - the tile's own spec run inside the warehouse by
services/dashboard_engine (or, for a file, the tile's own recipe in
pandas) - never a second way of computing it:

  evaluate(...)   the number now over the window (and the window before,
                  for the "why" line), optionally its month-by-month
                  history for the back-test;
  backtest(...)   would this line have fired on that history, how often;
  draft(...)      words -> a draft alert (never switched on here);
  suggestions(...) "Want me to watch this?" lines and the one thing GD360
                  noticed on the page.

Windows are measured back from the newest date in the data (for a live
source that is today), so a source whose data ends in 2017 still gets an
honest "last 30 days".
"""
from __future__ import annotations

import calendar
import logging
import math
import re
from datetime import date, datetime, timedelta

from sqlalchemy.orm import Session

from .. import models
from . import dashboard_engine
from .project_engine.present import _CURRENCY_NAME, _PERCENT_NAME, nice

logger = logging.getLogger("gd360.dashboard_watch")

WINDOWS = {"last_30_days": 30, "last_7_days": 7, "total": None}
WINDOW_TEXT = {"last_30_days": "the last 30 days", "last_7_days": "the last 7 days", "total": "everything the tile shows"}
HISTORY_POINTS = 24
KPI_TYPES = ("kpi", "gauge")
ADDITIVE = ("sum", "count")
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


class WatchError(ValueError):
    pass


# ---------------------------------------------------------------- lookup ----

def get_board(db: Session, user: models.User, dashboard_id: str) -> models.Dashboard:
    from ..routers.dashboards import _can_view
    d = db.get(models.Dashboard, dashboard_id or "")
    if not d or d.layout_version != 2 or not _can_view(db, d, user):
        raise WatchError("Pick a dashboard you can see.")
    return d


def find_block(d: models.Dashboard, block_id: str | None) -> tuple[models.DashboardPage, models.DashboardBlock]:
    for page in d.pages:
        for b in page.blocks:
            if b.id == block_id:
                return page, b
    raise WatchError("That number is no longer on the dashboard.")


def _source(db: Session, user: models.User, d: models.Dashboard) -> models.DataSource:
    from ..routers.dashboard_builder import _resolve_datasource_for_read
    ds = _resolve_datasource_for_read(db, user, d)
    if not ds:
        raise WatchError("This dashboard has no data source you can read.")
    return ds


def measure_of(block: models.DashboardBlock) -> dict | None:
    """{alias, agg, format, currency, good, label, warehouse} for a KPI tile, or None."""
    cfg = block.config or {}
    spec = cfg.get("spec")
    label = (block.title or cfg.get("label") or "").strip() or "The number"
    fmt = cfg.get("format")
    good = "down" if cfg.get("good_direction") == "down" else "up"
    if isinstance(spec, dict) and spec.get("table") and spec.get("measures"):
        m = spec["measures"][0]
        alias = m.get("alias")
        agg = (m.get("agg") or "").lower()
        if not fmt:
            fmt = "currency" if _CURRENCY_NAME.search(f"{alias} {label}") and agg in ADDITIVE + ("avg",) and agg != "count" else None
        return {"alias": alias, "agg": agg, "format": fmt, "currency": cfg.get("currency") or "USD", "good": good,
                "label": label, "warehouse": True, "table": spec.get("table")}
    recipe = cfg.get("recipe")
    if isinstance(recipe, dict) and not recipe.get("metric_id") and (recipe.get("metric_column") or recipe.get("count_rows")):
        agg = "count" if recipe.get("count_rows") else (recipe.get("agg") or "sum").lower()
        alias = recipe.get("alias") or recipe.get("metric_column")
        if not fmt:
            v = cfg.get("value")
            if _PERCENT_NAME.search(str(alias)) and isinstance(v, (int, float)) and 0 <= v <= 1:
                fmt = "percent"
            elif _CURRENCY_NAME.search(f"{alias} {label}") and agg != "count":
                fmt = "currency"
        return {"alias": alias, "agg": agg, "format": fmt, "currency": cfg.get("currency") or "USD", "good": good,
                "label": label, "warehouse": False, "recipe": recipe}
    if isinstance(cfg.get("value"), (int, float)):
        return {"alias": None, "agg": None, "format": fmt, "currency": cfg.get("currency") or "USD", "good": good,
                "label": label, "warehouse": False, "static": True}
    return None


def kpi_blocks(d: models.Dashboard, page_id: str | None = None) -> list[tuple[models.DashboardPage, models.DashboardBlock, dict]]:
    out = []
    pages = sorted(d.pages, key=lambda p: (p.id != page_id, p.position or 0))
    for page in pages:
        for b in sorted(page.blocks, key=lambda b: (b.y or 0, b.x or 0)):
            if b.type in KPI_TYPES:
                m = measure_of(b)
                if m:
                    out.append((page, b, m))
    return out


# ------------------------------------------------------------- formatting ----

def _shown(v: float | None, m: dict) -> float | None:
    """The number as people read it: a rate stored as 0.373 reads 37.3."""
    if v is None:
        return None
    return float(v) * 100 if m.get("format") == "percent" else float(v)


def _kind(m: dict) -> str:
    if m.get("format") == "percent":
        return "percent"
    if m.get("format") == "currency":
        return "currency"
    return "integer" if m.get("agg") == "count" else "number"


def display(v: float | None, kind: str, currency: str = "USD") -> str:
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return "—"
    if kind == "percent":
        return f"{v:.1f}%"
    return nice(v, kind, currency)


def line_display(v: float, kind: str, currency: str = "USD") -> str:
    if kind == "percent":
        return f"{v:g}%"
    return nice(v, kind, currency)


def month_label(period: str) -> str:
    try:
        y, m = int(period[:4]), int(period[5:7])
        return f"{MONTHS[m - 1]} {y}"
    except (ValueError, IndexError):
        return str(period)


def _parse_day(v) -> date | None:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


# --------------------------------------------------------------- engines ----

def _wh_specs(page: models.DashboardPage, block_ids: list[str]) -> list[dict]:
    """The tiles' own specs, each asked for its sparkline and prior-period
    comparison (the same SQL the tile runs, plus those two companions)."""
    from ..routers.dashboard_builder import _warehouse_page_blocks
    runnable, _ = _warehouse_page_blocks(page, block_ids)
    out = []
    for r in runnable:
        if r.get("spec") and r["id"] in block_ids:
            out.append({"id": r["id"], "spec": {**r["spec"], "sparkline": True, "compare_prior_period": True}})
        elif r["id"] in block_ids:
            out.append(r)
    return out


def _wh_run(db: Session, user: models.User, d: models.Dashboard, ds, page, block_ids: list[str],
            date_range: dict | None = None, period: str | None = None) -> dict:
    runnable = _wh_specs(page, block_ids)
    if not runnable:
        return {}
    res = dashboard_engine.run_page(
        db, ds, runnable, page_filters=[], period=period, date_range=date_range, user_id=user.id,
        date_column=d.date_column, block_filters={}, default_period=d.default_period,
        dashboard_parameters=d.parameters if isinstance(d.parameters, list) else [],
    )
    return res.get("blocks") or {}


def _wh_max_date(db: Session, user: models.User, d: models.Dashboard, ds, table: str | None) -> date | None:
    if not d.date_column or not table:
        return None
    b = dashboard_engine.column_bounds(db, ds, table, [d.date_column], user_id=user.id)
    return _parse_day((b.get(d.date_column) or {}).get("max"))


def _file_frame(db: Session, user: models.User, ds):
    from ..services import data_access_rules
    from ..services.data_loader import load_dataframe
    df = load_dataframe(ds, table=None, version="original", db=db)
    return data_access_rules.filter_dataframe_for_role(db, df, ds, user)


def _file_agg(frame, m: dict):
    recipe = m.get("recipe") or {}
    if m["agg"] == "count":
        return float(len(frame))
    col = recipe.get("metric_column")
    if col not in frame.columns or not len(frame):
        return None
    func = {"avg": "mean", "average": "mean"}.get(m["agg"], m["agg"])
    try:
        v = frame[col].agg(func)
        return float(v) if v == v else None
    except Exception:  # noqa: BLE001
        return None


def _file_dates(frame, column: str | None):
    import pandas as pd
    if not column or column not in frame.columns:
        return None
    s = frame[column]
    if not pd.api.types.is_datetime64_any_dtype(s):
        s = pd.to_datetime(s, errors="coerce")
    try:
        s = s.dt.tz_localize(None)
    except (TypeError, AttributeError):
        pass
    return s if s.notna().any() else None


# ------------------------------------------------------------ the number ----

class _Probe:
    """Reads one or two KPI tiles of a dashboard - over a window, and month by month."""

    def __init__(self, db: Session, user: models.User, d: models.Dashboard, parts: list[tuple]):
        self.db, self.user, self.d = db, user, d
        self.parts = parts  # [(page, block, measure)]
        self.ds = None if all(m.get("static") for _, _, m in parts) else _source(db, user, d)
        self.warehouse = bool(self.ds) and dashboard_engine.is_warehouse_native(self.ds)
        self._frame = None
        self._max = "?"

    def frame(self):
        if self._frame is None:
            self._frame = _file_frame(self.db, self.user, self.ds)
        return self._frame

    def max_date(self) -> date | None:
        if self._max != "?":
            return self._max
        out = None
        try:
            if self.warehouse:
                out = _wh_max_date(self.db, self.user, self.d, self.ds, self.parts[0][2].get("table"))
            elif self.ds is not None:
                recipe = self.parts[0][2].get("recipe") or {}
                s = _file_dates(self.frame(), recipe.get("trend_column") or self.d.date_column)
                out = s.max().date() if s is not None else None
        except Exception as e:  # noqa: BLE001
            logger.info("[watch] max date unavailable: %s", e)
        self._max = out
        return out

    def can_window(self) -> bool:
        if all(m.get("static") for _, _, m in self.parts):
            return False
        if self.warehouse:
            return bool(self.d.date_column) and self.max_date() is not None
        return all((m.get("recipe") or {}).get("trend_column") for _, _, m in self.parts) and self.max_date() is not None

    def values(self, window: str) -> dict:
        """{block_id: (current, prior)} - prior is the same-length window before (None for "total")."""
        days = WINDOWS.get(window)
        end = self.max_date() if days else None
        if days and end is None:
            days = None
        out: dict = {}
        if self.warehouse:
            by_page: dict = {}
            for page, b, m in self.parts:
                by_page.setdefault(page.id, (page, []))[1].append(b.id)
            dr = {"from": (end - timedelta(days=days - 1)).isoformat(), "to": end.isoformat()} if days else None
            for page, ids in by_page.values():
                res = _wh_run(self.db, self.user, self.d, self.ds, page, ids, date_range=dr)
                for page_, b, m in self.parts:
                    r = res.get(b.id)
                    if not r or r.get("status") != "ok" or not r.get("rows"):
                        if r and r.get("status") not in (None, "ok"):
                            raise WatchError(r.get("error") or f"{m['label']} could not be computed right now.")
                        continue
                    cur = r["rows"][0].get(m["alias"])
                    delta = (r.get("delta") or {}).get(m["alias"]) or {}
                    out[b.id] = (_num(cur), _num(delta.get("prior")) if dr else None)
            return out
        for page, b, m in self.parts:
            if m.get("static"):
                out[b.id] = (_num((b.config or {}).get("value")), None)
                continue
            frame = self.frame()
            if days:
                s = _file_dates(frame, (m.get("recipe") or {}).get("trend_column") or self.d.date_column)
                if s is None:
                    out[b.id] = (_file_agg(frame, m), None)
                    continue
                import pandas as pd
                endts = pd.Timestamp(end) + pd.Timedelta(days=1)
                start = endts - pd.Timedelta(days=days)
                prior_start = start - pd.Timedelta(days=days)
                cur = _file_agg(frame[(s >= start) & (s < endts)], m)
                prior = _file_agg(frame[(s >= prior_start) & (s < start)], m)
                out[b.id] = (cur, prior)
            else:
                out[b.id] = (_file_agg(frame, m), None)
        return out

    def history(self) -> dict:
        """{block_id: [(YYYY-MM, value)]} month by month, oldest first, the
        last month left out while the data only partly covers it."""
        end = self.max_date()
        out: dict = {}
        if self.warehouse:
            by_page: dict = {}
            for page, b, m in self.parts:
                by_page.setdefault(page.id, (page, []))[1].append(b.id)
            for page, ids in by_page.values():
                res = _wh_run(self.db, self.user, self.d, self.ds, page, ids, period="month")
                for _, b, m in self.parts:
                    r = res.get(b.id) or {}
                    rows = ((r.get("sparkline") or {}).get("rows")) or []
                    pts = []
                    for row in rows:
                        p = _parse_day(row.get("period"))
                        v = _num(row.get(m["alias"]))
                        if p and v is not None:
                            pts.append((p.strftime("%Y-%m"), v))
                    out[b.id] = pts
        elif self.ds is not None:
            frame = self.frame()
            for _, b, m in self.parts:
                if m.get("static"):
                    out[b.id] = []
                    continue
                s = _file_dates(frame, (m.get("recipe") or {}).get("trend_column") or self.d.date_column)
                if s is None:
                    out[b.id] = []
                    continue
                keys = s.dt.strftime("%Y-%m")
                pts = []
                for k in sorted(k for k in keys.dropna().unique()):
                    v = _file_agg(frame[keys == k], m)
                    if v is not None:
                        pts.append((k, v))
                out[b.id] = pts
        if end is not None:
            last_day = calendar.monthrange(end.year, end.month)[1]
            partial = end.strftime("%Y-%m") if end.day < last_day else None
            if partial:
                out = {k: [p for p in v if p[0] != partial] for k, v in out.items()}
        return out


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _ratio(n, d_, per: bool = False):
    if n is None or d_ in (None, 0):
        return None
    return n / d_ if per else n / d_ * 100


def _parts(d: models.Dashboard, target: dict) -> list[tuple]:
    page, b = find_block(d, target.get("block_id"))
    m = measure_of(b)
    if not m or b.type not in KPI_TYPES:
        raise WatchError("Pick a number tile (a KPI) to watch.")
    parts = [(page, b, m)]
    if target.get("den_block_id"):
        p2, b2 = find_block(d, target.get("den_block_id"))
        m2 = measure_of(b2)
        if not m2 or b2.type not in KPI_TYPES:
            raise WatchError("Pick a number tile (a KPI) to divide by.")
        if m.get("static") or m2.get("static") or m.get("agg") not in ADDITIVE or m2.get("agg") not in ADDITIVE:
            bad = m if m.get("agg") not in ADDITIVE else m2
            raise WatchError(f"A ratio needs two totals (sums or counts) - “{bad['label']}” is not a total, so dividing it would mislead.")
        parts.append((p2, b2, m2))
    return parts


def default_label(parts: list[tuple], per: bool = False) -> str:
    if len(parts) == 2:
        a, b = parts[0][2]["label"], parts[1][2]["label"]
        if per:
            unit = re.sub(r"^(total|number of|count of)\s+", "", b.strip(), flags=re.I).rstrip("s").lower() or b.lower()
            return f"{a} per {unit}"
        if re.search(r"profit|income|earning|margin", a, re.I) and re.search(r"sales|revenue|turnover", b, re.I):
            return "Profit margin"
        return f"{a} ÷ {b}"
    return parts[0][2]["label"]


def _move_word(pct: float | None, kind: str = "number", points: float | None = None) -> str:
    if kind == "percent" and points is not None:
        if abs(points) < 0.05:
            return "held steady"
        return f"{'rose' if points > 0 else 'fell'} {abs(points):.1f} points"
    if pct is None:
        return ""
    if abs(pct) < 0.05:
        return "held steady"
    return f"{'rose' if pct > 0 else 'fell'} {abs(pct):.1f}%"


def evaluate(db: Session, user: models.User, target: dict, history: bool = False) -> dict:
    """The watched number now (and, with history=True, month by month)."""
    d = get_board(db, user, target.get("dashboard_id"))
    parts = _parts(d, target)
    probe = _Probe(db, user, d, parts)
    window = target.get("window") if target.get("window") in WINDOWS else "last_30_days"
    if window != "total" and not probe.can_window():
        window = "total"
    vals = probe.values(window)
    (page, b, m) = parts[0]
    ratio = len(parts) == 2
    per = ratio and target.get("ratio_as") == "per"
    kind = ("currency" if m.get("format") == "currency" else "number") if per else ("percent" if ratio else _kind(m))
    cur_n, pri_n = vals.get(b.id, (None, None))
    why = None
    if ratio:
        cur_d, pri_d = vals.get(parts[1][1].id, (None, None))
        value, prior = _ratio(cur_n, cur_d, per), _ratio(pri_n, pri_d, per)
        pieces = []
        for (_, bb, mm), (c, p) in ((parts[0], (cur_n, pri_n)), (parts[1], (cur_d, pri_d))):
            if c is not None and p not in (None, 0):
                pieces.append(f"{mm['label']} {_move_word((c - p) / abs(p) * 100)}")
        if pieces and window != "total":
            why = " while ".join(pieces[:2]) + f", against the {WINDOWS[window]} days before."
            why = why[0].upper() + why[1:]
    else:
        value, prior = _shown(cur_n, m), _shown(pri_n, m)
        if value is not None and prior not in (None, 0) and window != "total":
            word = _move_word((value - prior) / abs(prior) * 100, kind, value - prior)
            why = f"{m['label']} {word} against the {WINDOWS[window]} days before ({display(prior, kind, m['currency'])} then)."
    label = (target.get("label") or "").strip() or default_label(parts, per)
    end = probe.max_date() if window != "total" else None
    out = {
        "key": "value", "label": label, "value": value, "display": display(value, kind, m["currency"]),
        "kind": kind, "unit": "%" if kind == "percent" else "", "currency": m["currency"],
        "prior": prior, "prior_display": display(prior, kind, m["currency"]) if prior is not None else None,
        "delta_pct": round((value - prior) / abs(prior) * 100, 2) if value is not None and prior not in (None, 0) else None,
        "why": why, "window": window, "window_text": WINDOW_TEXT[window],
        "as_of": end.isoformat() if end else None,
        "good": m.get("good", "up"),
        "ratio": ratio,
        "formula": f"{parts[0][2]['label']} ÷ {parts[1][2]['label']}" if ratio else None,
        "ratio_as": ("per" if per else "percent") if ratio else None,
        "parts": [{"block_id": bb.id, "label": mm["label"], "agg": mm.get("agg")} for _, bb, mm in parts],
        "dashboard": {"id": d.id, "name": d.name}, "page_id": page.id,
        "link": f"/dashboard-builder/{d.id}?page={page.id}",
        "can_window": window != "total",
    }
    if history:
        hist = probe.history()
        series = hist.get(b.id) or []
        if ratio:
            dens = dict(hist.get(parts[1][1].id) or [])
            series = [(p, _ratio(v, dens.get(p), per)) for p, v in series]
        else:
            series = [(p, _shown(v, m)) for p, v in series]
        series = [(p, v) for p, v in series if v is not None][-HISTORY_POINTS:]
        out["history"] = [{"period": p, "label": month_label(p), "value": round(v, 4)} for p, v in series]
    return out


def as_kpi(ev: dict) -> dict:
    """The shape services/automations reads (key/label/value/display/kind)."""
    out = {k: ev.get(k) for k in ("key", "label", "value", "display", "kind", "why", "window_text", "as_of", "prior_display", "delta_pct")}
    if ev.get("delta_pct") is not None:
        out["delta"] = f"{ev['delta_pct']:+.1f}%"
        out["delta_dir"] = "down" if ev["delta_pct"] < 0 else "up"
    return out


# --------------------------------------------------------------- backtest ----

BY_OPS = ("drops_by", "rises_by")
OP_WORDS = {"below": "goes below", "above": "goes above", "drops_by": "falls by more than", "rises_by": "rises by more than"}


def crossed(v: float, op: str, line: float) -> bool:
    """v is the number itself for below/above, its % change for drops_by/rises_by."""
    if op == "below":
        return v < line
    if op == "above":
        return v > line
    if op == "drops_by":
        return v <= -abs(line)
    return v >= abs(line)


def changes(history: list[dict]) -> list[dict]:
    """Month-over-month % change, for a "falls by more than X%" back-test."""
    out = []
    for a, b in zip(history, history[1:]):
        if a.get("value") not in (None, 0) and b.get("value") is not None:
            out.append({"period": b["period"], "label": b["label"], "value": (b["value"] - a["value"]) / abs(a["value"]) * 100})
    return out


def backtest(history: list[dict], op: str, line: float, kind: str, currency: str = "USD") -> dict:
    by = op in BY_OPS
    pts = [h for h in (changes(history or []) if by else history or []) if h.get("value") is not None]
    if len(pts) < 3:
        return {"points": len(pts), "text": "Not enough history to test this line on yet - it starts watching from today."}
    over = [h for h in pts if crossed(h["value"], op, line)]
    fires, was = 0, False
    for h in pts:
        now = crossed(h["value"], op, line)
        if now and not was:
            fires += 1
        was = now
    low = min(pts, key=lambda h: h["value"])
    high = max(pts, key=lambda h: h["value"])
    n = len(pts)
    if by:
        ld = f"{abs(line):g}%"
        word = "a fall of more than" if op == "drops_by" else "a rise of more than"
        if not over:
            ext = low if op == "drops_by" else high
            text = (f"{'Biggest monthly fall' if op == 'drops_by' else 'Biggest monthly rise'} in {n} months: "
                    f"{abs(ext['value']):.1f}% ({ext['label']}). On this history it would not have fired.")
        else:
            text = (f"{len(over)} of the last {n} months had {word} {ld} (most recently {over[-1]['label']}) - "
                    f"it would have told you {fires} time{'s' if fires != 1 else ''}.")
        return {"points": n, "months_crossed": len(over), "fires": fires, "text": text}
    ld = line_display(line, kind, currency)
    word = "below" if op == "below" else "above"
    if not over:
        ext = low if op == "below" else high
        text = (f"{'Lowest' if op == 'below' else 'Highest'} in {n} months: {display(ext['value'], kind, currency)} "
                f"({ext['label']}). On this history it would not have fired - so when it does, it means something.")
    else:
        last = over[-1]
        text = (f"It was {word} {ld} in {len(over)} of the last {n} months (most recently {last['label']}) - "
                f"it would have told you {fires} time{'s' if fires != 1 else ''}, once each time it crossed.")
        if len(over) >= n * 0.5:
            text += " That's most months - a line further out may be more useful."
    return {
        "points": n, "months_crossed": len(over), "fires": fires,
        "lowest": {"label": low["label"], "value": low["value"], "display": display(low["value"], kind, currency)},
        "highest": {"label": high["label"], "value": high["value"], "display": display(high["value"], kind, currency)},
        "text": text,
    }


# ------------------------------------------------------------ words -> draft ----

_BELOW = re.compile(r"\b(below|under(?:neath)?|less than|lower than|drops?|dips?|falls?|fell|sinks?|goes down|beneath|<)\b|<", re.I)
_ABOVE = re.compile(r"\b(above|over|more than|higher than|exceeds?|rises?|climbs?|goes up|tops?|greater than|>)\b|>", re.I)
_NUMBER = re.compile(r"(-?\d[\d,]*(?:\.\d+)?)\s*(%|percent|pct|k\b|m\b|b\b|thousand|million|billion|mn\b|bn\b)?", re.I)
_ALERT_WORDS = re.compile(
    r"\b(alert|notify|notification|tell me|let me know|warn|watch|ping|email me|message me|remind|keep an eye|heads up|monitor)\b", re.I)
_STOP = {"alert", "me", "if", "when", "the", "a", "an", "of", "goes", "go", "is", "gets", "get", "below", "above", "under", "over",
         "less", "more", "than", "drops", "drop", "falls", "fall", "to", "please", "notify", "tell", "let", "know", "watch",
         "my", "our", "on", "this", "dashboard", "number", "and", "or", "by", "for", "it", "rises", "rise", "exceeds", "percent",
         "pct", "warn", "email", "ping", "lower", "higher", "dips", "climbs", "every", "day", "time", "keep", "eye", "an"}
_SYN = {"sales": {"revenue", "turnover", "sales"}, "revenue": {"revenue", "sales", "turnover"}, "orders": {"orders", "bookings"},
        "bookings": {"bookings", "orders", "reservations"}, "profit": {"profit", "income", "earnings"},
        "customers": {"customers", "users", "clients"}, "aov": {"aov", "basket"}, "cancellations": {"cancellation", "cancellations", "canceled", "cancelled"}}


def looks_like_alert(text: str) -> bool:
    t = text or ""
    return bool(_ALERT_WORDS.search(t)) and bool(_NUMBER.search(t) or _BELOW.search(t) or _ABOVE.search(t))


def _tokens(text: str) -> set[str]:
    words = {w for w in re.findall(r"[a-z][a-z0-9]+", (text or "").lower()) if w not in _STOP and len(w) > 1}
    out = set(words)
    for w in words:
        out |= _SYN.get(w, set())
        if w.endswith("s"):
            out.add(w[:-1])
    return out


def _score(text_tokens: set[str], m: dict, block: models.DashboardBlock) -> int:
    names = _tokens(f"{m['label']} {str(m.get('alias') or '').replace('_', ' ')}")
    return len(text_tokens & names)


def parse_rule(text: str) -> dict:
    """Deterministic read of "alert me if X goes below 20%" - op, value, unit."""
    t = text or ""
    nm = None
    for m in _NUMBER.finditer(t):
        raw = m.group(1).replace(",", "")
        if re.fullmatch(r"(19|20)\d\d", raw) and not m.group(2):
            continue
        nm = m
        break
    op = None
    b, a = _BELOW.search(t), _ABOVE.search(t)
    if b and (not a or b.start() < a.start()):
        op = "below"
    elif a:
        op = "above"
    value, unit = None, ""
    if nm:
        value = float(nm.group(1).replace(",", ""))
        suf = (nm.group(2) or "").lower()
        if suf in ("%", "percent", "pct"):
            unit = "%"
        elif suf in ("k", "thousand"):
            value *= 1e3
        elif suf in ("m", "million", "mn"):
            value *= 1e6
        elif suf in ("b", "billion", "bn"):
            value *= 1e9
    by = re.search(r"\b(drops?|falls?|fell|declines?|decreases?|goes down|down|rises?|grows?|jumps?|increases?|goes up|up)\s+"
                   r"(?:by\s+)?(?:more than\s+|over\s+|at least\s+)?(\d[\d,]*(?:\.\d+)?)\s*(%|percent)", t, re.I)
    if by:
        down = re.match(r"drop|fall|fell|decline|decrease|goes down|down", by.group(1), re.I)
        return {"op": "drops_by" if down else "rises_by", "value": float(by.group(2).replace(",", "")), "unit": "%"}
    return {"op": op, "value": value, "unit": unit}


def match_metric(text: str, blocks: list[tuple]) -> dict:
    """{block_id, den_block_id, label} from the words, or {} when unsure."""
    toks = _tokens(text)
    per = re.search(r"([a-z][a-z ]*?)\s+(?:per|for each|each)\s+([a-z]+)", (text or "").lower())
    if per:
        left, right = _tokens(per.group(1).split(" if ")[-1]), _tokens(per.group(2))
        add = [(p, b, m) for p, b, m in blocks if m.get("agg") in ADDITIVE]
        nums = sorted(add, key=lambda x: -len(left & _tokens(f"{x[2]['label']} {x[2].get('alias') or ''}")))
        dens = sorted(add, key=lambda x: -len(right & _tokens(f"{x[2]['label']} {x[2].get('alias') or ''}")))
        if nums and dens and nums[0][1].id != dens[0][1].id \
                and left & _tokens(f"{nums[0][2]['label']} {nums[0][2].get('alias') or ''}") \
                and right & _tokens(f"{dens[0][2]['label']} {dens[0][2].get('alias') or ''}"):
            return {"block_id": nums[0][1].id, "den_block_id": dens[0][1].id, "ratio_as": "per", "label": None}
    if re.search(r"\bmargin\b", text or "", re.I):
        nums = [(p, b, m) for p, b, m in blocks if re.search(r"profit|income|earning", m["label"], re.I) and m.get("agg") in ADDITIVE]
        dens = [(p, b, m) for p, b, m in blocks if re.search(r"sales|revenue|turnover", m["label"], re.I) and m.get("agg") in ADDITIVE]
        own = [(p, b, m) for p, b, m in blocks if re.search(r"margin", m["label"], re.I)]
        if own:
            return {"block_id": own[0][1].id, "den_block_id": None, "label": own[0][2]["label"]}
        if nums and dens:
            nums.sort(key=lambda x: -_score(toks, x[2], x[1]))
            dens.sort(key=lambda x: -_score(toks, x[2], x[1]))
            return {"block_id": nums[0][1].id, "den_block_id": dens[0][1].id, "ratio_as": "percent", "label": "Profit margin"}
    scored = sorted(((_score(toks, m, b), i, b, m) for i, (p, b, m) in enumerate(blocks)), key=lambda x: (-x[0], x[1]))
    if scored and scored[0][0] > 0 and (len(scored) == 1 or scored[0][0] > scored[1][0]):
        return {"block_id": scored[0][2].id, "den_block_id": None, "label": scored[0][3]["label"]}
    return {}


_DRAFTER = """You are the GD360 ALERT DRAFTER. A person looking at a dashboard typed what they want to be alerted about.
Map it onto the dashboard's number tiles. Reply with ONE JSON object only:
{"understood": true|false,
 "block_id": "<id of the tile to watch, or the numerator of a ratio>",
 "den_block_id": "<id of the tile to divide by, or null>",
 "ratio_as": "percent"|"per"  (percent: a margin or rate, numerator/denominator x 100; per: an amount per unit, e.g. revenue per booking),
 "label": "<short name for the watched number, e.g. Profit margin>",
 "op": "below"|"above"|"drops_by"|"rises_by",
 "value": <number in the units people read: 20 for 20%, 1500000 for 1.5M>,
 "window": "last_30_days"|"last_7_days"|"total",
 "question": "<if not understood: one short question back to the person>"}
Rules: only use tile ids from the list. A margin or rate that is not a tile is a ratio of two TOTAL tiles (sum or count) -
never divide averages. If the number is a percent tile, value is in percent (20 means 20%). Default window last_30_days."""


def _llm_parse(text: str, blocks: list[tuple]) -> dict:
    from . import ai_engine
    lines = [f"- id={b.id} | {m['label']} | aggregation={m.get('agg') or 'stored'} | format={m.get('format') or 'number'}"
             for _, b, m in blocks[:24]]
    msgs = [{"role": "system", "content": _DRAFTER},
            {"role": "user", "content": "Number tiles:\n" + "\n".join(lines) + f"\n\nRequest: {text.strip()[:400]}"}]
    try:
        out = ai_engine._plan_with_retry(msgs, max_tokens=800)  # noqa: SLF001
        return out if isinstance(out, dict) else {}
    except Exception as e:  # noqa: BLE001 - the words are also read without a model
        logger.info("[watch] drafter model unavailable: %s", e)
        return {}


def draft(db: Session, user: models.User, dashboard_id: str, *, text: str | None = None, page_id: str | None = None,
          block_id: str | None = None, den_block_id: str | None = None, ratio_as: str | None = None, op: str | None = None,
          value: float | None = None, window: str | None = None, label: str | None = None,
          use_model: bool = True) -> dict:
    """A draft alert - never switched on here. Status "ok" | "need_metric" | "need_line"."""
    d = get_board(db, user, dashboard_id)
    blocks = kpi_blocks(d, page_id)
    choices = [{"block_id": b.id, "label": m["label"], "page_id": p.id, "agg": m.get("agg"), "format": m.get("format")}
               for p, b, m in blocks]
    if not blocks:
        return {"status": "need_metric", "message": "This dashboard has no number tiles to watch yet - add a KPI tile first.",
                "choices": []}
    rule = parse_rule(text or "") if text else {"op": None, "value": None, "unit": ""}
    picked = {"block_id": block_id, "den_block_id": den_block_id, "ratio_as": ratio_as, "label": label} if block_id else {}
    if text and not picked:
        picked = match_metric(text, blocks)
        if use_model:
            ai = _llm_parse(text, blocks)
            ids = {b.id for _, b, _ in blocks}
            # a ratio read straight from the words ("revenue per booking",
            # "profit margin") stands unless the model also saw a ratio
            keep_rule = bool(picked.get("den_block_id")) and not ai.get("den_block_id")
            if not keep_rule and ai.get("understood") and ai.get("block_id") in ids and (not ai.get("den_block_id") or ai["den_block_id"] in ids):
                picked = {"block_id": ai["block_id"], "den_block_id": ai.get("den_block_id") or None,
                          "ratio_as": "per" if ai.get("ratio_as") == "per" else "percent",
                          "label": (ai.get("label") or "").strip()[:60] or None}
                if ai.get("op") in OP_WORDS and not rule["op"]:
                    rule["op"] = ai["op"]
                if rule["value"] is None and _num(ai.get("value")) is not None:
                    rule["value"] = _num(ai.get("value"))
                if ai.get("window") in WINDOWS and not window:
                    window = ai["window"]
    op = op or rule["op"]
    value = value if value is not None else rule["value"]
    if not picked.get("block_id"):
        return {"status": "need_metric", "message": "Which number should I watch?", "choices": choices,
                "op": op, "value": value}
    target = {"kind": "board", "dashboard_id": d.id, "block_id": picked["block_id"],
              "den_block_id": picked.get("den_block_id") or None, "window": window or "last_30_days",
              "ratio_as": ("per" if picked.get("ratio_as") == "per" else "percent") if picked.get("den_block_id") else None,
              "label": picked.get("label") or None}
    try:
        ev = evaluate(db, user, target, history=True)
    except WatchError as e:
        return {"status": "need_metric", "message": str(e), "choices": choices, "op": op, "value": value}
    target["page_id"] = ev["page_id"]
    target["window"] = ev["window"]
    target["label"] = ev["label"]
    if ev["kind"] == "percent" and op in ("below", "above") and value is not None and rule.get("unit") != "%" \
            and 0 < abs(value) <= 1 and text and "%" not in text:
        value = value * 100  # "below 0.2" on a rate means 20%
    if op not in OP_WORDS or value is None:
        return {"status": "need_line", "message": f"Tell me the line for {ev['label']} - below or above what?",
                "current": _cur(ev), "target": target, "choices": choices}
    return {"status": "ok", "draft": build_draft(ev, target, op, float(value)), "choices": choices}


def _cur(ev: dict) -> dict:
    return {"display": ev["display"], "value": ev["value"], "window_text": ev["window_text"], "as_of": ev.get("as_of")}


def build_draft(ev: dict, target: dict, op: str, value: float) -> dict:
    kind = ev["kind"]
    by = op in BY_OPS
    value = abs(value) if by else value
    ld = f"{value:g}%" if by else line_display(value, kind, ev.get("currency") or "USD")
    bt = backtest(ev.get("history") or [], op, value, kind, ev.get("currency") or "USD")
    if by:
        dp = ev.get("delta_pct")
        now = crossed(dp, op, value) if dp is not None else None
    else:
        now = crossed(ev["value"], op, value) if ev.get("value") is not None else None
    word = OP_WORDS[op]
    return {
        "name": f"{ev['label']} {word.replace('goes ', '')} {ld}"[:80],
        "target": target, "kpi": "value", "op": op, "value": value, "unit": ev["unit"], "line_display": ld,
        "label": ev["label"], "formula": ev.get("formula"), "ratio": ev.get("ratio"),
        "window": ev["window"], "window_text": ev["window_text"], "as_of": ev.get("as_of"),
        "current": _cur(ev), "why": ev.get("why"), "met_now": now,
        "history": ev.get("history") or [], "backtest": bt,
        "dashboard": ev["dashboard"], "link": ev["link"], "kind": kind,
        "check": {"every": "hour", "minute": 0},
        "when_text": f"{ev['label']} {word} {ld}" + (f" against the {WINDOWS[ev['window']]} days before" if by and ev["window"] != "total" else ""),
    }


# ------------------------------------------------------------ suggestions ----

def _nice_line(v: float, kind: str, op: str) -> float:
    """A round line just beyond v ("below 120k" rather than 118,342.7)."""
    if v == 0:
        return 0.0
    if kind == "percent":
        step = 1 if abs(v) < 20 else 5
    else:
        mag = 10 ** math.floor(math.log10(abs(v)))
        step = mag / 2 if abs(v) / mag < 3 else mag
    return (math.floor(v / step) * step) if op == "below" else (math.ceil(v / step) * step)


_SUGGEST_TTL = 600
_suggest_cache: dict = {}


def suggestions(db: Session, user: models.User, dashboard_id: str, page_id: str | None = None, limit: int = 3) -> dict:
    """Up to `limit` "watch this?" lines for the page's number tiles, each a
    line its own history rarely crossed, and the one most notable recent
    move ("GD360 noticed ..."). Numbers only - no model. Kept for ten
    minutes per person and page (opening a dashboard asks for it)."""
    import time as _t
    d = get_board(db, user, dashboard_id)
    key = (d.id, page_id, user.id)
    hit = _suggest_cache.get(key)
    if hit and _t.time() - hit[0] < _SUGGEST_TTL:
        return {**hit[1], "suggestions": list(hit[1]["suggestions"])}
    out = _suggestions(db, user, d, page_id, limit)
    if len(_suggest_cache) > 500:
        _suggest_cache.clear()
    _suggest_cache[key] = (_t.time(), out)
    return {**out, "suggestions": list(out["suggestions"])}


def _suggestions(db: Session, user: models.User, d: models.Dashboard, page_id: str | None, limit: int) -> dict:
    blocks = [x for x in kpi_blocks(d, page_id) if (page_id is None or x[0].id == page_id) and not x[2].get("static")][:6]
    if not blocks:
        return {"suggestions": [], "noticed": None}
    try:
        probe = _Probe(db, user, d, blocks)
        hist = probe.history()
    except Exception as e:  # noqa: BLE001 - suggestions are a nicety, never an error
        logger.info("[watch] suggestions skipped: %s", e)
        return {"suggestions": [], "noticed": None}
    out, noticed = [], None
    for page, b, m in blocks:
        series = [(p, _shown(v, m)) for p, v in hist.get(b.id) or []]
        series = [(p, v) for p, v in series if v is not None]
        if len(series) < 4:
            continue
        kind = _kind(m)
        cur_p, cur = series[-1]
        recent = [v for _, v in series[-13:-1]] or [v for _, v in series[:-1]]
        op = "above" if m.get("good") == "down" else "below"
        edge = max(recent) if op == "above" else min(recent)
        line = _nice_line(edge * (1.02 if op == "above" else 0.98), kind, op)
        if line == 0 and kind != "percent":
            continue
        ld = line_display(line, kind, m["currency"])
        out.append({
            "block_id": b.id, "page_id": page.id, "label": m["label"], "op": op, "value": line, "line_display": ld,
            "text": f"{m['label']} {op} {ld}",
            "reason": f"It hasn't been {op} that in the last {len(recent)} full months.",
        })
        ago = next((v for p, v in series[:-1] if p == f"{int(cur_p[:4]) - 1}{cur_p[4:]}"), None)
        base, base_text = (ago, f"{month_label(f'{int(cur_p[:4]) - 1}{cur_p[4:]}')}") if ago not in (None, 0) else (series[-2][1], month_label(series[-2][0]))
        if base in (None, 0):
            continue
        pct = (cur - base) / abs(base) * 100
        bad = (pct < 0) if m.get("good") != "down" else (pct > 0)
        if bad and abs(pct) >= 5 and (noticed is None or abs(pct) > abs(noticed["pct"])):
            if kind == "percent":
                move = f"{abs(cur - base):.1f} points {'lower' if cur < base else 'higher'}"
            else:
                move = f"{abs(pct):.1f}% {'lower' if pct < 0 else 'higher'}"
            noticed = {
                "block_id": b.id, "page_id": page.id, "label": m["label"], "pct": round(pct, 1), "op": op,
                "value": line, "line_display": ld,
                "text": f"{m['label']}: {month_label(cur_p)} was {move} than {base_text} "
                        f"({display(cur, kind, m['currency'])} vs {display(base, kind, m['currency'])}).",
            }
    return {"suggestions": out[:limit], "noticed": noticed}

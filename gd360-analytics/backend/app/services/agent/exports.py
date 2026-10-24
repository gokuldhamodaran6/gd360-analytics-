"""2026-10-14 (R47): a dashboard page as a working Excel workbook or a PowerPoint deck.

Excel: one sheet per block with its rows, typed numbers and a Total row of live SUM
formulas; a Summary sheet whose figures are formulas pointing at the block sheets, so
the workbook recomputes when someone edits a cell. PowerPoint: one slide per block with
a native, editable chart (or a table, or a KPI), built from the same rows.

The rows come from the dashboard engine exactly as the page shows them (filters,
period and access rules applied), never re-queried differently.
"""
from __future__ import annotations

import io
import re
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ... import models, schemas

NUMERIC = (int, float)


def _num(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, NUMERIC):
        return float(v)
    if isinstance(v, str):
        s = v.replace(",", "").strip()
        try:
            return float(s)
        except ValueError:
            return None
    return None


def page_blocks(db: Session, user: models.User, dash: models.Dashboard, page: models.DashboardPage) -> list[dict]:
    """[{id, title, type, columns: [str], rows: [dict], kpi: {label, value, display} | None, chart_type}]"""
    from ...routers import dashboard_builder as dbr
    ds = db.get(models.DataSource, dash.datasource_id) if dash.datasource_id else None
    is_file = bool(ds and ds.kind in ("csv", "excel", "file"))
    results: dict[str, dict] = {}
    file_blocks: dict[str, dict] = {}
    if not is_file:
        try:
            out = dbr.run_page(dash.id, page.id, schemas.RunPageRequest(), db=db, user=user)
            results = (out.blocks if hasattr(out, "blocks") else out.get("blocks")) or {}
        except HTTPException as e:
            if e.status_code != 400:
                raise
            is_file = True
    if is_file:
        try:
            out = dbr.preview_filtered_blocks(dash.id, page.id, schemas.ApplyFiltersRequest(), db=db, user=user)
            blocks = out.blocks if hasattr(out, "blocks") else out.get("blocks")
            for b in blocks or []:
                bd = b if isinstance(b, dict) else b.model_dump()
                file_blocks[bd["id"]] = bd.get("config") or {}
        except HTTPException:
            pass
    items = []
    for b in sorted(page.blocks, key=lambda x: (x.y, x.x)):
        if b.type in ("text", "heading", "divider", "filter", "input"):
            continue
        cfg = dict(b.config or {})
        columns: list[str] = []
        rows: list[dict] = []
        r = results.get(b.id)
        if isinstance(r, dict) and r.get("status") == "ok":
            columns = [c.get("name") if isinstance(c, dict) else str(c) for c in (r.get("columns") or [])]
            rows = list(r.get("rows") or [])
        else:
            fc = file_blocks.get(b.id, cfg)
            cols = fc.get("result_columns") or fc.get("columns") or cfg.get("result_columns") or cfg.get("columns") or []
            columns = [c.get("name") if isinstance(c, dict) else str(c) for c in cols]
            raw = fc.get("result_rows") or fc.get("rows") or cfg.get("result_rows") or cfg.get("rows") or []
            rows = [dict(zip(columns, rw)) if isinstance(rw, (list, tuple)) else dict(rw) for rw in raw]
        kpi = None
        if b.type in ("kpi", "gauge", "sparkline"):
            val = None
            if rows:
                first = rows[0]
                for c in columns:
                    v = _num(first.get(c))
                    if v is not None:
                        val = v
                        break
            k = cfg.get("kpi") if isinstance(cfg.get("kpi"), dict) else {}
            if val is None:
                val = _num(k.get("value"))
            kpi = {"label": cfg.get("label") or b.title or "Value", "value": val, "display": k.get("display") or (f"{val:,.2f}" if val is not None else "—")}
        items.append({"id": b.id, "title": b.title or b.type.title(), "type": b.type, "columns": columns, "rows": rows[:5000], "kpi": kpi,
                      "chart_type": cfg.get("chart_type") or ("bar" if b.type == "chart" else b.type), "spec": cfg.get("spec") or {}})
    return items


def _sheet_name(title: str, taken: set[str]) -> str:
    base = re.sub(r"[\[\]:*?/\\]", " ", title).strip()[:28] or "Block"
    name, n = base, 2
    while name in taken:
        name = f"{base[:25]} {n}"
        n += 1
    taken.add(name)
    return name


def workbook(dash: models.Dashboard, page: models.DashboardPage, blocks: list[dict]) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    wb = Workbook()
    summary = wb.active
    summary.title = "Summary"
    bold = Font(bold=True)
    head_fill = PatternFill("solid", fgColor="F2F3F2")
    summary["A1"] = dash.name or "Dashboard"
    summary["A1"].font = Font(bold=True, size=14)
    summary["A2"] = f"Page: {page.name}"
    summary["A3"] = f"Exported {datetime.utcnow().strftime('%Y-%m-%d %H:%M')} UTC · every figure below is a formula over the block sheets"
    summary.append([])
    summary.append(["Block", "Kind", "Rows", "Total (first numeric column)", "Sheet"])
    for c in range(1, 6):
        summary.cell(row=5, column=c).font = bold
        summary.cell(row=5, column=c).fill = head_fill
    taken = {"Summary"}
    for blk in blocks:
        ws = wb.create_sheet(_sheet_name(blk["title"], taken))
        cols = blk["columns"] or (["value"] if blk["kpi"] else [])
        ws.append(cols)
        for c in range(1, len(cols) + 1):
            ws.cell(row=1, column=c).font = bold
            ws.cell(row=1, column=c).fill = head_fill
        numeric_cols: set[int] = set()
        rows = blk["rows"]
        if not rows and blk["kpi"] and blk["kpi"]["value"] is not None:
            rows = [{"value": blk["kpi"]["value"]}]
        for rw in rows:
            out = []
            for i, c in enumerate(cols):
                v = rw.get(c)
                n = _num(v)
                if n is not None and not (isinstance(v, str) and not re.match(r"^-?[\d.,]+$", v.strip())):
                    out.append(n)
                    numeric_cols.add(i + 1)
                else:
                    out.append("" if v is None else str(v))
            ws.append(out)
        last = ws.max_row
        total_cell = None
        if last >= 2 and numeric_cols:
            ws.cell(row=last + 1, column=1, value="Total").font = bold
            for ci in sorted(numeric_cols):
                letter = get_column_letter(ci)
                cell = ws.cell(row=last + 1, column=ci, value=f"=SUM({letter}2:{letter}{last})")
                cell.font = bold
                cell.number_format = "#,##0.00"
                if total_cell is None:
                    total_cell = f"'{ws.title}'!{letter}{last + 1}"
            for ci in sorted(numeric_cols):
                for r in range(2, last + 1):
                    ws.cell(row=r, column=ci).number_format = "#,##0.00"
        for ci, c in enumerate(cols, start=1):
            width = max(len(str(c)), *(len(str(ws.cell(row=r, column=ci).value or "")) for r in range(2, min(last, 40) + 1))) if last >= 2 else len(str(c))
            ws.column_dimensions[get_column_letter(ci)].width = min(42, max(10, width + 2))
        ws.freeze_panes = "A2"
        summary.append([blk["title"], blk["type"], len(rows), f"={total_cell}" if total_cell else "", ws.title])
        srow = summary.max_row
        summary.cell(row=srow, column=4).number_format = "#,##0.00"
        summary.cell(row=srow, column=3).alignment = Alignment(horizontal="right")
    for ci, w in ((1, 44), (2, 12), (3, 8), (4, 28), (5, 30)):
        summary.column_dimensions[get_column_letter(ci)].width = w
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def deck(dash: models.Dashboard, page: models.DashboardPage, blocks: list[dict], theme: str = "light") -> bytes:
    from pptx import Presentation
    from pptx.chart.data import CategoryChartData
    from pptx.dml.color import RGBColor
    from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
    from pptx.util import Emu, Inches, Pt
    dark = theme == "dark"
    bg = RGBColor(0x0B, 0x0F, 0x0E) if dark else RGBColor(0xFF, 0xFF, 0xFF)
    ink = RGBColor(0xF3, 0xF5, 0xF4) if dark else RGBColor(0x0B, 0x0F, 0x0E)
    muted = RGBColor(0x8A, 0x94, 0x8F) if dark else RGBColor(0x6E, 0x79, 0x75)
    accent = RGBColor(0x4B, 0xE3, 0xA3) if dark else RGBColor(0x0A, 0x7C, 0x5A)
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    blank = prs.slide_layouts[6]

    def paint(slide):
        fill = slide.background.fill
        fill.solid()
        fill.fore_color.rgb = bg

    def text(slide, s, left, top, width, height, size, color=ink, bold=False):
        tb = slide.shapes.add_textbox(left, top, width, height)
        tf = tb.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        p.text = s
        p.font.size = Pt(size)
        p.font.bold = bold
        p.font.color.rgb = color
        p.font.name = "Calibri"
        return tb

    s = prs.slides.add_slide(blank)
    paint(s)
    text(s, dash.name or "Dashboard", Inches(0.8), Inches(2.4), Inches(11.5), Inches(1.4), 40, bold=True)
    text(s, f"{page.name} · exported {datetime.utcnow().strftime('%b %d, %Y %H:%M')} UTC · Euliv", Inches(0.8), Inches(3.9), Inches(11.5), Inches(0.6), 16, muted)

    for blk in blocks:
        s = prs.slides.add_slide(blank)
        paint(s)
        text(s, blk["title"], Inches(0.8), Inches(0.5), Inches(11.5), Inches(0.8), 24, bold=True)
        cols, rows = blk["columns"], blk["rows"]
        if blk["kpi"]:
            text(s, blk["kpi"]["display"], Inches(0.8), Inches(2.2), Inches(11.5), Inches(1.6), 60, accent, bold=True)
            text(s, blk["kpi"]["label"], Inches(0.8), Inches(3.9), Inches(11.5), Inches(0.6), 18, muted)
            continue
        num_cols = [c for c in cols if rows and any(_num(r.get(c)) is not None for r in rows[:50])]
        cat_cols = [c for c in cols if c not in num_cols]
        if blk["type"] in ("chart", "donut") and num_cols and cat_cols and 1 <= len(rows) <= 60:
            cat = cat_cols[0]
            data = CategoryChartData()
            data.categories = [str(r.get(cat)) for r in rows]
            for m in num_cols[:4]:
                data.add_series(m, [(_num(r.get(m)) or 0.0) for r in rows])
            ct = blk.get("chart_type") or "bar"
            kind = XL_CHART_TYPE.LINE_MARKERS if ct in ("line", "area") else XL_CHART_TYPE.BAR_CLUSTERED if ct in ("horizontal_bar", "bar_h") \
                else XL_CHART_TYPE.DOUGHNUT if (blk["type"] == "donut" or ct in ("donut", "pie")) else XL_CHART_TYPE.COLUMN_CLUSTERED
            gf = s.shapes.add_chart(kind, Inches(0.8), Inches(1.4), Inches(11.7), Inches(5.6), data)
            chart = gf.chart
            chart.has_legend = len(num_cols) > 1 or kind == XL_CHART_TYPE.DOUGHNUT
            if chart.has_legend:
                chart.legend.position = XL_LEGEND_POSITION.BOTTOM
                chart.legend.include_in_layout = False
                chart.legend.font.color.rgb = ink
            try:
                chart.font.color.rgb = ink
                chart.font.size = Pt(11)
                if kind != XL_CHART_TYPE.DOUGHNUT:
                    chart.plots[0].series[0].format.fill.solid()
                    chart.plots[0].series[0].format.fill.fore_color.rgb = accent
                    chart.value_axis.has_major_gridlines = True
                    chart.value_axis.major_gridlines.format.line.color.rgb = RGBColor(0x1C, 0x23, 0x20) if dark else RGBColor(0xEC, 0xEE, 0xED)
            except Exception:  # noqa: BLE001 - styling never blocks the export
                pass
            continue
        # a table of the first rows
        n_rows = min(len(rows), 18)
        n_cols = min(len(cols), 8)
        if n_rows and n_cols:
            shape = s.shapes.add_table(n_rows + 1, n_cols, Inches(0.8), Inches(1.4), Inches(11.7), Emu(int(Inches(0.36) * (n_rows + 1))))
            tbl = shape.table
            for ci in range(n_cols):
                cell = tbl.cell(0, ci)
                cell.text = str(cols[ci])
                cell.text_frame.paragraphs[0].font.size = Pt(11)
                cell.text_frame.paragraphs[0].font.bold = True
            for ri in range(n_rows):
                for ci in range(n_cols):
                    v = rows[ri].get(cols[ci])
                    n = _num(v)
                    cell = tbl.cell(ri + 1, ci)
                    cell.text = f"{n:,.2f}".rstrip("0").rstrip(".") if n is not None and not isinstance(v, str) else ("" if v is None else str(v))
                    cell.text_frame.paragraphs[0].font.size = Pt(10)
            if len(rows) > n_rows:
                text(s, f"{len(rows) - n_rows:,} more rows in the Excel export", Inches(0.8), Inches(6.9), Inches(11.5), Inches(0.4), 11, muted)
        else:
            text(s, "No rows for this block under the current filters.", Inches(0.8), Inches(1.6), Inches(11.5), Inches(0.6), 14, muted)
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()

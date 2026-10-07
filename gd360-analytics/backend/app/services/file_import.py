"""
The import pipeline for an uploaded CSV / Excel file (2026-10-06, "pro"
local-file Data tab). Everything here is plain pandas over the FULL file -
an upload is complete data, never a sample - and nothing here ever
touches the stored bytes (DataSource.file_data): the import settings a
person picks, the type fixes that were applied and the summary the Data
tab's steps strip shows all live inside DataSource.connection_info
("import_settings" / "import_summary" / "import_by_sheet"), and every
cleaning step becomes its own new DatasetVersion, so the original can
always be reloaded as uploaded.

Four public pieces, in the order the Data tab uses them:

  inspect_file(bytes, filename)        -> what the file is (sheets, size,
                                          detected header row / delimiter /
                                          encoding / date format)
  load_with_settings(bytes, filename,  -> a DataFrame read with the chosen
                     settings)            settings (sheet, header row,
                                          delimiter, decimal, thousands,
                                          trim, skip empty rows)
  infer_types(df)                      -> per column: inferred family, a
                                          proposed fix (to_date / to_number
                                          / to_bool) with the EXACT matched
                                          count, and the mixed-type cell
                                          count
  apply_type_fixes(df, fixes)          -> the frame with those fixes
                                          applied; an unparsable cell
                                          becomes null and is counted,
                                          never raised on
  suggest_cleaning(df)                 -> up to 8 cleaning suggestions,
                                          each with its exact affected_rows
  apply_cleaning(df, suggestions, ids) -> the cleaned frame + one cleaning
                                          log entry per applied step, in
                                          the same shape routers/chat.py's
                                          _save_cleaning_result writes so
                                          the Flow tab reads them as-is

Every "matched"/"affected_rows" number is a real count over the real
frame - nothing is estimated or sampled.
"""
from __future__ import annotations

import csv
import io
import math
import os
import re
from datetime import datetime

import numpy as np
import pandas as pd

# A proposed conversion needs at least this share of the column's non-null
# values to parse - below it, the column is genuinely mixed and converting
# would silently blank too much. Reported alongside the exact matched count
# so the person can see what would be lost.
TYPE_FIX_MIN_RATIO = 0.98
MAX_SUGGESTIONS = 8
# "Fill empty" is only suggested for a numeric column that is this complete
# or better - a column 40% empty is not "almost complete, blanks mean 0".
FILL_EMPTY_MAX_NULL_PCT = 10.0
# A categorical column is one with this many distinct values or fewer -
# the variant check (case / whitespace) only runs on those.
CATEGORICAL_MAX_DISTINCT = 200
# How many leading rows the header-row detector looks at.
HEADER_SCAN_ROWS = 20

DEFAULT_SETTINGS: dict = {
    "sheet": None,
    "header_row": 1,          # 1-based, as a person counts rows in a spreadsheet
    "delimiter": "auto",      # "auto" | "," | "\t" | ";" | "|"
    "decimal": ".",
    "thousands": "auto",      # "auto" | "," | "." | " " | "none"
    "date_format": "auto",    # "auto" | "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY"
    "trim_whitespace": True,
    "skip_empty_rows": True,
}

_DATE_FORMAT_STRPTIME = {
    "YYYY-MM-DD": "%Y-%m-%d",
    "DD/MM/YYYY": "%d/%m/%Y",
    "MM/DD/YYYY": "%m/%d/%Y",
    "YYYY/MM/DD": "%Y/%m/%d",
    "DD-MM-YYYY": "%d-%m-%Y",
    "MM-DD-YYYY": "%m-%d-%Y",
}

_BOOL_TRUE = {"true", "yes", "y", "t"}
_BOOL_FALSE = {"false", "no", "n", "f"}

# A cell has to LOOK like a date before pd.to_datetime is even asked - a
# bare "2015" or "737" parses as a year/epoch otherwise, which is exactly
# the false positive that would mislabel a numeric column as a date.
_DATE_SHAPE = re.compile(
    r"^\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|"
    r"\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{2,4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})"
    r"([ T]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2}|[AaPp][Mm])?)?\s*$"
)
_NUMBER_SHAPE = re.compile(r"^\s*[-+]?(\d[\d,. ]*|\.\d+)([eE][-+]?\d+)?\s*%?\s*$")


def _is_excel_name(filename: str | None) -> bool:
    return os.path.splitext(filename or "")[1].lower() in (".xlsx", ".xls", ".xlsm")


def file_kind(filename: str | None) -> str:
    return "excel" if _is_excel_name(filename) else "csv"


def normalize_settings(raw: dict | None) -> dict:
    """Fills defaults and clamps each setting to a value the loaders below
    understand - a stray value from an old client never reaches pandas."""
    s = {**DEFAULT_SETTINGS, **{k: v for k, v in (raw or {}).items() if k in DEFAULT_SETTINGS}}
    try:
        s["header_row"] = max(1, min(int(s.get("header_row") or 1), 1000))
    except (TypeError, ValueError):
        s["header_row"] = 1
    if s.get("delimiter") not in ("auto", ",", "\t", ";", "|"):
        s["delimiter"] = "auto"
    if s.get("decimal") not in (".", ","):
        s["decimal"] = "."
    if s.get("thousands") not in ("auto", ",", ".", " ", "none"):
        s["thousands"] = "auto"
    if s.get("date_format") not in ("auto", *_DATE_FORMAT_STRPTIME.keys()):
        s["date_format"] = "auto"
    s["trim_whitespace"] = bool(s.get("trim_whitespace", True))
    s["skip_empty_rows"] = bool(s.get("skip_empty_rows", True))
    sheet = s.get("sheet")
    s["sheet"] = str(sheet) if sheet not in (None, "") else None
    return s


# ---------------------------------------------------------------- inspect


def detect_encoding(data: bytes) -> str:
    head = data[:1 << 20]
    if head.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    try:
        head.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        pass
    try:
        head.decode("cp1252")
        return "cp1252"
    except UnicodeDecodeError:
        return "latin-1"


def detect_delimiter(text: str) -> str:
    sample = text[:65536]
    try:
        return csv.Sniffer().sniff(sample, delimiters=",\t;|").delimiter
    except Exception:
        pass
    first = sample.splitlines()[:5]
    counts = {d: sum(line.count(d) for line in first) for d in (",", "\t", ";", "|")}
    best = max(counts, key=counts.get)
    return best if counts[best] > 0 else ","


def _looks_numeric(v) -> bool:
    if isinstance(v, (int, float, np.integer, np.floating)) and not isinstance(v, bool):
        return not pd.isna(v)
    return isinstance(v, str) and bool(_NUMBER_SHAPE.match(v)) and any(ch.isdigit() for ch in v)


def detect_header_row(raw: pd.DataFrame) -> int:
    """1-based index of the row that looks like the header: scanning the
    first HEADER_SCAN_ROWS rows of a header-less read, the first row whose
    non-empty cell count is the widest seen AND whose cells are mostly
    non-numeric text. A title line above the real header ("Hotel bookings
    2017", one cell) is skipped because it is far narrower than the header
    row; a numeric data row is skipped because it is numeric."""
    if raw is None or len(raw) == 0:
        return 1
    head = raw.head(HEADER_SCAN_ROWS)
    widths = [int(row.notna().sum()) for _, row in head.iterrows()]
    widest = max(widths) if widths else 0
    if widest == 0:
        return 1
    for i, (_, row) in enumerate(head.iterrows()):
        cells = [v for v in row.tolist() if not (v is None or (isinstance(v, float) and np.isnan(v)))]
        # At least 60% as wide as the widest row - rounded UP: with int() a
        # 2-cell note line above a 4-column header (2 < int(2.4) is false)
        # was taken for the header.
        if len(cells) < max(1, math.ceil(widest * 0.6)):
            continue
        texty = sum(1 for v in cells if isinstance(v, str) and not _looks_numeric(v))
        if texty >= max(1, int(len(cells) * 0.6)):
            return i + 1
    return 1


def _detect_date_format_from_values(values: pd.Series) -> str | None:
    s = values.dropna().astype(str).str.strip()
    if s.empty:
        return None
    sample = s.head(2000)
    iso = sample.str.match(r"^\d{4}-\d{2}-\d{2}")
    if iso.mean() >= 0.9:
        return "YYYY-MM-DD"
    slash_ymd = sample.str.match(r"^\d{4}/\d{1,2}/\d{1,2}$")
    if slash_ymd.mean() >= 0.9:
        return "YYYY/MM/DD"
    dmy_or_mdy = sample.str.extract(r"^(\d{1,2})([/-])(\d{1,2})\2(\d{2,4})(?:[ T]\d{1,2}:\d{2}.*)?$")
    ok = dmy_or_mdy[0].notna()
    if ok.mean() >= 0.9:
        first = pd.to_numeric(dmy_or_mdy.loc[ok, 0])
        second = pd.to_numeric(dmy_or_mdy.loc[ok, 2])
        sep = dmy_or_mdy.loc[ok, 1].mode().iat[0] if ok.any() else "/"
        # Disambiguate by the values: a component over 12 can only be a day.
        if (first > 12).any() and not (second > 12).any():
            return "DD/MM/YYYY" if sep == "/" else "DD-MM-YYYY"
        if (second > 12).any() and not (first > 12).any():
            return "MM/DD/YYYY" if sep == "/" else "MM-DD-YYYY"
        return "DD/MM/YYYY" if sep == "/" else "DD-MM-YYYY"
    return None


def detect_date_format(df: pd.DataFrame) -> str | None:
    """The first text column that is overwhelmingly date-shaped decides the
    file's date format - None when no text column is date-like at all (a
    file whose dates are already real datetimes needs no format)."""
    for col in df.columns:
        s = df[col]
        if s.dtype != object:
            continue
        non_null = s.dropna().astype(str).str.strip()
        if non_null.empty:
            continue
        shaped = non_null.head(2000).map(lambda v: bool(_DATE_SHAPE.match(v)))
        if shaped.mean() >= 0.9:
            fmt = _detect_date_format_from_values(non_null)
            if fmt:
                return fmt
    return None


def _read_excel(data: bytes, sheet, header: int | None, nrows: int | None = None) -> pd.DataFrame:
    buf = io.BytesIO(data)
    try:
        return pd.read_excel(buf, sheet_name=sheet, header=header, nrows=nrows, engine="calamine")
    except Exception as e:  # pragma: no cover - engine fallback
        print(f"[file_import] calamine failed, falling back to openpyxl: {e}")
        buf.seek(0)
        return pd.read_excel(buf, sheet_name=sheet, header=header, nrows=nrows)


def excel_sheet_names(data: bytes) -> list[str]:
    buf = io.BytesIO(data)
    try:
        return list(pd.ExcelFile(buf, engine="calamine").sheet_names)
    except Exception:  # pragma: no cover
        buf.seek(0)
        return list(pd.ExcelFile(buf).sheet_names)


def _csv_head_rows(text: str, delimiter: str, n: int) -> pd.DataFrame:
    """The first `n` physical lines of a CSV as a header-less frame, every
    row padded to the widest one (an empty cell is None).

    2026-10-07 (real end-to-end run): this scan used to be a header-less
    pandas read, which takes the column count from the FIRST line and
    treats every wider line as a bad line. A real export with a one-cell
    title line above the header ("Hotel bookings export - Lisbon group")
    therefore lost its header row and every data row from the scan, the
    3-cell note line under the title was picked as the header, and the
    upload failed with "Error tokenizing data. C error: Expected 3 fields
    in line 4, saw 14". csv.reader keeps ragged lines as they are, so
    detect_header_row sees the same rows a person does - like the Excel
    path always did."""
    rows: list[list] = []
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    for i, row in enumerate(reader):
        if i >= n:
            break
        rows.append([c if c.strip() != "" else None for c in row])
    width = max((len(r) for r in rows), default=0)
    return pd.DataFrame([r + [None] * (width - len(r)) for r in rows], dtype=object)


def inspect_file(data: bytes, filename: str | None) -> dict:
    """What the Data tab's import card needs before any setting is chosen.
    `sheets[*].rows` is the data row count under the detected header row
    (exact), `cols` the header width."""
    kind = file_kind(filename)
    out: dict = {
        "kind": kind,
        "filename": filename,
        "size_bytes": len(data or b""),
        "sheets": [],
        "detected_header_row": 1,
        "detected_delimiter": None,
        "detected_encoding": None,
        "detected_date_format": None,
    }
    if kind == "excel":
        names = excel_sheet_names(data)
        first_header = None
        first_date_fmt = None
        for name in names[:50]:
            raw = _read_excel(data, name, header=None)
            header_row = detect_header_row(raw)
            body = raw.iloc[header_row:]
            body = body.dropna(how="all")
            header_cells = raw.iloc[header_row - 1] if len(raw) >= header_row else pd.Series(dtype=object)
            cols = int(header_cells.notna().sum()) if len(header_cells) else int(raw.shape[1])
            out["sheets"].append({"name": name, "rows": int(len(body)), "cols": cols, "detected_header_row": header_row})
            if first_header is None:
                first_header = header_row
                try:
                    typed = _read_excel(data, name, header=header_row - 1, nrows=5000)
                    first_date_fmt = detect_date_format(typed)
                except Exception:
                    first_date_fmt = None
        out["detected_header_row"] = first_header or 1
        out["detected_date_format"] = first_date_fmt
        return out

    encoding = detect_encoding(data)
    text = data.decode(encoding, errors="replace")
    delimiter = detect_delimiter(text)
    raw = _csv_head_rows(text, delimiter, HEADER_SCAN_ROWS)
    header_row = detect_header_row(raw)
    typed = pd.read_csv(io.StringIO(text), sep=delimiter, skiprows=header_row - 1, header=0, engine="c", low_memory=False)
    typed = typed.dropna(how="all")
    stem = os.path.splitext(os.path.basename(filename or "data.csv"))[0] or "data"
    out["sheets"] = [{"name": stem, "rows": int(len(typed)), "cols": int(typed.shape[1]), "detected_header_row": header_row}]
    out["detected_header_row"] = header_row
    out["detected_delimiter"] = delimiter
    out["detected_encoding"] = encoding
    out["detected_date_format"] = detect_date_format(typed)
    return out


# ---------------------------------------------------------------- load


def _strip_text_columns(df: pd.DataFrame) -> pd.DataFrame:
    for col in df.columns:
        if df[col].dtype == object:
            s = df[col]
            mask = s.map(lambda v: isinstance(v, str))
            if mask.any():
                df[col] = s.where(~mask, s[mask].str.strip())
    return df


def load_with_settings(data: bytes, filename: str | None, settings: dict | None) -> pd.DataFrame:
    """Reads the file with the chosen settings. Header row is 1-based (row
    1 = the first line of the sheet); rows above it are skipped."""
    s = normalize_settings(settings)
    header = s["header_row"] - 1
    if file_kind(filename) == "excel":
        sheet = s["sheet"] if s["sheet"] else 0
        df = _read_excel(data, sheet, header=header)
    else:
        encoding = detect_encoding(data)
        text = data.decode(encoding, errors="replace")
        sep = detect_delimiter(text) if s["delimiter"] == "auto" else s["delimiter"]
        thousands = None
        if s["thousands"] == "auto":
            thousands = "," if s["decimal"] == "." else "."
        elif s["thousands"] != "none":
            thousands = s["thousands"]
        if thousands == s["decimal"]:
            thousands = None
        # `skiprows` counts physical lines, exactly like the 1-based header
        # row the import card shows. `header=<n>` alone does not: pandas
        # skips blank lines before counting, so one empty line above the
        # header made it take the first DATA row as the header.
        df = pd.read_csv(
            io.StringIO(text), sep=sep, skiprows=header, header=0, decimal=s["decimal"], thousands=thousands,
            skip_blank_lines=s["skip_empty_rows"], low_memory=False,
        )
    if s["skip_empty_rows"]:
        df = df.dropna(how="all")
    if s["trim_whitespace"]:
        df = _strip_text_columns(df)
    df.columns = [str(c) for c in df.columns]
    return df.reset_index(drop=True)


# ---------------------------------------------------------------- infer


def _clean_number_text(s: pd.Series, thousands: str | None = ",") -> pd.Series:
    t = s.astype(str).str.strip()
    if thousands:
        t = t.str.replace(thousands, "", regex=False)
    t = t.str.replace(r"^[$€£]\s*", "", regex=True).str.replace(r"\s*%$", "", regex=True)
    return t


def _classify_text_values(values: pd.Series) -> dict:
    """Counts how many of a text column's non-null values look like a
    number / a date / a boolean / plain text - the raw material for both
    the fix proposal and the mixed-types count."""
    s = values.astype(str).str.strip()
    total = int(len(s))
    if total == 0:
        return {"total": 0, "number": 0, "date": 0, "bool": 0, "text": 0, "bool_only": False}
    lower = s.str.lower()
    is_bool = lower.isin(_BOOL_TRUE | _BOOL_FALSE)
    shaped_num = s.map(lambda v: bool(_NUMBER_SHAPE.match(v)) and any(ch.isdigit() for ch in v))
    parsed_num = pd.to_numeric(_clean_number_text(s), errors="coerce").notna() & shaped_num
    shaped_date = s.map(lambda v: bool(_DATE_SHAPE.match(v)))
    n_bool = int(is_bool.sum())
    n_num = int(parsed_num.sum())
    n_date = int(shaped_date.sum())
    bool_only = n_bool == total
    if bool_only:
        n_text = 0
    else:
        # "yes"/"no" among other words is just text - only an all-boolean
        # column is a boolean column.
        n_text = int(total - (parsed_num | shaped_date).sum())
        n_bool = 0
    return {"total": total, "number": n_num, "date": n_date, "bool": n_bool, "text": n_text, "bool_only": bool_only}


def _date_matched(values: pd.Series, date_format: str | None) -> int:
    s = values.astype(str).str.strip()
    shaped = s[s.map(lambda v: bool(_DATE_SHAPE.match(v)))]
    if shaped.empty:
        return 0
    return int(_to_datetime(shaped, date_format).notna().sum())


def _to_datetime(s: pd.Series, date_format: str | None) -> pd.Series:
    # 2026-10-07 (real end-to-end run): with the date format left on "auto"
    # (the default - `date_format` is None here) every value went straight
    # to pandas' flexible parser, which reads an ambiguous "04/01/2015"
    # month-first. A DD/MM/YYYY file - which the import card itself
    # reports as "detected: DD/MM/YYYY" - therefore had every date whose
    # day is 12 or less silently turned into the wrong date (4 January ->
    # 1 April), with "0 lost". On auto, the column's own values now pick
    # the format, by the same rule the import card's detection uses.
    chosen = date_format if date_format in _DATE_FORMAT_STRPTIME else _detect_date_format_from_values(s)
    fmt = _DATE_FORMAT_STRPTIME.get(chosen or "")
    if fmt:
        parsed = pd.to_datetime(s, format=fmt, errors="coerce")
        missing = parsed.isna() & s.notna()
        if missing.any():
            # A sheet can mix "2017-03-01" and "2017-03-01 14:00" - the
            # strict format catches the first, the flexible parser the rest
            # (day-first when the format is, so "04/01/2015 14:00" agrees
            # with "04/01/2015").
            parsed = parsed.where(~missing, pd.to_datetime(s[missing], errors="coerce", format="mixed", dayfirst=fmt.startswith("%d")))
        return parsed
    return pd.to_datetime(s, errors="coerce", format="mixed")


def infer_types(df: pd.DataFrame, date_format: str | None = None) -> list[dict]:
    """One entry per column: {column, inferred, current_dtype, fix, mixed_types}.
    `fix` is None when the column is already typed, or when fewer than
    TYPE_FIX_MIN_RATIO of its non-null values would convert cleanly;
    otherwise {kind, matched, total} with exact counts."""
    out: list[dict] = []
    for col in df.columns:
        s = df[col]
        dtype = str(s.dtype)
        entry = {"column": str(col), "inferred": "text", "current_dtype": dtype, "fix": None, "mixed_types": 0}
        if pd.api.types.is_bool_dtype(s):
            entry["inferred"] = "boolean"
        elif pd.api.types.is_numeric_dtype(s):
            entry["inferred"] = "number"
        elif pd.api.types.is_datetime64_any_dtype(s):
            entry["inferred"] = "date"
        else:
            non_null = s.dropna()
            non_null = non_null[non_null.map(lambda v: not (isinstance(v, str) and v.strip() == ""))]
            # A text column whose cells are real Python numbers/dates
            # (an Excel sheet with a few numeric cells among text) counts
            # those cells by their real type, not their string form.
            py_num = non_null.map(lambda v: isinstance(v, (int, float, np.integer, np.floating)) and not isinstance(v, bool)).astype(bool)
            py_date = non_null.map(lambda v: isinstance(v, (datetime, pd.Timestamp))).astype(bool)
            strings = non_null[~(py_num | py_date)]
            cls = _classify_text_values(strings)
            total = int(len(non_null))
            n_num = cls["number"] + int(py_num.sum())
            n_date_shaped = cls["date"] + int(py_date.sum())
            n_bool = cls["bool"]
            n_text = cls["text"]
            if total == 0:
                out.append(entry)
                continue
            if cls["bool_only"] and n_bool == total:
                entry["inferred"] = "boolean"
                entry["fix"] = {"kind": "to_bool", "matched": n_bool, "total": total}
            elif n_num / total >= TYPE_FIX_MIN_RATIO:
                entry["inferred"] = "number"
                entry["fix"] = {"kind": "to_number", "matched": n_num, "total": total}
            elif n_date_shaped / total >= TYPE_FIX_MIN_RATIO:
                matched = _date_matched(strings.astype(str), date_format) + int(py_date.sum())
                if matched / total >= TYPE_FIX_MIN_RATIO:
                    entry["inferred"] = "date"
                    entry["fix"] = {"kind": "to_date", "matched": matched, "total": total}
            counts = {"number": n_num, "date": n_date_shaped, "bool": n_bool, "text": n_text}
            dominant = max(counts.values())
            present = sum(1 for v in counts.values() if v > 0)
            entry["mixed_types"] = int(total - dominant) if present > 1 else 0
        out.append(entry)
    return out


def apply_type_fixes(df: pd.DataFrame, fixes: list[dict], date_format: str | None = None, report: list | None = None) -> pd.DataFrame:
    """Applies [{column, kind}] fixes in order. A cell that cannot convert
    becomes null (never raises); each applied fix is appended to `report`
    (when given) as {column, kind, matched, total, lost, from, to}."""
    df = df.copy()
    for fix in fixes or []:
        col = fix.get("column")
        kind = fix.get("kind")
        if col not in df.columns or kind not in ("to_date", "to_number", "to_bool"):
            continue
        s = df[col]
        before_non_null = int(s.notna().sum())
        from_dtype = str(s.dtype)
        if kind == "to_number":
            is_str = s.map(lambda v: isinstance(v, str)).astype(bool)
            t = s.astype(object).copy()
            if is_str.any():
                t[is_str] = _clean_number_text(s[is_str])
            converted = pd.to_numeric(t, errors="coerce")
            # Plain int64 when every value is whole and nothing is missing
            # (the dtype every other loader in this app produces); float64
            # otherwise, which is how pandas itself represents a numeric
            # column with gaps.
            non_null = converted.dropna()
            if len(non_null) == len(converted) and len(non_null) and (non_null == non_null.round()).all():
                converted = converted.astype("int64")
            else:
                converted = converted.astype("float64")
        elif kind == "to_date":
            is_ts = s.map(lambda v: isinstance(v, (datetime, pd.Timestamp))).astype(bool)
            is_str = s.map(lambda v: isinstance(v, str)).astype(bool)
            converted = pd.Series(pd.NaT, index=s.index, dtype="datetime64[ns]")
            if is_ts.any():
                converted[is_ts] = pd.to_datetime(s[is_ts], errors="coerce")
            if is_str.any():
                converted[is_str] = _to_datetime(s[is_str].str.strip(), date_format)
        else:
            lower = s.astype(str).str.strip().str.lower()
            values = np.where(lower.isin(_BOOL_TRUE), True, np.where(lower.isin(_BOOL_FALSE), False, None))
            converted = pd.Series(values, index=s.index, dtype=object).where(s.notna(), None)
            if converted.notna().all() and len(converted):
                converted = converted.astype(bool)
        after_non_null = int(converted.notna().sum())
        df[col] = converted
        if report is not None:
            report.append({
                "column": str(col), "kind": kind, "from": from_dtype, "to": str(converted.dtype),
                "matched": after_non_null, "total": before_non_null, "lost": max(0, before_non_null - after_non_null),
            })
    return df


def _family_label(kind: str) -> str:
    return {"to_date": "date", "to_number": "number", "to_bool": "boolean"}[kind]


def run_import(data: bytes, filename: str | None, settings: dict | None) -> tuple[pd.DataFrame, dict, dict]:
    """load_with_settings + infer_types + apply_type_fixes, returning
    (frame, normalized settings, import summary). The summary is what the
    Data tab's steps strip and Import-health tile show - every number in it
    is a count over the whole frame."""
    s = normalize_settings(settings)
    df = load_with_settings(data, filename, s)
    date_format = None if s["date_format"] == "auto" else s["date_format"]
    inferred = infer_types(df, date_format=date_format)
    fixes = [{"column": e["column"], "kind": e["fix"]["kind"]} for e in inferred if e["fix"]]
    report: list = []
    df = apply_type_fixes(df, fixes, date_format=date_format, report=report)
    type_fixes = [
        {
            "column": r["column"], "kind": r["kind"], "from": "text", "to": _family_label(r["kind"]),
            "matched": r["matched"], "total": r["total"], "lost": r["lost"],
        }
        for r in report
    ]
    mixed = {e["column"]: e["mixed_types"] for e in inferred if e["mixed_types"]}
    summary = {
        "sheet": s["sheet"],
        "header_row": s["header_row"],
        "delimiter": s["delimiter"],
        "date_format": s["date_format"],
        "rows": int(len(df)),
        "columns": int(df.shape[1]),
        "type_fixes": type_fixes,
        "fixed_count": len(type_fixes),
        "errors": int(sum(r["lost"] for r in report)),
        "mixed_type_columns": mixed,
        "imported_at": datetime.utcnow().isoformat(),
    }
    return df, s, summary


def reapply_recorded_fixes(df: pd.DataFrame, summary: dict | None, settings: dict | None) -> pd.DataFrame:
    """Re-applies exactly the fixes an earlier import recorded - what the
    loader uses after a restart so the cached frame equals the imported
    one, with no fresh inference that could drift."""
    fixes = [{"column": f["column"], "kind": f["kind"]} for f in (summary or {}).get("type_fixes", []) if f.get("column") and f.get("kind")]
    if not fixes:
        return df
    s = normalize_settings(settings)
    date_format = None if s["date_format"] == "auto" else s["date_format"]
    return apply_type_fixes(df, fixes, date_format=date_format)


# ---------------------------------------------------------------- profile


def profile_dataframe(df: pd.DataFrame, max_columns: int = 200, top_values_max_distinct: int = 50, top_values_limit: int = 3) -> dict:
    """The file-kind counterpart of profiling.build_profile_query +
    parse_profile_row: the same per-column shape (type, non_null,
    null_pct, distinct, min, max, top_values) computed with pandas over
    the whole frame. `type` is the column's family (text / number / date /
    boolean) so the Data tab's type grouping reads it directly; `dtype` is
    the raw pandas dtype; `mixed_types` the count of cells whose shape
    disagrees with the column's dominant one."""
    total = int(len(df))
    inferred = {e["column"]: e for e in infer_types(df)}
    columns: dict = {}
    profiled = [str(c) for c in list(df.columns)[:max_columns]]
    for col in profiled:
        s = df[col]
        non_null = int(s.notna().sum())
        info = inferred.get(col) or {}
        family = "text"
        if pd.api.types.is_bool_dtype(s):
            family = "boolean"
        elif pd.api.types.is_numeric_dtype(s):
            family = "number"
        elif pd.api.types.is_datetime64_any_dtype(s):
            family = "date"
        elif s.dtype == object and non_null:
            # Python True/False (with gaps) or datetime.date objects sit in
            # an "object" column - label them by what they hold.
            sample = s.dropna().head(200)
            if all(isinstance(v, bool) for v in sample):
                family = "boolean"
            elif all(isinstance(v, (datetime, pd.Timestamp)) or (hasattr(v, "isoformat") and not isinstance(v, str)) for v in sample):
                family = "date"
        try:
            distinct = int(s.nunique(dropna=True))
        except TypeError:
            distinct = int(s.astype(str).nunique(dropna=True))
        mn = mx = None
        if non_null and family in ("number", "date"):
            try:
                mn, mx = _json_scalar(s.min()), _json_scalar(s.max())
            except Exception:
                mn = mx = None
        elif non_null and family == "text":
            try:
                strs = s.dropna().astype(str)
                mn, mx = str(strs.min()), str(strs.max())
            except Exception:
                mn = mx = None
        stat = {
            "type": family, "dtype": str(s.dtype), "non_null": non_null,
            "null_pct": round(100.0 * (total - non_null) / total, 2) if total else 0.0,
            "distinct": distinct, "min": mn, "max": mx,
            "mixed_types": int(info.get("mixed_types") or 0),
        }
        if 0 < distinct <= top_values_max_distinct and non_null:
            try:
                vc = (s.dropna().astype(str) if family == "text" else s.dropna()).value_counts().head(top_values_limit)
                stat["top_values"] = [
                    {"value": _json_scalar(v), "count": int(c), "pct": round(100.0 * int(c) / total, 1) if total else None}
                    for v, c in vc.items()
                ]
            except Exception:
                pass
        columns[col] = stat
    return {
        "supported": True,
        "exact_total_rows": total,
        "columns": columns,
        "profiled_columns": profiled,
        "truncated_columns": len(df.columns) > len(profiled),
        "top_values_computed": True,
        "computed_in": "gd360",
    }


def _json_scalar(v):
    if v is None:
        return None
    if isinstance(v, (pd.Timestamp, datetime)):
        return None if pd.isna(v) else pd.Timestamp(v).isoformat()
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        return None if np.isnan(v) else float(v)
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    if isinstance(v, (int, str)):
        return v
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return str(v)


# ---------------------------------------------------------------- suggestions


def _fmt(n: int) -> str:
    return f"{int(n):,}"


def suggest_cleaning(df: pd.DataFrame, date_format: str | None = None, limit: int = MAX_SUGGESTIONS) -> list[dict]:
    """Up to `limit` suggestions, each {id, kind, column, title, reason,
    affected_rows, params}. Ids are deterministic (kind:column) so the
    apply endpoint can recompute them on the same frame and pick by id."""
    total = int(len(df))
    out: list[dict] = []

    # 1. Type conversions - the same inference the import ran, so a column
    #    the import already fixed never shows up again.
    for e in infer_types(df, date_format=date_format):
        fix = e.get("fix")
        if not fix:
            continue
        col = e["column"]
        lost = fix["total"] - fix["matched"]
        family = _family_label(fix["kind"])
        if lost == 0:
            reason = f"{_fmt(fix['matched'])} values parse as {family} — none would be lost."
        else:
            reason = f"{_fmt(fix['matched'])} of {_fmt(fix['total'])} values parse as {family}; {_fmt(lost)} would become empty."
        out.append({
            "id": f"{fix['kind']}:{col}", "kind": fix["kind"], "column": col,
            "title": f"Convert `{col}` from text to {family}", "reason": reason,
            "affected_rows": int(fix["matched"]), "params": {"date_format": date_format} if fix["kind"] == "to_date" else {},
        })

    # 2. Exact duplicate rows.
    try:
        dup_count = int(df.duplicated().sum())
    except TypeError:
        dup_count = int(df.astype(str).duplicated().sum())
    if dup_count > 0:
        out.append({
            "id": "drop_duplicates", "kind": "drop_duplicates", "column": None,
            "title": f"Remove {_fmt(dup_count)} exact duplicate {'row' if dup_count == 1 else 'rows'}",
            "reason": f"{_fmt(dup_count)} {'row is' if dup_count == 1 else 'rows are'} an exact copy of an earlier row, every column identical.",
            "affected_rows": dup_count, "params": {},
        })

    # 3. Fill empty in a near-complete numeric column.
    for col in df.columns:
        s = df[col]
        if not pd.api.types.is_numeric_dtype(s) or pd.api.types.is_bool_dtype(s):
            continue
        nulls = int(s.isna().sum())
        if nulls == 0 or total == 0:
            continue
        null_pct = 100.0 * nulls / total
        if null_pct > FILL_EMPTY_MAX_NULL_PCT:
            continue
        non_null = s.dropna()
        whole = bool(len(non_null)) and bool((non_null == non_null.round()).all())
        if whole:
            value: float | int = 0
            reason = f"{_fmt(nulls)} {'row is' if nulls == 1 else 'rows are'} blank; every other row is a whole number, so blank almost certainly means none."
            title = f"Fill empty `{col}` with 0 ({_fmt(nulls)} {'row' if nulls == 1 else 'rows'})"
        else:
            value = float(non_null.median())
            reason = f"{_fmt(nulls)} {'row is' if nulls == 1 else 'rows are'} blank; the median of the other rows is {value:g}."
            title = f"Fill empty `{col}` with the median {value:g} ({_fmt(nulls)} {'row' if nulls == 1 else 'rows'})"
        out.append({
            "id": f"fill_empty:{col}", "kind": "fill_empty", "column": str(col), "title": title, "reason": reason,
            "affected_rows": nulls, "params": {"value": value},
        })

    # 4. Trim whitespace - one suggestion covering every affected column.
    trim_cols: dict[str, int] = {}
    any_row_mask = pd.Series(False, index=df.index)
    for col in df.columns:
        s = df[col]
        if s.dtype != object:
            continue
        is_str = s.map(lambda v: isinstance(v, str))
        if not is_str.any():
            continue
        strs = s[is_str]
        changed = strs != strs.str.strip()
        n = int(changed.sum())
        if n:
            trim_cols[str(col)] = n
            any_row_mask.loc[changed[changed].index] = True
    if trim_cols:
        rows = int(any_row_mask.sum())
        cols_txt = ", ".join(f"`{c}`" for c in list(trim_cols)[:4]) + (f" and {len(trim_cols) - 4} more" if len(trim_cols) > 4 else "")
        out.append({
            "id": "trim_whitespace", "kind": "trim_whitespace", "column": None,
            "title": f"Trim whitespace in {len(trim_cols)} text {'column' if len(trim_cols) == 1 else 'columns'} ({_fmt(rows)} {'row' if rows == 1 else 'rows'})",
            "reason": f"Leading or trailing spaces in {cols_txt} make equal values count as different ones.",
            "affected_rows": rows, "params": {"columns": trim_cols},
        })

    # 5. Case / whitespace variants of the same categorical value.
    for col in df.columns:
        s = df[col]
        if s.dtype != object:
            continue
        strs = s[s.map(lambda v: isinstance(v, str))]
        if strs.empty:
            continue
        try:
            if strs.nunique() > CATEGORICAL_MAX_DISTINCT:
                continue
        except TypeError:
            continue
        key = strs.str.strip().str.lower()
        counts = strs.value_counts()
        mapping: dict[str, str] = {}
        affected = 0
        examples: list[str] = []
        for k, group in strs.groupby(key):
            variants = group.value_counts()
            if len(variants) <= 1:
                continue
            canonical = variants.index[0]
            for variant in variants.index[1:]:
                mapping[variant] = canonical
                affected += int(counts.get(variant, 0))
            if len(examples) < 3:
                examples.append(", ".join(f"`{v}`" for v in variants.index[:3]))
        if mapping:
            groups = len(set(mapping.values()))
            out.append({
                "id": f"standardise:{col}", "kind": "standardise", "column": str(col),
                "title": f"Standardise `{col}` ({len(mapping) + groups} spellings of {groups} {'value' if groups == 1 else 'values'})",
                "reason": (
                    f"{examples[0]} currently count as different values. Only case and whitespace variants are merged here — "
                    f"a spelling variant such as PRT / Portugal is not detected in this version."
                ),
                "affected_rows": affected, "params": {"mapping": mapping},
            })

    return out[:limit]


def apply_cleaning(df: pd.DataFrame, suggestions: list[dict], ids: list[str], date_format: str | None = None) -> tuple[pd.DataFrame, list[dict]]:
    """Applies the chosen suggestions in the order given, returning the
    cleaned frame and one cleaning-log entry per step - the same keys
    routers/chat.py's _save_cleaning_result writes (prompt, summary,
    rows_before, rows_after, nulls_before, nulls_after, created_at) plus
    kind / column / suggestion_id for the Flow tab's step cards."""
    by_id = {s["id"]: s for s in suggestions}
    log: list[dict] = []
    for sid in ids:
        sug = by_id.get(sid)
        if not sug:
            continue
        rows_before = int(len(df))
        nulls_before = int(df.isna().sum().sum())
        kind = sug["kind"]
        col = sug.get("column")
        params = sug.get("params") or {}
        if kind in ("to_date", "to_number", "to_bool"):
            report: list = []
            df = apply_type_fixes(df, [{"column": col, "kind": kind}], date_format=params.get("date_format") or date_format, report=report)
            r = report[0] if report else {}
            summary = f"Converted `{col}` to {_family_label(kind)}: {_fmt(r.get('matched', 0))} values converted, {_fmt(r.get('lost', 0))} became empty."
        elif kind == "drop_duplicates":
            df = df.drop_duplicates().reset_index(drop=True)
            summary = f"Removed {_fmt(rows_before - len(df))} exact duplicate rows."
        elif kind == "fill_empty":
            value = params.get("value", 0)
            n = int(df[col].isna().sum()) if col in df.columns else 0
            if col in df.columns:
                df[col] = df[col].fillna(value)
            summary = f"Filled {_fmt(n)} empty `{col}` cells with {value:g}." if isinstance(value, (int, float)) else f"Filled {_fmt(n)} empty `{col}` cells."
        elif kind == "trim_whitespace":
            cols = list((params.get("columns") or {}).keys()) or [c for c in df.columns if df[c].dtype == object]
            df = df.copy()
            for c in cols:
                if c in df.columns and df[c].dtype == object:
                    is_str = df[c].map(lambda v: isinstance(v, str))
                    df[c] = df[c].where(~is_str, df[c][is_str].str.strip())
            summary = f"Trimmed leading/trailing whitespace in {len(cols)} text columns ({_fmt(sug.get('affected_rows', 0))} rows)."
        elif kind == "standardise":
            mapping = params.get("mapping") or {}
            if col in df.columns and mapping:
                df = df.copy()
                df[col] = df[col].map(lambda v: mapping.get(v, v) if isinstance(v, str) else v)
            summary = f"Standardised {_fmt(len(mapping))} case/whitespace spellings in `{col}`."
        else:
            continue
        log.append({
            "prompt": sug["title"],
            "summary": summary,
            "rows_before": rows_before,
            "rows_after": int(len(df)),
            "nulls_before": nulls_before,
            "nulls_after": int(df.isna().sum().sum()),
            "created_at": datetime.utcnow().isoformat(),
            "kind": kind,
            "column": col,
            "suggestion_id": sid,
            "affected_rows": int(sug.get("affected_rows") or 0),
            "source": "cleaning_suggestion",
        })
    return df, log


def version_label_for(applied: list[dict]) -> str:
    """A short tab name for the version a set of applied suggestions
    creates - "Dates fixed", "Duplicates removed", or "3 cleaning steps"."""
    if not applied:
        return "Cleaned"
    if len(applied) == 1:
        k = applied[0].get("kind")
        col = applied[0].get("column")
        return {
            "to_date": "Dates fixed", "to_number": "Numbers fixed", "to_bool": "Flags fixed",
            "drop_duplicates": "Duplicates removed", "trim_whitespace": "Whitespace trimmed",
        }.get(k) or (f"{col} standardised" if k == "standardise" and col else f"{col} filled" if col else "Cleaned")
    return f"{len(applied)} cleaning steps"

"""Dashboard appearance (2026-10-07, identity-colour round).

One module owns everything about how a dashboard LOOKS that is stored on
the server: the appearance document on `dashboards.appearance`, the
workspace brand kit on `workspaces.brand_kit`, their validation, and the
colour registry that makes "City Hotel is the same blue everywhere" true.

THE APPEARANCE DOCUMENT (stored flat on dashboards.appearance; every key
optional; NULL = "never touched"):

    v              1
    customized     true once the owner changed a style field. false/absent
                   = the dashboard follows its workspace's brand kit.
    --- style (only stored when customized; the kit holds the same keys) ---
    palette        {"kind": "preset", "id": <PALETTE_IDS>}
                   | {"kind": "brand", "color": "#rrggbb"}
                   | {"kind": "custom", "colors": ["#rrggbb", ... <=10], "adjust": bool}
    color_mode     "by_value" (default) | "single"
    single_color   "#rrggbb" | null   (single mode; null = the palette's primary)
    theme_default  "auto" | "light" | "dark"       (the published link)
    density        "comfortable" | "compact"
    radius         "sharp" | "soft" | "round"
    font           <FONT_IDS>
    currency       ISO 4217 code ("USD")
    locale         BCP-47 tag or "auto" (the viewer's browser)
    footer_note    <= 160 characters of plain text
    --- colour identity (per dashboard, never inherited) ---
    value_colors   {column: {value: "#rrggbb" | slot 0-9}}   the owner's pins
    assignments    {column: {value: slot 0-9}}              the registry
    overflow       [column, ...]  columns that have more values than slots
    registry_full  true when MAX_COLUMNS columns are registered

The API never returns the stored document; it returns effective_appearance():
the style resolved through the workspace kit and the defaults, plus the
pins and the registry, plus `source` ("dashboard" | "workspace" |
"default") and `brand` (the chrome colours in force).

THE COLOUR REGISTRY RULE (the client's half is src/dashboard/theme/chartTheme.ts):

  1. A value's colour is a function of (column, value) only. The registry
     maps it to a palette SLOT (0-9); the client turns the slot into the
     palette's light or dark hue. Nothing about a chart, a filter, a page,
     a viewer or the order things loaded takes part.
  2. Slots are handed out here, on the server, the first time a page run
     (or a file dashboard's stored result) shows a value: the lowest free
     slot of that column, values taken in order of the chart's first
     measure (largest first, ties by name). Once written an assignment
     never changes except through "Reset colours".
  3. A column has 10 slots. Values met after they are taken are not
     stored; the column is listed in `overflow` and those values are drawn
     in the neutral "Other" grey, named by their label. An owner's pin
     (value_colors) always wins and is how a late value gets a colour.
  4. Blank / null is never registered: it has its own fixed neutral.
     Numbers, dates and calendar words (months, weekdays) are positions,
     not identities - their columns are never registered either, and a
     chart over them stays one colour.
  5. Several measures on one axis are registered the same way, by measure
     name, under the reserved column MEASURES_KEY.
  6. The write is one guarded read-modify-write per run (assign_colors):
     nothing is written when nothing is new; concurrent runs serialise on
     a row lock (Postgres) plus a process lock (SQLite), so two runs can
     never give one value two slots or one slot to two values.
  7. Who may trigger a write: any signed-in person who can see the
     dashboard, on any run. An ANONYMOUS request (the public link) only on
     a canonical run - no filter, no parameter, no date range, the default
     period - because then every input of the assignment is the
     dashboard's own definition and data, never something the request
     supplied. A filtered anonymous run reads the registry and writes
     nothing.
  8. Bounded: MAX_COLUMNS columns x 10 values, keys at most MAX_KEY_LEN
     characters. At the column cap `registry_full` is set and further
     columns stay single-colour.
"""
from __future__ import annotations

import re
import threading
from collections import OrderedDict
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Iterable

PALETTE_IDS = ("gd360", "ocean", "sunset", "forest", "berry", "slate", "vivid", "cbsafe")
FONT_IDS = ("geist", "inter", "ibm-plex-sans", "source-sans-3")
COLOR_MODES = ("by_value", "single")
THEME_DEFAULTS = ("auto", "light", "dark")
DENSITIES = ("comfortable", "compact")
RADII = ("sharp", "soft", "round")

MAX_SLOTS = 10
MAX_COLUMNS = 40
MAX_KEY_LEN = 120
MAX_COLUMN_LEN = 128
MAX_PIN_COLUMNS = 40
MAX_PINS_PER_COLUMN = 50
FOOTER_MAX = 160
MEASURES_KEY = "__measures__"

DEFAULT_STYLE: dict = {
    "palette": {"kind": "preset", "id": "gd360"},
    "color_mode": "by_value",
    "single_color": None,
    "theme_default": "auto",
    "density": "comfortable",
    "radius": "soft",
    "font": "geist",
    "currency": "USD",
    "locale": "auto",
    "footer_note": "",
}
STYLE_KEYS = tuple(DEFAULT_STYLE.keys())
KIT_EXTRA_KEYS = ("brand_primary_color", "brand_accent_color")

# ISO 4217 active codes.
CURRENCIES = frozenset("""
AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC
CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD
JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD
NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SYP SZL
THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL
""".split())

_HEX_RE = re.compile(r"^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
_LOCALE_RE = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f​-‏ -‮⁦-⁩]")


class AppearanceError(ValueError):
    """A plain sentence the API returns as the 422 detail."""


def hex_color(raw: Any) -> str | None:
    """'#rrggbb' (lower case) from '#rgb' / '#rrggbb' / the same without '#'; None otherwise."""
    if not isinstance(raw, str):
        return None
    m = _HEX_RE.match(raw.strip())
    if not m:
        return None
    h = m.group(1)
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return "#" + h.lower()


def clean_text(raw: Any, limit: int) -> str:
    """Plain, single-line text: control and bidi-override characters and
    angle brackets removed, whitespace collapsed, cut at `limit`."""
    if raw is None:
        return ""
    s = _CONTROL_RE.sub(" ", str(raw)).replace("<", "").replace(">", "")
    return re.sub(r"\s+", " ", s).strip()[:limit].strip()


# --------------------------------------------------------------------------
# validation
# --------------------------------------------------------------------------

def _palette(raw: Any) -> dict:
    if not isinstance(raw, dict):
        raise AppearanceError("The palette must be an object with a kind.")
    kind = raw.get("kind")
    if kind == "preset":
        pid = str(raw.get("id") or "").strip().lower()
        if pid not in PALETTE_IDS:
            raise AppearanceError(f"Unknown palette \"{clean_text(raw.get('id'), 40)}\". Choose one of: {', '.join(PALETTE_IDS)}.")
        return {"kind": "preset", "id": pid}
    if kind == "brand":
        color = hex_color(raw.get("color"))
        if not color:
            raise AppearanceError("The brand colour must be a hex colour like #0f5c46.")
        return {"kind": "brand", "color": color}
    if kind == "custom":
        colors = raw.get("colors")
        if not isinstance(colors, list) or not colors:
            raise AppearanceError("A custom palette needs between 1 and 10 colours.")
        if len(colors) > MAX_SLOTS:
            raise AppearanceError("A custom palette can hold at most 10 colours.")
        out = []
        for i, c in enumerate(colors):
            h = hex_color(c)
            if not h:
                raise AppearanceError(f"Colour {i + 1} of the custom palette is not a hex colour (expected #rrggbb).")
            out.append(h)
        return {"kind": "custom", "colors": out, "adjust": raw.get("adjust") is not False}
    raise AppearanceError('The palette kind must be "preset", "brand" or "custom".')


def _choice(raw: Any, allowed: tuple, label: str) -> str:
    v = str(raw or "").strip().lower()
    if v not in allowed:
        raise AppearanceError(f"{label} must be one of: {', '.join(allowed)}.")
    return v


def _style_field(key: str, raw: Any) -> Any:
    if key == "palette":
        return _palette(raw)
    if key == "color_mode":
        return _choice(raw, COLOR_MODES, "The colour mode")
    if key == "single_color":
        if raw is None or raw == "":
            return None
        color = hex_color(raw)
        if not color:
            raise AppearanceError("The single colour must be a hex colour like #0f5c46.")
        return color
    if key == "theme_default":
        return _choice(raw, THEME_DEFAULTS, "The default theme")
    if key == "density":
        return _choice(raw, DENSITIES, "The density")
    if key == "radius":
        return _choice(raw, RADII, "The corner radius")
    if key == "font":
        return _choice(raw, FONT_IDS, "The font")
    if key == "currency":
        code = str(raw or "").strip().upper()
        if code not in CURRENCIES:
            raise AppearanceError(f"\"{clean_text(raw, 12)}\" is not an ISO 4217 currency code (for example USD, EUR, INR).")
        return code
    if key == "locale":
        tag = str(raw or "").strip()
        if tag.lower() in ("", "auto"):
            return "auto"
        if len(tag) > 35 or not _LOCALE_RE.match(tag):
            raise AppearanceError(f"\"{clean_text(raw, 40)}\" is not a locale tag (for example en-US, en-IN, de-DE).")
        parts = tag.split("-")
        norm = [parts[0].lower()]
        for p in parts[1:]:
            norm.append(p.upper() if len(p) == 2 else p.title() if len(p) == 4 else p)
        return "-".join(norm)
    if key == "footer_note":
        return clean_text(raw, FOOTER_MAX)
    raise AppearanceError(f"Unknown appearance field \"{key}\".")


def normalize_style(raw: dict | None, *, strict: bool = True) -> dict:
    """The style fields present in `raw`, validated. strict=False (reading
    a stored document) drops a bad field instead of raising."""
    out: dict = {}
    if not isinstance(raw, dict):
        return out
    for key in STYLE_KEYS:
        if key not in raw:
            continue
        try:
            out[key] = _style_field(key, raw[key])
        except AppearanceError:
            if strict:
                raise
    return out


def full_style(*layers: dict | None) -> dict:
    """DEFAULT_STYLE overlaid by each layer in turn (later wins)."""
    out = {k: (dict(v) if isinstance(v, dict) else v) for k, v in DEFAULT_STYLE.items()}
    for layer in layers:
        out.update(normalize_style(layer, strict=False))
    return out


def normalize_value_colors(raw: Any, *, strict: bool = True) -> dict:
    """{column: {value: '#rrggbb' | slot}} within the caps."""
    out: dict = {}
    if raw is None:
        return out
    if not isinstance(raw, dict):
        if strict:
            raise AppearanceError("value_colors must be an object of columns.")
        return out
    if len(raw) > MAX_PIN_COLUMNS and strict:
        raise AppearanceError(f"Colours can be pinned on at most {MAX_PIN_COLUMNS} columns.")
    for column, values in list(raw.items())[:MAX_PIN_COLUMNS]:
        if not isinstance(column, str) or not column or len(column) > MAX_COLUMN_LEN or not isinstance(values, dict):
            if strict:
                raise AppearanceError("Each pinned column must be a column name with an object of values.")
            continue
        if len(values) > MAX_PINS_PER_COLUMN and strict:
            raise AppearanceError(f"At most {MAX_PINS_PER_COLUMN} values can be pinned per column.")
        col: dict = {}
        for value, pin in list(values.items())[:MAX_PINS_PER_COLUMN]:
            if not isinstance(value, str) or not value or len(value) > MAX_KEY_LEN:
                if strict:
                    raise AppearanceError("A pinned value must be text of at most 120 characters.")
                continue
            if isinstance(pin, bool):
                pin = None
            if isinstance(pin, int) and 0 <= pin < MAX_SLOTS:
                col[value] = pin
            elif hex_color(pin):
                col[value] = hex_color(pin)
            elif strict:
                raise AppearanceError(f"The colour pinned to \"{clean_text(value, 40)}\" must be a hex colour or a palette slot from 0 to 9.")
        if col:
            out[column] = col
    return out


def _clean_assignments(raw: Any) -> dict:
    out: dict = {}
    if not isinstance(raw, dict):
        return out
    for column, values in raw.items():
        if not isinstance(column, str) or not column or len(column) > MAX_COLUMN_LEN or not isinstance(values, dict) or len(out) >= MAX_COLUMNS:
            continue
        col = {}
        used = set()
        for value, slot in values.items():
            if (isinstance(value, str) and value and len(value) <= MAX_KEY_LEN and isinstance(slot, int) and not isinstance(slot, bool)
                    and 0 <= slot < MAX_SLOTS and slot not in used):
                col[value] = slot
                used.add(slot)
        if col:
            out[column] = col
    return out


def normalize_kit(raw: dict | None, *, strict: bool = True) -> dict | None:
    """A workspace brand kit: the style fields plus the chrome brand colours."""
    if not isinstance(raw, dict):
        return None
    out = normalize_style(raw, strict=strict)
    for key in KIT_EXTRA_KEYS:
        if key in raw:
            if raw[key] in (None, ""):
                out[key] = None
            else:
                color = hex_color(raw[key])
                if color:
                    out[key] = color
                elif strict:
                    raise AppearanceError("Brand colours must be hex colours like #0f5c46.")
    return out


# --------------------------------------------------------------------------
# the effective appearance
# --------------------------------------------------------------------------

def stored_document(raw: Any) -> dict:
    """A stored appearance document, cleaned (never raises)."""
    doc = raw if isinstance(raw, dict) else {}
    out: dict = {"v": 1, "customized": bool(doc.get("customized"))}
    if out["customized"]:
        out.update(normalize_style(doc, strict=False))
    out["value_colors"] = normalize_value_colors(doc.get("value_colors"), strict=False)
    out["assignments"] = _clean_assignments(doc.get("assignments"))
    out["overflow"] = [c for c in (doc.get("overflow") or []) if isinstance(c, str)][:MAX_COLUMNS] if isinstance(doc.get("overflow"), list) else []
    out["registry_full"] = bool(doc.get("registry_full"))
    return out


def effective_appearance(stored: Any, kit: Any = None, *, brand_primary: str | None = None, brand_accent: str | None = None) -> dict:
    """What a dashboard looks like, resolved. `stored` is dashboards.appearance,
    `kit` the workspace brand kit (or None), `brand_*` the dashboard's own
    chrome colours (the pre-existing columns).

    Source of the style:
      "dashboard"  the owner customised it
      "workspace"  it follows the workspace brand kit
      "default"    neither exists: the GD360 palette, coloured by value
    A dashboard that was never customised but carries its own brand colour
    (set before this round) keeps the look it had: single colour, in that
    brand colour."""
    doc = stored_document(stored)
    kit_clean = normalize_kit(kit, strict=False) if isinstance(kit, dict) and kit else None
    if doc["customized"]:
        style, source = full_style(doc), "dashboard"
    elif kit_clean:
        style, source = full_style(kit_clean), "workspace"
    else:
        style, source = full_style(), "default"
    own_primary, own_accent = hex_color(brand_primary), hex_color(brand_accent)
    legacy_brand = not doc["customized"] and bool(own_primary)
    if legacy_brand:
        style["color_mode"] = "single"
        style["single_color"] = own_primary
    inherit = source == "workspace"
    brand = {
        "primary": own_primary or (kit_clean.get("brand_primary_color") if inherit and kit_clean else None),
        "accent": own_accent or (kit_clean.get("brand_accent_color") if inherit and kit_clean else None),
    }
    return {
        **style,
        "value_colors": doc["value_colors"],
        "assignments": doc["assignments"],
        "overflow": doc["overflow"],
        "registry_full": doc["registry_full"],
        "customized": doc["customized"],
        "source": source,
        "legacy_brand": legacy_brand,
        "brand": brand,
    }


def clean_block_color(config: Any) -> Any:
    """A block config with its per-block colour override validated:
    config["color_mode"] is "by_value" or "single" (anything else, e.g.
    "follow", is removed = follow the dashboard), config["single_color"] a
    normalised hex (else removed). Other keys are untouched."""
    if not isinstance(config, dict) or ("color_mode" not in config and "single_color" not in config):
        return config
    out = dict(config)
    if out.get("color_mode") not in COLOR_MODES:
        out.pop("color_mode", None)
    color = hex_color(out.get("single_color"))
    if color and out.get("color_mode") == "single":
        out["single_color"] = color
    else:
        out.pop("single_color", None)
    return out


def materialize(stored: Any, effective_style: dict) -> dict | None:
    """The stored document with the style in force written into it
    (customized = true), or None when it already is. Used when something
    outside the style changes what an uncustomised dashboard would resolve
    to - setting a brand colour must not silently switch its charts to the
    single-colour look that rule reserves for pre-existing dashboards."""
    doc = stored_document(stored)
    if doc["customized"]:
        return None
    doc.update(full_style(effective_style))
    doc["customized"] = True
    return doc


def apply_patch(stored: Any, patch: dict, effective_style: dict) -> dict:
    """The stored document after a PATCH. `patch` holds only the keys the
    client sent (already through exclude_unset). `effective_style` is the
    style in force before the change: the first customisation starts from
    it, so a dashboard that followed the workspace kit keeps every setting
    it showed and changes only what was asked.

    reset="workspace": drop the dashboard's own style (pins and the
    registry stay). reset="colors": drop the pins and the registry (the
    palette stays; the next run assigns again in rank order)."""
    doc = stored_document(stored)
    reset = patch.get("reset")
    if reset not in (None, "", "workspace", "colors"):
        raise AppearanceError('reset must be "workspace" or "colors".')
    if reset == "workspace":
        for key in STYLE_KEYS:
            doc.pop(key, None)
        doc["customized"] = False
    if reset == "colors":
        doc["value_colors"], doc["assignments"], doc["overflow"], doc["registry_full"] = {}, {}, [], False
    style_patch = normalize_style({k: patch[k] for k in STYLE_KEYS if k in patch}, strict=True)
    if style_patch:
        if not doc["customized"]:
            doc.update(full_style(effective_style))
            doc["customized"] = True
        doc.update(style_patch)
    if "value_colors" in patch:
        doc["value_colors"] = normalize_value_colors(patch["value_colors"], strict=True)
    return doc


# --------------------------------------------------------------------------
# the colour registry
# --------------------------------------------------------------------------

_MONTHS = {
    "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
}
_WEEKDAYS = {
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
}
_NUMERIC_RE = re.compile(r"^-?\d+([.,]\d+)?%?$")
_DATE_RE = re.compile(r"^\d{4}-\d{1,2}(-\d{1,2})?([t ].*)?$|^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$|^\d{4}$|^(q[1-4]|h[12])([ -]?\d{2,4})?$|^\d{4}[ -]?(q[1-4]|w\d{1,2})$")


def value_key(v: Any) -> str | None:
    """The registry key of a dimension value, or None when the value is
    not an identity: blank, a number, a date, or too long to store."""
    if v is None:
        return None
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float, Decimal, date, datetime)):
        return None
    s = str(v)
    if not s.strip() or len(s) > MAX_KEY_LEN:
        return None
    return s


def is_position_word(key: str) -> bool:
    """A value that names a position on a scale, not an entity: a number, a
    date or period, a month or a weekday."""
    s = key.strip().lower()
    return bool(_NUMERIC_RE.match(s) or _DATE_RE.match(s) or s in _MONTHS or s in _WEEKDAYS)


def is_identity_column(keys: Iterable[str]) -> bool:
    """False when every value of the column is a position word."""
    for k in keys:
        if not is_position_word(k):
            return True
    return False


def _num(v: Any) -> float:
    if isinstance(v, bool):
        return 0.0
    if isinstance(v, (int, float, Decimal)):
        f = float(v)
        return abs(f) if f == f and f not in (float("inf"), float("-inf")) else 0.0
    return 0.0


def rank_values(rows: list, column: str, measure: str | None) -> list[str]:
    """The identity values of `column` in `rows`, largest total of
    `measure` first (ties, and no measure, by name). [] when the column is
    not an identity column."""
    totals: "OrderedDict[str, float]" = OrderedDict()
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        key = value_key(row.get(column))
        if key is None:
            continue
        totals[key] = totals.get(key, 0.0) + (_num(row.get(measure)) if measure else 0.0)
    if not totals or not is_identity_column(totals.keys()):
        return []
    return [k for k, _ in sorted(totals.items(), key=lambda kv: (-kv[1], kv[0]))]


class Observations:
    """What one run saw: per column the values in rank order (first
    sighting wins), in the order the columns were met."""

    def __init__(self) -> None:
        self.columns: "OrderedDict[str, list[str]]" = OrderedDict()

    def add(self, column: str, keys: Iterable[str]) -> None:
        keys = [k for k in keys if isinstance(k, str) and k and len(k) <= MAX_KEY_LEN]
        if not isinstance(column, str) or not column or len(column) > MAX_COLUMN_LEN or not keys:
            return
        seen = self.columns.setdefault(column, [])
        have = set(seen)
        for k in keys:
            if k not in have:
                seen.append(k)
                have.add(k)

    def __bool__(self) -> bool:
        return any(self.columns.values())


COLOURED_BLOCK_TYPES = ("chart", "donut")


def observe_result(obs: Observations, block_type: str, result: dict) -> None:
    """A warehouse BlockResult (services/dashboard_engine) -> observations.
    Only blocks that draw identity colour take part: charts and donuts."""
    if block_type not in COLOURED_BLOCK_TYPES or not isinstance(result, dict) or result.get("status") != "ok":
        return
    rows = result.get("rows") or []
    measures = [m for m in (result.get("measures") or []) if isinstance(m, str)]
    dims = [d for d in (result.get("dimensions") or []) if isinstance(d, str)]
    time_column = result.get("time_column")
    if not rows or not measures:
        return
    first = measures[0]
    for dim in dims[:2]:
        if dim == time_column:
            continue
        obs.add(dim, rank_values(rows, dim, first))
    axis_dims = len(dims) + (1 if time_column else 0)
    if block_type == "chart" and len(measures) >= 2 and axis_dims <= 1:
        obs.add(MEASURES_KEY, [m for m in measures if value_key(m)])


# ---- file dashboards: the result a block stores on itself -----------------
# The client's adapter (frontend/src/dashboard/fileData.ts) decides which
# stored column is the category, the series and the measure. This mirrors
# its naming rules for the shapes that carry identity colour, so the
# registry is keyed by the same column names the charts ask for. A shape it
# does not recognise is simply not observed (the chart then stays in the
# single colour - the client never guesses).

_NATIVE_FILE_CHARTS = {
    "bar", "column", "horizontal_bar", "line", "area", "grouped_bar", "stacked_bar", "stacked_area", "step_line", "pie", "donut", "faceted_bar",
    # 2026-10-07 (chart-types round): the new native forms that draw identity colour.
    "stacked_bar_100", "stacked_area_100", "treemap", "scatter", "bubble", "funnel", "combo",
}
_YEAR_NAME_RE = re.compile(r"(^|[_\s])(year|yr)([_\s]|$)", re.I)
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$|^\d{4}-\d{2}$")


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float("inf"), float("-inf"))


def _stored_table(cfg: dict) -> tuple[list[dict], list[dict]] | None:
    for cols_key, rows_key in (("result_columns", "result_rows"), ("columns", "rows")):
        cols_raw, rows_raw = cfg.get(cols_key), cfg.get(rows_key)
        if not isinstance(cols_raw, list) or not isinstance(rows_raw, list):
            continue
        cols = []
        for c in cols_raw:
            if isinstance(c, str):
                cols.append({"name": c, "dtype": None, "role": None})
            elif isinstance(c, dict) and isinstance(c.get("name"), str):
                cols.append({"name": c["name"], "dtype": c.get("dtype") if isinstance(c.get("dtype"), str) else None,
                             "role": c.get("role") if isinstance(c.get("role"), str) else None})
        if cols:
            return cols, [r for r in rows_raw if isinstance(r, dict)]
    return None


def _all_dates(rows: list[dict], name: str) -> bool:
    seen = 0
    for r in rows:
        v = r.get(name)
        if v is None or v == "":
            continue
        if not isinstance(v, str) or not _ISO_DATE_RE.match(v.strip()):
            return False
        seen += 1
    return seen > 0


def _is_measure_column(col: dict, rows: list[dict]) -> bool:
    values = [r.get(col["name"]) for r in rows]
    if not any(_is_num(v) for v in values) or not all(v is None or _is_num(v) for v in values):
        return False
    present = [v for v in values if v is not None]
    if _YEAR_NAME_RE.search(col["name"]) and present and all(float(v).is_integer() and 1000 <= v <= 2999 for v in present):
        return False
    if col.get("role") == "dimension" and col.get("dtype") != "number":
        return False
    return True


def _unique(base: str, taken: set) -> str:
    name, n = base or "Value", 2
    while name in taken:
        name = f"{base} {n}"
        n += 1
    taken.add(name)
    return name


def _detect_chart_type(figure: Any) -> str | None:
    traces = [t for t in (figure.get("data") or []) if isinstance(t, dict)] if isinstance(figure, dict) else []
    if not traces:
        return None
    t = traces[0]
    if any(x.get("type") != t.get("type") for x in traces):
        return None
    kind = t.get("type")
    if kind == "bar":
        if any((x.get("meta") or {}).get("role") == "facet_panel" for x in traces if isinstance(x.get("meta"), dict)):
            return "faceted_bar"
        if len(traces) > 1:
            return "stacked_bar" if (figure.get("layout") or {}).get("barmode") == "stack" else "grouped_bar"
        return "horizontal_bar" if t.get("orientation") == "h" else "bar"
    if kind == "pie":
        return "donut" if isinstance(t.get("hole"), (int, float)) and t.get("hole") > 0 else "pie"
    if kind in ("scatter", None):
        mode = str(t.get("mode") or "")
        if t.get("fill") and t.get("fill") != "none":
            return "stacked_area" if len(traces) > 1 else "area"
        return "line" if "lines" in mode else "scatter"
    return None


def _file_chart_type(cfg: dict) -> str | None:
    recipe = cfg.get("recipe") if isinstance(cfg.get("recipe"), dict) else {}
    for t in (cfg.get("chart_type"), recipe.get("chart_type")):
        if isinstance(t, str) and t.strip():
            return t.strip().lower()
    return _detect_chart_type(cfg.get("chart_spec"))


def _file_shape(cfg: dict, cols: list[dict], rows: list[dict], chart_type: str | None) -> dict | None:
    """{"time", "dims", "measure_keys", "measure_names"} - which stored
    columns are what (fileData.ts recipeShape / inferredShape)."""
    names = [c["name"] for c in cols]
    recipe = cfg.get("recipe") if isinstance(cfg.get("recipe"), dict) and not cfg["recipe"].get("metric_id") else None
    if recipe:
        raw_groups = recipe.get("group_by") if isinstance(recipe.get("group_by"), list) and recipe.get("group_by") else ([recipe["group_by_column"]] if recipe.get("group_by_column") else [])
        groups = [g for g in raw_groups if isinstance(g, str) and g in names]
        rest = [n for n in names if n not in groups]
        if groups and rest:
            taken = set(groups)
            keys, shown = [], []
            listed = [m for m in recipe.get("measures") or [] if isinstance(m, dict)] if isinstance(recipe.get("measures"), list) else []
            for m in listed:
                alias = m.get("alias")
                if isinstance(alias, str) and alias in rest:
                    keys.append(alias)
                    shown.append(_unique(alias, taken))
            if not keys:
                key = next((n for n in rest if n == recipe.get("alias")), None) or next((n for n in rest if n == recipe.get("metric_column")), None) or rest[0]
                keys, shown = [key], [key]
            grain = recipe.get("time_grain") if recipe.get("time_grain") in ("day", "week", "month", "quarter", "year") else None
            time = groups[0] if grain and _all_dates(rows, groups[0]) else None
            return {"time": time, "dims": groups[1:] if time else groups, "measure_keys": keys, "measure_names": shown, "recipe": True}
    measure_cols = [c for c in cols if _is_measure_column(c, rows)]
    dim_cols = [c for c in cols if c not in measure_cols]
    if not measure_cols:
        return None
    if chart_type == "faceted_bar" and len(dim_cols) >= 2:
        dim_cols = [dim_cols[1], dim_cols[0], *dim_cols[2:]]
    time = dim_cols[0]["name"] if dim_cols and _all_dates(rows, dim_cols[0]["name"]) else None
    dims = [c["name"] for c in (dim_cols[1:] if time else dim_cols)]
    keys = [c["name"] for c in measure_cols]
    return {"time": time, "dims": dims, "measure_keys": keys, "measure_names": list(keys), "recipe": False}


_FILE_MAX_SERIES = 6  # frontend/src/dashboard/format.ts MAX_SERIES


def observe_stored_block(obs: Observations, block_type: str, config: Any) -> None:
    """A file block's stored result (or its filtered copy) -> observations."""
    if block_type not in COLOURED_BLOCK_TYPES or not isinstance(config, dict):
        return
    cfg = config
    table = _stored_table(cfg)
    recipe = cfg.get("recipe") if isinstance(cfg.get("recipe"), dict) else None

    if block_type == "donut":
        if table and table[1]:
            shape = _file_shape(cfg, table[0], table[1], "donut")
            if shape and (shape["dims"] or shape["time"]) and shape["measure_keys"] and not shape["time"]:
                obs.add(shape["dims"][0], rank_values(table[1], shape["dims"][0], shape["measure_keys"][0]))
                return
            if shape:
                return
        items = cfg.get("items")
        if isinstance(items, list):
            group = (recipe or {}).get("group_by_column") if isinstance((recipe or {}).get("group_by_column"), str) and (recipe or {}).get("group_by_column") else "Category"
            rows = [{"g": it.get("label"), "v": it.get("value")} for it in items if isinstance(it, dict)]
            obs.add(group, rank_values(rows, "g", "v"))
        return

    # chart
    if cfg.get("forecast_enabled") or cfg.get("anomalies_enabled"):
        return
    chart_type = _file_chart_type(cfg)
    if not chart_type or chart_type not in _NATIVE_FILE_CHARTS or not table or not table[1]:
        return
    cols, rows = table
    shape = _file_shape(cfg, cols, rows, chart_type)
    if not shape or not shape["measure_keys"] or not (shape["time"] or shape["dims"]):
        return
    if chart_type in ("pie", "donut"):
        if not shape["time"] and shape["dims"]:
            obs.add(shape["dims"][0], rank_values(rows, shape["dims"][0], shape["measure_keys"][0]))
        return
    # 2026-10-07 (chart-types round): a scatter / bubble / treemap / funnel
    # is native only from rows of its shape (frontend fileData + recommend.fits);
    # otherwise it keeps its Plotly figure and nothing is observed.
    if chart_type in ("scatter", "bubble"):
        need = 3 if chart_type == "bubble" else 2
        if not shape["time"] and len(shape["dims"]) == 1 and len(shape["measure_keys"]) >= need:
            size_or_y = shape["measure_keys"][2] if chart_type == "bubble" else shape["measure_keys"][0]
            obs.add(shape["dims"][0], rank_values(rows, shape["dims"][0], size_or_y))
        return
    if chart_type in ("treemap", "funnel"):
        if not shape["time"] and shape["dims"] and len(rows) >= 2:
            for dim in shape["dims"][:2]:
                obs.add(dim, rank_values(rows, dim, shape["measure_keys"][0]))
        return
    wide = not shape["recipe"] and chart_type in ("grouped_bar", "stacked_bar", "stacked_area") and len(shape["measure_keys"]) > 1
    if wide and len(shape["measure_keys"]) > _FILE_MAX_SERIES and len(shape["dims"]) + (1 if shape["time"] else 0) == 1:
        # One column per series, more than the chart keeps: the client
        # melts them into (category, series, value) rows.
        x = shape["time"] or shape["dims"][0]
        layout = (cfg.get("chart_spec") or {}).get("layout") if isinstance(cfg.get("chart_spec"), dict) else None
        legend = ((layout or {}).get("legend") or {}).get("title") if isinstance((layout or {}).get("legend"), dict) else None
        legend_text = legend if isinstance(legend, str) else (legend or {}).get("text") if isinstance(legend, dict) else None
        series = _unique(legend_text or "Series", {x})
        totals = sorted(((k, sum(_num(r.get(k)) for r in rows)) for k in shape["measure_keys"] if value_key(k)), key=lambda kv: (-kv[1], kv[0]))
        if not shape["time"]:
            obs.add(x, rank_values(rows, x, shape["measure_keys"][0]))
        obs.add(series, [k for k, _ in totals])
        return
    first = shape["measure_keys"][0]
    for dim in shape["dims"][:2 if not shape["time"] else 1]:
        obs.add(dim, rank_values(rows, dim, first))
    axis_dims = len(shape["dims"]) + (1 if shape["time"] else 0)
    if len(shape["measure_names"]) >= 2 and axis_dims <= 1:
        obs.add(MEASURES_KEY, [m for m in shape["measure_names"] if value_key(m)])


def merge_observations(doc: dict, obs: Observations) -> bool:
    """Assigns slots for every new value in `obs` on a stored document, in
    place. Returns True when the document changed. Pure and deterministic:
    the result depends only on (doc, obs)."""
    changed = False
    assignments: dict = doc.setdefault("assignments", {})
    overflow: list = doc.setdefault("overflow", [])
    for column, keys in obs.columns.items():
        if not keys:
            continue
        col = assignments.get(column)
        if col is None:
            if len(assignments) >= MAX_COLUMNS:
                if not doc.get("registry_full"):
                    doc["registry_full"] = True
                    changed = True
                continue
            col = {}
        used = set(col.values())
        col_changed = False
        for key in keys:
            if key in col:
                continue
            slot = next((s for s in range(MAX_SLOTS) if s not in used), None)
            if slot is None:
                if column not in overflow:
                    overflow.append(column)
                    changed = True
                break
            col[key] = slot
            used.add(slot)
            col_changed = True
        if col_changed:
            assignments[column] = col
            changed = True
    return changed


def needs_write(stored: Any, obs: Observations) -> bool:
    """Would merge_observations change this document? (The lock-free fast
    path: almost every run meets nothing new.)"""
    if not obs:
        return False
    doc = stored_document(stored)
    probe = {"assignments": {c: dict(v) for c, v in doc["assignments"].items()}, "overflow": list(doc["overflow"]), "registry_full": doc["registry_full"]}
    return merge_observations(probe, obs)


_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _lock_for(dashboard_id: str) -> threading.Lock:
    with _LOCKS_GUARD:
        lock = _LOCKS.get(dashboard_id)
        if lock is None:
            if len(_LOCKS) > 2000:
                _LOCKS.clear()
            lock = _LOCKS[dashboard_id] = threading.Lock()
        return lock


def mutate(db, dashboard_id: str, fn) -> dict:
    """The one way dashboards.appearance is written: read the row under a
    lock (SELECT ... FOR UPDATE on Postgres; a per-dashboard process lock
    covers SQLite, where that clause is a no-op), let `fn(document)` return
    the new document (or None for "no change"), write, commit. Returns the
    document now stored. Uses the request's own session, so there is never
    a second connection waiting on the first."""
    from .. import models  # local: keeps this module importable on its own

    with _lock_for(dashboard_id):
        row = (
            db.query(models.Dashboard)
            .filter(models.Dashboard.id == dashboard_id)
            .with_for_update()
            .populate_existing()
            .first()
        )
        if row is None:
            db.rollback()
            return stored_document(None)
        doc = stored_document(row.appearance)
        try:
            new_doc = fn(doc)
        except Exception:
            db.rollback()
            raise
        if new_doc is not None:
            row.appearance = new_doc
            doc = new_doc
        db.commit()
        return doc


def assign_colors(db, dashboard, obs: Observations) -> dict | None:
    """Registers the values a run met. None when nothing was new (no lock
    taken, nothing written); otherwise the stored document after the write.
    Never raises: a failed write only means the values stay neutral until
    the next run."""
    try:
        if not obs or getattr(dashboard, "id", None) is None or not needs_write(getattr(dashboard, "appearance", None), obs):
            return None

        def _merge(doc: dict):
            return doc if merge_observations(doc, obs) else None

        return mutate(db, dashboard.id, _merge)
    except Exception as e:  # noqa: BLE001 - colour must never fail a run
        print(f"[appearance] colour assignment skipped (non-fatal): {e}")
        try:
            db.rollback()
        except Exception:
            pass
        return None


def registry_payload(stored: Any) -> dict:
    """What a run response carries so the page can colour what it just
    received: the registry and its overflow list."""
    doc = stored_document(stored)
    return {"assignments": doc["assignments"], "overflow": doc["overflow"], "registry_full": doc["registry_full"]}

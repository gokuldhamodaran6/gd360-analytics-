// 2026-10-07 (identity-colour round): the ONE object every chart renderer
// reads its colours from. Nothing in src/dashboard/charts, BlockRenderer,
// KpiStrip, the canvas, the Plotly restyler, the SVG export or the chat's
// WorkspaceChart names a series colour of its own; they ask a ChartTheme.
//
// THE COLOUR-RESOLUTION RULE
//   1. colorFor(column, value) depends on (column, value) and the palette -
//      never on a chart, a rank, a filter, a page, a viewer or load order.
//   2. An owner's pin (appearance.value_colors) wins: a hex is used as is,
//      a slot number follows the palette.
//   3. Else the registry's slot for (column, value) -> the palette's hue of
//      that slot: its LIGHT list on the light surface, the SAME slot of its
//      DARK list on the dark one.
//   4. Else - a value past the column's 10 slots, or not registered yet -
//      the palette's neutral "Other" grey; blank / null is always the fixed
//      neutral `blank`. Either way the label names it (legend, axis, tooltip).
//   5. Slots are assigned on the server, once, in first-seen order ranked by
//      the chart's measure, and never move (backend services/appearance.py).
//      The chat workspace has no server registry: LocalColorRegistry applies
//      the same rule in the browser, per data source.
//   6. Single colour: `primary` (single_color, else the palette's first hue;
//      for the GD360 palette today's pine green, or the dashboard's brand
//      colour). Used for one measure over time or over an ordinal axis,
//      small multiples, KPI sparklines, and every one-measure chart when
//      color_mode is "single".
//   7. Several measures on one axis: measureColor(name) - the same rule,
//      keyed by measure name under the reserved column MEASURES_KEY.
//   8. Text never takes a series colour. A swatch beside it carries identity.
//
// What gets identity colour in "by_value" mode is decided where the chart
// is planned (charts/model.ts planChart, charts/DonutChart.tsx); this file
// only answers "which colour".

import { SIGNATURE_COLORS } from "../../lib/chartStyle";
import {
  DEFAULT_APPEARANCE, type ColorAssignments, type ColorMode, type ColorPin, type ColorRegistry, type DashboardAppearance, type PaletteChoice,
} from "./appearance";
import {
  DIVERGING, PALETTES, SEQUENTIAL, STATUS, divergingRamp, getPalette, hexToOklch, paletteFromBrand, parseHex, sequentialRamp, validateCustomPalette,
  type Hex7, type Mode, type StatusColors,
} from "./palettes";

export const BLANK_KEY = "(Blanks)";
export const MEASURES_KEY = "__measures__";
export const MAX_SLOTS = 10;
export const MAX_LOCAL_COLUMNS = 40;
/** A one-measure bar chart over a column with more values than slots is
 *  coloured by value only when it is a "top N" of at most this many bars. */
export const BY_VALUE_MAX_BARS = 12;

// Today's --color-primary (index.css): the single-series colour of the
// GD360 palette. Light and dark are the token's own two values.
const PINE: Record<Mode, string> = { light: "#0f5c46", dark: "#147a5c" };
// Blank / null: a quiet neutral, lighter than "Other" on the light surface
// and darker on the dark one, so the two never read as the same bucket.
const BLANK: Record<Mode, string> = { light: "#bdbcb6", dark: "#55554f" };

/** The registry key of a dimension value (backend appearance.value_key). */
export function valueKey(v: unknown): string {
  if (v === null || v === undefined) return BLANK_KEY;
  if (typeof v === "boolean") return v ? "true" : "false";
  const s = String(v);
  return s.trim() === "" ? BLANK_KEY : s;
}

// ---- palettes ------------------------------------------------------------

export type ResolvedPalette = {
  key: string;
  kind: "preset" | "brand" | "custom";
  id: string;
  name: string;
  // The hues of this mode, in slot order (10, or as many as a custom palette has).
  slots: string[];
  other: string;
  // The single-series colour of this palette.
  primary: string;
  sequential: Hex7;
  diverging: Hex7;
  // Custom palettes: the indexes whose colour was adjusted to stay distinguishable.
  adjusted: number[];
};

const paletteCache = new Map<string, ResolvedPalette>();

function hueOf(hex: string): { h: number; c: number } {
  const o = hexToOklch(hex);
  // A colour with no hue of its own gets the same slate palettes.ts gives it.
  return o.c < 0.02 ? { h: 255, c: 0.12 } : { h: o.h, c: o.c };
}

/** A palette choice as concrete colours for one mode. Memoised: brand and
 *  custom palettes are searched, not looked up. */
export function resolvePalette(choice: PaletteChoice | null | undefined, mode: Mode): ResolvedPalette {
  const c: PaletteChoice = choice && typeof choice === "object" ? choice : DEFAULT_APPEARANCE.palette;
  const key = `${mode}|${JSON.stringify(c)}`;
  const hit = paletteCache.get(key);
  if (hit) return hit;
  let out: ResolvedPalette;
  const base = PALETTES[0];
  if (c.kind === "brand") {
    const brand = parseHex(c.color) ?? PINE.light;
    const built = paletteFromBrand(brand, mode);
    const { h, c: chroma } = hueOf(built.primary);
    out = {
      key, kind: "brand", id: "brand", name: "Brand", slots: [...built.categorical], other: base.other[mode], primary: built.primary,
      sequential: built.sequential, diverging: divergingRamp(h, (h + 180) % 360, chroma, mode), adjusted: [],
    };
  } else if (c.kind === "custom") {
    const typed = (Array.isArray(c.colors) ? c.colors : []).slice(0, MAX_SLOTS);
    const checked = validateCustomPalette(typed, mode);
    const useFixed = c.adjust !== false;
    const slots = typed.length ? typed.map((raw, i) => (useFixed ? checked.fixed[i] : parseHex(raw) ?? checked.fixed[i])) : [...base[mode]];
    const { h, c: chroma } = hueOf(slots[0]);
    out = {
      key, kind: "custom", id: "custom", name: "Custom", slots, other: base.other[mode], primary: slots[0],
      sequential: sequentialRamp(h, Math.max(chroma, 0.12), mode), diverging: divergingRamp(h, (h + 180) % 360, chroma, mode),
      adjusted: useFixed ? checked.adjusted : [],
    };
  } else {
    const p = getPalette(String(c.id || "gd360"));
    out = {
      key, kind: "preset", id: p.id, name: p.name, slots: [...p[mode]], other: p.other[mode],
      primary: p.id === "gd360" ? PINE[mode] : p[mode][0],
      sequential: (SEQUENTIAL[p.id] ?? SEQUENTIAL.gd360)[mode], diverging: (DIVERGING[p.id] ?? DIVERGING.gd360)[mode], adjusted: [],
    };
  }
  if (paletteCache.size > 200) paletteCache.clear();
  paletteCache.set(key, out);
  return out;
}

// ---- positions are not identities ---------------------------------------
// (backend appearance.is_position_word, same words.)

const MONTHS = new Set(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"]);
const WEEKDAYS = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun"]);
const NUMERIC_RE = /^-?\d+([.,]\d+)?%?$/;
const DATE_RE = /^\d{4}-\d{1,2}(-\d{1,2})?([t ].*)?$|^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$|^\d{4}$|^(q[1-4]|h[12])([ -]?\d{2,4})?$|^\d{4}[ -]?(q[1-4]|w\d{1,2})$/;

export function isPositionWord(key: string): boolean {
  const s = key.trim().toLowerCase();
  return NUMERIC_RE.test(s) || DATE_RE.test(s) || MONTHS.has(s) || WEEKDAYS.has(s);
}

/** The registry keys of a list of raw values, or [] when the column is a
 *  scale (every value a number, a date, a month, a weekday) rather than a
 *  set of entities. Blanks are never keys. */
export function identityKeys(values: unknown[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  let identity = false;
  for (const v of values) {
    if (typeof v === "number") continue;
    const k = valueKey(v);
    if (k === BLANK_KEY || k.length > 120 || seen.has(k)) continue;
    seen.add(k);
    keys.push(k);
    if (!isPositionWord(k)) identity = true;
  }
  return identity ? keys : [];
}

// ---- a registry kept in the browser (the chat workspace) -----------------

const LOCAL_PREFIX = "gd360_colors:";

/** The server's assignment rule (lowest free slot, first seen, 10 a column)
 *  applied in the browser, for surfaces that have no dashboard to store a
 *  registry on. Kept per scope in localStorage so a reload shows the same
 *  colours on this device. */
export class LocalColorRegistry {
  readonly scope: string | null;
  assignments: ColorAssignments = {};
  overflow: string[] = [];
  private revision = 0;

  constructor(scope: string | null) {
    this.scope = scope;
    if (!scope || typeof localStorage === "undefined") return;
    try {
      const raw = JSON.parse(localStorage.getItem(LOCAL_PREFIX + scope) || "null");
      if (raw && typeof raw === "object" && raw.assignments && typeof raw.assignments === "object") {
        for (const [column, values] of Object.entries(raw.assignments as Record<string, Record<string, unknown>>)) {
          const col: Record<string, number> = {};
          const used = new Set<number>();
          for (const [value, slot] of Object.entries(values || {})) {
            if (typeof slot === "number" && Number.isInteger(slot) && slot >= 0 && slot < MAX_SLOTS && !used.has(slot)) { col[value] = slot; used.add(slot); }
          }
          if (Object.keys(col).length) this.assignments[column] = col;
        }
        if (Array.isArray(raw.overflow)) this.overflow = raw.overflow.filter((c: unknown) => typeof c === "string");
      }
    } catch {
      // Unreadable storage: start empty.
    }
  }

  get rev(): number { return this.revision; }

  /** Registers `keys` (in rank order) for `column`. True when anything changed. */
  observe(column: string, keys: string[]): boolean {
    if (!column || !keys.length) return false;
    let col = this.assignments[column];
    if (!col) {
      if (Object.keys(this.assignments).length >= MAX_LOCAL_COLUMNS) return false;
      col = {};
    }
    const used = new Set(Object.values(col));
    let changed = false;
    for (const key of keys) {
      if (key in col) continue;
      let slot = 0;
      while (used.has(slot)) slot++;
      if (slot >= MAX_SLOTS) {
        if (!this.overflow.includes(column)) { this.overflow = [...this.overflow, column]; changed = true; }
        break;
      }
      col = { ...col, [key]: slot };
      used.add(slot);
      changed = true;
    }
    if (changed) {
      this.assignments = { ...this.assignments, [column]: col };
      this.revision++;
      this.save();
    }
    return changed;
  }

  snapshot(): ColorRegistry {
    return { assignments: this.assignments, overflow: this.overflow };
  }

  private save() {
    if (!this.scope || typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(LOCAL_PREFIX + this.scope, JSON.stringify(this.snapshot()));
    } catch {
      // Storage full or blocked: the colours still hold for this page.
    }
  }
}

const locals = new Map<string, LocalColorRegistry>();
/** The shared LocalColorRegistry of a scope ("ds:<datasource id>"). */
export function localRegistry(scope: string): LocalColorRegistry {
  let reg = locals.get(scope);
  if (!reg) {
    if (locals.size > 50) locals.clear();
    reg = new LocalColorRegistry(scope);
    locals.set(scope, reg);
  }
  return reg;
}

// ---- the theme -----------------------------------------------------------

export type ColumnColorInfo = {
  // The registry (or a pin) knows this column: its values are identities.
  known: boolean;
  // It has more values than slots: the rest share "Other".
  overflow: boolean;
};

export type ChartTheme = {
  mode: Mode;
  // Changes whenever anything a renderer could have memoised on does.
  key: string;
  // True only for DEFAULT_CHART_THEME: its colours are the kit's CSS tokens.
  tokens: boolean;
  // The registry lives in this browser (the chat workspace), not on a dashboard.
  local: boolean;
  colorMode: ColorMode;
  palette: ResolvedPalette;
  slots: readonly string[];
  // The single-series colour.
  primary: string;
  // The folded "Other" bucket, and values past a column's slots.
  other: string;
  // Blank / null.
  blank: string;
  // Reserved state colours - always with an icon and a label.
  status: StatusColors;
  // 7-step ramps (index 0 = lowest value / strongest negative) for
  // heatmaps and maps; `mode` defaults to the theme's own.
  sequential: (mode?: Mode) => Hex7;
  diverging: (mode?: Mode) => Hex7;
  // A 7-step ramp in the hue of any colour (a block's own single colour).
  rampFor: (color: string) => Hex7;
  // The palette's hue of slot i ("Other" past the palette's end).
  slot: (i: number) => string;
  colorFor: (column: string, value: unknown) => string;
  // A pin or a slot exists for this value (a swatch is worth drawing).
  hasColor: (column: string, value: unknown) => boolean;
  column: (column: string) => ColumnColorInfo;
  // `fallbackIndex`: the measure's position in its chart, used until the
  // registry knows the name.
  measureColor: (name: string, fallbackIndex?: number) => string;
  pinOf: (column: string, value: unknown) => ColorPin | null;
  // Local registries only (a no-op on a dashboard, whose registry is the
  // server's): the values a chart is about to draw, largest first.
  observe: (column: string, rankedValues: unknown[]) => void;
  // Numbers: the locale ("auto" = undefined = the viewer's) and currency.
  number: { locale: string | undefined; currency: string };
  // Edit mode: pin (or, with null, unpin) a value's colour everywhere.
  pin: ((column: string, value: string, pin: ColorPin | null) => void) | null;
};

export type ChartThemeOptions = {
  appearance?: Partial<DashboardAppearance> | null;
  mode: Mode;
  // The registry of the latest run (newer than the page payload's).
  registry?: ColorRegistry | null;
  // The chat workspace: assign in the browser instead.
  local?: LocalColorRegistry | null;
  onPin?: ChartTheme["pin"];
};

function pinColor(pin: ColorPin | undefined | null, slot: (i: number) => string): string | null {
  if (typeof pin === "number") return Number.isInteger(pin) && pin >= 0 && pin < MAX_SLOTS ? slot(pin) : null;
  if (typeof pin === "string") return parseHex(pin);
  return null;
}

export function buildChartTheme({ appearance, mode, registry, local, onPin }: ChartThemeOptions): ChartTheme {
  const a = appearance || DEFAULT_APPEARANCE;
  const palette = resolvePalette(a.palette, mode);
  const pins = a.value_colors || {};
  const reg: ColorRegistry = local ? local.snapshot() : registry || { assignments: a.assignments || {}, overflow: a.overflow || [] };
  const slot = (i: number) => (i >= 0 && i < palette.slots.length ? palette.slots[i] : palette.other);
  const brandPrimary = parseHex(a.brand?.primary ?? null);
  const primary = parseHex(a.single_color) ?? (palette.kind === "preset" && palette.id === "gd360" && brandPrimary ? brandPrimary : palette.primary);
  const assignments = () => (local ? local.assignments : reg.assignments);
  const overflow = () => (local ? local.overflow : reg.overflow);

  const colorFor = (column: string, value: unknown): string => {
    const key = valueKey(value);
    const pinned = pinColor(pins[column]?.[key], slot);
    if (pinned) return pinned;
    if (key === BLANK_KEY) return BLANK[mode];
    const s = assignments()[column]?.[key];
    return typeof s === "number" ? slot(s) : palette.other;
  };
  const theme: ChartTheme = {
    mode,
    key: "",
    tokens: false,
    local: Boolean(local),
    colorMode: a.color_mode === "single" ? "single" : "by_value",
    palette,
    slots: palette.slots,
    primary,
    other: palette.other,
    blank: BLANK[mode],
    status: STATUS[mode],
    sequential: (m = mode) => (m === mode ? palette.sequential : resolvePalette(a.palette, m).sequential),
    diverging: (m = mode) => (m === mode ? palette.diverging : resolvePalette(a.palette, m).diverging),
    rampFor: (color) => {
      const hex = parseHex(color);
      if (!hex || hex === palette.primary) return palette.sequential;
      const { h, c } = hueOf(hex);
      return sequentialRamp(h, Math.max(c, 0.12), mode);
    },
    slot,
    colorFor,
    hasColor: (column, value) => {
      const key = valueKey(value);
      if (pinColor(pins[column]?.[key], slot)) return true;
      return key !== BLANK_KEY && typeof assignments()[column]?.[key] === "number";
    },
    column: (column) => ({
      known: Boolean(assignments()[column] && Object.keys(assignments()[column]).length) || Boolean(pins[column] && Object.keys(pins[column]).length),
      overflow: overflow().includes(column),
    }),
    measureColor: (name, fallbackIndex = 0) => {
      const pinned = pinColor(pins[MEASURES_KEY]?.[name], slot);
      if (pinned) return pinned;
      const s = assignments()[MEASURES_KEY]?.[name];
      return slot(typeof s === "number" ? s : Math.min(Math.max(0, fallbackIndex), palette.slots.length - 1));
    },
    pinOf: (column, value) => {
      const pin = pins[column]?.[valueKey(value)];
      return pin === undefined ? null : pin;
    },
    observe: (column, rankedValues) => {
      if (!local) return;
      if (column === MEASURES_KEY) local.observe(column, rankedValues.map((v) => String(v)).filter(Boolean));
      else local.observe(column, identityKeys(rankedValues));
    },
    number: { locale: !a.locale || a.locale === "auto" ? undefined : a.locale, currency: a.currency || "USD" },
    pin: onPin ?? null,
  };
  theme.key = [
    mode, palette.key, theme.colorMode, primary, a.currency, a.locale, JSON.stringify(pins),
    local ? `local:${local.scope}:${local.rev}` : JSON.stringify(reg.assignments) + (reg.overflow || []).join(","),
  ].join("|");
  return theme;
}

// ---- no provider: today's tokens -----------------------------------------
// A chart drawn outside any ChartThemeProvider (a unit test of the planner,
// a surface that has not been given an appearance) gets exactly what the
// renderers drew before this round: the kit's CSS tokens, one colour for
// one measure, the palette in its fixed order for several series. The
// tokens follow the page's light / dark theme by themselves.

const tokenSlots: string[] = [1, 2, 3, 4, 5, 6].map((i) => `rgb(var(--color-series-${i}))`).concat(SIGNATURE_COLORS[6], PALETTES[0].light.slice(7));

export const DEFAULT_CHART_THEME: ChartTheme = (() => {
  const base = buildChartTheme({ appearance: { ...DEFAULT_APPEARANCE, color_mode: "single" }, mode: "light" });
  const slot = (i: number) => (i >= 0 && i < tokenSlots.length ? tokenSlots[i] : "rgb(var(--color-faint))");
  return {
    ...base,
    key: "default-tokens",
    tokens: true,
    slots: tokenSlots,
    primary: "rgb(var(--color-primary))",
    other: "rgb(var(--color-faint))",
    blank: "rgb(var(--color-faint))",
    slot,
    colorFor: () => "rgb(var(--color-faint))",
    hasColor: () => false,
    column: () => ({ known: false, overflow: false }),
    measureColor: (_name, fallbackIndex = 0) => slot(Math.min(Math.max(0, fallbackIndex), tokenSlots.length - 1)),
    pinOf: () => null,
  };
})();

// ---- per-block override ----------------------------------------------------
// block.config.color_mode: "by_value" | "single" (absent = follow the
// dashboard); block.config.single_color: the hex "Single" uses (absent =
// the theme's primary).

export function blockColorMode(theme: ChartTheme, config: any): ColorMode {
  const own = config?.color_mode;
  return own === "by_value" || own === "single" ? own : theme.colorMode;
}

export function blockSingleColor(theme: ChartTheme, config: any): string {
  return (config?.color_mode === "single" ? parseHex(config?.single_color) : null) ?? theme.primary;
}

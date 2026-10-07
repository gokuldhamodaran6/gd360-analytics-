// 2026-10-07 (identity-colour round): the appearance document as the client
// knows it - the same shape backend/app/services/appearance.py documents,
// resolves and validates (see that module's header; it is the one place
// the document is specified). This file holds the types, the defaults, and
// the presentation presets (fonts, corner radii, density, currencies,
// locales). Colour resolution is chartTheme.ts.

export type PaletteChoice =
  | { kind: "preset"; id: string }
  | { kind: "brand"; color: string }
  // `adjust` (default true): draw the minimally adjusted set
  // palettes.validateCustomPalette returns instead of the colours as typed.
  | { kind: "custom"; colors: string[]; adjust?: boolean };

export type ColorMode = "by_value" | "single";
export type ThemeDefault = "auto" | "light" | "dark";
export type Density = "comfortable" | "compact";
export type Radius = "sharp" | "soft" | "round";

// A pinned colour: a hex, or a palette slot (0-9) that follows the palette.
export type ColorPin = string | number;
export type ValueColors = Record<string, Record<string, ColorPin>>;
export type ColorAssignments = Record<string, Record<string, number>>;

/** The colour registry a run response carries (RunPageOut.colors). */
export type ColorRegistry = { assignments: ColorAssignments; overflow: string[]; registry_full?: boolean };

export type AppearanceStyle = {
  palette: PaletteChoice;
  color_mode: ColorMode;
  single_color: string | null;
  theme_default: ThemeDefault;
  density: Density;
  radius: Radius;
  font: string;
  currency: string;
  locale: string;
  footer_note: string;
};

/** The RESOLVED appearance of a dashboard (DashboardBuilderOut.appearance /
 *  PublicDashboardOut.appearance). */
export type DashboardAppearance = AppearanceStyle & {
  value_colors: ValueColors;
  assignments: ColorAssignments;
  overflow: string[];
  registry_full?: boolean;
  customized?: boolean;
  // Where the style comes from.
  source?: "dashboard" | "workspace" | "default";
  // Branded before this round and never customised: single colour, in its brand colour.
  legacy_brand?: boolean;
  // The chrome colours in force (the dashboard's own, or its workspace kit's).
  brand?: { primary: string | null; accent: string | null };
};

/** A workspace brand kit: the style a workspace's dashboards start from. */
export type BrandKit = Partial<AppearanceStyle> & { brand_primary_color?: string | null; brand_accent_color?: string | null };

export const STYLE_KEYS = ["palette", "color_mode", "single_color", "theme_default", "density", "radius", "font", "currency", "locale", "footer_note"] as const;
export type StyleKey = (typeof STYLE_KEYS)[number];

export const DEFAULT_STYLE: AppearanceStyle = {
  palette: { kind: "preset", id: "gd360" },
  color_mode: "by_value",
  single_color: null,
  theme_default: "auto",
  density: "comfortable",
  radius: "soft",
  font: "geist",
  currency: "USD",
  locale: "auto",
  footer_note: "",
};

export const DEFAULT_APPEARANCE: DashboardAppearance = {
  ...DEFAULT_STYLE,
  value_colors: {},
  assignments: {},
  overflow: [],
  registry_full: false,
  customized: false,
  source: "default",
  legacy_brand: false,
  brand: { primary: null, accent: null },
};

/** A payload's appearance (possibly from an older backend: null) made whole. */
export function completeAppearance(a: Partial<DashboardAppearance> | null | undefined): DashboardAppearance {
  if (!a || typeof a !== "object") return DEFAULT_APPEARANCE;
  return {
    ...DEFAULT_APPEARANCE,
    ...a,
    palette: a.palette && typeof a.palette === "object" ? a.palette : DEFAULT_STYLE.palette,
    value_colors: a.value_colors && typeof a.value_colors === "object" ? a.value_colors : {},
    assignments: a.assignments && typeof a.assignments === "object" ? a.assignments : {},
    overflow: Array.isArray(a.overflow) ? a.overflow : [],
    brand: a.brand && typeof a.brand === "object" ? a.brand : DEFAULT_APPEARANCE.brand,
  };
}

/** A kit as a dashboard appearance (the kit editor's preview, the prompt
 *  builder's proposal preview, the chat workspace's charts). */
export function appearanceFromKit(kit: BrandKit | null | undefined): DashboardAppearance {
  if (!kit) return DEFAULT_APPEARANCE;
  const style: Partial<AppearanceStyle> = {};
  for (const key of STYLE_KEYS) if (kit[key] !== undefined) (style as Record<string, unknown>)[key] = kit[key];
  return completeAppearance({ ...style, source: "workspace", brand: { primary: kit.brand_primary_color ?? null, accent: kit.brand_accent_color ?? null } });
}

// ---- fonts ---------------------------------------------------------------
// The kit's Geist plus three faces enterprise brand guides ask for. Only
// Geist is in index.html; the others are fetched from Google Fonts the
// first time a dashboard that uses them is on screen (ensureFont). Every
// stack ends in the system UI fonts, so a blocked or slow font request
// leaves readable text in the same metrics class, never a blank.

const SYSTEM_STACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export type FontPreset = { id: string; name: string; stack: string; href: string | null; note: string };

export const FONT_PRESETS: FontPreset[] = [
  { id: "geist", name: "Geist", stack: `Geist, ${SYSTEM_STACK}`, href: null, note: "The GD360 default" },
  { id: "inter", name: "Inter", stack: `Inter, ${SYSTEM_STACK}`, href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap", note: "Neutral, the product-UI standard" },
  { id: "ibm-plex-sans", name: "IBM Plex Sans", stack: `"IBM Plex Sans", ${SYSTEM_STACK}`, href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap", note: "Technical, corporate" },
  { id: "source-sans-3", name: "Source Sans 3", stack: `"Source Sans 3", ${SYSTEM_STACK}`, href: "https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap", note: "Humanist, report-like" },
];

export function fontPreset(id: string | null | undefined): FontPreset {
  return FONT_PRESETS.find((f) => f.id === id) ?? FONT_PRESETS[0];
}

/** Adds the font's stylesheet to <head> once. Nothing is fetched for Geist. */
export function ensureFont(id: string | null | undefined): void {
  const font = fontPreset(id);
  if (!font.href || typeof document === "undefined") return;
  if (document.head.querySelector(`link[data-gd-font="${font.id}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = font.href;
  link.setAttribute("data-gd-font", font.id);
  document.head.appendChild(link);
}

// ---- corner radius, density ---------------------------------------------

export const RADIUS_PRESETS: Record<Radius, { label: string; ctl: number; card: number; sm: number }> = {
  sharp: { label: "Sharp", ctl: 2, card: 3, sm: 2 },
  soft: { label: "Soft", ctl: 8, card: 12, sm: 6 },
  round: { label: "Round", ctl: 12, card: 20, sm: 9 },
};

/** The 12-column grid's metrics per density. The view and the editor both
 *  read these (BlockGrid / EditGrid), so they stay pixel for pixel alike. */
export type GridMetrics = { rowUnit: number; gap: number };
export const GRID_METRICS: Record<Density, GridMetrics> = {
  comfortable: { rowUnit: 48, gap: 16 },
  compact: { rowUnit: 40, gap: 10 },
};

/** CSS custom properties + font for the dashboard's root element. */
export function scopeStyle(a: Pick<AppearanceStyle, "radius" | "font" | "density">): Record<string, string> {
  const out: Record<string, string> = {};
  const r = RADIUS_PRESETS[a.radius] ?? RADIUS_PRESETS.soft;
  if (a.radius !== "soft") {
    out["--radius-ctl"] = `${r.ctl}px`;
    out["--radius-card"] = `${r.card}px`;
    out["--radius-sm"] = `${r.sm}px`;
  }
  if (a.font && a.font !== "geist") out.fontFamily = fontPreset(a.font).stack;
  return out;
}

// ---- numbers -------------------------------------------------------------

export const CURRENCY_CHOICES: { code: string; name: string }[] = [
  { code: "USD", name: "US dollar" }, { code: "EUR", name: "Euro" }, { code: "GBP", name: "Pound sterling" }, { code: "INR", name: "Indian rupee" },
  { code: "JPY", name: "Japanese yen" }, { code: "CNY", name: "Chinese yuan" }, { code: "AUD", name: "Australian dollar" }, { code: "CAD", name: "Canadian dollar" },
  { code: "CHF", name: "Swiss franc" }, { code: "SGD", name: "Singapore dollar" }, { code: "AED", name: "UAE dirham" }, { code: "SAR", name: "Saudi riyal" },
  { code: "BRL", name: "Brazilian real" }, { code: "MXN", name: "Mexican peso" }, { code: "ZAR", name: "South African rand" }, { code: "SEK", name: "Swedish krona" },
  { code: "NOK", name: "Norwegian krone" }, { code: "DKK", name: "Danish krone" }, { code: "PLN", name: "Polish zloty" }, { code: "TRY", name: "Turkish lira" },
  { code: "KRW", name: "South Korean won" }, { code: "HKD", name: "Hong Kong dollar" }, { code: "NZD", name: "New Zealand dollar" }, { code: "THB", name: "Thai baht" },
  { code: "IDR", name: "Indonesian rupiah" }, { code: "MYR", name: "Malaysian ringgit" }, { code: "PHP", name: "Philippine peso" }, { code: "NGN", name: "Nigerian naira" },
  { code: "EGP", name: "Egyptian pound" }, { code: "ILS", name: "Israeli shekel" },
];

export const LOCALE_CHOICES: { tag: string; name: string }[] = [
  { tag: "auto", name: "Each viewer's own (browser)" },
  { tag: "en-US", name: "English (United States)" }, { tag: "en-GB", name: "English (United Kingdom)" }, { tag: "en-IN", name: "English (India)" },
  { tag: "en-AU", name: "English (Australia)" }, { tag: "en-SG", name: "English (Singapore)" }, { tag: "de-DE", name: "German (Germany)" },
  { tag: "de-CH", name: "German (Switzerland)" }, { tag: "fr-FR", name: "French (France)" }, { tag: "es-ES", name: "Spanish (Spain)" },
  { tag: "es-MX", name: "Spanish (Mexico)" }, { tag: "it-IT", name: "Italian (Italy)" }, { tag: "nl-NL", name: "Dutch (Netherlands)" },
  { tag: "pt-BR", name: "Portuguese (Brazil)" }, { tag: "sv-SE", name: "Swedish (Sweden)" }, { tag: "pl-PL", name: "Polish (Poland)" },
  { tag: "tr-TR", name: "Turkish (Türkiye)" }, { tag: "ja-JP", name: "Japanese (Japan)" }, { tag: "ko-KR", name: "Korean (South Korea)" },
  { tag: "zh-CN", name: "Chinese (China)" }, { tag: "ar-AE", name: "Arabic (UAE)" }, { tag: "hi-IN", name: "Hindi (India)" },
];

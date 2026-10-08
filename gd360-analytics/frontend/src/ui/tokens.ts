// Hex tokens for chart code (DESIGN_BRIEF.md + System.dc.html, 2026-10-06).
// Everything the UI renders through CSS reads the `--color-*` variables in
// src/index.css instead; this file exists because Plotly/SVG chart code
// needs literal colour strings. One source of truth: the series palette
// comes from src/lib/chartStyle.ts (SIGNATURE_COLORS) and is only
// re-exported here, never duplicated.

import { SIGNATURE_COLORS } from "../lib/chartStyle";

export { SIGNATURE_COLORS };

/** Chart series 1..6, assigned in order and never cycled: blue, orange,
 *  aqua, yellow, magenta, green. Identical in light and dark mode. */
export const SERIES: readonly string[] = SIGNATURE_COLORS.slice(0, 6);

/** The colour of a chart that has exactly one series. */
export const SINGLE_SERIES = "#0f5c46";

/** One-hue sequential ramp (heatmaps, choropleths), light -> dark. */
export const SEQUENTIAL: readonly string[] = ["#e8f3ee", "#c3dfd3", "#8fc4ad", "#4f9a7c", "#1f6f55", "#0f4a38"];

/** The same ramp for dark mode: derived from the dark primary so "more"
 *  still reads as "more contrast against the page". */
export const SEQUENTIAL_DARK: readonly string[] = ["#122521", "#144234", "#1f6e55", "#4f9a7c", "#8fc4ad", "#c3dfd3"];

export const BRAND = {
  primary: "#0f5c46",
  accent: "#2d8267",
  tint: "#e8f3ee",
  tintBorder: "#c3dfd3",
  // Dark-mode counterparts (System.dc.html "Dark mode").
  primaryDark: "#43e5a0",
  accentDark: "#6ec9aa",
} as const;

export const STATUS = {
  good: { ink: "#0f5c46", fill: "#e8f3ee", border: "#c3dfd3" },
  warning: { ink: "#b45309", fill: "#fdf1e3", border: "#f3dcbd" },
  danger: { ink: "#b42318", fill: "#fdecea", border: "#f6c9c4" },
} as const;

export const LIGHT = {
  ground: "#f6f6f3",
  surface: "#ffffff",
  subtle: "#f1f1ed",
  border: "#e3e3de",
  borderStrong: "#d4d4ce",
  text: "#161615",
  secondary: "#4f4f4b",
  muted: "#6f6f6a",
  faint: "#a8a8a4",
} as const;

export const DARK = {
  ground: "#0a0a0b",
  surface: "#121214",
  subtle: "#1a1a1d",
  border: "#2a2a2e",
  borderStrong: "#3a3a3f",
  text: "#ededE9",
  secondary: "#bebeba",
  muted: "#969694",
  faint: "#686866",
} as const;

/** Gridlines: the Subtle fill in light, Border in dark (System.dc.html). */
export const GRIDLINE = { light: LIGHT.subtle, dark: DARK.border } as const;

/** Pick the series colour for index `i` of `n` series: a single series is
 *  brand green, otherwise palette order. Never cycles - a chart with more
 *  than six series should be redesigned, not recoloured. */
export function seriesColor(i: number, n: number): string {
  if (n <= 1) return SINGLE_SERIES;
  return SERIES[Math.min(i, SERIES.length - 1)];
}

/** Reads a `--color-*` RGB triplet from the live document so SVG/canvas
 *  code can follow the theme toggle; falls back to the light hex. */
export function cssColor(token: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--color-${token}`).trim();
  if (!raw) return fallback;
  const parts = raw.split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return fallback;
  return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
}

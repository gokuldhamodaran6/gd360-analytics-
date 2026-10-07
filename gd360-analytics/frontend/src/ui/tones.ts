// Status tones shared by StatusPill, Badge, KpiTile's delta pill, Field's
// error state and ChartCard's error state - the fill + ink + border pairs
// from the design system (src/index.css --color-good/-warning/-danger).
// Tone is always passed in explicitly by the caller; nothing in the kit
// infers "good" from a number's sign.
export type Tone = "good" | "warning" | "danger" | "neutral" | "brand";

export const TONE_CLASSES: Record<Tone, string> = {
  good: "bg-good-fill text-good border-good-border",
  warning: "bg-warning-fill text-warning border-warning-border",
  danger: "bg-danger-fill text-danger border-danger-border",
  neutral: "bg-subtle text-secondary border-border",
  brand: "bg-tint text-brand-ink border-tint-border",
};

export const TONE_DOT_CLASSES: Record<Tone, string> = {
  good: "bg-good",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-muted",
  brand: "bg-brand-ink",
};

export const TONE_TEXT_CLASSES: Record<Tone, string> = {
  good: "text-good",
  warning: "text-warning",
  danger: "text-danger",
  neutral: "text-secondary",
  brand: "text-brand-ink",
};

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useThemeMode } from "../../api/ThemeContext";
import { useIsNarrow } from "../../components/DashboardBlocks";
import {
  Button, CheckIcon, CloseIcon, ConfirmDialog, Field, Input, SegmentedControl, Select, Sheet, StatusPill, WarningIcon, cn,
} from "../../ui";
import { formatValueWith, humanize, type ValueFormat } from "../format";
import {
  CURRENCY_CHOICES, DEFAULT_STYLE, FONT_PRESETS, LOCALE_CHOICES, RADIUS_PRESETS, ensureFont, fontPreset,
  type ColorMode, type DashboardAppearance, type Density, type PaletteChoice, type Radius, type ThemeDefault,
} from "./appearance";
import { ChartThemeProvider, ColorSwatch, useChartTheme } from "./ChartThemeContext";
import { MEASURES_KEY, resolvePalette } from "./chartTheme";
import { CustomPaletteEditor } from "./CustomPaletteEditor";
import { PalettePreview, SAMPLE_PREVIEWS, type PreviewSamples } from "./PalettePreview";
import { PALETTES, parseHex, type Mode } from "./palettes";
import type { AppearanceController, SaveState } from "./useAppearanceEditor";

// 2026-10-07 (identity-colour round): the ONE place a dashboard's look is
// set - opened from the header's More menu and from the edit toolbar - and,
// in "kit" mode, the workspace brand kit's editor.
//
//   Colours        colour by value / single colour; the palette gallery
//                  (each palette drawn on this dashboard's own data); a
//                  palette from one brand colour; a custom palette of up
//                  to ten colours, checked live; the pinned values; reset
//   Brand          logo, brand primary / accent (the chrome), page
//                  background - the pre-existing features, same endpoints
//   Layout & type  density, corner radius, font
//   Numbers        currency and locale, with a live sample
//   Public link    the published link's default theme, the footer note
//
// Every change shows on the dashboard behind the sheet at once (the sheet
// has no scrim), saves by itself (Saving... / Saved / Retry in the footer)
// and can be undone with "Revert changes" until the sheet closes.

type SectionId = "colors" | "brand" | "layout" | "numbers" | "public";
const SECTIONS: { id: SectionId; label: string; short: string }[] = [
  { id: "colors", label: "Colours", short: "Colours" },
  { id: "brand", label: "Brand", short: "Brand" },
  { id: "layout", label: "Layout & type", short: "Layout" },
  { id: "numbers", label: "Numbers", short: "Numbers" },
  { id: "public", label: "Public link", short: "Public" },
];

export type AppearanceSheetProps = {
  open: boolean;
  onClose: () => void;
  controller: AppearanceController;
  // The palette cards' charts: this dashboard's results (see
  // PalettePreview.previewSamples); default: the built-in sample.
  samples?: PreviewSamples;
  // The colour registry of the latest run (newer than the payload's).
  registry?: DashboardAppearance["assignments"] | null;
  // Extra content of the Brand section (a dashboard's logo and page
  // background, which live on their own endpoints).
  brandExtra?: ReactNode;
  // What is being styled, for the title ("Acme Hotels" brand kit).
  subjectName?: string | null;
  // A line above the section tabs (the kit editor: whether a kit exists).
  notice?: ReactNode;
  initialSection?: SectionId;
};

export function SaveStatus({ state, error, onRetry }: { state: SaveState; error?: string | null; onRetry?: () => void }) {
  if (state === "saving") {
    return (
      <span data-save-state="saving" role="status" className="inline-flex items-center gap-1.5 text-caption text-muted">
        <span className="ui-spinner !h-3 !w-3 !border-[1.5px]" aria-hidden="true" /> Saving…
      </span>
    );
  }
  if (state === "error") {
    return (
      <span data-save-state="error" role="alert" title={error || undefined} className="inline-flex min-w-0 items-center gap-1 text-caption text-danger">
        <WarningIcon size={12} className="shrink-0" />
        <span className="truncate">{error || "Couldn't save"} —</span>
        {onRetry && <button type="button" className="ui-focus rounded px-0.5 font-medium underline underline-offset-2 hover:no-underline" onClick={onRetry}>Retry</button>}
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span data-save-state="saved" role="status" className="inline-flex items-center gap-1 text-caption text-muted">
        <CheckIcon size={12} /> Saved
      </span>
    );
  }
  return <span data-save-state="idle" className="text-caption text-muted">Changes save automatically</span>;
}

function SectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h3 className="text-ui font-semibold text-text">{children}</h3>
      {hint && <p className="text-caption text-muted">{hint}</p>}
    </div>
  );
}

function Swatches({ colors, size = 16 }: { colors: readonly string[]; size?: number }) {
  return (
    <span className="flex flex-wrap gap-[3px]" aria-hidden="true" data-palette-swatches="">
      {colors.map((c, i) => <span key={i} className="rounded-[4px]" style={{ width: size, height: size, background: c }} />)}
    </span>
  );
}

/** A colour input + its hex code, kept in step. */
export function ColorField({ label, value, fallback, onChange, disabled, onClear, clearLabel = "Reset" }: { label: string; value: string | null; fallback: string; onChange: (hex: string) => void; disabled?: boolean; onClear?: () => void; clearLabel?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value ?? "";
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        aria-label={label}
        disabled={disabled}
        value={parseHex(value) || parseHex(fallback) || PALETTES[0].light[0]}
        onChange={(e) => { setDraft(null); onChange(e.target.value.toLowerCase()); }}
        className="ui-focus h-9 w-10 shrink-0 cursor-pointer rounded-ctl border border-border bg-transparent p-0"
      />
      <Input
        aria-label={`${label} hex code`}
        mono
        maxLength={7}
        disabled={disabled}
        placeholder={fallback}
        invalid={draft !== null && draft.trim() !== "" && !parseHex(draft)}
        value={shown}
        onChange={(e) => { const text = e.target.value; setDraft(text); const hex = parseHex(text); if (hex) onChange(hex); }}
        onBlur={() => setDraft(null)}
        className="w-[112px]"
      />
      {onClear && value && <Button variant="ghost" disabled={disabled} onClick={() => { setDraft(null); onClear(); }}>{clearLabel}</Button>}
    </div>
  );
}

// ---- Colours ---------------------------------------------------------------

function PinnedList({ controller }: { controller: AppearanceController }) {
  const theme = useChartTheme();
  const pins = controller.appearance.value_colors || {};
  const rows = Object.entries(pins).flatMap(([column, values]) => Object.keys(values).map((value) => ({ column, value })));
  if (!rows.length) return <p className="text-caption text-muted" data-pins-empty="">Nothing pinned. While editing, click a legend key or a filter chip's dot to give a value its own colour.</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" data-pinned-values="">
      {rows.map(({ column, value }) => (
        <li key={`${column}\u0000${value}`} className="flex items-center gap-2 rounded-ctl border border-border px-2 py-1" data-pinned={`${column}:${value}`}>
          <ColorSwatch column={column} value={value} label={value} color={column === MEASURES_KEY ? theme.measureColor(value) : theme.colorFor(column, value)} size={12} />
          <span className="min-w-0 flex-1 truncate text-ui text-text" title={value}>{column === MEASURES_KEY ? humanize(value) : value}</span>
          <span className="shrink-0 truncate text-caption text-muted" title={column === MEASURES_KEY ? undefined : column}>{column === MEASURES_KEY ? "Measure" : humanize(column)}</span>
          <button type="button" aria-label={`Remove the pinned colour of ${value}`} title="Remove" disabled={!controller.canEdit} onClick={() => controller.pin?.(column, value, null)} className="ui-focus inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-muted hover:bg-subtle hover:text-text">
            <CloseIcon size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function ValueColors({ controller }: { controller: AppearanceController }) {
  const theme = useChartTheme();
  const columns = Object.entries(theme.local ? {} : (controller.appearance.assignments || {})).filter(([c]) => c !== MEASURES_KEY);
  const measures = Object.keys(controller.appearance.assignments?.[MEASURES_KEY] || {});
  if (!columns.length && !measures.length) return null;
  const overflow = new Set(controller.appearance.overflow || []);
  return (
    <div className="flex flex-col gap-2.5" data-value-colors="">
      {columns.map(([column, values]) => (
        <div key={column} className="flex flex-col gap-1">
          <div className="text-caption text-muted"><span className="font-medium text-secondary" title={column}>{humanize(column)}</span>{overflow.has(column) ? " · has more values than the palette has colours; the rest share the neutral grey" : ""}</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {Object.keys(values).map((value) => (
              <span key={value} className="inline-flex max-w-full items-center gap-1 text-caption text-secondary">
                <ColorSwatch column={column} value={value} label={value} color={theme.colorFor(column, value)} />
                <span className="truncate">{value}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
      {measures.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-caption text-muted"><span className="font-medium text-secondary">Measures</span> · on charts that plot several</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {measures.map((name) => (
              <span key={name} className="inline-flex max-w-full items-center gap-1 text-caption text-secondary">
                <ColorSwatch column={MEASURES_KEY} value={name} label={name} color={theme.measureColor(name)} />
                <span className="truncate" title={name}>{humanize(name)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ColoursSection({ controller, samples, mode, narrow }: { controller: AppearanceController; samples: PreviewSamples; mode: Mode; narrow: boolean }) {
  const a = controller.appearance;
  const disabled = !controller.canEdit;
  const palette = a.palette;
  const [brandDraft, setBrandDraft] = useState<string>(() => (palette.kind === "brand" ? palette.color : parseHex(controller.brand.primary) || resolvePalette(DEFAULT_STYLE.palette, "light").primary));
  const [confirmReset, setConfirmReset] = useState(false);
  const brandHex = parseHex(brandDraft) || resolvePalette(DEFAULT_STYLE.palette, "light").primary;
  const brandPalette = useMemo<PaletteChoice>(() => ({ kind: "brand", color: brandHex }), [brandHex]);
  const brandResolved = useMemo(() => resolvePalette(brandPalette, mode), [brandPalette, mode]);
  const brandActive = palette.kind === "brand" && palette.color === brandHex;
  const previewWidth = narrow ? 250 : 206;
  const setPalette = (p: PaletteChoice) => controller.patch({ palette: p });
  const single = resolvePalette(palette, mode);

  return (
    <div className="flex flex-col gap-6" data-appearance-section="colors">
      <div className="flex flex-col gap-2.5">
        <SectionTitle>How charts are coloured</SectionTitle>
        <SegmentedControl<ColorMode>
          ariaLabel="Colour mode"
          fullWidth
          disabled={disabled}
          value={a.color_mode}
          onChange={(v) => controller.patch({ color_mode: v })}
          options={[{ value: "by_value", label: "By value" }, { value: "single", label: "Single colour" }]}
        />
        <dl className="m-0 flex flex-col gap-1 text-caption" data-color-mode-help="">
          <div className={cn("flex gap-1.5", a.color_mode === "by_value" ? "text-secondary" : "text-muted")}>
            <dt className="shrink-0 font-medium">By value</dt>
            <dd className="m-0">Each value keeps its own colour on every chart and page - City Hotel is the same colour everywhere.</dd>
          </div>
          <div className={cn("flex gap-1.5", a.color_mode === "single" ? "text-secondary" : "text-muted")}>
            <dt className="shrink-0 font-medium">Single colour</dt>
            <dd className="m-0">One colour for every chart of one measure. Charts that compare several series still use the palette.</dd>
          </div>
        </dl>
        {a.color_mode === "single" && (
          <Field label="The single colour" hint={a.single_color ? undefined : "Using the palette's own first colour."}>
            <ColorField label="Single colour" value={a.single_color} fallback={single.primary} disabled={disabled} onChange={(hex) => controller.patch({ single_color: hex })} onClear={() => controller.patch({ single_color: null })} clearLabel="Use the palette's" />
          </Field>
        )}
      </div>

      <div className="flex flex-col gap-2.5">
        <SectionTitle hint={samples === SAMPLE_PREVIEWS ? "Shown on sample data." : "Shown on this dashboard's own data."}>Palette</SectionTitle>
        <div role="radiogroup" aria-label="Palette" className={cn("grid gap-2.5", narrow ? "grid-cols-1" : "grid-cols-2")} data-palette-gallery="">
          {PALETTES.map((p) => {
            const selected = palette.kind === "preset" && palette.id === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                data-palette-card={p.id}
                title={p.description}
                onClick={() => setPalette({ kind: "preset", id: p.id })}
                className={cn(
                  "ui-focus flex min-w-0 flex-col gap-2 rounded-card border bg-surface p-3 text-left transition-colors",
                  selected ? "border-brand-ink ring-1 ring-brand-ink" : "border-border hover:border-border-strong"
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-ui font-medium text-text">{p.name}</span>
                  {selected && <span className="inline-flex shrink-0 items-center gap-1 text-caption font-medium text-brand-ink"><CheckIcon size={12} /> In use</span>}
                </span>
                <Swatches colors={p[mode]} />
                <PalettePreview appearance={a} palette={{ kind: "preset", id: p.id }} samples={samples} width={previewWidth} />
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2.5" data-brand-palette="">
        <SectionTitle hint="One colour in, ten that go with it out - spaced around the colour wheel and checked to stay distinguishable.">From your brand colour</SectionTitle>
        <ColorField label="Brand colour" value={brandDraft} fallback={brandHex} disabled={disabled} onChange={setBrandDraft} />
        <div className={cn("flex flex-col gap-2 rounded-card border p-3", brandActive ? "border-brand-ink ring-1 ring-brand-ink" : "border-border")}>
          <div className="flex items-center justify-between gap-2">
            <Swatches colors={brandResolved.slots} />
            {brandActive && <span className="inline-flex shrink-0 items-center gap-1 text-caption font-medium text-brand-ink"><CheckIcon size={12} /> In use</span>}
          </div>
          {brandResolved.primary !== brandHex && (
            <p className="text-caption text-muted" data-brand-moved="">
              {brandHex} is drawn as {brandResolved.primary} on charts, so it stays visible on the {mode} surface. Your hue is kept.
            </p>
          )}
          <PalettePreview appearance={a} palette={brandPalette} samples={samples} width={narrow ? 250 : 430} />
          <Button variant={brandActive ? "secondary" : "primary"} disabled={disabled || brandActive} onClick={() => setPalette(brandPalette)} className="self-start" data-brand-apply="">
            {brandActive ? "Applied" : "Apply this palette"}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <SectionTitle hint="Up to ten of your own colours, in the order they are used.">Custom palette{palette.kind === "custom" ? " · in use" : ""}</SectionTitle>
        <CustomPaletteEditor value={palette.kind === "custom" ? palette : null} mode={mode} disabled={disabled} active={palette.kind === "custom"} onApply={(p) => setPalette(p)} />
      </div>

      {controller.kind === "dashboard" && (
        <>
          <div className="flex flex-col gap-2.5">
            <SectionTitle hint="A pinned colour wins over the automatic one, everywhere this value appears.">Pinned values</SectionTitle>
            <PinnedList controller={controller} />
          </div>
          <div className="flex flex-col gap-2.5">
            <SectionTitle hint="Colours are given in the order values first appear, largest first, and never move. Click a key to pin another colour.">Colours in use</SectionTitle>
            <ValueColors controller={controller} />
            <Button variant="secondary" disabled={disabled} onClick={() => setConfirmReset(true)} className="self-start" data-reset-colors="">Reset colours</Button>
          </div>
          <ConfirmDialog
            open={confirmReset}
            title="Reset the colours of this dashboard?"
            confirmLabel="Reset colours"
            onCancel={() => setConfirmReset(false)}
            onConfirm={() => { setConfirmReset(false); controller.resetColors?.(); }}
          >
            Pinned colours are removed and every value is given a colour again, largest first. The palette stays as it is.
          </ConfirmDialog>
        </>
      )}
    </div>
  );
}

// ---- Brand -------------------------------------------------------------------

function BrandSection({ controller, extra }: { controller: AppearanceController; extra?: ReactNode }) {
  const disabled = !controller.canEdit;
  const { primary, accent } = controller.brand;
  return (
    <div className="flex flex-col gap-6" data-appearance-section="brand">
      <div className="flex flex-col gap-3">
        <SectionTitle hint={controller.kind === "kit" ? "Buttons, links and active filters on every dashboard that follows this kit." : "Buttons, links and active filters on this dashboard - not the chart palette (that is under Colours)."}>Brand colours</SectionTitle>
        <Field label="Primary">
          <ColorField label="Brand primary" value={primary} fallback={resolvePalette(DEFAULT_STYLE.palette, "light").primary} disabled={disabled} onChange={(hex) => controller.setBrand({ primary: hex })} onClear={() => controller.setBrand({ primary: null })} />
        </Field>
        <Field label="Accent">
          <ColorField label="Brand accent" value={accent} fallback={PALETTES[0].light[2]} disabled={disabled} onChange={(hex) => controller.setBrand({ accent: hex })} onClear={() => controller.setBrand({ accent: null })} />
        </Field>
      </div>
      {extra}
    </div>
  );
}

// ---- Layout & type -------------------------------------------------------------

function LayoutSection({ controller }: { controller: AppearanceController }) {
  const a = controller.appearance;
  const disabled = !controller.canEdit;
  const font = fontPreset(a.font);
  useEffect(() => { ensureFont(a.font); }, [a.font]);
  return (
    <div className="flex flex-col gap-6" data-appearance-section="layout">
      <div className="flex flex-col gap-2.5">
        <SectionTitle hint="Compact fits more rows of blocks on a screen: shorter rows, tighter gaps.">Density</SectionTitle>
        <SegmentedControl<Density> ariaLabel="Density" fullWidth disabled={disabled} value={a.density} onChange={(v) => controller.patch({ density: v })} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} />
      </div>
      <div className="flex flex-col gap-2.5">
        <SectionTitle hint="Cards, tiles, buttons and chips.">Corner radius</SectionTitle>
        <SegmentedControl<Radius>
          ariaLabel="Corner radius"
          fullWidth
          disabled={disabled}
          value={a.radius}
          onChange={(v) => controller.patch({ radius: v })}
          options={(Object.keys(RADIUS_PRESETS) as Radius[]).map((r) => ({
            value: r,
            label: RADIUS_PRESETS[r].label,
            icon: <span aria-hidden="true" className="inline-block h-3.5 w-3.5 border-l-[1.5px] border-t-[1.5px] border-current" style={{ borderTopLeftRadius: Math.min(9, RADIUS_PRESETS[r].card) }} />,
          }))}
        />
      </div>
      <div className="flex flex-col gap-2.5">
        <SectionTitle hint="Loaded only for dashboards that use it; a system font stands in if it cannot be fetched.">Font</SectionTitle>
        <Select aria-label="Font" disabled={disabled} value={font.id} onChange={(e) => controller.patch({ font: e.target.value })} options={FONT_PRESETS.map((f) => ({ value: f.id, label: `${f.name} - ${f.note}` }))} data-font-select="" />
        <div className="rounded-ctl border border-border bg-subtle/60 px-3 py-2.5" style={{ fontFamily: font.stack }} data-font-sample={font.id}>
          <div className="text-section font-semibold text-text">Revenue by market segment</div>
          <div className="text-ui text-secondary tabular-nums">1,234,567.89 · 42.7M · 37.0% · Online TA, Offline TA/TO</div>
        </div>
      </div>
    </div>
  );
}

// ---- Numbers -------------------------------------------------------------------

const SAMPLE_NUMBER = 42722889;
const CURRENCY: ValueFormat = { format: "currency", decimals: null, inferred: false, currency: "" };
const NUMBER: ValueFormat = { format: "number", decimals: null, inferred: false, currency: "" };
const PERCENT: ValueFormat = { format: "percent", decimals: 1, inferred: false, currency: "" };

function NumbersSection({ controller }: { controller: AppearanceController }) {
  const a = controller.appearance;
  const disabled = !controller.canEdit;
  const settings = { locale: !a.locale || a.locale === "auto" ? undefined : a.locale, currency: a.currency || "USD" };
  const currencies = CURRENCY_CHOICES.some((c) => c.code === a.currency) ? CURRENCY_CHOICES : [{ code: a.currency, name: a.currency }, ...CURRENCY_CHOICES];
  const locales = LOCALE_CHOICES.some((l) => l.tag === a.locale) ? LOCALE_CHOICES : [{ tag: a.locale, name: a.locale }, ...LOCALE_CHOICES];
  const rows: [string, string, string][] = [
    ["A KPI in currency", formatValueWith(settings, SAMPLE_NUMBER, NUMBER, "full"), formatValueWith(settings, SAMPLE_NUMBER, CURRENCY, "auto")],
    ["A table cell in currency", "1234567.5", formatValueWith(settings, 1234567.5, { ...CURRENCY, decimals: 2 }, "full")],
    ["An axis tick", "6500", formatValueWith(settings, 6500, NUMBER, "compact")],
    ["A rate", "0.3704", formatValueWith(settings, 0.3704, PERCENT, "full")],
  ];
  return (
    <div className="flex flex-col gap-6" data-appearance-section="numbers">
      <div className="flex flex-col gap-3">
        <SectionTitle hint='Used wherever a block&apos;s number format is "Currency".'>Currency</SectionTitle>
        <Select aria-label="Currency" disabled={disabled} value={a.currency} onChange={(e) => controller.patch({ currency: e.target.value })} options={currencies.map((c) => ({ value: c.code, label: `${c.code} - ${c.name}` }))} data-currency-select="" />
      </div>
      <div className="flex flex-col gap-3">
        <SectionTitle hint="Decimal and thousands separators, where the currency symbol sits, and how large numbers are shortened.">Number locale</SectionTitle>
        <Select aria-label="Number locale" disabled={disabled} value={a.locale || "auto"} onChange={(e) => controller.patch({ locale: e.target.value })} options={locales.map((l) => ({ value: l.tag, label: l.tag === "auto" ? l.name : `${l.name} (${l.tag})` }))} data-locale-select="" />
      </div>
      <div className="flex flex-col gap-2">
        <SectionTitle>Sample</SectionTitle>
        <div className="rounded-ctl border border-border bg-subtle/60 px-3 py-2.5 text-ui tabular-nums" data-number-sample="">
          <div className="text-body font-semibold text-text" data-number-sample-headline="">{rows[0][1]} → {rows[0][2]}</div>
          <dl className="m-0 mt-1.5 flex flex-col gap-0.5 text-caption">
            {rows.slice(1).map(([what, from, to]) => (
              <div key={what} className="flex items-baseline justify-between gap-3">
                <dt className="text-muted">{what}</dt>
                <dd className="m-0 text-secondary"><span className="text-muted">{from} → </span>{to}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}

// ---- Public link ----------------------------------------------------------------

function PublicSection({ controller }: { controller: AppearanceController }) {
  const a = controller.appearance;
  const disabled = !controller.canEdit;
  const [note, setNote] = useState(a.footer_note || "");
  const typed = useRef(false);
  useEffect(() => { if (!typed.current) setNote(a.footer_note || ""); typed.current = false; }, [a.footer_note]);
  return (
    <div className="flex flex-col gap-6" data-appearance-section="public">
      <div className="flex flex-col gap-2.5">
        <SectionTitle hint="What a visitor of the published link sees first. They can still switch with the theme button.">Default theme</SectionTitle>
        <SegmentedControl<ThemeDefault>
          ariaLabel="Default theme of the public link"
          fullWidth
          disabled={disabled}
          value={a.theme_default}
          onChange={(v) => controller.patch({ theme_default: v })}
          options={[{ value: "auto", label: "Visitor's own" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
        />
      </div>
      <div className="flex flex-col gap-2.5">
        <SectionTitle hint="One line under the dashboard, here and on the published link.">Footer note</SectionTitle>
        <Field hint={`${note.length} of 160 characters`}>
          <Input
            aria-label="Footer note"
            maxLength={160}
            disabled={disabled}
            placeholder="Confidential - Acme Hotels"
            value={note}
            onChange={(e) => { typed.current = true; setNote(e.target.value); controller.patch({ footer_note: e.target.value }); }}
            data-footer-note-input=""
          />
        </Field>
      </div>
    </div>
  );
}

// ---- the sheet -----------------------------------------------------------------

export function AppearanceSheet({ open, onClose, controller, samples = SAMPLE_PREVIEWS, registry, brandExtra, subjectName, notice, initialSection = "colors" }: AppearanceSheetProps) {
  const [section, setSection] = useState<SectionId>(initialSection);
  const narrow = useIsNarrow(560);
  const mode = useThemeMode();
  const begin = controller.begin;
  useEffect(() => {
    if (open) begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const a = controller.appearance;
  // The sheet is drawn outside the dashboard (a portal): its own swatches
  // and previews get the same theme the dashboard has, registry included.
  const themed = useMemo<DashboardAppearance>(() => (registry ? { ...a, assignments: registry } : a), [a, registry]);
  const kit = controller.kind === "kit";
  const source = kit
    ? null
    : a.customized
      ? "Customised for this dashboard"
      : a.legacy_brand
        ? "Using this dashboard's own brand colour"
        : a.source === "workspace"
          ? `Using workspace brand${controller.workspaceName ? ` · ${controller.workspaceName}` : ""}`
          : "Using the GD360 defaults";

  return (
    <Sheet
      open={open}
      onClose={onClose}
      scrim={false}
      size="md"
      id="appearance-sheet"
      title={kit ? "Workspace brand kit" : "Appearance"}
      subtitle={kit ? `${subjectName ? `${subjectName} · ` : ""}What every dashboard of this workspace starts from, and follows until it is customised.` : "How this dashboard looks - here, on its pages, and on the published link."}
      headerExtra={
        <div className="flex flex-col gap-2.5">
          {notice}
          {source && (
            <div className="flex flex-wrap items-center gap-2" data-appearance-source={a.customized ? "dashboard" : a.source}>
              <StatusPill tone={a.customized ? "neutral" : "brand"} icon="dot">{source}</StatusPill>
              {a.customized && controller.resetToWorkspace && (
                <button type="button" disabled={!controller.canEdit} onClick={controller.resetToWorkspace} className="ui-focus rounded px-0.5 text-caption font-medium text-brand-ink hover:underline disabled:text-faint" data-reset-workspace="">
                  {controller.workspaceKit ? "Reset to workspace brand" : "Reset to the defaults"}
                </button>
              )}
            </div>
          )}
          {!controller.canEdit && <StatusPill tone="neutral" icon="glyph">{kit ? "Only the workspace owner can change the brand kit" : "You can view this, not change it"}</StatusPill>}
          {narrow ? (
            <Select aria-label="Section" value={section} onChange={(e) => setSection(e.target.value as SectionId)} options={SECTIONS.map((s) => ({ value: s.id, label: s.label }))} data-appearance-sections="" />
          ) : (
            <SegmentedControl<SectionId> ariaLabel="Section" fullWidth size="sm" value={section} onChange={setSection} options={SECTIONS.map((s) => ({ value: s.id, label: s.label }))} />
          )}
        </div>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-3" data-appearance-footer="">
          <span className="min-w-0"><SaveStatus state={controller.saveState} error={controller.saveError} onRetry={controller.retry} /></span>
          <span className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" disabled={!controller.dirty || !controller.canEdit} onClick={controller.revert} data-appearance-revert="">Revert changes</Button>
            <Button variant="primary" onClick={onClose} data-appearance-done="">Done</Button>
          </span>
        </div>
      }
    >
      <ChartThemeProvider appearance={themed} numbers={false} onPin={controller.canEdit ? controller.pin : undefined}>
        {section === "colors" && <ColoursSection controller={controller} samples={samples} mode={mode} narrow={narrow} />}
        {section === "brand" && <BrandSection controller={controller} extra={brandExtra} />}
        {section === "layout" && <LayoutSection controller={controller} />}
        {section === "numbers" && <NumbersSection controller={controller} />}
        {section === "public" && <PublicSection controller={controller} />}
      </ChartThemeProvider>
    </Sheet>
  );
}

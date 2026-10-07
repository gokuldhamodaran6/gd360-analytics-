import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useThemeMode } from "../../api/ThemeContext";
import { Button, Input, Popover, cn } from "../../ui";
import { releaseNumberSettings, setNumberSettings } from "../format";
import { GRID_METRICS, ensureFont, scopeStyle, type ColorPin, type ColorRegistry, type DashboardAppearance, type GridMetrics } from "./appearance";
import { DEFAULT_CHART_THEME, MEASURES_KEY, buildChartTheme, localRegistry, valueKey, type ChartTheme } from "./chartTheme";
import { parseHex } from "./palettes";

// 2026-10-07 (identity-colour round): the React side of the chart theme.
//
//   <ChartThemeProvider appearance registry>   around a dashboard (the
//       shell does it), a proposal preview, the chat workspace
//   useChartTheme()                           what every renderer calls
//   useGridMetrics()                          row height + gap of the 12-
//                                             column grid for the density
//   useDashboardScope(appearance)             the root element's style
//                                             (corner radius, font) and
//                                             the font's stylesheet
//   <ColorSwatch>                             the mark beside a name: a
//                                             legend key, a chip's dot, a
//                                             table cell's dot. While the
//                                             owner edits, it is a button
//                                             that opens the pin popover.
//
// Without a provider useChartTheme() returns DEFAULT_CHART_THEME - the
// kit's tokens, exactly what was drawn before this round.

const ThemeCtx = createContext<ChartTheme>(DEFAULT_CHART_THEME);
const MetricsCtx = createContext<GridMetrics>(GRID_METRICS.comfortable);

export function useChartTheme(): ChartTheme {
  return useContext(ThemeCtx);
}

export function useGridMetrics(): GridMetrics {
  return useContext(MetricsCtx);
}

export type ChartThemeProviderProps = {
  appearance?: Partial<DashboardAppearance> | null;
  // The colour registry of the latest run (see useDashboardRun().colors).
  registry?: ColorRegistry | null;
  // No dashboard to keep a registry on (the chat workspace): assign in the
  // browser, remembered per scope ("ds:<datasource id>").
  localScope?: string | null;
  // The owner is editing: a swatch pins its value's colour through this.
  onPin?: ChartTheme["pin"];
  // False for a preview nested inside a dashboard (a palette card in the
  // Appearance sheet): colours only, the page's numbers stay the page's.
  numbers?: boolean;
  // Force a mode (a light / dark palette specimen); default: the page's.
  mode?: "light" | "dark";
  // A theme already built by useChartThemeValue (a page that also needs
  // it outside this subtree); the other colour props are then ignored.
  theme?: ChartTheme;
  children: ReactNode;
};

/** The theme a ChartThemeProvider with these props would provide - for a
 *  page that needs it in its own body as well (pass it back as `theme`). */
export function useChartThemeValue({ appearance, registry, localScope, onPin, mode: forcedMode }: Omit<ChartThemeProviderProps, "children" | "numbers" | "theme">): ChartTheme {
  const pageMode = useThemeMode();
  const mode = forcedMode ?? pageMode;
  const local = useMemo(() => (localScope ? localRegistry(localScope) : null), [localScope]);
  return useMemo(
    () => buildChartTheme({ appearance, mode, registry, local, onPin }),
    [appearance, mode, registry, local, onPin]
  );
}

export function ChartThemeProvider({ appearance, registry, localScope, onPin, numbers = true, mode, theme: given, children }: ChartThemeProviderProps) {
  const built = useChartThemeValue({ appearance, registry, localScope, onPin, mode });
  const theme = given ?? built;
  // Number settings are in force before any child formats a value, and
  // released when this dashboard leaves the screen.
  if (numbers) setNumberSettings(theme.number);
  const numberSettings = theme.number;
  useEffect(() => {
    if (!numbers) return;
    return () => releaseNumberSettings(numberSettings);
  }, [numbers, numberSettings]);
  const metrics = GRID_METRICS[appearance?.density === "compact" ? "compact" : "comfortable"];
  return (
    <ThemeCtx.Provider value={theme}>
      <MetricsCtx.Provider value={metrics}>{children}</MetricsCtx.Provider>
    </ThemeCtx.Provider>
  );
}

/** Style + data attributes for the element a dashboard is drawn in, and
 *  the stylesheet of its font (fetched only when the font is not Geist). */
export function useDashboardScope(appearance: Partial<DashboardAppearance> | null | undefined): { style: CSSProperties; attrs: Record<string, string> } {
  const radius = appearance?.radius ?? "soft";
  const font = appearance?.font ?? "geist";
  const density = appearance?.density ?? "comfortable";
  useEffect(() => {
    ensureFont(font);
  }, [font]);
  return useMemo(
    () => ({
      style: scopeStyle({ radius, font, density }) as CSSProperties,
      attrs: { "data-density": density, "data-radius": radius, "data-font": font },
    }),
    [radius, font, density]
  );
}

// ---- the swatch ------------------------------------------------------------

export type SwatchShape = "square" | "dot" | "line";

function SwatchMark({ color, shape, size }: { color: string; shape: SwatchShape; size: number }) {
  if (shape === "line") return <span aria-hidden="true" className="inline-block shrink-0 rounded-full" style={{ width: size + 2, height: 2, background: color }} />;
  return <span aria-hidden="true" className={cn("inline-block shrink-0", shape === "dot" ? "rounded-full" : "rounded-[3px]")} style={{ width: size, height: size, background: color }} />;
}

/** The pin panel: the palette's slots, a custom hex, Reset. */
export function ColorPinPanel({ column, value, label, close }: { column: string; value: string; label: string; close: () => void }) {
  const theme = useChartTheme();
  const pin = theme.pinOf(column, value);
  const current = theme.colorFor(column, value);
  const [draft, setDraft] = useState(typeof pin === "string" ? pin : "");
  const hex = parseHex(draft);
  // Focus lands on the slot in use (the group's one tab stop), not on the
  // first button: Enter then keeps the colour, the arrow keys move from it.
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('button[data-pin-slot][tabindex="0"]')?.focus();
  }, []);
  const apply = (next: ColorPin | null) => {
    theme.pin?.(column, value, next);
    close();
  };
  // Arrow keys walk the slots like a radio group.
  const onSlotKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button[data-pin-slot]");
    if (!buttons?.length) return;
    buttons[(i + delta + buttons.length) % buttons.length].focus();
  };
  return (
    <div ref={panel} className="flex w-[232px] flex-col gap-2.5 p-3" data-color-pin-panel="">
      <div className="min-w-0">
        <div className="truncate text-ui font-medium text-text" title={label}>{label}</div>
        <div className="text-caption text-muted">{column === MEASURES_KEY ? "This measure's colour on every chart" : "This value's colour on every chart and page"}</div>
      </div>
      <div role="radiogroup" aria-label="Palette colours" className="grid grid-cols-5 gap-1.5">
        {theme.slots.map((color, i) => {
          const selected = pin === i || (pin === null && current === color);
          return (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`Palette colour ${i + 1}`}
              title={`Palette colour ${i + 1}`}
              data-pin-slot={i}
              tabIndex={selected || (i === 0 && !theme.slots.some((c, j) => pin === j || (pin === null && current === c))) ? 0 : -1}
              onClick={() => apply(i)}
              onKeyDown={(e) => onSlotKey(e, i)}
              className={cn("ui-focus relative h-8 rounded-[6px] border", selected ? "border-text" : "border-transparent hover:border-border-strong")}
            >
              <span aria-hidden="true" className="absolute inset-[3px] rounded-[4px]" style={{ background: color }} />
            </button>
          );
        })}
      </div>
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (hex) apply(hex);
        }}
      >
        <span aria-hidden="true" className="h-9 w-9 shrink-0 rounded-ctl border border-border" style={{ background: hex ?? "transparent" }} />
        <Input aria-label="Custom colour (hex)" placeholder="#0f5c46" value={draft} maxLength={7} mono invalid={draft.trim() !== "" && !hex} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" variant="secondary" disabled={!hex}>Use</Button>
      </form>
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption text-muted">{pin === null ? "Assigned automatically" : "Pinned by you"}</span>
        <Button variant="ghost" disabled={pin === null} onClick={() => apply(null)} data-pin-reset="">Reset</Button>
      </div>
    </div>
  );
}

export type ColorSwatchProps = {
  column: string;
  // The raw value (or its registry key) this swatch stands for.
  value: unknown;
  // What a screen reader and the popover call it.
  label: string;
  color: string;
  shape?: SwatchShape;
  size?: number;
  className?: string;
  style?: CSSProperties;
  // Never interactive (a swatch inside another button).
  inert?: boolean;
  // The mark is already drawn underneath (an SVG legend key): be only the
  // button over it - no second mark, no fill that would hide the first.
  ghost?: boolean;
};

/** A colour mark. While the dashboard's owner is editing (theme.pin is
 *  set) it is a button that opens the pin popover; otherwise a decorative
 *  mark - the name beside it is the identity. */
export function ColorSwatch({ column, value, label, color, shape = "square", size = 10, className, style, inert = false, ghost = false }: ColorSwatchProps) {
  const theme = useChartTheme();
  const key = valueKey(value);
  if (!theme.pin || inert) {
    return <span className={cn("inline-flex shrink-0 items-center", className)} style={style} data-color-swatch={column} data-swatch-value={key}><SwatchMark color={color} shape={shape} size={size} /></span>;
  }
  return (
    <Popover
      portal
      align="start"
      autoFocus={false}
      ariaLabel={`Colour of ${label}`}
      className={className}
      trigger={(api) => (
        <button
          type="button"
          data-popover-trigger=""
          data-color-swatch={column}
          data-swatch-value={key}
          data-pin-trigger=""
          aria-label={`Change the colour of ${label}`}
          title="Change colour"
          style={style}
          className={cn("ui-focus inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px]", ghost ? "align-top hover:ring-1 hover:ring-border-strong" : "hover:bg-subtle")}
          {...api.props}
          onClick={(e) => { e.stopPropagation(); api.toggle(); }}
        >
          {ghost ? <span aria-hidden="true" className="block" style={{ width: size, height: size }} /> : <SwatchMark color={color} shape={shape} size={size} />}
        </button>
      )}
    >
      {({ close }) => <ColorPinPanel column={column} value={key} label={label} close={close} />}
    </Popover>
  );
}

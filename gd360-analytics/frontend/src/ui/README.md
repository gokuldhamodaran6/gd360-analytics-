# GD360 UI kit (`src/ui/`)

The design system from `System.dc.html` / `DESIGN_BRIEF.md` (2026-10-06) in
code. One file per component, named exports, typed props, `forwardRef` where
a DOM ref matters, Tailwind classes over the tokens below, light + dark via the
same tokens. Import everything from `src/ui` (`import { Button } from "../ui"`).

## Components

| Group | Components (file) |
| --- | --- |
| Buttons | `Button` (`variant` primary/secondary/ghost/danger, `size` md 36 / lg 40, `loading`, `leadingIcon`), `IconButton` (`aria-label` required) |
| Forms | `Input`, `NumberInput`, `Select` (native), `MenuSelect` + `Listbox` (popover listbox), `SearchInput`, `Textarea`, `Checkbox`, `Switch`, `Label`, `Field` (label / hint / error state), `FieldHint` |
| Filters | `SegmentedControl` (arrow keys, 36 px), `FilterChip`, `ChipGroup`, `MultiSelect` (`options`/`value`/`onChange`/`onSearch`/`loading`, "+N" overflow, Clear), `MultiSelectChips` (chip / field / chips variants), `CheckboxList` (counts, Select all / Clear), `OptionSearch` (search → `{value, count}` rows + "+N more"), `DateRangePicker` (`value: {from, to}`, presets, two-month grid, `format="months"` for "Jul 2015 – Aug 2017"), `RangeSlider` (two thumbs, pointer + keyboard), `SavedViewSelect` (Save current view… / rename / delete callbacks), `ResetFiltersLine`, `FilterRail` + `FilterRailSection` (260 px rail) |
| Cards & charts | `Card`, `ChartCard` (title / subtitle / toolbar / body / footer; `computed={{provider, rows, durationMs, cached}}` renders `ComputedIn` as the footer), `ComputedIn` ("Computed in BigQuery · 119,386 rows · 0.8 s"), `ComputedFooter` (older name), `KpiTile` + `DeltaPill` (`delta: {pct | abs | label, direction, good, caption, captionShort}` — glyph + text, never colour alone; anatomy is always label → value → one delta line → sparkline, and a strip passes `reserveDeltaRow` so a tile with no delta keeps the line's height and the sparklines align), `Sparkline` (120×32 SVG, 7–30 points) |
| Badges | `StatusPill` (good / warning / danger / neutral, icon + text), `Badge` (new / provider / exact / sample), `ProviderBadge`, `Tag`, `Avatar` |
| Overlays | `Popover` (anchored; outside click + Escape via `src/lib/useExclusiveOpen.ts`; `portal` renders the panel into `<body>`, fixed and viewport-aware, for menus that open from inside a clipped or transformed box), `Sheet` (420 px right panel), `ConfirmDialog` (the kit's confirm - an `alertdialog` that opens on Cancel; never `window.confirm`), `Tooltip`, `Skeleton` (block / text / tile) |
| Tables | `TableFrame` (= `DataTableFrame`: sticky header, no zebra, row hover, `overflow: auto`), `TableFooter` (= `PaginationFooter`: "1–50 of 75,166 · Load 50 more") |
| Chrome | `TopBar` (+ `Breadcrumb`, `TopBarSearch`) — `src/components/TopNav.tsx` is built on it; the 56 px icon rail is `src/components/AppSidebar.tsx` |
| Icons | `Icons.tsx`: `GridIcon ChartIcon BarChartIcon DatabaseIcon SettingsIcon SearchIcon FilterIcon CalendarIcon ChevronIcon ChevronDown/Up/Left/RightIcon CloseIcon CheckIcon WarningIcon InfoIcon MoreIcon ExternalIcon DownloadIcon SparkleIcon CommentIcon SqlIcon` + the app's other glyphs (file, table, clock, user, trash, edit, …). 24-unit viewBox, 1.8 stroke, `currentColor`. |
| Tokens | `tokens.ts`: `SERIES` (6 chart colours, re-exported from `src/lib/chartStyle.ts` `SIGNATURE_COLORS`), `SINGLE_SERIES`, `SEQUENTIAL`, `SEQUENTIAL_DARK`, `BRAND`, `STATUS`, `LIGHT`, `DARK`, `GRIDLINE`, `seriesColor(i, n)`, `cssColor(token, fallback)` |

Helpers: `cn()` class joiner, `tones.ts` (`TONE_CLASSES` for status fills), `dateUtils` (ISO date helpers, `formatRange`).

## Tokens

CSS variables in `src/index.css` as RGB triplets (`--color-x: r g b`), registered in
`tailwind.config.js` so `bg-x`, `text-x`, `border-x` (with `/opacity`) work. Dark is the
bare `:root`, light is `:root[data-theme="light"]`.

| Token | Tailwind | Light | Use |
| --- | --- | --- | --- |
| `--color-base` | `base` | `#f6f6f3` | page ground |
| `--color-surface` | `surface` | `#ffffff` | cards, bars, inputs |
| `--color-surface2` | `surface2` | `#f4f4f1` | (pre-existing) |
| `--color-subtle` | `subtle` | `#f1f1ed` | table heads, gridlines, chip fills |
| `--color-border` | `border` | `#e3e3de` | 1 px everywhere |
| `--color-border-strong` | `border-strong` | `#d4d4ce` | hover borders |
| `--color-text` | `text` | `#161615` | headings, body, numbers |
| `--color-secondary` | `secondary` | `#4f4f4b` | supporting copy |
| `--color-muted` | `muted` | `#6f6f6a` | labels, captions, icons |
| `--color-faint` | `faint` | `#a8a8a4` | disabled, out-of-month days |
| `--color-primary` | `primary` | `#0f5c46` | brand: primary button, active, 1-series |
| `--color-accent` | `accent` | `#2d8267` | link hover, focus ring |
| `--color-tint` / `--color-tint-border` | `tint` / `tint-border` | `#e8f3ee` / `#c3dfd3` | active chips, good banners |
| `--color-brand-ink` | `brand-ink` | `#0f5c46` | text/icon on tint (accent in dark) |
| `--color-good[-fill/-border]` | `good`, `good-fill`, `good-border` | `#0f5c46` on `#e8f3ee` | status |
| `--color-warning[-fill/-border]` | `warning`, … | `#b45309` on `#fdf1e3` | status |
| `--color-danger[-fill/-border]` | `danger`, … | `#b42318` on `#fdecea` | status |
| `--color-series-1..6` | `series-1..6` | blue, orange, aqua, yellow, magenta, green | chart series, same in dark |
| `--color-seq-1..6` | `seq-1..6` | `#e8f3ee` → `#0f4a38` | sequential ramp (reversed in dark) |

Scale tokens: `--radius-ctl` 8, `--radius-card` 12, `--radius-pill` 999 (`rounded-ctl`,
`rounded-card`); `--space-1..8` (4 → 32); type `text-caption` 12, `text-ui` 13.5,
`text-body` 14, `text-section` 16, `text-title` 20, `text-kpi` 28 (`tracking-caps`
0.04em for uppercase labels); heights `h-ctl` 36, `h-ctl-lg` 40, `h-chip` 32,
`h-topbar` 56; widths `w-rail` 56, `w-filter-rail` 260, `w-sheet` 420; shadows
`shadow-card`, `shadow-pop`. Kit-only CSS classes: `.ui-focus`, `.ui-focus-inset`,
`.ui-shimmer`, `.ui-spinner`, `.ui-select`, `.ui-range-input`, `.ui-number`,
`.ui-sheet-panel`.

Pre-existing tokens (`--dash-accent-0..5`, `.dash-card`, `--glow-*`, …) are untouched.

## Test

`gd360-wh-test/uikit.test.tsx` (jsdom, run with `node build-any.mjs <frontend> uikit.test.tsx`)
mounts every component and asserts keyboard behaviour, controlled callbacks and
that the run produces no React warnings.

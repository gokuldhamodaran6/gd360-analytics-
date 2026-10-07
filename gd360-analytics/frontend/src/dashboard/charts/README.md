# GD360 charts

Every chart a dashboard, a canvas cell, a published link, a file dashboard and the
chat workspace draws comes from this folder. This file documents each chart type:
when to use it, the data shape it needs, and its options. It is also the list the
model prompts carry: `backend/app/services/chart_recommender.py` (`CHART_TYPES`,
`chart_type_guide()`) and `recommend.ts` (`CHART_TYPES`) hold the same 23 entries,
in the same order, with the same wording. Change one, change all three.

## How a chart is chosen

One deterministic function decides: `recommend(shape)` (Python:
`chart_recommender.recommend`, TypeScript: `recommend.ts`, tested against each
other on a shared case table). It takes the SHAPE of a result, never its topic:

| Shape | Chart | Why |
|---|---|---|
| a binned numeric column | histogram | a distribution |
| no grouping, one measure and a target | bullet | a number against a target |
| no grouping | KPI tile | one headline number |
| a date, one measure | line | change over time |
| a date, several measures | line (aligned panels when the scales differ by more than 8x) | never two y-axes |
| a date and a category with up to 6 values | line, one per value | few series compare on one axis |
| a date and a category with more than 6 values | heatmap | too many lines to tell apart |
| a country column, more than 6 countries, 80%+ of values resolve | map (with its ranked list) | geography is the question |
| one category, 3-6 values, an additive measure, no negatives | donut | share of a whole |
| one category, 7-30 values | horizontal bars | a ranking; long names fit |
| one category, 31-200 values | horizontal bars of the largest | the tail folds |
| one category, more than 200 values | table | more than a chart reads |
| one ordered column (a year, a weekday, a bucket) | bars, or a line past 30 | the order is the axis |
| one category, two measures, 6+ items | scatter | a relationship |
| one category, three or four measures, up to 12 items | bar panels | compare each measure |
| two categories, one measure, up to 2,500 cells | heatmap | a matrix |
| two categories, several measures | pivot table | numbers by row and column |
| anything else | table | exact values |

Ties go to the plainer chart. The function returns a chart type and a one-line
reason ("Country column with 175 values → map"); the chart gallery shows it as
"Recommended". A model may SUGGEST a type; `resolve(shape, hint)` keeps the
suggestion only when the shape can be drawn as it and no strong rule says
otherwise, and logs every override. `fits(shape, type)` says whether a shape can
be drawn as a type and, when not, what the type needs ("needs a country column") -
that sentence is the disabled tile's text in the gallery and in "Swap to".

## The chart types

`chart_type` is stored on the block (`config.chart_type`); a donut is its own
block type. "Dimensions" are group-by columns, date parts or a time bucket;
"measures" are aggregations.

| Type | Use it to | Data shape | Options |
|---|---|---|---|
| `bar` | compare one measure across a few categories or ordered buckets | a category or a date; 1+ measures (several measures of one scale group side by side, of different scales become panels) | `color_mode` (single / by value), `stacked` via `stacked_bar` |
| `horizontal_bar` | a ranking of 7-30 named categories (long names fit) | one category; 1+ measures | sorted by the query's order; the tail past 30 folds into "Other" when the measure adds up |
| `line` | one or a few measures over time | a date (or an ordered column); up to 6 series | `forecast`; a partial first / last period is drawn dashed |
| `area` | one measure over time where the volume matters | a date or an ordered column | `forecast` |
| `stacked_bar` | a total split into up to 6 parts across categories or periods | two dimensions and a measure, or one dimension and several additive measures | segments keep a 2px gap; the total is in the tooltip |
| `stacked_bar_100` | how the MIX changes across categories or periods (shares, not totals) | as `stacked_bar` | axis 0-100%; the tooltip gives the share and the raw value |
| `stacked_area` | a total and its parts over time | a date and a dimension (or several additive measures) | - |
| `stacked_area_100` | how the mix shifts over time | a date and a dimension | axis 0-100% |
| `combo` | two measures of different scale over one axis - drawn as aligned panels, never two y-axes | one axis, two or more measures | bars in the first panel, lines in the ones below, one shared x axis |
| `donut`, `pie` | share of a whole across 3-6 categories | one category, one additive measure | centre total; slices past 6 fold into "Other" |
| `treemap` | part-to-whole across many categories (one or two levels) | one or two categories, one additive measure | at most 24 tiles a level, the rest fold into "Other"; labels only where they fit |
| `map` | one measure by a country column with more than 6 countries | one country column (names, ISO-2 or ISO-3 codes), one measure | 5-7 colour classes; equal steps, or quantiles when one class would hold most countries (the legend says which); diverging around zero when values straddle it; countries with no data are a neutral fill; small territories are dots; a ranked list beside the map; "Zoom to data" / "World"; values that match no country are counted under the map |
| `heatmap` | one measure by two dimensions (segment x month, weekday x month) | two dimensions (a date bucket or date part counts), one measure | value labels when every cell has room; `Totals` toggle (additive measures); ordered axes keep their order, named ones sort by total |
| `pivot` | several measures by a row dimension and a column dimension | two dimensions, 1+ measures | `Shade` (first measure) and `Totals` toggles; CSV is the export |
| `scatter` | the relationship between two measures, one point per category | one category, two measures (y = first, x = second) | least-squares trend line with r-squared when there are 6+ points (`config.trend: false` hides it); labels only on outliers, placed without overlap |
| `bubble` | two measures per category with a third as size | one category, three measures | size legend; otherwise as `scatter` |
| `funnel` | ordered stages with the drop between them | several measures of a one-row result (stage = measure, in query order), or one category and one measure | stage-to-stage and overall conversion; one hue, dark to light |
| `waterfall` | how parts add up to a total, or the change between two periods by category | one category and one additive measure; or two dimensions where one has exactly two values (a bridge from the first value to the second) | rises and falls in the status colours, totals in the primary; at most 12 steps, the rest fold into "Other" |
| `histogram` | the distribution of one numeric column | `spec.bins = {column, count}`; no group-by, no time | bins are computed in the warehouse (pandas for files) on round edges; values beyond 4 standard deviations collect in an under / overflow bin, marked on the axis |
| `bullet` | one number against a target | one measure and `config.target` (or one category and one measure: a bullet per row) | the bar on a lighter track of its own hue, the target as a tick, and the words "4,120 of 5,000 target · 82%"; up to 12 rows; the gauge block is the same data on an arc |
| `table` | exact values, many columns, or more categories than a chart reads | anything | every chart also has "View as table" |
| `kpi` | one headline number | one measure, no grouping | prior-period delta, sparkline, `forecast` ("Next month ≈ 4,120 (3,700-4,560)") |

Aliases accepted from a model or an older block: `column`, `grouped_bar` (bar),
`hbar`, `barh` (horizontal bar), `choropleth`, `geo` (map), `matrix`, `heat_map`
(heatmap), `pivot_table`, `100_stacked_bar`, `percent_stacked_bar`, `stacked_100`,
`distribution` (histogram), `progress` (bullet), `bridge` (waterfall),
`step_line` (line), `tree_map`.

## Query grammar the charts rely on

A block's query is a BlockSpec (`backend/app/services/query_builder.py`). Two keys
exist for charts and are emitted only when used:

- `date_parts: [{column, part, alias?}]` - `part` is `weekday` (ISO, 1 = Monday),
  `month`, `quarter`, `day` or `hour`. A grouping column like any other ("bookings
  by weekday", a month x weekday heatmap). Counts toward the 3-column grouping limit.
- `bins: {column, count}` - a histogram. `count` is 2-60 (default 20). The engine
  first reads MIN / MAX / AVG / STDDEV of the column under the block's own filters,
  picks round edges close to `count`, then counts rows per bin in one statement.
  No `group_by`, no `time`.

## Forecast and anomalies

A line, area or bar over a time bucket (and a KPI tile with a sparkline) can
carry `config.forecast = {horizon, interval: "80" | "95" | "both", anomalies}`.
The server computes it on the block's aggregated series
(`backend/app/services/forecast.py`): damped Holt-Winters when a full season is
there and it wins the backtest, damped Holt otherwise, with a seasonal-naive
floor; intervals from out-of-sample rolling-origin errors, widening with the
horizon; a rolling-origin backtest (MAPE, sMAPE, MASE) in the caption. It refuses,
with the reason, when there is too little history, too many gaps, a flat series,
more than 4 series, or when it cannot beat the naive baseline. A partial last
period is left out of the fit and drawn dashed.

On the chart: history solid, forecast dashed in the same hue, an 80% and a 95%
band, a divider at the last complete period, anomalies ringed in the status
colour, and one caption line under the plot.

## Files

| File | What it holds |
|---|---|
| `recommend.ts` | the chart list, `shapeFromSpec` / `shapeFromResult`, `fits`, `recommend`, `resolve` |
| `model.ts` | `planChart`: a result and a block to a chart model (cartesian), or to `{kind: "special", type}`; forecast, partial periods, histogram, 100%, combo |
| `layout.ts`, `CartesianChart.tsx` | measured layout and drawing of bars / lines / areas / histogram |
| `SpecialChart.tsx` | one entry for map, heatmap, pivot, scatter, bubble, treemap, funnel, waterfall, bullet |
| `MapChart.tsx`, `mapModel.ts`, `worldMap.ts` | the choropleth; country shapes and name / code resolution (no map library, no network) |
| `HeatmapChart.tsx`, `PivotTable.tsx`, `matrixModel.ts`, `dimensions.ts` | two-dimension forms |
| `ScatterChart.tsx`, `TreemapChart.tsx`, `FunnelChart.tsx`, `WaterfallChart.tsx`, `BulletChart.tsx`, `DonutChart.tsx` | one form each (model + component) |
| `scale.ts`, `scaleLegend.ts` | classed colour scales (sequential, diverging) and their legend |
| `kit.tsx` | what every chart shares: ink tokens, type sizes, the tooltip, legend rows, keyboard navigation, the export hook |
| `geometry.ts`, `useBox.ts`, `exportSvg.ts` | text measuring, sizing, PNG / SVG export |

## Rules every chart here follows

- Every colour comes from the chart theme (`useChartTheme()`); a test scans these
  files for hex literals and fails on one. Text is ink (primary / secondary /
  muted), never a series colour.
- Sequential scales are one hue, light to dark; diverging scales are two hues
  around a neutral midpoint; status colours mean good / bad and nothing else.
- One y-axis. Two scales means two aligned panels.
- A legend for two or more series; direct labels only where they fit; a hover
  tooltip and keyboard focus on every mark; "View as table" on every chart.

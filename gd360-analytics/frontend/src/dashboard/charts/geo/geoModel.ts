// 2026-11-11 (live maps): what a result holds that a street map can draw - read from the columns, the way a person
// would. Pure; LiveMapCanvas.tsx turns the plan into map layers.
//
//   points   a latitude and a longitude column (lat / latitude, lng / lon / long / longitude), any prefix:
//            "store_lat" + "store_lng" is one point per row
//   routes   two such pairs ("pickup_lat/pickup_lng" + "drop_lat/drop_lng"), or two place columns that read as a
//            start and an end (origin / destination, from / to, pickup / dropoff, source / target) - one arc per row
//   places   one place column (city, town, location, address, pincode ...) or a country column - looked up to
//            coordinates by the backend (POST /geo/resolve, offline index), one bubble per place
//
// The size and colour of a mark come from the first measure that is not a coordinate; a text column that is not
// a place labels the tooltip.
import type { BlockResult } from "../../../api/client";
import { looksLikeCountryName } from "../recommend";

export const LAT_RE = /(^|[_\s.-])(lat|latitude)([_\s.-]|$)/i;
export const LON_RE = /(^|[_\s.-])(lng|lon|long|longitude)([_\s.-]|$)/i;
export const PLACE_RE = /(^|[_\s.-])(city|cities|town|location|locality|place|address|pincode|pin_code|zip|zipcode|zip_code|postcode|postal_code|destination|origin|pickup|dropoff|drop|venue|from|to|source|target|start|end)([_\s.-]|$)/i;
const START_RE = /(^|[_\s.-])(origin|from|pickup|start|src|source|departure|depart)([_\s.-]|$)/i;
const END_RE = /(^|[_\s.-])(destination|dest|to|drop|dropoff|end|target|arrival|arrive)([_\s.-]|$)/i;

const snake = (s: string) => s.replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_");

export type CoordPair = { lat: string; lon: string; prefix: string };
export type GeoPlan =
  | { kind: "points"; pair: CoordPair; measure: string | null; label: string | null }
  | { kind: "routes"; from: CoordPair | string; to: CoordPair | string; measure: string | null; label: string | null }
  | { kind: "places"; column: string; measure: string | null; country: boolean };

function numericShare(rows: Record<string, any>[], col: string, lo: number, hi: number): number {
  let n = 0, ok = 0;
  for (const r of rows.slice(0, 2000)) {
    const v = r[col];
    if (v === null || v === undefined || v === "") continue;
    n++;
    const f = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(f) && f >= lo && f <= hi) ok++;
  }
  return n ? ok / n : 0;
}

function textShare(rows: Record<string, any>[], col: string): number {
  let n = 0, ok = 0;
  for (const r of rows.slice(0, 2000)) {
    const v = r[col];
    if (v === null || v === undefined || v === "") continue;
    n++;
    if (typeof v === "string" && /[A-Za-z]/.test(v)) ok++;
  }
  return n ? ok / n : 0;
}

const prefixOf = (col: string, re: RegExp) => snake(col).toLowerCase().replace(re, "$1").replace(/[_\s.-]+$/, "").replace(/^[_\s.-]+/, "");

export function coordPairs(result: Pick<BlockResult, "columns" | "rows">): CoordPair[] {
  const cols = (result.columns || []).map((c) => c.name);
  const rows = result.rows || [];
  const lats = cols.filter((c) => LAT_RE.test(snake(c)) && numericShare(rows, c, -90, 90) >= 0.9);
  const lons = cols.filter((c) => LON_RE.test(snake(c)) && numericShare(rows, c, -180, 180) >= 0.9);
  const pairs: CoordPair[] = [];
  const used = new Set<string>();
  for (const lat of lats) {
    const p = prefixOf(lat, LAT_RE);
    const lon = lons.find((l) => !used.has(l) && prefixOf(l, LON_RE) === p) ?? (lats.length === 1 && lons.length === 1 ? lons[0] : undefined);
    if (lon) {
      used.add(lon);
      pairs.push({ lat, lon, prefix: p });
    }
  }
  return pairs;
}

export function geoPlan(result: Pick<BlockResult, "columns" | "rows" | "measures" | "dimensions">): GeoPlan | null {
  const cols = (result.columns || []).map((c) => c.name);
  const rows = result.rows || [];
  if (!rows.length) return null;
  const pairs = coordPairs(result);
  const coordCols = new Set(pairs.flatMap((p) => [p.lat, p.lon]));
  const numeric = (c: string) => numericShare(rows, c, -Infinity, Infinity) >= 0.9;
  const measures = (result.measures && result.measures.length ? result.measures : cols).filter((c) => !coordCols.has(c) && numeric(c));
  const measure = measures[0] ?? null;
  const places = cols.filter((c) => !coordCols.has(c) && (PLACE_RE.test(snake(c)) || looksLikeCountryName(c)) && textShare(rows, c) >= 0.8);
  const labelCol = cols.find((c) => !coordCols.has(c) && !places.includes(c) && textShare(rows, c) >= 0.8) ?? places[0] ?? null;

  if (pairs.length >= 2) {
    const from = pairs.find((p) => START_RE.test(p.prefix)) ?? pairs[0];
    const to = pairs.find((p) => p !== from && END_RE.test(p.prefix)) ?? pairs.find((p) => p !== from)!;
    return { kind: "routes", from, to, measure, label: labelCol };
  }
  if (pairs.length === 1) return { kind: "points", pair: pairs[0], measure, label: labelCol };
  const start = places.find((c) => START_RE.test(snake(c)));
  const end = places.find((c) => c !== start && END_RE.test(snake(c)));
  if (start && end) return { kind: "routes", from: start, to: end, measure, label: null };
  const dims = (result.dimensions && result.dimensions.length ? result.dimensions : cols).filter((c) => places.includes(c));
  const place = dims[0] ?? places[0];
  if (place) return { kind: "places", column: place, measure, country: looksLikeCountryName(place) };
  return null;
}

/** Can this result be drawn on the live map at all? (the gallery's disabled tile says why not) */
export function geoNeeds(result: Pick<BlockResult, "columns" | "rows" | "measures" | "dimensions">): string | null {
  return geoPlan(result) ? null : "Live map needs latitude and longitude, or a city column.";
}

// 2026-11-11 (live maps): the live street map - points, bubbles, a heatmap or routes on a real map you can pan and
// zoom, like the map visuals in Power BI or a ride app's trip map. MapLibre GL draws it from OpenFreeMap's free
// vector tiles in Euliv's own Midnight / Daylight style (geo/basemap.ts). Place names are turned into coordinates
// by our own offline index (POST /geo/resolve); latitude and longitude columns are drawn as they are.
// Loaded lazily (LiveMap.tsx), so the map library is only downloaded by a page that shows a map.
import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type LngLatBoundsLike, type Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { BlockResult, DashboardBlock } from "../../api/client";
import { api } from "../../api/client";
import { useThemeMode } from "../../api/ThemeContext";
import { formatValue, humanize, measureFormats, PLAIN_FORMAT } from "../format";
import { eulivStyle } from "./geo/basemap";
import { geoPlan, type CoordPair, type GeoPlan } from "./geo/geoModel";

type Mode = "bubbles" | "heat" | "points" | "routes";
type Coord = { lat: number; lon: number; label?: string };
type Feature = { type: "Feature"; geometry: any; properties: Record<string, any> };

const COBALT = "#2D5BFF";
const ICE = "#8EA6FF";
const resolveCache = new Map<string, Coord | null>();

async function resolvePlaces(values: string[]): Promise<Map<string, Coord | null>> {
  const missing = values.filter((v) => !resolveCache.has(v));
  for (let i = 0; i < missing.length; i += 1000) {
    const chunk = missing.slice(i, i + 1000);
    try {
      const { data } = await api.post<{ results: Record<string, { lat: number; lon: number; label: string } | null> }>("/geo/resolve", { values: chunk });
      for (const v of chunk) {
        const r = data.results?.[v];
        resolveCache.set(v, r ? { lat: r.lat, lon: r.lon, label: r.label } : null);
      }
    } catch {
      for (const v of chunk) resolveCache.set(v, null);
    }
  }
  return new Map(values.map((v) => [v, resolveCache.get(v) ?? null]));
}

const num = (v: unknown): number | null => {
  const f = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(f) ? f : null;
};

function pairCoord(row: Record<string, any>, p: CoordPair): Coord | null {
  const lat = num(row[p.lat]), lon = num(row[p.lon]);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

/** A gentle arc between two points (a quadratic curve in lon/lat), so routes read like trips, not ruler lines. */
function arc(a: Coord, b: Coord, steps = 24): [number, number][] {
  const mx = (a.lon + b.lon) / 2, my = (a.lat + b.lat) / 2;
  const dx = b.lon - a.lon, dy = b.lat - a.lat;
  const bend = 0.18;
  const cx = mx - dy * bend, cy = my + dx * bend;
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push([(1 - t) * (1 - t) * a.lon + 2 * (1 - t) * t * cx + t * t * b.lon, (1 - t) * (1 - t) * a.lat + 2 * (1 - t) * t * cy + t * t * b.lat]);
  }
  return out;
}

type Built = { points: Feature[]; lines: Feature[]; unplaced: number; placedLabel: string; max: number };

async function buildFeatures(plan: GeoPlan, rows: Record<string, any>[]): Promise<Built> {
  const points: Feature[] = [], lines: Feature[] = [];
  let unplaced = 0, max = 0;
  const value = (r: Record<string, any>) => (plan.measure ? num(r[plan.measure]) : 1);
  if (plan.kind === "points") {
    for (const r of rows.slice(0, 50000)) {
      const c = pairCoord(r, plan.pair);
      if (!c) { unplaced++; continue; }
      const v = value(r) ?? 0;
      max = Math.max(max, Math.abs(v));
      points.push({ type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] }, properties: { v, label: plan.label ? String(r[plan.label] ?? "") : "" } });
    }
    return { points, lines, unplaced, placedLabel: "points", max };
  }
  if (plan.kind === "places") {
    const agg = new Map<string, number>();
    for (const r of rows) {
      const key = r[plan.column];
      if (key === null || key === undefined || String(key).trim() === "") continue;
      const k = String(key).trim();
      agg.set(k, (agg.get(k) ?? 0) + (value(r) ?? 0));
    }
    const coords = await resolvePlaces([...agg.keys()]);
    for (const [k, v] of agg) {
      const c = coords.get(k);
      if (!c) { unplaced++; continue; }
      max = Math.max(max, Math.abs(v));
      points.push({ type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] }, properties: { v, label: k } });
    }
    return { points, lines, unplaced, placedLabel: "places", max };
  }
  // routes
  const placeCols = [plan.from, plan.to].filter((x): x is string => typeof x === "string");
  const names = new Set<string>();
  for (const r of rows) for (const c of placeCols) if (r[c] !== null && r[c] !== undefined) names.add(String(r[c]).trim());
  const coords = names.size ? await resolvePlaces([...names]) : new Map<string, Coord | null>();
  const at = (r: Record<string, any>, end: CoordPair | string): Coord | null =>
    typeof end === "string" ? coords.get(String(r[end] ?? "").trim()) ?? null : pairCoord(r, end);
  const merged = new Map<string, { a: Coord; b: Coord; v: number; label: string }>();
  for (const r of rows.slice(0, 20000)) {
    const a = at(r, plan.from), b = at(r, plan.to);
    if (!a || !b) { unplaced++; continue; }
    const key = `${a.lat.toFixed(3)},${a.lon.toFixed(3)}>${b.lat.toFixed(3)},${b.lon.toFixed(3)}`;
    const v = value(r) ?? 0;
    const label = typeof plan.from === "string" && typeof plan.to === "string" ? `${r[plan.from]} → ${r[plan.to]}` : plan.label ? String(r[plan.label] ?? "") : "";
    const m = merged.get(key);
    if (m) m.v += v; else merged.set(key, { a, b, v, label });
  }
  for (const m of [...merged.values()].sort((x, y) => y.v - x.v).slice(0, 3000)) {
    max = Math.max(max, Math.abs(m.v));
    lines.push({ type: "Feature", geometry: { type: "LineString", coordinates: arc(m.a, m.b) }, properties: { v: m.v, label: m.label } });
    points.push({ type: "Feature", geometry: { type: "Point", coordinates: [m.a.lon, m.a.lat] }, properties: { v: 0, end: "from", label: m.label } });
    points.push({ type: "Feature", geometry: { type: "Point", coordinates: [m.b.lon, m.b.lat] }, properties: { v: 0, end: "to", label: m.label } });
  }
  return { points, lines, unplaced, placedLabel: "routes", max };
}

function boundsOf(features: Feature[]): LngLatBoundsLike | null {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90, any = false;
  const add = ([x, y]: number[]) => { any = true; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
  for (const f of features) {
    if (f.geometry.type === "Point") add(f.geometry.coordinates);
    else for (const c of f.geometry.coordinates) add(c);
  }
  return any ? [[x0, y0], [x1, y1]] : null;
}

function addLayers(map: MLMap, built: Built, mode: Mode) {
  const max = built.max || 1;
  // Fewer marks, bigger bubbles: 26 px for a few dozen places, down to 6 px for thousands of points.
  const maxR = Math.max(6, Math.min(26, 26 * Math.sqrt(40 / Math.max(1, built.points.length))));
  map.addSource("eu-points", { type: "geojson", data: { type: "FeatureCollection", features: built.points } as any });
  map.addSource("eu-lines", { type: "geojson", lineMetrics: true, data: { type: "FeatureCollection", features: built.lines } as any });
  map.addLayer({ id: "eu-heat", type: "heatmap", source: "eu-points", layout: { visibility: mode === "heat" ? "visible" : "none" },
    paint: {
      "heatmap-weight": ["interpolate", ["linear"], ["abs", ["get", "v"]], 0, 0.04, max, 0.5],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 9, 0.9, 14, 1.6],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 4, 9, 14, 14, 26],
      "heatmap-opacity": 0.85,
      "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(45,91,255,0)", 0.15, "rgba(22,40,110,0.45)", 0.4, "rgba(45,91,255,0.75)", 0.7, ICE, 0.95, "#E6ECFF"],
    } });
  map.addLayer({ id: "eu-routes", type: "line", source: "eu-lines", layout: { "line-cap": "round", visibility: mode === "routes" ? "visible" : "none" },
    paint: {
      "line-width": ["interpolate", ["linear"], ["abs", ["get", "v"]], 0, 1.2, max, 5],
      "line-opacity": 0.85,
      "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, ICE, 1, COBALT],
    } });
  map.addLayer({ id: "eu-bubbles", type: "circle", source: "eu-points", filter: ["!", ["has", "end"]], layout: { visibility: mode === "bubbles" ? "visible" : "none" },
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["sqrt", ["/", ["abs", ["get", "v"]], max]], 0, Math.min(4, maxR / 2), 1, maxR],
      "circle-color": COBALT, "circle-opacity": 0.55, "circle-stroke-color": ICE, "circle-stroke-width": 1, "circle-stroke-opacity": 0.9,
    } });
  map.addLayer({ id: "eu-dots", type: "circle", source: "eu-points", layout: { visibility: mode === "points" || mode === "routes" ? "visible" : "none" },
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 2.5, 12, 5],
      "circle-color": ["match", ["get", "end"], "to", COBALT, "from", ICE, COBALT],
      "circle-stroke-color": "#0A0A0B", "circle-stroke-width": 0.8, "circle-opacity": 0.95,
    } });
}

const MODE_LAYERS: Record<Mode, string[]> = { bubbles: ["eu-bubbles"], heat: ["eu-heat"], points: ["eu-dots"], routes: ["eu-routes", "eu-dots"] };

export default function LiveMapCanvas({ result, block, minHeight = 320, compact = false, theme: forced }: {
  result: BlockResult; block: Pick<DashboardBlock, "id" | "title" | "config">; minHeight?: number; compact?: boolean; theme?: "light" | "dark";
}) {
  // a designed dashboard (board) has its own light or dark theme, which wins over the app's
  const appTheme = useThemeMode() === "light" ? "light" : "dark";
  const theme = forced ?? appTheme;
  const plan = useMemo(() => geoPlan(result), [result]);
  const box = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [built, setBuilt] = useState<Built | null>(null);
  const defaultMode: Mode = !plan ? "points" : plan.kind === "routes" ? "routes" : plan.kind === "points" ? ((result.rows?.length ?? 0) > 300 ? "heat" : plan.measure ? "bubbles" : "points") : "bubbles";
  const [mode, setMode] = useState<Mode>((block.config?.map_mode as Mode) || defaultMode);
  const fmt = useMemo(() => (plan?.measure ? measureFormats(block, result)[plan.measure] ?? PLAIN_FORMAT : PLAIN_FORMAT), [plan, block, result]);

  useEffect(() => {
    let alive = true;
    if (!plan) return;
    buildFeatures(plan, result.rows || []).then((b) => { if (alive) setBuilt(b); });
    return () => { alive = false; };
  }, [plan, result]);

  useEffect(() => {
    if (!box.current || !built) return;
    const map = new maplibregl.Map({
      container: box.current, style: eulivStyle(theme), center: [0, 20], zoom: 1.2, attributionControl: { compact: true },
      cooperativeGestures: !compact, interactive: !compact, dragRotate: false, pitchWithRotate: false,
    });
    mapRef.current = map;
    if (!compact) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "eu-map-pop", offset: 10 });
    // Data layers go on as soon as the style is parsed ("style.load"), not after every tile arrives ("load"): a
    // network that blocks the map tiles still shows the points, routes and heat on a plain ground.
    map.on("error", () => undefined);
    map.once("style.load", () => {
      addLayers(map, built, mode);
      const b = boundsOf([...built.points, ...built.lines]);
      if (b) map.fitBounds(b, { padding: compact ? 16 : 56, maxZoom: 11, duration: 0 });
      for (const id of ["eu-bubbles", "eu-dots", "eu-routes"]) {
        map.on("mousemove", id, (e) => {
          const f = e.features?.[0];
          if (!f) return;
          map.getCanvas().style.cursor = "pointer";
          const p = f.properties as Record<string, any>;
          const val = plan?.measure && p.v ? `<b>${formatValue(Number(p.v), fmt)}</b> ${humanize(plan.measure)}` : "";
          popup.setLngLat(e.lngLat).setHTML(`<div>${String(p.label || "").replace(/[<>&]/g, "")}</div>${val ? `<div>${val}</div>` : ""}`).addTo(map);
        });
        map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; popup.remove(); });
      }
    });
    return () => { popup.remove(); map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built, theme, compact]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    for (const ids of Object.values(MODE_LAYERS)) for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
    for (const id of MODE_LAYERS[mode]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
  }, [mode]);

  if (!plan) return <div className="eu-map-msg" style={{ minHeight }}>Live map needs latitude and longitude, or a city column.</div>;
  const modes: Mode[] = plan.kind === "routes" ? ["routes", "heat", "points"] : ["bubbles", "heat", "points"];
  const total = built ? (plan.kind === "routes" ? built.lines.length : built.points.length) : 0;
  return (
    <div className="eu-map" style={{ minHeight }} data-eu-live-map={plan.kind}>
      <div ref={box} className="eu-map-canvas" />
      {!compact && (
        <>
          <div className="eu-map-tools" role="group" aria-label="Map view">
            {modes.map((m) => (
              <button key={m} type="button" className={m === mode ? "on" : ""} aria-pressed={m === mode} onClick={() => setMode(m)}>
                {m === "bubbles" ? "Bubbles" : m === "heat" ? "Heat" : m === "points" ? "Points" : "Routes"}
              </button>
            ))}
            <button type="button" onClick={() => { const b = built && boundsOf([...built.points, ...built.lines]); if (b && mapRef.current) mapRef.current.fitBounds(b, { padding: 56, maxZoom: 11 }); }} aria-label="Fit the map to the data">Fit</button>
          </div>
          <div className="eu-map-legend">
            {built ? (
              <span>
                <b>{total.toLocaleString()}</b> {built.placedLabel}{plan.measure ? <> · size = {humanize(plan.measure)}</> : null}
                {built.unplaced > 0 ? <> · {built.unplaced.toLocaleString()} not placed</> : null}
              </span>
            ) : <span>Placing on the map…</span>}
          </div>
        </>
      )}
    </div>
  );
}

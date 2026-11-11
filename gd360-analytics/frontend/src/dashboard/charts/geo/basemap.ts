// 2026-11-11 (live maps): Euliv's own street-map styles, drawn by MapLibre GL from OpenFreeMap's free vector
// tiles (OpenStreetMap data, no API key, no per-view cost). Our own style, not a stock one, so the map reads as
// part of Euliv: Midnight (near-black land, ink-blue water, quiet roads) for the dark theme and Daylight for the
// light one. Labels are kept sparse so data on top stays the loudest thing on screen.
import type { StyleSpecification } from "maplibre-gl";

const TILES = "https://tiles.openfreemap.org/planet";
const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
export const ATTRIBUTION = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

type Palette = {
  land: string; landcover: string; park: string; water: string; waterLine: string; building: string;
  minor: string; major: string; motorway: string; rail: string; boundary: string; boundary2: string;
  label: string; labelHalo: string; labelStrong: string; waterLabel: string;
};

const MIDNIGHT: Palette = {
  land: "#0B0B0D", landcover: "#0E0F12", park: "#0E1412", water: "#0A1230", waterLine: "#14204D", building: "#15161B",
  minor: "#17181E", major: "#20222B", motorway: "#262B3D", rail: "#1B1C22", boundary: "#2B3566", boundary2: "#1E2440",
  label: "#7C7F8A", labelHalo: "#0B0B0D", labelStrong: "#C9CBD3", waterLabel: "#3A4C9C",
};
const DAYLIGHT: Palette = {
  land: "#F4F5F7", landcover: "#EEF0F2", park: "#E6EEE8", water: "#D5DEFA", waterLine: "#BCCBF6", building: "#E6E7EB",
  minor: "#FFFFFF", major: "#FFFFFF", motorway: "#DCE3FF", rail: "#DADCE2", boundary: "#9DB1F2", boundary2: "#C8D4FC",
  label: "#6A6C76", labelHalo: "#F4F5F7", labelStrong: "#25262C", waterLabel: "#5B73C9",
};

const NAME: any = ["coalesce", ["get", "name_en"], ["get", "name:latin"], ["get", "name"]];

export function eulivStyle(theme: "dark" | "light"): StyleSpecification {
  const c = theme === "light" ? DAYLIGHT : MIDNIGHT;
  const road = (id: string, classes: string[], color: string, w: [number, number, number, number]): any => ({
    id, type: "line", source: "omt", "source-layer": "transportation",
    filter: ["in", ["get", "class"], ["literal", classes]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": color, "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], w[0], w[1], w[2], w[3]] },
  });
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: { omt: { type: "vector", url: TILES, attribution: ATTRIBUTION } },
    layers: [
      { id: "land", type: "background", paint: { "background-color": c.land } },
      { id: "landcover", type: "fill", source: "omt", "source-layer": "landcover", paint: { "fill-color": c.landcover, "fill-opacity": 0.7 } },
      { id: "park", type: "fill", source: "omt", "source-layer": "park", paint: { "fill-color": c.park, "fill-opacity": 0.8 } },
      { id: "water", type: "fill", source: "omt", "source-layer": "water", paint: { "fill-color": c.water } },
      { id: "waterway", type: "line", source: "omt", "source-layer": "waterway", paint: { "line-color": c.waterLine, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 14, 2] } },
      { id: "building", type: "fill", source: "omt", "source-layer": "building", minzoom: 13, paint: { "fill-color": c.building, "fill-opacity": 0.9 } },
      road("road-minor", ["minor", "street", "street_limited", "service", "track"], c.minor, [12, 0.4, 18, 10]),
      road("road-mid", ["tertiary", "secondary"], c.major, [8, 0.5, 18, 16]),
      road("road-major", ["primary", "trunk"], c.major, [5, 0.5, 18, 20]),
      road("road-motorway", ["motorway"], c.motorway, [4, 0.6, 18, 22]),
      { id: "rail", type: "line", source: "omt", "source-layer": "transportation", filter: ["==", ["get", "class"], "rail"], minzoom: 10, paint: { "line-color": c.rail, "line-width": 1, "line-dasharray": [3, 3] } },
      { id: "boundary-state", type: "line", source: "omt", "source-layer": "boundary", filter: ["all", [">=", ["get", "admin_level"], 3], ["<=", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]], paint: { "line-color": c.boundary2, "line-width": 0.8, "line-dasharray": [2, 2] } },
      { id: "boundary-country", type: "line", source: "omt", "source-layer": "boundary", filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]], paint: { "line-color": c.boundary, "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.6, 8, 1.6] } },
      { id: "water-label", type: "symbol", source: "omt", "source-layer": "water_name", filter: ["==", ["geometry-type"], "Point"],
        layout: { "text-field": NAME, "text-font": ["Noto Sans Italic"], "text-size": 11 }, paint: { "text-color": c.waterLabel, "text-halo-color": c.labelHalo, "text-halo-width": 1 } },
      { id: "road-label", type: "symbol", source: "omt", "source-layer": "transportation_name", minzoom: 13,
        layout: { "symbol-placement": "line", "text-field": NAME, "text-font": ["Noto Sans Regular"], "text-size": 10.5 }, paint: { "text-color": c.label, "text-halo-color": c.labelHalo, "text-halo-width": 1 } },
      { id: "place-minor", type: "symbol", source: "omt", "source-layer": "place", filter: ["in", ["get", "class"], ["literal", ["town", "village", "suburb", "neighbourhood"]]], minzoom: 9,
        layout: { "text-field": NAME, "text-font": ["Noto Sans Regular"], "text-size": 11 }, paint: { "text-color": c.label, "text-halo-color": c.labelHalo, "text-halo-width": 1.2 } },
      { id: "place-city", type: "symbol", source: "omt", "source-layer": "place", filter: ["==", ["get", "class"], "city"], minzoom: 4,
        layout: { "text-field": NAME, "text-font": ["Noto Sans Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 4, 11, 10, 15] }, paint: { "text-color": c.labelStrong, "text-halo-color": c.labelHalo, "text-halo-width": 1.4 } },
      { id: "place-state", type: "symbol", source: "omt", "source-layer": "place", filter: ["==", ["get", "class"], "state"], minzoom: 4, maxzoom: 8,
        layout: { "text-field": NAME, "text-font": ["Noto Sans Regular"], "text-size": 10.5, "text-transform": "uppercase", "text-letter-spacing": 0.12 }, paint: { "text-color": c.label, "text-halo-color": c.labelHalo, "text-halo-width": 1 } },
      { id: "place-country", type: "symbol", source: "omt", "source-layer": "place", filter: ["==", ["get", "class"], "country"], maxzoom: 7,
        layout: { "text-field": NAME, "text-font": ["Noto Sans Bold"], "text-size": ["interpolate", ["linear"], ["zoom"], 1, 10, 6, 14] }, paint: { "text-color": c.labelStrong, "text-halo-color": c.labelHalo, "text-halo-width": 1.4 } },
    ],
  } as StyleSpecification;
}

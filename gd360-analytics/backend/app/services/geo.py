"""
2026-11-11 (live maps): place names -> coordinates, offline and free.

The live map (frontend dashboard/charts/LiveMap.tsx) draws points on a real street map. Rows that carry latitude
and longitude are drawn as they are; rows that only name a place ("Chennai", "Austin, TX", "Germany") are looked
up here. Nothing leaves Euliv: the lookup is a local index of every city of 15,000+ people (GeoNames, CC BY 4.0,
via the geonamescache package), every country and every US state - no geocoding API, no key, no per-call cost.

The index is built once at image build time (Dockerfile: `python app/services/geo.py build <path>`), a ~2 MB TSV,
and loaded lazily on the first lookup (about 20 MB in memory), so a server that never draws a map never pays.
Local development without the file falls back to building it from geonamescache when that package is installed.

    name  alt names (|)  country  admin1  lat  lon  population

Matching: the whole value first ("New York"), then "city, region/country" ("Austin, TX", "Paris, France"), then
countries (name, ISO2, ISO3) and US states (name, code). Among cities of one name the largest wins, unless a
country hint (the request's or the value's own ", Country") says otherwise.
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import unicodedata
from pathlib import Path

INDEX_PATH = Path(os.getenv("GEO_INDEX_PATH", "/opt/euliv-geo/cities.tsv"))

_lock = threading.Lock()
_index: dict | None = None


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return re.sub(r"^(the|city of|greater) ", "", s)


# ---- building the index (image build time) ----------------------------------------------------------------

def build(out_path: str) -> int:
    import geonamescache  # only at build time

    base = Path(geonamescache.__file__).parent / "data"
    with open(base / "cities15000.json", encoding="utf-8") as f:
        cities = json.load(f)
    rows = []
    for c in cities.values():
        alts = []
        for a in c.get("alternatenames") or []:
            if a and len(a) <= 32 and re.fullmatch(r"[A-Za-z][A-Za-z .'\-]*", a) and a != c["name"]:
                alts.append(a)
            if len(alts) >= 6:
                break
        rows.append("\t".join([c["name"], "|".join(alts), c.get("countrycode") or "", str(c.get("admin1code") or ""),
                               f'{float(c["latitude"]):.4f}', f'{float(c["longitude"]):.4f}', str(int(c.get("population") or 0))]))
    with open(base / "countries.json", encoding="utf-8") as f:
        countries = json.load(f)
    with open(base / "us_states.json", encoding="utf-8") as f:
        states = json.load(f)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("#countries\t" + json.dumps({k: {"name": v["name"], "iso3": v.get("iso3"), "capital": v.get("capital")}
                                              for k, v in countries.items()}) + "\n")
        f.write("#us_states\t" + json.dumps({k: v.get("name") for k, v in states.items()}) + "\n")
        f.write("\n".join(rows) + "\n")
    return len(rows)


# ---- loading ------------------------------------------------------------------------------------------------

def _load() -> dict:
    global _index
    if _index is not None:
        return _index
    with _lock:
        if _index is not None:
            return _index
        path = INDEX_PATH
        if not path.exists():
            alt = Path(__file__).resolve().parent.parent.parent / ".geo_cache" / "cities.tsv"
            if not alt.exists():
                try:
                    build(str(alt))
                except Exception as e:  # noqa: BLE001
                    print(f"[geo] no index and could not build one: {e}")
                    _index = {"cities": {}, "countries": {}, "states": {}}
                    return _index
            path = alt
        cities: dict[str, list] = {}
        countries_meta: dict = {}
        states_meta: dict = {}
        weight: dict[str, list] = {}       # country -> [sum w*lat, sum w*lon, sum w, best city]
        sweight: dict[str, list] = {}      # US state code -> same
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.rstrip("\n")
                if not line:
                    continue
                if line.startswith("#countries\t"):
                    countries_meta = json.loads(line.split("\t", 1)[1])
                    continue
                if line.startswith("#us_states\t"):
                    states_meta = json.loads(line.split("\t", 1)[1])
                    continue
                name, alts, cc, a1, lat, lon, pop = line.split("\t")
                lat_f, lon_f, pop_i = float(lat), float(lon), int(pop)
                rec = (name, cc, a1, lat_f, lon_f, pop_i)
                for key in {_norm(name), *(_norm(a) for a in alts.split("|") if a)}:
                    if key:
                        cities.setdefault(key, []).append(rec)
                w = weight.setdefault(cc, [0.0, 0.0, 0.0])
                w[0] += lat_f * pop_i; w[1] += lon_f * pop_i; w[2] += pop_i
                if cc == "US":
                    sw = sweight.setdefault(a1, [0.0, 0.0, 0.0])
                    sw[0] += lat_f * pop_i; sw[1] += lon_f * pop_i; sw[2] += pop_i
        for lst in cities.values():
            lst.sort(key=lambda r: -r[5])
        countries: dict[str, dict] = {}
        for iso2, meta in countries_meta.items():
            w = weight.get(iso2)
            if not w or not w[2]:
                continue
            rec = {"label": meta["name"], "lat": round(w[0] / w[2], 4), "lon": round(w[1] / w[2], 4), "kind": "country", "country": iso2}
            for key in (meta["name"], iso2, meta.get("iso3") or ""):
                if key:
                    countries[_norm(key)] = rec
        for alias, iso2 in (("usa", "US"), ("united states of america", "US"), ("america", "US"), ("uk", "GB"), ("england", "GB"),
                            ("great britain", "GB"), ("uae", "AE"), ("south korea", "KR"), ("korea", "KR"), ("russia", "RU"),
                            ("czech republic", "CZ"), ("ivory coast", "CI"), ("holland", "NL"), ("the netherlands", "NL")):
            if _norm(iso2) in countries:
                countries[_norm(alias)] = countries[_norm(iso2)]
        states: dict[str, dict] = {}
        for code, sname in states_meta.items():
            w = sweight.get(code)
            if not w or not w[2]:
                continue
            rec = {"label": sname, "lat": round(w[0] / w[2], 4), "lon": round(w[1] / w[2], 4), "kind": "state", "country": "US"}
            states[_norm(sname)] = rec
            states[_norm(code)] = rec
        _index = {"cities": cities, "countries": countries, "states": states}
        print(f"[geo] index loaded: {len(cities):,} city names, {len(countries)} country keys, {len(states)} state keys")
        return _index


# ---- resolving ----------------------------------------------------------------------------------------------

def _country_code(hint: str | None, idx: dict) -> str | None:
    if not hint:
        return None
    rec = idx["countries"].get(_norm(hint))
    return rec["country"] if rec else None


def _pick(rec: tuple) -> dict:
    name, ccode, _a1, lat, lon, _pop = rec
    return {"label": name, "lat": lat, "lon": lon, "kind": "city", "country": ccode}


def _state_code(text: str, idx: dict) -> str | None:
    st = idx["states"].get(_norm(text))
    if not st:
        return None
    return next((k.upper() for k, v in idx["states"].items() if v is st and len(k) == 2), None)


def _city(key: str, idx: dict, cc: str | None = None) -> dict | None:
    lst = idx["cities"].get(key)
    if not lst:
        return None
    if cc:
        same = [r for r in lst if r[1] == cc]
        if same:
            return _pick(same[0])
    return _pick(lst[0])


def resolve_one(value: str, idx: dict, country_hint: str | None = None) -> dict | None:
    raw = str(value or "").strip()
    if not raw or len(raw) > 120:
        return None
    hint_cc = _country_code(country_hint, idx)
    key = _norm(raw)
    if not key or key.isdigit():
        return None
    # "Austin, TX" / "Springfield, IL" / "Paris, Texas" / "Paris, France" / "Chennai, Tamil Nadu, India"
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if len(parts) >= 2:
        lst = idx["cities"].get(_norm(parts[0])) or []
        for tail in parts[1:]:
            code = _state_code(tail, idx)
            if code:
                same = [r for r in lst if r[1] == "US" and r[2].upper() == code]
                if same:
                    return _pick(same[0])
            cc = _country_code(tail, idx)
            if cc:
                same = [r for r in lst if r[1] == cc]
                if same:
                    return _pick(same[0])
        if lst:
            return _city(_norm(parts[0]), idx, hint_cc)
    if key in idx["countries"]:
        return dict(idx["countries"][key])
    hit = _city(key, idx, hint_cc)
    if hit:
        return hit
    if key in idx["states"]:
        return dict(idx["states"][key])
    return None


def resolve(values: list, country_hint: str | None = None) -> dict[str, dict | None]:
    idx = _load()
    out: dict[str, dict | None] = {}
    for v in values:
        s = str(v)
        if s not in out:
            out[s] = resolve_one(s, idx, country_hint)
    return out


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "build":
        n = build(sys.argv[2])
        print(f"[geo] wrote {n:,} cities to {sys.argv[2]}")
    else:
        print("usage: python app/services/geo.py build <out.tsv>")

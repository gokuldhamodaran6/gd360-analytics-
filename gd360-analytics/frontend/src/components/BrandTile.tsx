// 2026-10-09 (round 15): the tile a connector or source is shown with - a
// clean brand-colour monogram, the same size and weight everywhere. Official
// logo files can be added later without code: put <slug>.svg files in
// frontend/public/logos/ and list the slugs in frontend/public/logos/index.json
// (e.g. ["instagram","stripe"]) - each vendor's press / brand kit has one.
// Until then nothing is guessed or redrawn.
import { useEffect, useState } from "react";
import { kindTile } from "../api/spaces";

let manifest: Promise<Set<string>> | null = null;
function logoSlugs(): Promise<Set<string>> {
  if (!manifest) {
    manifest = fetch("/logos/index.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => new Set<string>(Array.isArray(list) ? list.map(String) : []))
      .catch(() => new Set<string>());
  }
  return manifest;
}

export default function BrandTile({
  slug,
  kind,
  name,
  monogram,
  color,
  ink,
  size = 40,
  className = "",
}: {
  slug?: string | null;
  kind?: string | null;
  name?: string;
  monogram?: string;
  color?: string;
  ink?: string;
  size?: number;
  className?: string;
}) {
  const base = kindTile(kind || slug || "", name);
  const key = slug || kind || "";
  const [hasLogo, setHasLogo] = useState(false);
  useEffect(() => {
    let live = true;
    if (key) logoSlugs().then((s) => live && setHasLogo(s.has(key)));
    return () => {
      live = false;
    };
  }, [key]);
  const radius = Math.round(size * 0.27);
  const box = { width: size, height: size, borderRadius: radius };
  if (hasLogo) {
    return (
      <span className={`shrink-0 grid place-items-center overflow-hidden bg-surface ${className}`} style={{ ...box, boxShadow: "inset 0 0 0 1px rgb(var(--color-border))" }} aria-hidden="true">
        <img src={`/logos/${key}.svg`} alt="" width={Math.round(size * 0.62)} height={Math.round(size * 0.62)} onError={() => setHasLogo(false)} />
      </span>
    );
  }
  return (
    <span
      className={`shrink-0 grid place-items-center font-bold tracking-tight select-none ${className}`}
      style={{ ...box, background: color || base.c, color: ink || base.t, fontSize: Math.max(9, Math.round(size * 0.32)), boxShadow: "inset 0 0 0 1px rgba(255,255,255,.07)" }}
      aria-hidden="true"
    >
      {monogram || base.m}
    </span>
  );
}

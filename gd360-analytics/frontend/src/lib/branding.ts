import { useEffect, useState } from "react";
import { dashboardBuilderApi, DashboardBranding } from "../api/client";

// 2026-09-25 (Round 4, branding/customization): the ONE place branding is
// turned into actual CSS, shared by DashboardBuilderView.tsx (owner editor
// + preview) and PublicDashboardView.tsx (anonymous public/private
// viewer) - see backend routers/dashboard_builder.py's own module
// docstring for why DashboardBranding is one shared shape rather than two
// that could drift apart. This file owns the rendering rule; it never
// itself decides WHERE the branding data comes from (an authenticated
// DashboardBuilderDetail fetch vs. an anonymous PublicDashboard fetch) -
// that stays with each caller.

// This app's CSS custom properties (--color-primary etc., see index.css)
// are stored as space-separated "R G B" triplets so callers can use
// rgb(var(--x)) / rgb(var(--x) / alpha) - this converts a picked hex color
// into that exact format. Returns null for anything that isn't a clean
// 6-digit hex (with or without "#"), so a bad/partial value from a color
// input never gets set rather than corrupting a CSS variable.
export function hexToRgbTriple(hex: string | null | undefined): string | null {
  if (!hex) return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

// Inline style overrides for whichever of this app's CSS tokens a
// dashboard's branding customizes - applied to the outermost `.dash-shell`
// wrapper so every component underneath (cards, buttons, chips, the
// widget accent classes) picks them up for free through the same
// rgb(var(--x)) machinery the app's normal light/dark theme already uses.
// brand_accent_color also overrides --dash-accent-0 (Round 3's first
// rotating widget-accent token) so a branded dashboard's gauges/donuts/
// sparklines/avatar-list chips lean the SAME accent rather than one this
// dashboard's owner never chose.
export function brandingStyleVars(b: DashboardBranding | null | undefined): React.CSSProperties {
  if (!b) return {};
  const style: Record<string, string> = {};
  const primary = hexToRgbTriple(b.brand_primary_color);
  const accent = hexToRgbTriple(b.brand_accent_color);
  if (primary) style["--color-primary"] = primary;
  if (accent) {
    style["--color-accent"] = accent;
    style["--dash-accent-0"] = accent;
  }
  if (b.background_style === "color") {
    const base = hexToRgbTriple(b.background_color);
    if (base) style["--color-base"] = base;
  }
  return style as React.CSSProperties;
}

// A plain CSS background-image (not a token - an uploaded photo/pattern
// isn't something rgb(var(--x)) can express) for when background_style is
// "image" AND the image itself has actually loaded. `imageUrl` is null
// while it hasn't (or there isn't one) - callers pass null in that case
// and this quietly contributes no background rather than a broken url().
export function brandingBackgroundImageStyle(
  b: DashboardBranding | null | undefined,
  imageUrl: string | null
): React.CSSProperties {
  if (!b || b.background_style !== "image" || !imageUrl) return {};
  return {
    backgroundImage: `url(${imageUrl})`,
    backgroundSize: "cover",
    backgroundPosition: "center",
    backgroundAttachment: "fixed",
  };
}

// The owner/editor's own authenticated image fetch (DashboardBuilderView.tsx
// only - the public viewer points a plain <img> straight at its own
// unauthenticated branding URL instead, see PublicDashboardView.tsx). GET
// .../branding/logo|background requires view access, so a bare <img src>
// can't carry the Authorization header the normal `api` axios instance
// attaches - this fetches the bytes through that instance and hands back a
// blob: object URL, revoking the previous one on cleanup/unmount so
// switching dashboards or re-uploading never leaks blob URLs. `nonce`
// exists purely to force a refetch after a successful re-upload replaces
// the same has_logo/has_background_image===true state with new bytes -
// bump it in the caller right after upload/remove succeeds.
export function useBrandingAsset(
  dashboardId: string | undefined,
  kind: "logo" | "background",
  enabled: boolean,
  nonce: number
): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;

    if (!dashboardId || !enabled) {
      setUrl(null);
      return;
    }

    dashboardBuilderApi.fetchBrandingImageUrl(dashboardId, kind).then((fetched) => {
      if (cancelled) {
        if (fetched) URL.revokeObjectURL(fetched);
        return;
      }
      objectUrl = fetched;
      setUrl(fetched);
    });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardId, kind, enabled, nonce]);

  return url;
}

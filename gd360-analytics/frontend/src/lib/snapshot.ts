// 2026-11-11 (R67): a real picture of a dashboard for its card on the Dashboards list - the top of the page as its
// editor sees it, a small JPEG (about 40 KB) saved with the dashboard. Best effort: a failure leaves the card's
// drawn preview in place.
import { api } from "../api/client";

const pending = new Map<string, Promise<string | null>>();

/** Draws the element and saves it as the dashboard's picture (once per page load - a second caller gets the
 *  first one's result). Returns the image (a data URL) or null. */
export function captureThumbnail(el: HTMLElement | null, dashboardId: string): Promise<string | null> {
  if (!el || !dashboardId) return Promise.resolve(null);
  const had = pending.get(dashboardId);
  if (had) return had;
  const p = draw(el, dashboardId);
  pending.set(dashboardId, p);
  void p.then((r) => { if (!r) pending.delete(dashboardId); });
  return p;
}

async function draw(el: HTMLElement, dashboardId: string): Promise<string | null> {
  try {
    const { toJpeg } = await import("html-to-image");
    const w = Math.max(el.scrollWidth, 1);
    const h = Math.min(el.scrollHeight, Math.round(w * 0.62));
    const url = await toJpeg(el, {
      quality: 0.78, pixelRatio: Math.min(1, 960 / w), width: w, height: h, skipFonts: true, cacheBust: false,
      backgroundColor: getComputedStyle((el.closest(".bd") as HTMLElement | null) || el).backgroundColor || getComputedStyle(document.body).backgroundColor || undefined,
      filter: (n) => !(n instanceof HTMLElement && (n.classList.contains("sd-float") || n.classList.contains("sd-resize") || n.classList.contains("bd-changed")
        || n.dataset?.commentControl !== undefined || n.dataset?.snapSkip !== undefined)),
    });
    if (url.length > 30 && url.length < 380_000) {
      await api.post(`/v2/dashboards/${dashboardId}/thumbnail`, { image: url });
      return url;
    }
    return null;
  } catch {
    return null;
  }
}

// ---- snapshot mode (R68): /boards/:id?snap=1 and friends, opened in a hidden frame by the Dashboards list ------
// The page draws normally; once its charts have settled the dashboard's own area is captured, saved, and the
// frame tells the list (postMessage) so the card shows the picture at once. Works for every kind of dashboard.

const SNAP_PATH = /^\/(dashboard-builder|boards|dashboards|project-dashboards)\/([^/?#]+)/;

export function snapTarget(): string | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search);
  if (q.get("snap") !== "1") return null;
  const m = window.location.pathname.match(SNAP_PATH);
  return m ? m[2] : null;
}

function busy(): boolean {
  return !!document.querySelector('[aria-busy="true"], .bd-skel, .bd-loading, .animate-pulse, [data-loading="true"], .eu-map-loading');
}

function area(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-bd-page-full] .bd-body")
    || document.querySelector<HTMLElement>("[data-dashboard-main]")
    || document.querySelector<HTMLElement>("[data-dashboard-shell]")
    || document.querySelector<HTMLElement>("main");
}

export async function runSnapMode(id: string): Promise<void> {
  const t0 = Date.now();
  // at least 5 s for the charts to draw; then wait for the loaders to clear (up to 25 s in all)
  await new Promise((r) => setTimeout(r, 5000));
  while (Date.now() - t0 < 25000 && (busy() || !area())) await new Promise((r) => setTimeout(r, 700));
  await new Promise((r) => setTimeout(r, 1200));
  const image = await captureThumbnail(area(), id);
  try { window.parent?.postMessage({ type: "euliv-thumb", id, image }, window.location.origin); } catch { /* not in a frame */ }
}

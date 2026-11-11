// 2026-11-11 (R67): a real picture of a dashboard for its card on the Dashboards list - the top of the page as its
// editor sees it, a small JPEG (about 40 KB) saved with the dashboard. Best effort: a failure leaves the card's
// drawn preview in place.
import { api } from "../api/client";

const done = new Set<string>();

export async function captureThumbnail(el: HTMLElement | null, dashboardId: string): Promise<void> {
  if (!el || !dashboardId || done.has(dashboardId)) return;
  done.add(dashboardId);
  try {
    const { toJpeg } = await import("html-to-image");
    const w = Math.max(el.scrollWidth, 1);
    const h = Math.min(el.scrollHeight, Math.round(w * 0.62));
    const url = await toJpeg(el, {
      quality: 0.78, pixelRatio: Math.min(1, 960 / w), width: w, height: h, skipFonts: true, cacheBust: false,
      backgroundColor: getComputedStyle((el.closest(".bd") as HTMLElement | null) || el).backgroundColor || undefined,
      filter: (n) => !(n instanceof HTMLElement && (n.classList.contains("sd-float") || n.classList.contains("sd-resize") || n.classList.contains("bd-changed")
        || n.dataset?.commentControl !== undefined)),
    });
    if (url.length > 30 && url.length < 380_000) await api.post(`/v2/dashboards/${dashboardId}/thumbnail`, { image: url });
  } catch {
    done.delete(dashboardId);
  }
}

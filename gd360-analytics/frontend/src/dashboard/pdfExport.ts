// 2026-10-10: "Download PDF" for every full dashboard. It used to call
// window.print(), which re-laid the page out at paper width (the phone
// layout, the menu button, squashed charts) and forced a white page under
// dark-theme colours. Now the dashboard is captured exactly as it is drawn
// on screen - in the theme the person picks - and written straight into a
// PDF file: the name and subtitle as real text, the content as a sharp
// image cut into pages between blocks (never through a chart), and a page
// number on every page. Both libraries load only when someone exports.

export type PdfTheme = "screen" | "dark" | "light";
export type PdfOrientation = "landscape" | "portrait";

export type PdfExportOptions = {
  /** The dashboard's content area (the grid or canvas, without the rail). */
  target: HTMLElement;
  title: string;
  subtitle?: string;
  theme: PdfTheme;
  orientation: PdfOrientation;
  /** The theme on screen now. */
  currentTheme: "dark" | "light";
  /** Shows a theme without saving it as the preference; null clears it. */
  setTransientTheme: (t: "dark" | "light" | null) => void;
  /** Called while the file is being made. */
  onStage?: (stage: "theme" | "capture" | "write") => void;
};

const MARGIN_MM = 12;
const HEADER_MM = 22;
const FOOTER_MM = 9;

function sleep(ms: number) {
  return new Promise((r) => window.setTimeout(r, ms));
}

function nextFrames(n = 2) {
  return new Promise<void>((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });
}

/** "rgb(7, 9, 10)" / "rgba(...)" -> [r, g, b], or null when transparent. */
function parseRgb(v: string): [number, number, number] | null {
  const m = v.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/);
  if (!m) return null;
  if (m[4] !== undefined) {
    const a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (a === 0) return null;
  }
  return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
}

/** The first solid background behind an element. */
function backgroundBehind(el: HTMLElement): [number, number, number] {
  let cur: HTMLElement | null = el;
  while (cur) {
    const rgb = parseRgb(getComputedStyle(cur).backgroundColor);
    if (rgb) return rgb;
    cur = cur.parentElement;
  }
  return parseRgb(getComputedStyle(document.body).backgroundColor) || [255, 255, 255];
}

function tokenRgb(name: string, fallback: [number, number, number]): [number, number, number] {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parts = raw.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
  return parts.length >= 3 ? [parts[0], parts[1], parts[2]] : fallback;
}

/** Heights (CSS px from the top of target) where a page may be cut: the
 *  top and bottom of every block, minus any line that runs through one. */
function safeCuts(target: HTMLElement): { cuts: number[]; blocks: [number, number][] } {
  const top = target.getBoundingClientRect().top;
  const nodes = target.querySelectorAll<HTMLElement>(".react-grid-item, [data-block-id], [data-pdf-block], [data-kpi-strip], [data-canvas-cell]");
  const blocks: [number, number][] = [];
  nodes.forEach((n) => {
    const r = n.getBoundingClientRect();
    if (r.height < 4) return;
    blocks.push([r.top - top, r.bottom - top]);
  });
  const cuts = new Set<number>();
  for (const [a, b] of blocks) {
    cuts.add(Math.max(0, Math.floor(a) - 6));
    cuts.add(Math.ceil(b) + 6);
  }
  const ok = [...cuts].filter((y) => !blocks.some(([a, b]) => y > a + 1 && y < b - 1));
  return { cuts: ok.sort((x, y) => x - y), blocks };
}

function fileName(title: string) {
  const base = (title || "dashboard").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "dashboard";
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${base} ${stamp}.pdf`;
}

export async function exportDashboardPdf(opts: PdfExportOptions): Promise<void> {
  const { target, title, subtitle, orientation, currentTheme, setTransientTheme, onStage } = opts;
  const want = opts.theme === "screen" ? currentTheme : opts.theme;
  const switched = want !== currentTheme;
  const [{ toCanvas }, { jsPDF }] = await Promise.all([import("html-to-image"), import("jspdf")]);
  try {
    if (switched) {
      onStage?.("theme");
      setTransientTheme(want);
      // Charts re-theme on the next render; give them time to redraw.
      await nextFrames(3);
      await sleep(900);
    }
    onStage?.("capture");
    await (document as any).fonts?.ready;
    const bg = backgroundBehind(target);
    const text = tokenRgb("--color-text", want === "dark" ? [236, 238, 240] : [20, 22, 24]);
    const muted = tokenRgb("--color-muted", want === "dark" ? [140, 146, 152] : [110, 114, 120]);
    const width = Math.ceil(target.scrollWidth);
    const height = Math.ceil(target.scrollHeight);
    const { cuts } = safeCuts(target);
    const filter = (node: HTMLElement) => {
      if (!(node instanceof HTMLElement)) return true;
      if (node.hasAttribute("data-pdf-exclude")) return false;
      if (node.classList?.contains("print:hidden")) return false;
      return true;
    };
    const pixelRatio = Math.min(2, Math.max(1.5, 4000 / Math.max(width, 1)));
    const capture = (skipFonts: boolean) =>
      toCanvas(target, {
        backgroundColor: `rgb(${bg.join(",")})`,
        pixelRatio,
        width,
        height,
        cacheBust: true,
        skipFonts,
        filter: filter as any,
        style: { margin: "0", transform: "none" },
      });
    let canvas: HTMLCanvasElement;
    try {
      canvas = await capture(false);
    } catch {
      // A font that can't be read (blocked by the browser) shouldn't stop
      // the export - fall back to the fonts already on the page.
      canvas = await capture(true);
    }

    onStage?.("write");
    const pdf = new jsPDF({ orientation, unit: "mm", format: "a4", compress: true });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const contentW = pageW - MARGIN_MM * 2;
    const mmPerPx = contentW / width;
    const pxPerCanvas = canvas.width / width;

    const paintPage = () => {
      pdf.setFillColor(bg[0], bg[1], bg[2]);
      pdf.rect(0, 0, pageW, pageH, "F");
    };

    // Page 1 carries the name and subtitle as real, selectable text.
    paintPage();
    pdf.setTextColor(text[0], text[1], text[2]);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(17);
    const titleLines = pdf.splitTextToSize(title || "Dashboard", contentW) as string[];
    pdf.text(titleLines[0], MARGIN_MM, MARGIN_MM + 6);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9.5);
    pdf.setTextColor(muted[0], muted[1], muted[2]);
    const sub = [subtitle?.replace(/\s+/g, " ").trim(), `Exported ${new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`]
      .filter(Boolean)
      .join("  ·  ");
    pdf.text((pdf.splitTextToSize(sub, contentW) as string[])[0], MARGIN_MM, MARGIN_MM + 12.5);

    const firstTop = MARGIN_MM + HEADER_MM;
    const otherTop = MARGIN_MM;
    const bottom = pageH - MARGIN_MM - FOOTER_MM + 4;

    // Slice the capture into pages, cutting between blocks where possible.
    const slices: { from: number; to: number }[] = [];
    let y = 0;
    let first = true;
    while (y < height - 2) {
      const room = ((first ? bottom - firstTop : bottom - otherTop) / mmPerPx) | 0;
      let to = Math.min(height, y + room);
      if (to < height) {
        const fit = cuts.filter((c) => c > y + room * 0.35 && c <= y + room);
        if (fit.length) to = fit[fit.length - 1];
      }
      slices.push({ from: y, to });
      y = to;
      first = false;
    }

    const piece = document.createElement("canvas");
    const ctx = piece.getContext("2d")!;
    slices.forEach((s, i) => {
      if (i > 0) {
        pdf.addPage("a4", orientation);
        paintPage();
      }
      const sy = Math.round(s.from * pxPerCanvas);
      const sh = Math.max(1, Math.round((s.to - s.from) * pxPerCanvas));
      piece.width = canvas.width;
      piece.height = sh;
      ctx.fillStyle = `rgb(${bg.join(",")})`;
      ctx.fillRect(0, 0, piece.width, piece.height);
      ctx.drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, canvas.width, sh);
      const img = piece.toDataURL("image/jpeg", 0.93);
      // Same scale on every page: width fills the page, height follows -
      // never stretched.
      pdf.addImage(img, "JPEG", MARGIN_MM, i === 0 ? firstTop : otherTop, contentW, (s.to - s.from) * mmPerPx, undefined, "FAST");
    });

    const total = pdf.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      pdf.setPage(p);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8);
      pdf.setTextColor(muted[0], muted[1], muted[2]);
      const short = (title || "Dashboard").length > 70 ? `${(title || "").slice(0, 69)}…` : title || "Dashboard";
      pdf.text(short, MARGIN_MM, pageH - MARGIN_MM + 2);
      pdf.text(`GD360  ·  ${p} / ${total}`, pageW - MARGIN_MM, pageH - MARGIN_MM + 2, { align: "right" });
    }
    pdf.save(fileName(title));
  } finally {
    if (switched) setTransientTheme(currentTheme);
  }
}

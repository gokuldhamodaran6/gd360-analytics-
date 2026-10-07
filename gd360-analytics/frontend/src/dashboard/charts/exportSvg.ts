import { LIGHT } from "../../ui/tokens";

// 2026-10-07 (dashboard polish round): "Export PNG" for a native chart.
// The live <svg> is cloned with every colour and font resolved (it is
// styled through CSS variables, which do not travel with a file), given a
// surface-coloured background and the card's title, and saved as SVG or
// rasterised at 2x. The marks keep exactly the colours on screen - the
// ChartTheme's (identity colours included) - because what is copied is
// each element's computed style; this file names no colour of its own
// (the two fallbacks are the kit's light surface and ink tokens).

const COPIED = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "vector-effect", "opacity", "font-family", "font-size", "font-weight", "font-variant-numeric", "text-anchor"] as const;

function resolved(source: SVGSVGElement): SVGSVGElement {
  const clone = source.cloneNode(true) as SVGSVGElement;
  const from = source.querySelectorAll<SVGElement>("*");
  const to = clone.querySelectorAll<SVGElement>("*");
  from.forEach((el, i) => {
    const target = to[i];
    if (!target || el.tagName.toLowerCase() === "title") return;
    const cs = getComputedStyle(el);
    for (const prop of COPIED) {
      const v = cs.getPropertyValue(prop);
      if (v) target.setAttribute(prop, v);
    }
    target.removeAttribute("style");
    target.removeAttribute("class");
  });
  return clone;
}

function token(el: Element, name: string, fallback: string): string {
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  const parts = raw.split(/\s+/).map(Number);
  return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})` : fallback;
}

export function serializeChart(svg: SVGSVGElement, title: string): { markup: string; width: number; height: number } {
  const w = svg.width.baseVal.value || svg.clientWidth || 560;
  const h = svg.height.baseVal.value || svg.clientHeight || 260;
  const pad = 20, head = title ? 30 : 0;
  const width = w + pad * 2, height = h + pad * 2 + head;
  const ns = "http://www.w3.org/2000/svg";
  const out = document.createElementNS(ns, "svg");
  out.setAttribute("xmlns", ns);
  out.setAttribute("width", String(width));
  out.setAttribute("height", String(height));
  out.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const bg = document.createElementNS(ns, "rect");
  bg.setAttribute("width", String(width));
  bg.setAttribute("height", String(height));
  bg.setAttribute("fill", token(svg, "--color-surface", LIGHT.surface));
  out.appendChild(bg);
  const family = getComputedStyle(svg).fontFamily || "system-ui, sans-serif";
  if (title) {
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", String(pad));
    t.setAttribute("y", String(pad + 12));
    t.setAttribute("font-family", family);
    t.setAttribute("font-size", "14");
    t.setAttribute("font-weight", "600");
    t.setAttribute("fill", token(svg, "--color-text", LIGHT.text));
    t.textContent = title;
    out.appendChild(t);
  }
  const body = document.createElementNS(ns, "g");
  body.setAttribute("transform", `translate(${pad} ${pad + head})`);
  body.setAttribute("font-family", family);
  const clone = resolved(svg);
  while (clone.firstChild) body.appendChild(clone.firstChild);
  out.appendChild(body);
  return { markup: new XMLSerializer().serializeToString(out), width, height };
}

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadSvg(svg: SVGSVGElement, format: "png" | "jpeg" | "svg" | "webp", title: string): Promise<void> {
  const name = (title || "chart").replace(/[^a-zA-Z0-9-_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "chart";
  const { markup, width, height } = serializeChart(svg, title);
  const svgBlob = new Blob([markup], { type: "image/svg+xml;charset=utf-8" });
  if (format === "svg") {
    save(svgBlob, `${name}.svg`);
    return;
  }
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Couldn't render the chart."));
      img.src = url;
    });
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const c = canvas.getContext("2d");
    if (!c) return;
    c.scale(scale, scale);
    c.drawImage(img, 0, 0, width, height);
    const type = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
    if (blob) save(blob, `${name}.${format === "jpeg" ? "jpg" : format}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

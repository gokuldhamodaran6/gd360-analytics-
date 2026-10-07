import { useLayoutEffect, useState } from "react";

// The pixel box a chart is drawn in. Until the element has been laid out
// (and where layout does not exist at all - tests, server render) the
// chart draws at `fallback`.
export function useBox(fallback: { w: number; h: number }): [(el: HTMLDivElement | null) => void, HTMLDivElement | null, { w: number; h: number }] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState(fallback);
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (w > 0 && h > 0) setSize((prev) => (Math.abs(prev.w - w) < 1 && Math.abs(prev.h - h) < 1 ? prev : { w, h }));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, el, size];
}

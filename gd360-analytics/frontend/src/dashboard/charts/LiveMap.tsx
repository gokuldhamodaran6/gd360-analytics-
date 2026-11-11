// 2026-11-11 (live maps): the entry SpecialChart draws for chart_type "live_map". The map library (maplibre-gl,
// ~800 KB) is loaded only when a map is on screen.
import { lazy, Suspense } from "react";
import type { BlockResult, DashboardBlock } from "../../api/client";

const LiveMapCanvas = lazy(() => import("./LiveMapCanvas"));

export function LiveMap(props: { result: BlockResult; block: Pick<DashboardBlock, "id" | "title" | "config">; minHeight?: number; compact?: boolean; theme?: "light" | "dark" }) {
  const h = props.minHeight ?? 320;
  return (
    <Suspense fallback={<div className="eu-map eu-map-loading" style={{ minHeight: h }}><span>Loading the map…</span></div>}>
      <LiveMapCanvas {...props} />
    </Suspense>
  );
}

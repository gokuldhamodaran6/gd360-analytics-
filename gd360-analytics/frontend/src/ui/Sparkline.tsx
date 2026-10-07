import { useMemo } from "react";
import { cn } from "./cn";

// A tiny SVG polyline (System.dc.html: "sparkline 36 px, brand green, no
// axes"), 120x32 by default, 2 px line, a dot on the last point, optional
// soft area fill. Stroke is currentColor so the caller picks the tone with
// a text-* class (defaults to the brand primary). Renders 7-30 points:
// longer series are evenly downsampled (a KPI sparkline is a shape, not
// a chart), shorter ones draw as they are.

export type SparklineProps = {
  data: number[];
  width?: number;
  height?: number;
  strokeWidth?: number;
  area?: boolean;
  endDot?: boolean;
  className?: string;
  // A concrete colour for the line (a dashboard's chart theme); default:
  // the text-* class, i.e. the brand primary.
  color?: string;
  // Accessible description; omit to mark as decorative.
  label?: string;
};

export const SPARKLINE_MAX_POINTS = 30;

export function downsample(values: number[], max = SPARKLINE_MAX_POINTS): number[] {
  if (values.length <= max) return values;
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(values[Math.round((i / (max - 1)) * (values.length - 1))]);
  return out;
}

export function Sparkline({ data, width = 120, height = 32, strokeWidth = 2, area = false, endDot = true, className, color, label }: SparklineProps) {
  const { points, path, areaPath, last } = useMemo(() => {
    const vals = downsample(data.filter((n) => Number.isFinite(n)));
    if (vals.length === 0) return { points: "", path: "", areaPath: "", last: null as { x: number; y: number } | null };
    const pad = strokeWidth + 1;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const w = width - pad * 2;
    const h = height - pad * 2;
    const pts = vals.map((v, i) => ({
      x: pad + (vals.length === 1 ? w / 2 : (i / (vals.length - 1)) * w),
      y: pad + h - ((v - min) / span) * h,
    }));
    const pointsStr = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    const ap = `${d} L${pts[pts.length - 1].x.toFixed(1)} ${(height - pad).toFixed(1)} L${pts[0].x.toFixed(1)} ${(height - pad).toFixed(1)} Z`;
    return { points: pointsStr, path: d, areaPath: ap, last: pts[pts.length - 1] };
  }, [data, width, height, strokeWidth]);

  if (!points) return null;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("block shrink-0 text-primary", className)}
      style={color ? { color } : undefined}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {area && <path d={areaPath} fill="currentColor" fillOpacity="0.1" stroke="none" />}
      <path d={path} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      {endDot && last && <circle cx={last.x} cy={last.y} r={strokeWidth + 0.5} fill="currentColor" />}
    </svg>
  );
}

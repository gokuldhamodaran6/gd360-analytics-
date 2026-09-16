import { useRef, useState } from "react";
import Plot, { Plotly } from "../lib/plotly";
import { useTheme } from "../api/ThemeContext";

const EXPORT_FORMATS: { value: "png" | "jpeg" | "svg" | "webp"; label: string }[] = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPG" },
  { value: "svg", label: "SVG" },
  { value: "webp", label: "WEBP" },
];

export default function ChartCanvas({ chartSpec, title }: { chartSpec: any; title?: string }) {
  const graphDivRef = useRef<any>(null);
  const [downloading, setDownloading] = useState("");
  const { theme } = useTheme();

  if (!chartSpec) {
    return (
      <div className="card h-full flex items-center justify-center text-muted p-10 text-center">
        Ask GD360 something about your data (left panel) and your chart will appear here, interactive,
        exportable, and ready to customize.
      </div>
    );
  }

  const download = async (format: "png" | "jpeg" | "svg" | "webp") => {
    if (!graphDivRef.current) return;
    setDownloading(format);
    try {
      const safeName = (title || "chart").replace(/[^a-zA-Z0-9-_]+/g, "_").slice(0, 60) || "chart";
      await (Plotly as any).downloadImage(graphDivRef.current, {
        format,
        filename: safeName,
        width: 1200,
        height: 800,
      });
    } catch {
      // Non-fatal - the chart is still on screen either way.
    } finally {
      setDownloading("");
    }
  };

  // Server-built chart specs always use the Plotly dark template. When the
  // person is in light mode we layer light-friendly colors on top on the
  // client, rather than teaching the backend about the viewer theme.
  const themedLayout =
    theme === "light"
      ? {
          ...chartSpec.layout,
          template: undefined,
          paper_bgcolor: "#FFFFFF",
          plot_bgcolor: "#FFFFFF",
          font: { ...(chartSpec.layout?.font || {}), color: "#171725" },
          xaxis: { ...(chartSpec.layout?.xaxis || {}), gridcolor: "#E7E9F2", zerolinecolor: "#DDE0EC", linecolor: "#DDE0EC" },
          yaxis: { ...(chartSpec.layout?.yaxis || {}), gridcolor: "#E7E9F2", zerolinecolor: "#DDE0EC", linecolor: "#DDE0EC" },
          legend: { ...(chartSpec.layout?.legend || {}), font: { color: "#171725" } },
        }
      : chartSpec.layout;

  return (
    <div className="card p-4 h-full flex flex-col overflow-hidden">
      <div className="flex items-center justify-between mb-2 shrink-0">
        <div className="text-xs text-muted">Export chart as</div>
        <div className="flex gap-1.5">
          {EXPORT_FORMATS.map((f) => (
            <button
              key={f.value}
              disabled={!!downloading}
              className="text-xs btn-secondary px-2.5 py-1 disabled:opacity-50"
              onClick={() => download(f.value)}
            >
              {downloading === f.value ? "..." : f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <Plot
          data={chartSpec.data}
          layout={{ ...themedLayout, autosize: true, title: title || chartSpec.layout?.title }}
          style={{ width: "100%", height: "100%", minHeight: 380 }}
          useResizeHandler
          config={{ displaylogo: false, responsive: true }}
          onInitialized={(_figure: any, graphDiv: any) => {
            graphDivRef.current = graphDiv;
          }}
          onUpdate={(_figure: any, graphDiv: any) => {
            graphDivRef.current = graphDiv;
          }}
        />
      </div>
    </div>
  );
}

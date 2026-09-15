import Plot from "react-plotly.js";

export default function ChartCanvas({ chartSpec, title }: { chartSpec: any; title?: string }) {
  if (!chartSpec) {
    return (
      <div className="card h-full flex items-center justify-center text-muted p-10 text-center">
        Ask GD360 something about your data (left panel) and your chart will appear here — interactive,
        exportable, and ready to customize.
      </div>
    );
  }

  return (
    <div className="card p-4 h-full">
      <Plot
        data={chartSpec.data}
        layout={{ ...chartSpec.layout, autosize: true, title: title || chartSpec.layout?.title }}
        style={{ width: "100%", height: "100%", minHeight: 420 }}
        useResizeHandler
        config={{ displaylogo: false, responsive: true }}
      />
    </div>
  );
}

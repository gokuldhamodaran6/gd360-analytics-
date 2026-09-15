const CHART_TYPES = [
  "bar", "line", "area", "pie", "scatter", "histogram", "box", "heatmap", "waterfall", "funnel", "treemap",
];

export default function ChartCustomizer({ onApply, disabled }: { onApply: (override: { chart_type?: string; title?: string }) => void; disabled?: boolean }) {
  return (
    <div className="card p-4">
      <div className="text-sm font-semibold mb-3">Customize this chart</div>
      <div className="flex flex-wrap gap-2">
        {CHART_TYPES.map((t) => (
          <button
            key={t}
            disabled={disabled}
            className="btn-secondary text-xs px-3 py-1.5 capitalize"
            onClick={() => onApply({ chart_type: t })}
          >
            {t}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted mt-3">
        Or just type customization requests in the chat, e.g. "make it a pie chart" or "title it Q3 Revenue by Region".
      </p>
    </div>
  );
}

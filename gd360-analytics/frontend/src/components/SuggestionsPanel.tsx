export default function SuggestionsPanel({
  charts, stats, onPick,
}: {
  charts?: { chart_type: string; title: string; reason: string }[] | null;
  stats?: { method: string; reason: string }[] | null;
  onPick: (prompt: string) => void;
}) {
  if ((!charts || charts.length === 0) && (!stats || stats.length === 0)) return null;

  return (
    <div className="card p-4 space-y-4">
      {charts && charts.length > 0 && (
        <div>
          <div className="text-sm font-semibold mb-2">Suggested charts</div>
          <div className="space-y-2">
            {charts.map((c, i) => (
              <button
                key={i}
                className="w-full text-left text-xs bg-surface2 hover:bg-[#21213A] border border-border rounded-lg px-3 py-2 transition"
                onClick={() => onPick(`Show me: ${c.title} (as a ${c.chart_type} chart)`)}
              >
                <div className="font-medium text-text">{c.title}</div>
                <div className="text-muted mt-0.5">{c.reason}</div>
              </button>
            ))}
          </div>
        </div>
      )}
      {stats && stats.length > 0 && (
        <div>
          <div className="text-sm font-semibold mb-2">Suggested statistical methods</div>
          <div className="space-y-2">
            {stats.map((s, i) => (
              <button
                key={i}
                className="w-full text-left text-xs bg-surface2 hover:bg-[#21213A] border border-border rounded-lg px-3 py-2 transition"
                onClick={() => onPick(`Run ${s.method} and explain the result.`)}
              >
                <div className="font-medium text-text">{s.method}</div>
                <div className="text-muted mt-0.5">{s.reason}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

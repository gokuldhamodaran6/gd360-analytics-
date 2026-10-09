// 2026-10-08 (round 13): ML Studio home - start from a goal in words, see
// every model (training, ready or stopped).
// 2026-10-09 (round 14): choose what to learn from (any connected table or
// uploaded file), start from a table's suggested ideas, and no more side
// doors to the classic wizard or the Experiments page.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { FAMILY_COLOR, metricLine, mlStudioApi, StudioProject, StudioTable, TYPE_LABEL } from "../api/mlStudio";
import { timeAgo } from "../project/format";

const FAMILY_OF: Record<string, string> = {
  yes_no: "Predict", number: "Predict", drivers: "Discover", segments: "Discover", anomalies: "Discover", forecast_one: "Forecast", forecast_many: "Forecast",
};

export default function MLStudio() {
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [items, setItems] = useState<StudioProject[] | null>(null);
  const [goal, setGoal] = useState("");
  const [error, setError] = useState("");
  const [tables, setTables] = useState<StudioTable[]>([]);
  const [from, setFrom] = useState("");

  useEffect(() => {
    mlStudioApi.types().then((t) => setTables(t.tables)).catch(() => {});
  }, []);

  useEffect(() => {
    mlStudioApi.list().then(setItems).catch(() => {
      setItems([]);
      setError("Couldn't load your models.");
    });
  }, []);

  useEffect(() => {
    if (!items?.some((p) => p.status === "training")) return;
    const t = setInterval(() => mlStudioApi.list().then(setItems).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [items]);

  const go = () => {
    const q = new URLSearchParams();
    if (goal.trim()) q.set("goal", goal.trim());
    if (from) {
      const [sid, tbl] = from.split("::");
      q.set("source", sid);
      q.set("table", tbl);
    }
    navigate(`/ml-studio/new${q.toString() ? `?${q}` : ""}`);
  };
  const startFrom = (t: StudioTable, type: string) =>
    navigate(`/ml-studio/new?${new URLSearchParams({ type, source: t.source_id, table: t.table })}`);
  const open = (p: StudioProject) => navigate(p.problem_type ? `/ml-studio/${p.id}` : `/ml-models/${p.id}`);

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />
        <main className="px-4 sm:px-8 lg:px-10 py-8 max-w-[1160px] mx-auto flex flex-col gap-7">
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div className="flex flex-col gap-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">ML Studio</span>
              <h1 className="m-0 text-[30px] sm:text-[34px] font-bold tracking-tight text-text">Predict, forecast and discover</h1>
              <p className="m-0 text-body text-secondary max-w-[64ch]">
                Say what you want to know. GD360 picks the method, builds the label and features from your data, tests every model on rows it never saw, and
                tells you which columns it left out and why.
              </p>
            </div>
            <Link to="/ml-studio/new" className="btn-primary text-sm">+ New project</Link>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              go();
            }}
            className="rounded-card border border-border bg-surface p-4 sm:p-5 flex flex-col gap-3"
          >
            <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
              <label htmlFor="ml-goal" className="sr-only">What do you want to predict or discover?</label>
              <input
                id="ml-goal"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="e.g. Which customers are likely to stop buying in the next 30 days?"
                className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[17px] text-text placeholder:text-faint"
              />
              <button type="submit" className="btn-primary text-sm shrink-0">Make a plan →</button>
            </div>
            <div className="flex items-center gap-2.5 flex-wrap border-t border-border pt-3">
              <label htmlFor="ml-from-home" className="text-ui text-secondary">Learn from</label>
              <select
                id="ml-from-home"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-9 min-w-0 max-w-full flex-1 sm:flex-none sm:min-w-[320px] rounded-ctl border border-border bg-base px-2.5 text-ui text-text"
              >
                <option value="">Let GD360 choose from all your data</option>
                {tables.map((t) => (
                  <option key={`${t.source_id}::${t.table}`} value={`${t.source_id}::${t.table}`}>{t.source} · {t.table}</option>
                ))}
              </select>
              <Link to="/data" className="text-ui text-muted underline hover:text-text">Upload a file or connect a source</Link>
            </div>
          </form>

          {tables.length > 0 && (
            <section className="flex flex-col gap-3" aria-label="Start from your data">
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <h2 className="m-0 text-title font-semibold text-text">Start from your data</h2>
                <span className="text-caption text-muted">Ideas from each table's columns — pick one and GD360 makes the plan</span>
              </div>
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 340px), 1fr))" }}>
                {tables.slice(0, 6).map((t) => (
                  <div key={`${t.source_id}::${t.table}`} className="rounded-card border border-border bg-surface p-4 flex flex-col gap-3 min-w-0">
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-body font-semibold text-text truncate">{t.table}</span>
                      <span className="text-caption text-muted truncate">{t.source} · {t.columns.length} columns</span>
                    </div>
                    <div className="flex gap-1.5 flex-wrap">
                      {ideasFor(t).map((i) => (
                        <button
                          key={i.type}
                          type="button"
                          onClick={() => startFrom(t, i.type)}
                          className="h-8 px-2.5 rounded-ctl border text-caption hover:border-border-strong"
                          style={{ borderColor: "rgb(var(--auto-do-border))", background: "rgb(var(--auto-do-fill) / 0.35)", color: "rgb(var(--auto-do))" }}
                        >
                          {i.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {error && <div role="alert" className="rounded-card border border-danger-border bg-danger-fill px-4 py-3 text-ui text-text">{error}</div>}

          <section className="flex flex-col gap-3" aria-label="Your models">
            <h2 className="m-0 text-title font-semibold text-text">Your models{items ? ` · ${items.length}` : ""}</h2>
            {!items && <div className="text-ui text-muted">Loading…</div>}
            {items && items.length === 0 && (
              <div className="rounded-card border border-dashed border-border-strong p-6 text-ui text-muted">
                No models yet. Describe what you want above, or <Link to="/ml-studio/new" className="underline hover:text-text">pick a problem type</Link>.
              </div>
            )}
            {items && items.length > 0 && (
              <div className="rounded-card border border-border bg-surface overflow-hidden">
                {items.map((p) => {
                  const fam = p.problem_type ? FAMILY_OF[p.problem_type] : "Predict";
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => open(p)}
                      className="w-full text-left flex items-center gap-4 px-4 sm:px-5 py-3.5 border-t first:border-t-0 border-border hover:bg-subtle"
                    >
                      <span
                        className="shrink-0 font-mono text-[10.5px] uppercase tracking-[0.06em] px-2 py-1 rounded"
                        style={{ color: FAMILY_COLOR[fam], background: "rgb(var(--color-subtle))" }}
                      >
                        {p.problem_type ? TYPE_LABEL[p.problem_type] || p.problem_type : p.task_type === "regression" ? "Number" : "Yes / no"}
                      </span>
                      <span className="flex flex-col min-w-0 flex-1">
                        <span className="text-body text-text truncate">{p.name}</span>
                        <span className="text-caption text-muted truncate">
                          {p.source}
                          {p.table ? ` · ${p.table}` : ""}
                          {p.rows ? ` · ${p.rows.toLocaleString()} rows` : ""}
                        </span>
                      </span>
                      <span className={`hidden sm:block text-ui text-right max-w-[300px] truncate ${p.status === "failed" ? "text-danger" : p.status === "training" ? "text-[rgb(var(--auto-tell))]" : "text-secondary"}`}>
                        {p.status === "training" && <span className="inline-block w-1.5 h-1.5 rounded-full bg-[rgb(var(--auto-tell))] animate-pulse mr-2 align-middle" />}
                        {metricLine(p)}
                      </span>
                      <span className="hidden md:block text-caption text-muted w-[84px] text-right">{timeAgo(p.trained_at || p.created_at)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

        </main>
      </div>
    </div>
  );
}

const DATE_HINT = /(date|time|day|week|month|year|_at$|created|period)/i;
const NUM_TYPE = /(int|float|double|numeric|decimal|number|real|money)/i;
const OUTCOME_HINT = /(churn|cancel|is_|has_|status|converted|default|fraud|returned|left|active|won|lost|paid)/i;

/** What a table can be used for, read off its column names and types. */
function ideasFor(t: StudioTable): { type: string; label: string }[] {
  const cols = t.columns || [];
  const hasDate = cols.some((c) => DATE_HINT.test(c.name) || /date|time/i.test(c.type || ""));
  const nums = cols.filter((c) => NUM_TYPE.test(c.type || "")).length;
  const outcome = cols.some((c) => OUTCOME_HINT.test(c.name));
  const out: { type: string; label: string }[] = [];
  if (outcome) out.push({ type: "yes_no", label: "Predict an outcome" });
  if (hasDate && nums) out.push({ type: "forecast_one", label: "Forecast" });
  if (nums >= 2) out.push({ type: "segments", label: "Find segments" });
  if (nums) out.push({ type: "anomalies", label: "Spot unusual rows" });
  if (nums && out.length < 4) out.push({ type: "drivers", label: "What drives a number" });
  return out.slice(0, 4);
}

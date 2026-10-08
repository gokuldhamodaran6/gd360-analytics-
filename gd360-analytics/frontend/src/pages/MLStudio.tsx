// 2026-10-08 (round 13): ML Studio home - start from a goal in words, see
// every model (training, ready or stopped), and reach Experiments.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { FAMILY_COLOR, metricLine, mlStudioApi, StudioProject, TYPE_LABEL } from "../api/mlStudio";
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

  const go = () => navigate(`/ml-studio/new${goal.trim() ? `?goal=${encodeURIComponent(goal.trim())}` : ""}`);
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
            <div className="flex gap-2">
              <Link to="/experiments" className="btn-secondary text-sm">Experiments</Link>
              <Link to="/ml-studio/new" className="btn-primary text-sm">+ New project</Link>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              go();
            }}
            className="rounded-card border border-border bg-surface p-4 sm:p-5 flex flex-col sm:flex-row gap-3 sm:items-center"
          >
            <label htmlFor="ml-goal" className="sr-only">What do you want to predict or discover?</label>
            <input
              id="ml-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="e.g. Which customers are likely to stop buying in the next 30 days?"
              className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[17px] text-text placeholder:text-faint"
            />
            <button type="submit" className="btn-primary text-sm shrink-0">Make a plan →</button>
          </form>

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
                          {!p.problem_type ? " · classic wizard" : ""}
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

          <p className="m-0 text-caption text-muted">
            Prefer to pick every column yourself? <Link to="/ml-models/classic" className="underline hover:text-text">Use the classic model wizard</Link>.
          </p>
        </main>
      </div>
    </div>
  );
}

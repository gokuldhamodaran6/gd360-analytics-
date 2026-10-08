// 2026-10-08 (round 13): ML Studio - new project. Describe the goal (or pick
// a problem type); GD360 understands it, then shows a plan computed from the
// real data - label, features, leak check, fair test, compute, output -
// which can be adjusted before training starts.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { FAMILY_COLOR, mlStudioApi, Plan, ProblemType, Spec, StudioTable } from "../api/mlStudio";

function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  return typeof d === "string" && d.trim() ? d : fallback;
}

const UNDERSTOOD: Record<string, string> = {
  yes_no: "predict yes / no",
  number: "predict a number",
  drivers: "what drives a number",
  segments: "find segments",
  anomalies: "find anomalies",
  forecast_one: "forecast one series",
  forecast_many: "forecast many series",
};

const FAMILIES = ["Predict", "Forecast", "Discover", "Decide", "Language"] as const;

export default function MLStudioNew() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [goal, setGoal] = useState(params.get("goal") || "");
  const [types, setTypes] = useState<ProblemType[]>([]);
  const [tables, setTables] = useState<StudioTable[]>([]);
  const [spec, setSpec] = useState<Spec | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<"" | "understand" | "plan" | "start">("");
  const [error, setError] = useState("");
  const [adjust, setAdjust] = useState(false);
  const asked = useRef(false);

  useEffect(() => {
    mlStudioApi.types().then((t) => {
      setTypes(t.types);
      setTables(t.tables);
    }).catch(() => setError("Couldn't load ML Studio."));
  }, []);

  const makePlan = async (s: Spec) => {
    setBusy("plan");
    setError("");
    try {
      const p = await mlStudioApi.plan(s);
      setPlan(p);
      setSpec({ ...s, ...p.spec });
    } catch (e: any) {
      setPlan(null);
      setSpec(s);
      setError(errorText(e, "Couldn't make a plan from that table."));
      setAdjust(true);
    } finally {
      setBusy("");
    }
  };

  const understand = async (problemType?: string) => {
    setBusy("understand");
    setError("");
    try {
      const s = await mlStudioApi.understand(goal, problemType || null, null);
      setSpec(s);
      await makePlan(s);
    } catch (e: any) {
      setError(errorText(e, "Couldn't understand that - try picking a problem type below."));
      setBusy("");
    }
  };

  useEffect(() => {
    if (!asked.current && goal.trim().length > 6) {
      asked.current = true;
      understand();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    if (!spec || !plan) return;
    setBusy("start");
    setError("");
    try {
      const name = (goal.trim() || plan.title).replace(/\?$/, "").slice(0, 80);
      const out = await mlStudioApi.start(plan.spec, name, goal.trim());
      navigate(`/ml-studio/${out.id}`);
    } catch (e: any) {
      setError(errorText(e, "Couldn't start training."));
      setBusy("");
    }
  };

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />
        <main className="px-4 sm:px-8 lg:px-10 py-7 max-w-[1320px] mx-auto flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-caption text-muted uppercase tracking-[0.06em]">
              <Link to="/ml-models" className="hover:text-text">ML Studio</Link> / New project
            </span>
            <h1 className="m-0 text-[28px] sm:text-[32px] font-bold tracking-tight text-text text-balance">What do you want to predict or discover?</h1>
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)] items-start">
            <div className="flex flex-col gap-5 min-w-0">
              <form
                className="rounded-card border p-5 flex flex-col gap-4"
                style={{ borderColor: "rgb(var(--auto-do-border))", background: "rgb(var(--auto-do-fill) / 0.3)" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (goal.trim().length > 3) understand();
                }}
              >
                <label htmlFor="ml-goal" className="sr-only">Your goal</label>
                <textarea
                  id="ml-goal"
                  value={goal}
                  rows={2}
                  onChange={(e) => setGoal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (goal.trim().length > 3) understand();
                    }
                  }}
                  placeholder="Which customers are likely to stop buying in the next 30 days?"
                  className="w-full resize-none bg-transparent border-0 outline-none text-[19px] leading-snug text-text placeholder:text-faint"
                />
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <span className="text-ui text-muted">Describe it in your own words — GD360 picks the method.</span>
                  {spec && plan && busy === "" ? (
                    <span className="font-mono text-caption" style={{ color: "rgb(var(--auto-do))" }}>✓ understood as: {UNDERSTOOD[spec.problem_type] || spec.problem_type}</span>
                  ) : (
                    <button type="submit" className="btn-secondary text-sm" disabled={!!busy || goal.trim().length < 4}>
                      {busy === "understand" || busy === "plan" ? "Reading your data…" : "Make a plan"}
                    </button>
                  )}
                </div>
              </form>

              <div className="flex flex-col gap-4" aria-label="Problem types">
                <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Or choose a problem type</span>
                {FAMILIES.map((fam) => (
                  <div key={fam} className="flex flex-col gap-2.5">
                    <span className="text-ui font-semibold" style={{ color: FAMILY_COLOR[fam] }}>{fam}</span>
                    <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-3">
                      {types.filter((t) => t.family === fam).map((t) => {
                        const on = spec?.problem_type === t.id;
                        return (
                          <button
                            key={t.id}
                            type="button"
                            disabled={!t.ready || !!busy}
                            aria-pressed={on}
                            onClick={() => understand(t.id)}
                            className={`text-left rounded-card border p-3.5 flex flex-col gap-1 transition-colors ${
                              on ? "" : "border-border bg-surface hover:border-border-strong"
                            } disabled:cursor-not-allowed ${t.ready ? "" : "opacity-55"}`}
                            style={on ? { borderColor: "rgb(var(--auto-do))", background: "rgb(var(--auto-do-fill) / 0.5)" } : undefined}
                          >
                            <span className="flex items-center justify-between gap-2">
                              <span className="text-ui font-semibold text-text">{t.title}</span>
                              {!t.ready && <span className="font-mono text-[10px] uppercase text-muted">Soon</span>}
                            </span>
                            <span className="text-caption text-muted leading-snug">{t.sub}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <aside className="rounded-card border border-border bg-surface p-5 flex flex-col gap-4 lg:sticky lg:top-4" aria-label="GD360's plan">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em]" style={{ color: "rgb(var(--auto-do))" }}>GD360's plan</span>
              {!plan && !busy && !error && (
                <p className="m-0 text-ui text-muted leading-relaxed">
                  Describe your goal or pick a problem type. The plan is worked out from your real data: how the answer is labelled, which columns it learns
                  from, what is left out and why, and how it is tested.
                </p>
              )}
              {(busy === "understand" || busy === "plan") && (
                <div className="flex items-center gap-2.5 text-ui text-muted">
                  <span className="w-4 h-4 rounded-full border-2 border-border border-t-[rgb(var(--auto-do))] animate-spin" />
                  {busy === "understand" ? "Understanding your goal…" : "Reading the table and checking every column…"}
                </div>
              )}
              {error && <div role="alert" className="rounded-ctl border border-danger-border bg-danger-fill px-3 py-2.5 text-ui text-text">{error}</div>}
              {plan && busy !== "understand" && busy !== "plan" && (
                <>
                  <h2 className="m-0 text-[19px] font-bold leading-snug text-text text-balance">{plan.title}</h2>
                  <dl className="m-0 flex flex-col">
                    {plan.rows_text.map((r) => (
                      <div key={r.k} className="grid grid-cols-[96px_1fr] gap-3 py-3 border-t border-border">
                        <dt className="text-ui text-muted">{r.k}</dt>
                        <dd className="m-0 flex flex-col gap-1 min-w-0">
                          <span className={`text-ui leading-snug ${r.k === "Leak check" && /removed/.test(r.v) ? "text-warning" : "text-text"}`}>{r.v}</span>
                          {r.m && <span className="font-mono text-[11px] text-muted break-words">{r.m}</span>}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {plan.warnings.map((w) => (
                    <div key={w} className="rounded-ctl border border-warning-border bg-warning-fill px-3 py-2 text-caption text-text">{w}</div>
                  ))}
                </>
              )}
              {spec && adjust && (
                <AdjustPanel
                  spec={spec}
                  tables={tables}
                  onApply={(s) => {
                    setAdjust(false);
                    makePlan(s);
                  }}
                  onCancel={() => setAdjust(false)}
                  busy={!!busy}
                />
              )}
              {spec && (
                <div className="flex gap-2 flex-wrap pt-1">
                  {!adjust && <button type="button" className="btn-secondary text-sm" onClick={() => setAdjust(true)} disabled={!!busy}>Adjust plan</button>}
                  <button type="button" className="btn-primary text-sm" onClick={start} disabled={!plan || !!busy || adjust}>
                    {busy === "start" ? "Starting…" : "Start training →"}
                  </button>
                </div>
              )}
            </aside>
          </div>
        </main>
      </div>
    </div>
  );
}

const SELECT = "h-9 w-full rounded-ctl border border-border bg-base px-2.5 text-ui text-text";

function AdjustPanel({ spec, tables, onApply, onCancel, busy }: { spec: Spec; tables: StudioTable[]; onApply: (s: Spec) => void; onCancel: () => void; busy: boolean }) {
  const [s, setS] = useState<Spec>(spec);
  const t = tables.find((x) => x.source_id === s.source_id && x.table === s.table) || tables.find((x) => x.source_id === s.source_id);
  const cols = useMemo(() => (t?.columns || []).map((c) => c.name), [t]);
  const ptype = s.problem_type;
  const supervised = ["yes_no", "number", "drivers"].includes(ptype);
  const forecast = ptype.startsWith("forecast");
  const field = (label: string, child: React.ReactNode) => (
    <label className="flex flex-col gap-1 text-caption text-muted">
      {label}
      {child}
    </label>
  );
  const colSelect = (key: keyof Spec, label: string, allowNone = false) =>
    field(
      label,
      <select className={SELECT} value={(s[key] as string) || ""} onChange={(e) => setS({ ...s, [key]: e.target.value || null })}>
        {allowNone && <option value="">None</option>}
        {!allowNone && !s[key] && <option value="">Pick a column…</option>}
        {cols.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    );
  return (
    <div className="rounded-card border border-border-strong bg-base p-3.5 flex flex-col gap-3" aria-label="Adjust the plan">
      {field(
        "Table",
        <select
          className={SELECT}
          value={`${s.source_id}::${s.table}`}
          onChange={(e) => {
            const [sid, tb] = e.target.value.split("::");
            setS({ ...s, source_id: sid, table: tb, target: null, time_column: null, value_column: null, group_column: null, exclude: [] });
          }}
        >
          {tables.map((x) => <option key={`${x.source_id}::${x.table}`} value={`${x.source_id}::${x.table}`}>{x.source} · {x.table}</option>)}
        </select>
      )}
      {supervised && colSelect("target", ptype === "drivers" ? "The number (or outcome) to explain" : "Column to predict")}
      {(supervised || forecast) && colSelect("time_column", forecast ? "Date column" : "Date column (test on the most recent rows)", !forecast)}
      {forecast && colSelect("value_column", "Number to forecast (none = count rows)", true)}
      {ptype === "forecast_many" && colSelect("group_column", "Column naming each series")}
      {forecast &&
        field(
          "Period",
          <select className={SELECT} value={s.grain || ""} onChange={(e) => setS({ ...s, grain: e.target.value || null })}>
            <option value="">Automatic</option>
            {["day", "week", "month", "quarter"].map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        )}
      {ptype === "anomalies" &&
        field(
          "Flag the most unusual",
          <select className={SELECT} value={String(s.share || 0.02)} onChange={(e) => setS({ ...s, share: Number(e.target.value) })}>
            {[0.005, 0.01, 0.02, 0.05, 0.1].map((v) => <option key={v} value={v}>{v * 100}% of rows</option>)}
          </select>
        )}
      {!forecast && (
        <div className="flex flex-col gap-1.5 text-caption text-muted">
          Leave out
          <div className="flex flex-wrap gap-1.5">
            {cols.filter((c) => c !== s.target && c !== s.time_column).map((c) => {
              const out = (s.exclude || []).includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={out}
                  onClick={() => setS({ ...s, exclude: out ? (s.exclude || []).filter((x) => x !== c) : [...(s.exclude || []), c] })}
                  className={`h-7 px-2 rounded-md border text-caption ${out ? "border-danger-border bg-danger-fill text-danger line-through" : "border-border text-secondary hover:text-text"}`}
                >
                  {c}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <button type="button" className="btn-primary text-sm" onClick={() => onApply(s)} disabled={busy}>Update the plan</button>
        <button type="button" className="btn-secondary text-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// 2026-10-08 (round 13): ML Studio - new project. Describe the goal (or pick
// a problem type); GD360 understands it, then shows a plan computed from the
// real data - label, features, leak check, fair test, compute, output -
// which can be adjusted before training starts.
// 2026-10-09 (round 15): learn inside a Space or from several tables joined
// (1 Choose tables -> 2 Check the join -> 3 Plan), all 21 kinds, and an
// Adjust panel built from each kind's own inputs.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import {
  errorText,
  FAMILIES,
  FAMILY_COLOR,
  JoinCandidate,
  JoinPreview,
  JoinRef,
  mlStudioApi,
  Plan,
  ProblemType,
  Spec,
  StudioTable,
  TYPE_LABEL,
} from "../api/mlStudio";
import { Space, spacesApi } from "../api/spaces";
import AdjustPanel from "../ml/AdjustPanel";
import { candKey, CheckJoin, ChooseTables, MAX_JOINS, Stepper } from "../ml/JoinFlow";
import { joinsSentence } from "../ml/ResultSections";

const understoodAs = (t: string) => (TYPE_LABEL[t] || t).toLowerCase();

export default function MLStudioNew() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const spaceId = params.get("space") || "";
  const [goal, setGoal] = useState(params.get("goal") || "");
  const [types, setTypes] = useState<ProblemType[]>([]);
  const [tables, setTables] = useState<StudioTable[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [space, setSpace] = useState<Space | null>(null);
  const [spec, setSpec] = useState<Spec | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<"" | "understand" | "plan" | "start">("");
  const [error, setError] = useState("");
  const [adjust, setAdjust] = useState(false);
  const [learnFrom, setLearnFrom] = useState(params.get("source") ? `${params.get("source")}::${params.get("table") || ""}` : "");
  const asked = useRef(false);

  // round 15: several tables joined
  const [joinMode, setJoinMode] = useState(params.get("join") === "1");
  const [step, setStep] = useState(1);
  const [base, setBase] = useState(params.get("source") && params.get("table") ? `${params.get("source")}::${params.get("table")}` : "");
  const [candidates, setCandidates] = useState<JoinCandidate[] | null>(null);
  const [candLoading, setCandLoading] = useState(false);
  const [candError, setCandError] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [preview, setPreview] = useState<JoinPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [joins, setJoins] = useState<JoinRef[]>([]);

  useEffect(() => {
    mlStudioApi
      .types(spaceId || null)
      .then((t) => {
        setTypes(t.types);
        setTables(t.tables);
      })
      .catch((e) => setError(errorText(e, "Couldn't load ML Studio.")))
      .finally(() => setLoaded(true));
  }, [spaceId]);

  useEffect(() => {
    if (!spaceId) return;
    spacesApi
      .list(activeWorkspaceId)
      .then((list) => setSpace(list.find((s) => s.id === spaceId) || null))
      .catch(() => {});
  }, [spaceId, activeWorkspaceId]);

  // step 1: tables that share a key with the main table
  useEffect(() => {
    if (!joinMode || !base) return;
    const [sid, tbl] = base.split("::");
    let live = true;
    setCandLoading(true);
    setCandError("");
    setCandidates(null);
    mlStudioApi
      .joinSuggest(sid, tbl || null, spaceId || null)
      .then((c) => {
        if (!live) return;
        setCandidates(c);
        // keep what was already picked (coming back from step 2), else the strongest few
        setPicked((cur) => {
          const still = cur.filter((k) => c.some((x) => candKey(x) === k));
          return still.length ? still : c.filter((x) => x.overlap >= 0.5).slice(0, 3).map(candKey);
        });
      })
      .catch((e) => live && setCandError(errorText(e, "Couldn't look for tables to join.")))
      .finally(() => live && setCandLoading(false));
    return () => {
      live = false;
    };
  }, [joinMode, base, spaceId]);

  const makePlan = async (s: Spec) => {
    setBusy("plan");
    setError("");
    try {
      const p = await mlStudioApi.plan(s);
      setPlan(p);
      // the plan's spec fills every guessed column; the joins chosen here stay
      setSpec({ ...s, ...p.spec, joins: p.spec?.joins ?? s.joins ?? null });
    } catch (e: any) {
      setPlan(null);
      setSpec(s);
      setError(errorText(e, "Couldn't make a plan from that table."));
      setAdjust(true);
    } finally {
      setBusy("");
    }
  };

  const understand = async (problemType?: string, from: string = learnFrom, withJoins: JoinRef[] = joins, inSpace: string = spaceId) => {
    setBusy("understand");
    setError("");
    setAdjust(false);
    try {
      const scopeFrom = withJoins.length ? base : from;
      const [sid, tbl] = scopeFrom ? scopeFrom.split("::") : [null, null];
      const s = await mlStudioApi.understand(goal, problemType || null, sid || null, tbl || null, inSpace || null, withJoins.length ? withJoins : null);
      setSpec(s);
      await makePlan(s);
    } catch (e: any) {
      setError(errorText(e, "Couldn't understand that - try picking a kind below."));
      setBusy("");
    }
  };

  useEffect(() => {
    if (asked.current || joinMode) return;
    if (goal.trim().length > 6 || params.get("type")) {
      asked.current = true;
      understand(params.get("type") || undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkJoin = async () => {
    const [sid, tbl] = base.split("::");
    const chosen = (candidates || []).filter((c) => picked.includes(candKey(c)));
    const refs: JoinRef[] = chosen.map((c) => ({ source_id: c.source_id, table: c.table, key: c.key, base_key: c.base_key }));
    if (!refs.length) {
      // one table after all - straight to the plan
      setJoins([]);
      setLearnFrom(base);
      setStep(3);
      understand(params.get("type") || spec?.problem_type, base, []);
      return;
    }
    setStep(2);
    setPreview(null);
    setPreviewError("");
    setPreviewLoading(true);
    try {
      const p = await mlStudioApi.joinPreview({ source_id: sid, table: tbl, joins: refs, space_id: spaceId || null });
      setPreview(p);
      setJoins(refs);
    } catch (e: any) {
      setPreviewError(errorText(e, "Couldn't build the join."));
    } finally {
      setPreviewLoading(false);
    }
  };

  const toPlan = () => {
    setStep(3);
    understand(params.get("type") || spec?.problem_type, base, joins);
  };

  // round 15: the goal fits a table outside the Space better - learn from it instead
  const leaveSpace = (h: NonNullable<Spec["scope_hint"]>) => {
    const next = new URLSearchParams(params);
    next.delete("space");
    next.set("source", h.source_id);
    next.set("table", h.table);
    setParams(next, { replace: true });
    const from = `${h.source_id}::${h.table}`;
    setLearnFrom(from);
    understand(spec?.problem_type, from, [], "");
  };

  const startJoin = () => {
    const from = spec ? `${spec.source_id}::${spec.table}` : learnFrom;
    setBase(from || "");
    setJoinMode(true);
    setStep(1);
  };

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

  const typeDef = types.find((t) => t.id === spec?.problem_type);
  const joinedNow = joins.length > 0 || !!(spec?.joins && spec.joins.length);
  const valuesOf = useMemo(
    () => (column: string): string[] => {
      const out = new Set<string>();
      if (plan?.label?.classes && (plan.target === column || plan.spec?.target === column)) plan.label.classes.forEach((c) => out.add(String(c)));
      (preview?.preview || []).forEach((r) => {
        const v = r[column];
        if (v !== null && v !== undefined && v !== "") out.add(String(v));
      });
      return Array.from(out).slice(0, 60);
    },
    [plan, preview],
  );

  const showPlanStage = !joinMode || step === 3;
  const scopeLine = space ? `Learning from the ${space.name} Space` : spaceId ? "Learning from a Space" : "";
  const planJoinsLine = joinsSentence(plan?.joins, "Learns from");

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />
        <main className="px-4 sm:px-8 lg:px-10 py-7 max-w-[1320px] mx-auto flex flex-col gap-6">
          <header className="flex flex-col gap-2">
            <span className="font-mono text-caption text-muted uppercase tracking-[0.06em]">
              <Link to="/ml-models" className="hover:text-text">← ML Studio</Link> / New project
            </span>
            <h1 className="m-0 text-[24px] sm:text-[30px] font-semibold tracking-tight text-text text-balance leading-tight">
              {joinMode && goal.trim() ? goal.trim() : "What do you want to predict or discover?"}
            </h1>
            {(scopeLine || (spec && plan && busy === "")) && (
              <span className="inline-flex items-center gap-2 flex-wrap text-ui text-secondary">
                {scopeLine && (
                  <>
                    <span className="w-2 h-2 rounded-[3px]" style={{ background: space?.color || "rgb(var(--auto-do))" }} aria-hidden="true" />
                    {scopeLine}
                  </>
                )}
                {spec && plan && busy === "" && (
                  <span>
                    {scopeLine ? " · " : ""}understood as <b className="font-medium text-text">{understoodAs(spec.problem_type)}</b>
                  </span>
                )}
              </span>
            )}
          </header>

          {joinMode && (
            <Stepper
              step={step}
              canGo={(n) => (n === 1 ? true : n === 2 ? !!preview || previewLoading || !!previewError : !!spec || joins.length > 0)}
              onGo={(n) => setStep(n)}
            />
          )}

          {joinMode && step === 1 && (
            <ChooseTables
              tables={tables}
              base={base}
              onBase={(v) => {
                setBase(v);
                setPicked([]);
                setPreview(null);
                setJoins([]);
              }}
              spaceName={space?.name || null}
              candidates={candidates}
              loading={candLoading || (!loaded && !!base)}
              error={candError}
              picked={picked}
              onToggle={(k) =>
                setPicked((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : cur.length >= MAX_JOINS ? cur : [...cur, k]))
              }
              onNext={checkJoin}
              busy={!!busy}
            />
          )}

          {joinMode && step === 2 && (
            <CheckJoin preview={preview} tables={tables} loading={previewLoading} error={previewError} onBack={() => setStep(1)} onNext={toPlan} />
          )}

          {showPlanStage && (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)] items-start">
              <form
                className="rounded-card border p-4 sm:p-5 flex flex-col gap-4 min-w-0 lg:col-start-1 lg:row-start-1"
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
                  className="w-full resize-none bg-transparent border-0 outline-none text-[17px] sm:text-[19px] leading-snug text-text placeholder:text-faint"
                />
                <div className="flex items-center gap-2.5 flex-wrap border-t border-border pt-3">
                  <span className="text-ui text-secondary">Learn from</span>
                  {joins.length > 0 ? (
                    <>
                      <span className="text-ui text-text min-w-0">
                        {base.split("::")[1]} + {joins.length} joined table{joins.length === 1 ? "" : "s"}
                      </span>
                      <button
                        type="button"
                        className="text-ui text-muted underline hover:text-text"
                        onClick={() => {
                          setJoinMode(true);
                          setStep(1);
                        }}
                        disabled={!!busy}
                      >
                        Change tables
                      </button>
                    </>
                  ) : (
                    <>
                      <label htmlFor="ml-from" className="sr-only">Table to learn from</label>
                      <select
                        id="ml-from"
                        value={learnFrom}
                        disabled={!!busy}
                        onChange={(e) => {
                          setLearnFrom(e.target.value);
                          if (goal.trim().length > 3 || spec) understand(spec?.problem_type, e.target.value, []);
                        }}
                        className="h-9 max-w-full min-w-0 w-full sm:w-auto sm:min-w-[300px] rounded-ctl border border-border bg-base px-2.5 text-ui text-text"
                      >
                        <option value="">{space ? `Let GD360 choose from the ${space.name} Space` : "Let GD360 choose from all your data"}</option>
                        {tables.map((t) => (
                          <option key={`${t.source_id}::${t.table}`} value={`${t.source_id}::${t.table}`}>
                            {t.source} · {t.table}
                          </option>
                        ))}
                      </select>
                      <button type="button" className="text-ui text-muted underline hover:text-text" onClick={startJoin} disabled={!!busy || !tables.length}>
                        Join other tables
                      </button>
                      <Link to="/data?tab=catalog" className="text-ui text-muted underline hover:text-text">Upload a file</Link>
                    </>
                  )}
                </div>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <span className="text-ui text-muted">Describe it in your own words — GD360 picks the method.</span>
                  <button type="submit" className="btn-secondary text-sm" disabled={!!busy || goal.trim().length < 4}>
                    {busy === "understand" || busy === "plan" ? "Reading your data…" : spec ? "Plan again" : "Make a plan"}
                  </button>
                </div>
              </form>

              <aside
                className="rounded-card border border-border bg-surface p-4 sm:p-5 flex flex-col gap-4 min-w-0 lg:sticky lg:top-4 lg:col-start-2 lg:row-start-1 lg:row-span-2"
                aria-label="GD360's plan"
              >
                <span className="font-mono text-[11px] uppercase tracking-[0.12em]" style={{ color: "rgb(var(--auto-do))" }}>GD360's plan</span>
                {spec?.scope_hint && !busy && (
                  <div role="status" className="rounded-ctl border border-warning-border bg-warning-fill px-3 py-2.5 flex flex-col gap-2">
                    <span className="text-ui text-text leading-snug">{spec.scope_hint.text}</span>
                    <span className="flex gap-2 flex-wrap">
                      <button type="button" className="btn-secondary text-sm" onClick={() => leaveSpace(spec.scope_hint!)}>
                        Learn from {spec.scope_hint.table} instead
                      </button>
                    </span>
                  </div>
                )}
                {!plan && !busy && !error && (
                  <p className="m-0 text-ui text-muted leading-relaxed">
                    Describe your goal or pick a kind. The plan is worked out from your real data: how the answer is labelled, which columns it learns from,
                    what is left out and why, and how it is tested.
                  </p>
                )}
                {(busy === "understand" || busy === "plan") && (
                  <div className="flex items-center gap-2.5 text-ui text-muted" role="status">
                    <span className="w-4 h-4 rounded-full border-2 border-border border-t-[rgb(var(--auto-do))] animate-spin" aria-hidden="true" />
                    {busy === "understand" ? "Understanding your goal…" : joins.length ? "Joining the tables and checking every column…" : "Reading the table and checking every column…"}
                  </div>
                )}
                {error && <div role="alert" className="rounded-ctl border border-danger-border bg-danger-fill px-3 py-2.5 text-ui text-text">{error}</div>}
                {plan && busy !== "understand" && busy !== "plan" && (
                  <>
                    <h2 className="m-0 text-[19px] font-bold leading-snug text-text text-balance">{plan.title}</h2>
                    {planJoinsLine && <p className="m-0 text-caption text-secondary">{planJoinsLine}</p>}
                    <dl className="m-0 flex flex-col">
                      {plan.rows_text.map((r) => (
                        <div key={r.k} className="grid grid-cols-[84px_minmax(0,1fr)] sm:grid-cols-[96px_minmax(0,1fr)] gap-3 py-3 border-t border-border">
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
                    key={`${spec.problem_type}-${spec.source_id}-${spec.table}`}
                    spec={spec}
                    type={typeDef}
                    tables={tables}
                    planColumns={plan?.columns || (preview ? preview.columns.map((c) => c.name) : null)}
                    valuesOf={valuesOf}
                    joined={joinedNow}
                    busy={!!busy}
                    onApply={(s) => {
                      setAdjust(false);
                      makePlan(s);
                    }}
                    onCancel={() => setAdjust(false)}
                  />
                )}
                {spec && (
                  <div className="flex gap-2 flex-wrap pt-1">
                    {!adjust && (
                      <button type="button" className="btn-secondary text-sm" onClick={() => setAdjust(true)} disabled={!!busy}>
                        Adjust plan
                      </button>
                    )}
                    <button type="button" className="btn-primary text-sm" onClick={start} disabled={!plan || !!busy || adjust}>
                      {busy === "start" ? "Starting…" : "Start training →"}
                    </button>
                  </div>
                )}
              </aside>

              <div className="flex flex-col gap-4 min-w-0 lg:col-start-1 lg:row-start-2" aria-label="Kinds of project">
                <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Or choose what to build · {types.length || 21} kinds</span>
                {FAMILIES.map((fam) => {
                  const list = types.filter((t) => t.family === fam);
                  if (!list.length) return null;
                  return (
                    <div key={fam} className="flex flex-col gap-2.5">
                      <span className="inline-flex items-center gap-2 text-ui font-semibold text-text">
                        <span className="w-2 h-2 rounded-[3px]" style={{ background: FAMILY_COLOR[fam] }} aria-hidden="true" />
                        {fam}
                      </span>
                      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 200px), 1fr))" }}>
                        {list.map((t) => {
                          const on = spec?.problem_type === t.id;
                          return (
                            <button
                              key={t.id}
                              type="button"
                              disabled={!!busy}
                              aria-pressed={on}
                              onClick={() => understand(t.id)}
                              className={`text-left rounded-card border p-3.5 flex flex-col gap-1 transition-colors min-w-0 ${on ? "" : "border-border bg-surface hover:border-border-strong"} disabled:cursor-not-allowed`}
                              style={on ? { borderColor: "rgb(var(--auto-do))", background: "rgb(var(--auto-do-fill) / 0.5)" } : undefined}
                            >
                              <span className="text-ui font-semibold text-text">{t.title}</span>
                              <span className="text-caption text-muted leading-snug">{t.sub}</span>
                              {t.needs && <span className="mt-1 font-mono text-[10.5px] text-faint">needs {t.needs}</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

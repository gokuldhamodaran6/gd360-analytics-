// 2026-10-08 (round 13): one ML Studio project - live while it trains and its results when done.
// 2026-10-09 (round 15): every kind's results, the tables a model was joined from.
// 2026-10-12 (round 39): rebuilt on ML engine v2. The run reads as a story -
// where it stands (queued, training, ready), how much data it really used and
// why, then every step of the run with three views: Visual (charts of what
// the step did - the default), Code (the real SQL and Python that ran, the
// data step editable) and Rows (what the step produced). Scoring every row
// runs on the ML worker with live progress; the whole run exports as a
// notebook.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import {
  BoardRow,
  Engine,
  errorText,
  FAMILY_COLOR,
  FAMILY_OF,
  LEGACY_RESULTS,
  mlStudioApi,
  NOT_SCORABLE,
  Progress,
  Pushdown,
  RunData,
  Stage,
  StudioProject,
  TYPE_LABEL,
} from "../api/mlStudio";
import { timeAgo } from "../project/format";
import ResultSections, { Headline, joinsSentence } from "../ml/ResultSections";
import StageVisuals, { compact, RowsPreview } from "../ml/StageVisuals";
import CodeBlock from "../ml/CodeBlock";
import DataStep from "../ml/DataStep";
import ModelSql from "../ml/ModelSql";
import { CodeIcon, DatabaseIcon, DownloadIcon, ShieldCheckIcon, SegmentedControl, TableIcon, ChartIcon } from "../ui";

type Tab = "visual" | "code" | "rows";

const STRATEGY_WORDS: Record<string, string> = {
  all: "every row",
  stratified: "stratified sample",
  recent: "most recent rows",
  groups: "whole groups",
  uniform: "random sample",
  daily: "every row, summed per day",
  warehouse: "sampled by the warehouse",
};

function defaultStage(stages: Stage[], status?: string): string | null {
  if (!stages.length) return null;
  const running = stages.find((s) => s.status === "running");
  if (running) return running.id;
  if (status === "ready") {
    const pref = ["explain", "test", "train"].find((id) => stages.some((s) => s.id === id && (s.visual?.length || id === "train")));
    if (pref) return pref;
  }
  const lastDone = [...stages].reverse().find((s) => s.status === "done");
  return (lastDone || stages[0]).id;
}

function storyFor(p: StudioProject, kind: string, data?: RunData): string {
  const res = p.results || {};
  const used = data?.rows_used ?? res.train_rows;
  const total = data?.rows_total;
  const rowsBit = total
    ? used && used < total && data?.sample?.strategy !== "daily"
      ? `Learned from ${compact(used)} of ${compact(total)} rows (${STRATEGY_WORDS[data?.sample?.strategy || ""] || "a fair sample"})`
      : `Learned from all ${Number(total).toLocaleString()} rows`
    : "";
  if (res.headline && res.engine === "sql") return res.headline;
  if (res.headline && !LEGACY_RESULTS.has(p.problem_type || "")) return [res.headline, rowsBit].filter(Boolean).join(" · ");
  if (kind === "binary" || kind === "multiclass" || kind === "number") {
    const [m1] = METRIC[kind] || ["Score"];
    const beat = res.beats_baseline ? "beats the baseline" : "does not beat the baseline";
    return [rowsBit, `${res.winner}: ${m1} ${fmt(kind, res.test_score)} on held-out rows - ${beat} (${fmt(kind, res.baseline?.score)})`].filter(Boolean).join(" · ");
  }
  return [res.headline, rowsBit].filter(Boolean).join(" · ") || "Ready.";
}

export default function MLStudioProject() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [p, setP] = useState<StudioProject | null>(null);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("visual");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState("");
  const [engine, setEngine] = useState<Engine | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const picked = useRef(false);

  const load = () =>
    mlStudioApi
      .get(id)
      .then(setP)
      .catch((e) => (e?.response?.status === 404 ? setNotFound(true) : setError(errorText(e, "Couldn't load this project."))));

  useEffect(() => {
    picked.current = false;
    setSel(null);
    load();
    mlStudioApi.engine().then(setEngine).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const scoring = p?.progress?.scoring;
  const live = p?.status === "training" || scoring?.state === "queued" || scoring?.state === "running";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  const prog: Progress | null = (p?.progress as Progress) || null;
  const stages = useMemo(() => prog?.stages || [], [prog]);
  const training = p?.status === "training";
  const queued = training && p?.queue?.state === "queued";
  const res = p?.results;
  const kind: string = res?.kind || kindOf(p?.problem_type);
  const ptype = p?.problem_type || "";
  const legacy = !ptype || LEGACY_RESULTS.has(ptype);
  const data: RunData | undefined = (res?.data as RunData) || prog?.data;
  const scorable = !!ptype && !NOT_SCORABLE.has(ptype) && kind !== "forecast";
  const canTry = ["yes_no", "number", "drivers", "which_category"].includes(ptype);
  const joinsUsed = (res?.joins && res.joins.length ? res.joins : prog?.joins) || [];
  const joinLine = joinsSentence(joinsUsed, training ? "Learning from" : "Learned from");
  // round 40: trained inside the database
  const isSql = res?.engine === "sql" || prog?.engine === "sql";
  const pd: Pushdown | null = (res?.pushdown as Pushdown) || null;
  const livePd = prog?.pushdown;
  const sqlWhere = pd?.engine || livePd?.engine || "the database";
  const inWarehouse = isSql && (pd ? pd.live : livePd?.live ?? data?.source?.mode === "live");
  const rowsInPlace = pd?.rows ?? livePd?.rows;

  const shownId = (picked.current && sel) || (training ? defaultStage(stages, p?.status) : sel || defaultStage(stages, p?.status));
  const stage = stages.find((s) => s.id === shownId) || null;
  const shownIdx = stages.findIndex((s) => s.id === shownId);
  const hasVisual = !!stage && ((stage.visual && stage.visual.length > 0) || (stage.id === "train" && (prog?.leaderboard.length || 0) > 0));
  const hasCode = !!stage?.code?.length;
  const hasRows = !!stage?.preview?.rows?.length;
  const tabs = [
    { value: "visual" as Tab, label: <span className="inline-flex items-center gap-1.5"><ChartIcon size={13} />Visual</span>, disabled: !hasVisual },
    { value: "code" as Tab, label: <span className="inline-flex items-center gap-1.5"><CodeIcon size={13} />Code</span>, disabled: !hasCode },
    { value: "rows" as Tab, label: <span className="inline-flex items-center gap-1.5"><TableIcon size={13} />Rows</span>, disabled: !hasRows },
  ];
  const shownTab: Tab = tabs.find((t) => t.value === tab && !t.disabled)?.value || tabs.find((t) => !t.disabled)?.value || "visual";
  const spec = p?.plan?.spec;

  const pick = (sid: string) => {
    picked.current = true;
    setSel(sid);
    setEditing(false);
  };

  const act = async (what: string, fn: () => Promise<unknown>, fallback: string) => {
    setBusy(what);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorText(e, fallback));
    } finally {
      setBusy("");
    }
  };

  const downloadNotebook = async () => {
    setBusy("notebook");
    try {
      const blob = await mlStudioApi.notebook(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(p?.name || "ml_project").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60)}.ipynb`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(errorText(e, "Couldn't export the notebook."));
    } finally {
      setBusy("");
    }
  };

  if (notFound) {
    return (
      <div className="min-h-screen grid place-items-center bg-base px-6">
        <div className="text-center">
          <div className="text-section font-semibold text-text">This model doesn't exist or isn't shared with you.</div>
          <Link to="/ml-models" className="btn-primary text-sm mt-4 inline-flex">ML Studio</Link>
        </div>
      </div>
    );
  }

  const ahead = (p?.queue?.position || 0) + (p?.queue?.running || 0);
  const statusPill = !p
    ? null
    : queued
      ? { text: ahead ? `Queued · ${ahead} ahead` : "Starting…", color: "rgb(var(--auto-tell))", pulse: true }
      : training
        ? { text: `Training · ${stages.find((s) => s.status === "running")?.title || "starting"}`, color: "rgb(var(--auto-tell))", pulse: true }
        : p.status === "ready"
          ? { text: `Ready${p.trained_at ? ` · trained ${timeAgo(p.trained_at)}` : ""}`, color: "rgb(var(--auto-do))", pulse: false }
          : { text: "Didn't finish", color: "rgb(var(--color-danger))", pulse: false };
  const story = !p
    ? ""
    : queued
      ? `Waiting for the ML worker${ahead ? ` - ${ahead} run${ahead === 1 ? "" : "s"} ahead` : ""}. It starts on its own; you can leave this page.`
      : training
        ? prog?.message || "Working…"
        : p.status === "ready"
          ? storyFor(p, kind, data)
          : p.error || "It stopped before it finished.";
  const scorePct = scoring?.total ? Math.min(100, ((scoring.done || 0) / scoring.total) * 100) : 0;
  const srcRows = data?.prep ? data?.source?.rows ?? data?.rows_total : data?.rows_total;

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />
        <main className="px-4 sm:px-8 lg:px-10 py-7 max-w-[1360px] mx-auto flex flex-col gap-6">
          {!p && !error && <div className="text-ui text-muted">Loading…</div>}
          {error && <div role="alert" className="rounded-card border border-danger-border bg-danger-fill px-4 py-3 text-ui text-text">{error}</div>}
          {p && (
            <>
              <header className="flex items-start justify-between gap-4 flex-wrap" data-ml-header="">
                <div className="flex flex-col gap-2 min-w-0 flex-[1_1_480px]">
                  <span className="font-mono text-caption text-muted uppercase tracking-[0.06em] truncate">
                    <Link to="/ml-models" className="hover:text-text">← ML Studio</Link> / {TYPE_LABEL[ptype] || "Model"}
                  </span>
                  <h1 className="m-0 text-[24px] sm:text-[30px] font-semibold tracking-tight text-text text-balance leading-tight">{p.name}</h1>
                  <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap text-ui text-secondary">
                    {statusPill && (
                      <span className="inline-flex items-center gap-2 h-7 px-2.5 rounded-full border border-border bg-surface text-text text-caption font-medium" data-ml-status={queued ? "queued" : p.status}>
                        <span className={`w-2 h-2 rounded-full ${statusPill.pulse ? "animate-pulse" : ""}`} style={{ background: statusPill.color }} aria-hidden="true" />
                        {statusPill.text}
                      </span>
                    )}
                    {ptype && (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block w-2 h-2 rounded-[3px]" style={{ background: FAMILY_COLOR[FAMILY_OF[ptype] || "Predict"] }} aria-hidden="true" />
                        {TYPE_LABEL[ptype] || ptype}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1.5 min-w-0">
                      <DatabaseIcon size={13} />
                      <span className="truncate">{p.source}{p.table ? ` · ${p.table}` : ""}</span>
                    </span>
                    {p.elapsed != null && !queued && <span className="font-mono text-caption text-muted">{dur(p.elapsed)}</span>}
                  </div>
                </div>
                <div className="flex gap-2 flex-wrap items-center">
                  {training ? (
                    <>
                      <button type="button" className="btn-secondary text-sm" onClick={() => navigate("/ml-models")}>Run in background</button>
                      {p.can_edit && (
                        <button type="button" className="btn-secondary text-sm" disabled={!!busy} onClick={() => act("stop", () => mlStudioApi.stop(id), "Couldn't stop it.")}>
                          {queued ? "Cancel" : "Stop"}
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      {p.status === "ready" && (
                        <button type="button" className="btn-secondary text-sm inline-flex items-center gap-1.5" onClick={downloadNotebook} disabled={!!busy} data-ml-notebook="">
                          <DownloadIcon size={14} /> {busy === "notebook" ? "Exporting…" : "Notebook"}
                        </button>
                      )}
                      {p.can_edit && (
                        <button type="button" className="btn-secondary text-sm" disabled={!!busy} onClick={() => act("retrain", () => mlStudioApi.retrain(id), "Couldn't start it.")}>
                          Train again
                        </button>
                      )}
                      {p.status === "ready" && canTry && <Link to={`/ml-models/${id}`} className="btn-secondary text-sm">Try a prediction</Link>}
                      {p.status === "ready" && isSql && pd && (
                        <a href="#model-sql" className={inWarehouse ? "btn-primary text-sm" : "btn-secondary text-sm"} data-ml-use-sql="">
                          {inWarehouse ? `Use it in ${pd.engine}` : "The model as SQL"}
                        </a>
                      )}
                      {p.status === "ready" && scorable && !inWarehouse && scoring?.state !== "running" && scoring?.state !== "queued" && (
                        <button type="button" className="btn-primary text-sm" disabled={!!busy} onClick={() => act("score", () => mlStudioApi.scoreJob(id), "Couldn't start scoring.")} data-ml-score="">
                          Score every row
                        </button>
                      )}
                    </>
                  )}
                </div>
              </header>

              <section
                className="rounded-card border px-4 sm:px-5 py-4 flex items-start gap-3"
                style={{ borderColor: p.status === "failed" && !training ? "rgb(var(--color-danger-border))" : "rgb(var(--auto-do-border))", background: p.status === "failed" && !training ? "rgb(var(--color-danger-fill))" : "rgb(var(--auto-do-fill) / 0.35)" }}
                aria-live="polite"
                data-ml-story=""
              >
                <span className="mt-1 w-2.5 h-2.5 rounded-full shrink-0" style={{ background: statusPill?.color }} aria-hidden="true" />
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="text-[15.5px] sm:text-[16.5px] leading-snug text-text text-pretty">{story}</span>
                  {prog?.retry_note && <span className="text-caption text-warning">{prog.retry_note}</span>}
                  {joinLine && <span className="text-caption text-secondary">{joinLine}</span>}
                </div>
              </section>

              {(scoring && scoring.state !== "cancelled") && (
                <section className="rounded-card border border-border bg-surface px-4 py-3 flex items-center gap-4 flex-wrap" data-ml-scoring={scoring.state}>
                  <span className="text-ui font-medium text-text">
                    {scoring.state === "done"
                      ? `Scored ${Number(scoring.rows || 0).toLocaleString()}${scoring.rows_total ? ` of ${Number(scoring.rows_total).toLocaleString()} rows (a sample of the live table)` : " rows"} in ${scoring.seconds} s`
                      : scoring.state === "failed"
                        ? "Scoring stopped"
                        : scoring.state === "queued"
                          ? "Scoring is queued on the ML worker"
                          : `Scoring every row · ${Number(scoring.done || 0).toLocaleString()} of ${Number(scoring.total || 0).toLocaleString()}`}
                  </span>
                  {(scoring.state === "running" || scoring.state === "queued") && (
                    <>
                      <span className="flex-1 min-w-[160px] h-[6px] rounded-full bg-subtle overflow-hidden">
                        <span className="block h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(2, scorePct)}%`, background: "rgb(var(--auto-do))" }} />
                      </span>
                      <button type="button" className="text-caption text-muted underline hover:text-text" onClick={() => act("scorestop", () => mlStudioApi.scoreStop(id), "Couldn't stop scoring.")}>Stop</button>
                    </>
                  )}
                  {scoring.state === "done" && (
                    <Link to={`/workspace/${p.source_id}`} className="text-ui underline" style={{ color: "rgb(var(--auto-do))" }}>
                      Open “{scoring.version_name}” →
                    </Link>
                  )}
                  {scoring.state === "failed" && <span className="text-caption text-danger">{scoring.error}</span>}
                </section>
              )}

              {isSql ? (
                <section className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }} aria-label="How much data" data-ml-scale="sql">
                  <ScaleTile
                    label="Rows read in place"
                    value={rowsInPlace != null ? compact(rowsInPlace) : "—"}
                    exact={rowsInPlace}
                    note={(pd || livePd)?.train_rows != null ? `${compact((pd || livePd)!.train_rows)} to learn · ${compact((pd || livePd)!.test_rows)} held out` : `counted inside ${sqlWhere}`}
                    tone="do"
                  />
                  <ScaleTile
                    label={`Queries in ${sqlWhere}`}
                    value={pd ? String(pd.passes) : livePd ? String(livePd.passes) : "—"}
                    note={pd ? `${pd.train_steps} training step${pd.train_steps === 1 ? "" : "s"} · ${pd.db_seconds} s in the database` : "each one SELECT, read only"}
                  />
                  {pd && pd.sample_rows_looked_at > 0 ? (
                    <ScaleTile
                      label="Came back to GD360"
                      value={bytesText(pd.model_bytes ?? pd.bytes_back)}
                      exact={pd.model_bytes ?? pd.bytes_back}
                      note={`sums and a score histogram · plus ${pd.sample_rows_looked_at.toLocaleString()} rows to read the column types`}
                    />
                  ) : (
                    <ScaleTile
                      label={`Your rows that left ${sqlWhere}`}
                      value={pd ? String(pd.rows_out ?? 0) : livePd ? String(livePd.rows_out ?? 0) : "0"}
                      note={pd ? `${bytesText(pd.bytes_back)} of sums and counts came back` : livePd ? `${bytesText(livePd.bytes_back)} of sums and counts so far` : "only sums and counts come back"}
                      tone="do"
                    />
                  )}
                  <ScaleTile
                    label="Scores every row"
                    value={pd ? (pd.last_test ? compact(pd.last_test.rows) : "1 SELECT") : "—"}
                    exact={pd?.last_test?.rows}
                    note={pd?.last_test ? `checked in ${pd.engine}` : `the model as SQL, run in ${sqlWhere}`}
                  />
                </section>
              ) : (
              <section className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }} aria-label="How much data" data-ml-scale="">
                <ScaleTile
                  label="Rows in the source"
                  value={srcRows != null ? compact(srcRows) : "—"}
                  exact={srcRows}
                  note={data?.prep && data.rows_total != null ? `shaped to ${compact(data.rows_total)} rows by your data step` : data?.source?.how}
                />
                <ScaleTile
                  label="Learns from"
                  value={data?.rows_used != null ? compact(data.sample?.strategy === "daily" ? data.rows_total : data.rows_used) : "—"}
                  exact={data?.rows_used}
                  note={data?.sample ? STRATEGY_WORDS[data.sample.strategy] || data.sample.strategy : training ? "worked out from the memory free" : undefined}
                  tone="do"
                />
                <ScaleTile
                  label="Row budget"
                  value={data?.budget ? compact(data.budget.rows) : "—"}
                  exact={data?.budget?.rows}
                  note={data?.budget ? `${data.budget.free_mb.toLocaleString()} MB free · ${engine?.mode === "external" ? "ML worker" : "this server"}` : undefined}
                  hint={data?.budget?.reason}
                />
                <ScaleTile
                  label="Scored"
                  value={scoring?.state === "done" ? compact(scoring.rows) : scoring?.state === "running" ? `${Math.round(scorePct)}%` : "Not yet"}
                  exact={scoring?.rows}
                  note={scoring?.state === "done" ? "saved as a table" : scorable ? "every row, on the worker" : "this kind reports, not scores"}
                />
              </section>
              )}

              {stages.length > 0 && (
                <section className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)] items-start" aria-label="The run" data-ml-run="">
                  <ol className="m-0 p-0 list-none flex flex-col gap-1.5 lg:sticky lg:top-4" aria-label="Steps">
                    <li className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted px-1 pb-1">The run · {stages.length} steps</li>
                    {stages.map((s, i) => (
                      <li key={s.id}>
                        <StepRow s={s} i={i} on={s.id === shownId} failed={p.status === "failed" && !training} onPick={() => pick(s.id)} />
                      </li>
                    ))}
                  </ol>

                  <div className="rounded-card border border-border bg-surface/60 flex flex-col min-w-0" data-ml-panel={stage?.id || ""}>
                    {stage && (
                      <>
                        <div className="px-4 sm:px-5 pt-4 pb-3 flex flex-col gap-2 border-b border-border">
                          <div className="flex items-center gap-3 flex-wrap">
                            <span className="font-mono text-caption text-muted">{String(shownIdx + 1).padStart(2, "0")}</span>
                            <h2 className="m-0 text-[18px] font-semibold text-text">{stage.title}</h2>
                            {stage.seconds != null && <span className="font-mono text-caption text-muted">{stage.seconds} s</span>}
                            <span className="flex-1" />
                            <SegmentedControl size="sm" options={tabs} value={shownTab} onChange={(v) => setTab(v)} ariaLabel="View" />
                          </div>
                          {stage.note && <p className="m-0 text-ui text-secondary leading-snug">{stage.note}</p>}
                          {hasCode && (
                            <div className="flex gap-1.5 flex-wrap">
                              {Array.from(new Set((stage.code || []).map((c) => c.engine).filter(Boolean))).map((e) => (
                                <span key={e} className="text-[11px] px-2 py-0.5 rounded-full border border-border text-secondary">{e}</span>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="p-4 sm:p-5 flex flex-col gap-3 min-w-0">
                          {shownTab === "visual" && (
                            <>
                              {stage.id === "train" && prog && prog.leaderboard.length > 0 && <Leaderboard prog={prog} kind={kind} done={!training} />}
                              <StageVisuals visuals={stage.visual} />
                              {!hasVisual && (
                                <p className="m-0 text-ui text-muted">
                                  {stage.status === "pending" ? (p.status === "failed" ? "This step didn't run." : "This step hasn't started yet.") : stage.status === "running" ? "Working on it…" : "Nothing to draw for this step - see its code."}
                                </p>
                              )}
                            </>
                          )}
                          {shownTab === "code" && (
                            <>
                              {(stage.code || []).map((c, k) => (
                                <CodeBlock key={k} entry={c} onEdit={p.can_edit && !training ? () => setEditing(true) : undefined} />
                              ))}
                              {stage.id === "data" && p.can_edit && !training && !spec?.prep_sql && !editing && (
                                <button type="button" className="self-start btn-secondary text-sm inline-flex items-center gap-1.5" onClick={() => setEditing(true)}>
                                  <CodeIcon size={14} /> Add a data step (SQL)
                                </button>
                              )}
                            </>
                          )}
                          {shownTab === "rows" && <RowsPreview preview={stage.preview} note={stage.id === "data" ? "First rows the model learned from" : undefined} />}
                          {editing && spec && (
                            <DataStep
                              spec={spec}
                              initialSql={spec.prep_sql || ""}
                              applyLabel="Train again with this data step"
                              onCancel={() => setEditing(false)}
                              onApply={(r) =>
                                act("retrain", async () => {
                                  await mlStudioApi.retrain(id, r.sql);
                                  setEditing(false);
                                  picked.current = false;
                                }, "Couldn't train again with that data step.")
                              }
                            />
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </section>
              )}

              {p.status === "ready" && res && (
                <section className="flex flex-col gap-4" aria-label="Results" data-ml-results="">
                  <h2 className="m-0 text-[20px] font-semibold text-text">Results</h2>
                  {legacy && !isSql ? <Results kind={kind} res={res} /> : <GenericResults res={res} />}
                </section>
              )}

              {p.status === "ready" && isSql && pd?.sql && <ModelSql id={id} pd={pd} canRun />}

              {isSql ? (
              <section className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }} aria-label="How this run is governed" data-ml-trust="sql">
                <TrustCard title="Where it ran" lines={[
                  inWarehouse ? `Inside ${sqlWhere}: every pass was one SELECT over the rows where they live.` : `Inside ${sqlWhere}, over every row of this exact version of the data.`,
                  pd ? (pd.sample_rows_looked_at > 0
                    ? `${pd.passes} queries · ${bytesText(pd.bytes_back)} back · GD360 looked at ${pd.sample_rows_looked_at.toLocaleString()} rows only to read the column types.`
                    : `${pd.passes} queries · ${bytesText(pd.bytes_back)} back · not one of your rows left ${sqlWhere}: every query returned sums, counts or a histogram.`) : "",
                ]} />
                <TrustCard title="Reproducible" lines={[
                  pd?.split?.how === "time"
                    ? `Tested on the newest rows by ${pd.split.column} (from ${pd.split.cutoff_text}) - the future the model hadn't seen.`
                    : pd ? `The held-out rows are fixed by a hash of ${pd.key || "the row values"} - the same rows on every run.` : "The held-out rows are fixed by a hash - the same rows on every run.",
                  "Every query is in the run's Code tab; the notebook replays the model in Python and DuckDB.",
                ]} />
                <TrustCard icon title="Governed" lines={[
                  "Read-only SQL through GD360's warehouse guard, with your access rules in every WHERE.",
                  inWarehouse ? "Every pass is in the query log and counts towards the daily scan budget." : "Runs in the read-only sandbox; no file or network access.",
                ]} />
              </section>
              ) : (
              <section className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }} aria-label="How this run is governed" data-ml-trust="">
                <TrustCard title="Where it ran" lines={[
                  engine?.mode === "external" ? "A dedicated ML worker with its own memory" : "The ML worker inside this server, one run at a time",
                  engine ? `${engine.memory_free_mb.toLocaleString()} MB free now · ${engine.queued} queued · ${engine.running} running` : "",
                ]} />
                <TrustCard title="Reproducible" lines={[
                  `Fair samples use a fixed seed (${engine?.seed ?? 42}); the data is read from a snapshot of this exact version.`,
                  p.status === "ready" ? "Export the run as a notebook to replay it." : "",
                ]} />
                <TrustCard icon title="Governed" lines={[
                  "Your access rules are applied in the SQL, so the model never sees rows you can't.",
                  "SQL runs read-only in a sandbox; every step's code is kept with the run.",
                ]} />
              </section>
              )}

              {!training && p.can_delete && (
                <div className="flex gap-2">
                  {confirmDelete ? (
                    <>
                      <button type="button" className="btn-secondary text-sm !text-danger" onClick={() => mlStudioApi.remove(id).then(() => navigate("/ml-models"))}>Delete for good</button>
                      <button type="button" className="btn-secondary text-sm" onClick={() => setConfirmDelete(false)}>Keep it</button>
                    </>
                  ) : (
                    <button type="button" className="text-caption text-muted underline hover:text-danger" onClick={() => setConfirmDelete(true)}>Delete this model</button>
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

/** Round 40: bytes as people read them. */
function bytesText(n: number): string {
  if (n < 1024) return `${n.toLocaleString()} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ScaleTile({ label, value, exact, note, tone, hint }: { label: string; value: string; exact?: number | null; note?: string; tone?: "do"; hint?: string }) {
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3.5 flex flex-col gap-1 min-w-0" title={hint || undefined}>
      <span className="text-caption text-muted">{label}</span>
      <span className="font-mono text-[24px] leading-tight tabular-nums text-text" style={tone === "do" ? { color: "rgb(var(--auto-do))" } : undefined} title={exact != null ? Number(exact).toLocaleString() : undefined}>
        {value}
      </span>
      {note && <span className="text-[12px] text-muted leading-snug line-clamp-2" title={note}>{note}</span>}
    </div>
  );
}

function StepRow({ s, i, on, failed, onPick }: { s: Stage; i: number; on: boolean; failed: boolean; onPick: () => void }) {
  const status = failed && s.status === "running" ? "failed" : s.status;
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={on ? "step" : undefined}
      className={`w-full text-left rounded-card border px-3 py-2.5 flex items-start gap-3 transition-colors ${on ? "" : "border-border bg-surface hover:border-border-strong"}`}
      style={on ? { borderColor: "rgb(var(--auto-tell) / 0.7)", background: "rgb(var(--auto-tell) / 0.08)" } : undefined}
      data-ml-step={s.id}
    >
      <span className="font-mono text-[11.5px] mt-[3px] w-5 shrink-0" style={{ color: status === "done" ? "rgb(var(--auto-do))" : status === "running" ? "rgb(var(--auto-tell))" : "rgb(var(--color-muted))" }}>
        {String(i + 1).padStart(2, "0")}
      </span>
      <span className="flex flex-col gap-0.5 min-w-0 flex-1">
        <span className={`text-ui font-medium ${status === "pending" ? "text-muted" : "text-text"}`}>{s.title}</span>
        {s.note && <span className="text-[12px] text-muted leading-snug line-clamp-2">{s.note}</span>}
        {!s.note && status === "pending" && <span className="text-[12px] text-faint">{failed ? "not run" : "waiting"}</span>}
      </span>
      <span className="shrink-0 mt-[2px] text-[11px] font-mono">
        {status === "done" && <span style={{ color: "rgb(var(--auto-do))" }}>{s.seconds != null ? `${s.seconds}s` : "✓"}</span>}
        {status === "running" && <span className="inline-flex items-center gap-1" style={{ color: "rgb(var(--auto-tell))" }}><span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "rgb(var(--auto-tell))" }} />now</span>}
        {status === "failed" && <span className="text-danger">stopped</span>}
      </span>
    </button>
  );
}

function TrustCard({ title, lines, icon }: { title: string; lines: string[]; icon?: boolean }) {
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3.5 flex flex-col gap-1.5 min-w-0">
      <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
        {icon && <ShieldCheckIcon size={13} />} {title}
      </span>
      {lines.filter(Boolean).map((l) => (
        <span key={l} className="text-caption text-secondary leading-snug">{l}</span>
      ))}
    </div>
  );
}

/** The leaderboard's metric family while training (before results exist). */
function kindOf(problemType: string | null | undefined): string {
  switch (problemType) {
    case "yes_no":
    case "drivers":
    case "time_to_event":
      return "binary";
    case "which_category":
      return "multiclass";
    case "number":
      return "number";
    case "segments":
    case "anomalies":
      return problemType;
    case "forecast_one":
    case "forecast_many":
      return "forecast";
    default:
      return problemType || "binary";
  }
}

function dur(s?: number | null): string {
  if (s == null) return "";
  const t = Math.max(0, Math.round(s));
  if (t < 60) return `${t} s`;
  return `${Math.floor(t / 60)} min ${t % 60} s`;
}

const METRIC: Record<string, [string, string]> = {
  binary: ["ROC AUC", "Top 10% hit"],
  multiclass: ["Accuracy", "Macro F1"],
  number: ["R²", "Mean abs. error"],
  segments: ["Silhouette", ""],
  anomalies: ["Flagged share", ""],
  forecast: ["MASE (lower is better)", ""],
  // round 15
  what_if: ["R² on the latest periods", "Mean abs. % error"],
  recommendations: ["Found in top 5", ""],
  text_tag: ["Accuracy", "Macro F1"],
};

function fmt(kind: string, v: number | null | undefined, second = false): string {
  if (v == null || Number.isNaN(v)) return "—";
  if (kind === "binary") return second ? `${Math.round(v * 100)}%` : v.toFixed(3);
  if (kind === "multiclass") return `${(v * 100).toFixed(1)}%`;
  if (kind === "number") return second ? (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2)) : v.toFixed(3);
  if (kind === "anomalies") return `${(v * 100).toFixed(1)}%`;
  if (kind === "recommendations" || kind === "text_tag") return `${(v * 100).toFixed(1)}%`;
  if (kind === "what_if") return second ? `${(v * 100).toFixed(1)}%` : v.toFixed(3);
  return v.toFixed(3);
}

function Leaderboard({ prog, kind, done }: { prog: Progress; kind: string; done: boolean }) {
  const [m1, m2] = METRIC[kind] || ["Score", ""];
  const useTest = done && prog.leaderboard.some((r) => r.test_score != null);
  const val = (r: BoardRow) => (useTest ? r.test_score : r.score);
  const scores = prog.leaderboard.map(val).filter((x): x is number => typeof x === "number" && !Number.isNaN(x));
  const max = Math.max(...scores, 0.0001);
  const min = kind === "forecast" ? 0 : Math.min(0, ...scores);
  const isForecast = kind === "forecast";
  return (
    <section className="rounded-card border border-border bg-surface overflow-hidden" aria-label="Leaderboard">
      <div className="flex items-baseline justify-between gap-3 px-5 pt-4 pb-3 flex-wrap">
        <h2 className="m-0 text-[18px] font-semibold text-text">{done ? (isForecast ? "Each series" : "Leaderboard") : "Live leaderboard"}</h2>
        <span className="font-mono text-caption text-muted">
          {useTest ? "scores on held-out rows" : isForecast ? "backtest error per series" : kind === "segments" ? "how well separated each number of groups is" : kind === "anomalies" ? "share of rows flagged" : "scores on a validation slice"}
          {prog.trials_total ? ` · ${prog.trials_done} of ${prog.trials_total} ${isForecast ? "series" : kind === "segments" ? "group counts" : "trials"}` : ""}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-ui border-collapse min-w-[560px]">
          <thead>
            <tr className="text-left border-y border-border">
              {[isForecast ? "Series" : "Algorithm", m1, m2, isForecast ? "Method" : "Trials", "State"].filter((h, i) => h || i === 0).map((h) => (
                <th key={h} className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted font-medium px-5 py-2.5">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {prog.leaderboard.map((r) => {
              const v = val(r);
              const w = typeof v === "number" && !Number.isNaN(v) ? Math.max(2, ((v - min) / (max - min || 1)) * 100) : 0;
              return (
                <tr key={r.key} className={`border-b border-border last:border-b-0 ${r.best ? "bg-[rgb(var(--auto-do-fill)/0.4)]" : ""}`}>
                  <td className="px-5 py-3 text-text">
                    {r.algorithm}
                    {r.best && !isForecast && <span className="ml-2 font-mono text-[10px] uppercase" style={{ color: "rgb(var(--auto-do))" }}>{done ? "chosen" : "best so far"}</span>}
                  </td>
                  <td className="px-5 py-3">
                    <span className="flex items-center gap-3">
                      <span className="font-mono text-text w-[52px]">{fmt(kind, v)}</span>
                      <span className="flex-1 min-w-[80px] max-w-[160px] h-[6px] rounded-full bg-subtle overflow-hidden">
                        <span
                          className="block h-full rounded-full"
                          style={{ width: `${w}%`, background: r.baseline ? "rgb(var(--color-faint))" : r.best ? "rgb(var(--auto-do))" : "rgb(var(--auto-tell))" }}
                        />
                      </span>
                    </span>
                  </td>
                  {m2 && <td className="px-5 py-3 font-mono text-secondary">{fmt(kind, useTest ? r.test_second : r.second, true)}</td>}
                  <td className="px-5 py-3 font-mono text-secondary">{isForecast ? r.method || "—" : r.trials ?? "—"}</td>
                  <td className={`px-5 py-3 font-mono text-caption ${r.state === "running" ? "text-[rgb(var(--auto-tell))]" : "text-muted"}`}>{r.state}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {prog.curve.length > 1 && !isForecast && kind !== "segments" && <Curve prog={prog} kind={kind} />}
      {prog.split && <p className="m-0 px-5 pb-4 text-caption text-muted">{prog.split}.</p>}
    </section>
  );
}

function Curve({ prog, kind }: { prog: Progress; kind: string }) {
  const pts = prog.curve.filter((c) => typeof c.best === "number");
  const base = prog.leaderboard.find((r) => r.baseline)?.score ?? null;
  const ys = pts.map((c) => c.best as number).concat(base != null ? [base] : []);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const pad = (hi - lo) * 0.12 || 0.01;
  const y0 = lo - pad;
  const y1 = hi + pad;
  const W = 640;
  const H = 150;
  const n = Math.max(prog.trials_total || pts.length, pts.length, 2);
  const x = (i: number) => 40 + ((i - 1) / (n - 1)) * (W - 60);
  const y = (v: number) => 10 + (1 - (v - y0) / (y1 - y0)) * (H - 30);
  const path = pts.map((c, i) => `${i ? "L" : "M"}${x(c.trial).toFixed(1)},${y(c.best as number).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <figure className="m-0 px-5 pb-3 pt-1" aria-label="Best score so far, by trial">
      <figcaption className="text-ui text-secondary mb-1">Best score so far, by trial</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`Best ${METRIC[kind]?.[0] || "score"} rose to ${last ? fmt(kind, last.best) : ""}`}>
        <text x="0" y={y(y1 - pad) + 4} fontSize="11" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">{fmt(kind, hi)}</text>
        <text x="0" y={y(y0 + pad) + 4} fontSize="11" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">{fmt(kind, lo)}</text>
        {base != null && (
          <>
            <line x1="40" x2={W - 20} y1={y(base)} y2={y(base)} stroke="rgb(var(--color-faint))" strokeDasharray="4 4" strokeWidth="1.5" />
            <text x={W - 20} y={y(base) - 6} fontSize="11" textAnchor="end" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">baseline {fmt(kind, base)}</text>
          </>
        )}
        <path d={path} fill="none" stroke="rgb(var(--auto-do))" strokeWidth="2.2" strokeLinejoin="round" />
        {last && <circle cx={x(last.trial)} cy={y(last.best as number)} r="4.5" fill="rgb(var(--auto-do))" />}
      </svg>
    </figure>
  );
}

// ---------------------------------------------------------------- results ----

function Warnings({ list }: { list?: string[] | null }) {
  return (
    <>
      {(list || []).map((w: string) => (
        <div key={w} className="rounded-card border border-warning-border bg-warning-fill px-4 py-3 text-ui text-text">{w}</div>
      ))}
    </>
  );
}

/** round 15: every kind other than the round-13 ones - headline, KPI tiles, sections. */
function GenericResults({ res }: { res: any }) {
  return (
    <section className="flex flex-col gap-4 min-w-0" aria-label="Results">
      <Warnings list={res.warnings} />
      <ResultSections headline={res.headline} kpis={res.kpis} sections={res.sections} />
    </section>
  );
}

function Results({ kind, res }: { kind: string; res: any }) {
  return (
    <section className="flex flex-col gap-4 min-w-0" aria-label="Results">
      <Warnings list={res.warnings} />
      {res.headline && <Headline text={res.headline} />}
      {(kind === "binary" || kind === "multiclass" || kind === "number") && <SupervisedResult res={res} kind={kind} />}
      {kind === "segments" && <Segments res={res} />}
      {kind === "anomalies" && <Anomalies res={res} />}
      {kind === "forecast" && <Forecasts res={res} />}
    </section>
  );
}

function SupervisedResult({ res, kind }: { res: any; kind: string }) {
  const [m1, m2] = METRIC[kind];
  const maxImp = Math.max(...(res.drivers || []).map((d: any) => Math.abs(d.importance)), 1e-9);
  return (
    <>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
        <Kpi label={`${m1} on held-out rows`} value={fmt(kind, res.test_score)} note={res.winner} />
        {m2 && <Kpi label={m2} value={fmt(kind, res.test_second, true)} note={kind === "binary" ? "of the top-scored 10% really were yes" : ""} />}
        <Kpi
          label="Baseline"
          value={fmt(kind, res.baseline?.score)}
          note={res.baseline?.name?.replace("Baseline · ", "")}
          tone={res.beats_baseline ? "good" : "bad"}
          badge={res.beats_baseline ? "beaten" : "not beaten"}
        />
        <Kpi label="Tested on" value={`${Number(res.test_rows).toLocaleString()} rows`} note={`trained on ${Number(res.train_rows).toLocaleString()}`} />
      </div>
      <p className="m-0 text-caption text-muted">{res.split}.</p>
      <section className="rounded-card border border-border bg-surface p-5 flex flex-col gap-3" aria-label="Drivers">
        <h2 className="m-0 text-[18px] font-semibold text-text">What moves {res.label?.target}{res.kind === "binary" ? ` = ${res.positive}` : ""}</h2>
        <p className="m-0 text-caption text-muted">How much the held-out score drops when each column is shuffled - bigger means the model leans on it more. Arrows show which way higher values push.</p>
        <div className="flex flex-col gap-2">
          {(res.drivers || []).slice(0, 12).map((d: any) => (
            <div key={d.feature} className="grid grid-cols-[minmax(110px,30%)_1fr_auto] gap-3 items-center text-ui">
              <span className="text-text truncate" title={d.feature}>{d.feature}</span>
              <span className="h-[8px] rounded-full bg-subtle overflow-hidden">
                <span className="block h-full rounded-full" style={{ width: `${Math.max(2, (Math.abs(d.importance) / maxImp) * 100)}%`, background: "rgb(var(--auto-do))" }} />
              </span>
              <span className="font-mono text-caption text-secondary w-[64px] text-right">
                {d.direction === "up" ? "↑ raises" : d.direction === "down" ? "↓ lowers" : "mixed"}
              </span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function Kpi({ label, value, note, tone, badge }: { label: string; value: string; note?: string; tone?: "good" | "bad"; badge?: string }) {
  return (
    <div className="rounded-card border border-border bg-surface px-[18px] py-4 flex flex-col gap-1 min-w-0">
      <span className="flex items-center justify-between gap-2 text-ui text-muted">
        {label}
        {badge && <span className={`font-mono text-[10px] uppercase px-1.5 py-0.5 rounded ${tone === "good" ? "bg-good-fill text-good" : "bg-danger-fill text-danger"}`}>{badge}</span>}
      </span>
      <span className="font-mono text-kpi leading-tight tracking-tight text-text">{value}</span>
      {note && <span className="text-caption text-muted leading-snug line-clamp-2" title={note}>{note}</span>}
    </div>
  );
}

function Segments({ res }: { res: any }) {
  return (
    <section className="flex flex-col gap-3" aria-label="Segments">
      <h2 className="m-0 text-[18px] font-semibold text-text">{res.k} groups</h2>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))" }}>
        {res.groups.map((g: any, i: number) => (
          <article key={g.id} className="rounded-card border border-border bg-surface p-5 flex flex-col gap-3">
            <span className="flex justify-between items-baseline gap-2">
              <span className="font-mono text-caption uppercase" style={{ color: "rgb(var(--auto-when))" }}>Group {i + 1}</span>
              <span className="font-mono text-caption text-muted">{g.rows.toLocaleString()} rows · {(g.share * 100).toFixed(0)}%</span>
            </span>
            <span className="h-[6px] rounded-full bg-subtle overflow-hidden">
              <span className="block h-full rounded-full" style={{ width: `${g.share * 100}%`, background: "rgb(var(--auto-when))" }} />
            </span>
            <ul className="m-0 pl-4 flex flex-col gap-1 text-ui text-secondary">
              {g.traits.map((t: any) => <li key={t.feature}>{t.text}</li>)}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

function Anomalies({ res }: { res: any }) {
  return (
    <section className="rounded-card border border-border bg-surface p-5 flex flex-col gap-3" aria-label="Anomalies">
      <h2 className="m-0 text-[18px] font-semibold text-text">
        {Number(res.flagged).toLocaleString()} of {Number(res.rows_total).toLocaleString()} rows flagged
      </h2>
      <p className="m-0 text-caption text-muted">The most unusual first, each with the columns that make it stand out.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-ui border-collapse min-w-[520px]">
          <thead>
            <tr className="text-left">
              {["Row", "Score", "Why it stands out"].map((h) => (
                <th key={h} className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted font-medium px-2 py-2 border-b border-border">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {res.top.slice(0, 25).map((r: any) => (
              <tr key={r.row} className="border-b border-border last:border-b-0">
                <td className="px-2 py-2.5 font-mono text-secondary">#{r.row + 1}</td>
                <td className="px-2 py-2.5 font-mono text-text">{r.score.toFixed(3)}</td>
                <td className="px-2 py-2.5 text-secondary">{r.reasons.join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Forecasts({ res }: { res: any }) {
  const ok = (res.series || []).filter((s: any) => s.status === "ok");
  const [pick, setPick] = useState(0);
  const s = ok[pick] || ok[0];
  if (!s) return null;
  return (
    <section className="rounded-card border border-border bg-surface p-5 flex flex-col gap-4" aria-label="Forecast">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[18px] font-semibold text-text">
            {res.value} per {res.grain}
            {s.series != null ? ` — ${s.series}` : ""}: next {res.horizon} {res.grain}s
          </h2>
          <span className="text-caption text-muted">
            {s.method}
            {s.backtest?.mase != null ? ` · backtest MASE ${Number(s.backtest.mase).toFixed(2)} (below 1 beats “${s.backtest?.baseline?.method || "same period last season"}”)` : ""}
          </span>
        </div>
        {ok.length > 1 && (
          <label className="flex items-center gap-2 text-caption text-muted">
            Series
            <select className="h-9 rounded-ctl border border-border bg-base px-2 text-ui text-text" value={pick} onChange={(e) => setPick(Number(e.target.value))}>
              {ok.map((x: any, i: number) => <option key={i} value={i}>{String(x.series)}</option>)}
            </select>
          </label>
        )}
      </div>
      <ForecastChart s={s} />
      <div className="overflow-x-auto">
        <table className="w-full text-ui border-collapse min-w-[420px]">
          <thead>
            <tr className="text-left">
              {["Period", "Forecast", "80% range", "95% range"].map((h) => (
                <th key={h} className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted font-medium px-2 py-2 border-b border-border">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.points.map((pt: any) => (
              <tr key={pt.period} className="border-b border-border last:border-b-0">
                <td className="px-2 py-2 font-mono text-secondary">{pt.period}</td>
                <td className="px-2 py-2 font-mono text-text">{Math.round(pt.value).toLocaleString()}</td>
                <td className="px-2 py-2 font-mono text-muted">{pt.lo80 != null ? `${Math.round(pt.lo80).toLocaleString()} – ${Math.round(pt.hi80).toLocaleString()}` : "—"}</td>
                <td className="px-2 py-2 font-mono text-muted">{pt.lo95 != null ? `${Math.round(pt.lo95).toLocaleString()} – ${Math.round(pt.hi95).toLocaleString()}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(s.notes || []).length > 0 && <p className="m-0 text-caption text-muted">{s.notes.join(" ")}</p>}
    </section>
  );
}

function ForecastChart({ s }: { s: any }) {
  const hist = (s.history || []).filter((h: any) => h.value != null).slice(-52);
  const pts = s.points || [];
  const all = [...hist.map((h: any) => h.value), ...pts.map((p: any) => p.hi95 ?? p.hi80 ?? p.value), ...pts.map((p: any) => p.lo95 ?? p.lo80 ?? p.value)];
  const lo = Math.min(...all, 0);
  const hi = Math.max(...all, 1);
  const W = 720;
  const H = 220;
  const n = hist.length + pts.length;
  const x = (i: number) => 46 + (i / Math.max(1, n - 1)) * (W - 60);
  const y = (v: number) => 12 + (1 - (v - lo) / (hi - lo || 1)) * (H - 36);
  const line = hist.map((h: any, i: number) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(h.value).toFixed(1)}`).join(" ");
  const fline = pts.map((p: any, i: number) => `${i ? "L" : "M"}${x(hist.length + i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const band = (loK: string, hiK: string) =>
    pts.length && pts[0][loK] != null
      ? pts.map((p: any, i: number) => `${i ? "L" : "M"}${x(hist.length + i).toFixed(1)},${y(p[hiK]).toFixed(1)}`).join(" ") +
        " " +
        [...pts].reverse().map((p: any, i: number) => `L${x(hist.length + pts.length - 1 - i).toFixed(1)},${y(p[loK]).toFixed(1)}`).join(" ") +
        " Z"
      : "";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="History and forecast with ranges">
      {[lo, (lo + hi) / 2, hi].map((v, i) => (
        <g key={i}>
          <line x1="46" x2={W - 14} y1={y(v)} y2={y(v)} stroke="rgb(var(--chart-grid))" strokeWidth="1" />
          <text x="0" y={y(v) + 4} fontSize="11" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">{Math.round(v).toLocaleString()}</text>
        </g>
      ))}
      {band("lo95", "hi95") && <path d={band("lo95", "hi95")} fill="rgb(var(--auto-tell) / 0.12)" />}
      {band("lo80", "hi80") && <path d={band("lo80", "hi80")} fill="rgb(var(--auto-tell) / 0.22)" />}
      <path d={line} fill="none" stroke="rgb(var(--color-secondary))" strokeWidth="1.8" />
      <path d={fline} fill="none" stroke="rgb(var(--auto-tell))" strokeWidth="2.2" />
      {hist.length > 0 && <line x1={x(hist.length - 1)} x2={x(hist.length - 1)} y1="8" y2={H - 22} stroke="rgb(var(--color-border-strong))" strokeDasharray="3 3" />}
      {hist[0] && <text x={x(0)} y={H - 6} fontSize="11" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">{hist[0].period}</text>}
      {pts.length > 0 && <text x={W - 14} y={H - 6} fontSize="11" textAnchor="end" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">{pts[pts.length - 1].period}</text>}
    </svg>
  );
}

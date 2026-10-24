// R54: Automate data - the Studio for one flow. The conversation on the left; the work on the right
// (what GD360 found in the data, the plan, the results, every run, the settings and the SQL).
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { errorText } from "../api/initiatives";
import { Flow, flowsApi, fmtCell, fmtNum, fmtSecs, Msg, Person, REASON_WORD, Run, RUN_WORD, runWord, SourceOption, STATUS_WORD, timeOf, whenOf } from "../api/flows";
import { I, Mark } from "../flows/icons";
import { CheckList, DataTab, PlanTab, RunsTab, SettingsTab } from "../flows/parts";
import "../flows/flows.css";
import { StudioFrame } from "../studio/Frame";
import { Ic } from "../studio/icons";
import "../studio/studio.css";

export type Tab = "data" | "plan" | "results" | "runs" | "settings" | "code";
// R56 (Studio board "Pipeline"): the views are the canvas tools - Graph (the plan), Data, Results, Run history, Settings, Code
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "plan", label: "Graph", icon: "flow" }, { id: "data", label: "Data", icon: "db" }, { id: "results", label: "Results", icon: "table" },
  { id: "runs", label: "Run history", icon: "hist" }, { id: "settings", label: "Settings", icon: "gear" }, { id: "code", label: "Code", icon: "code" },
];

export default function FlowStudio() {
  const { flowId = "" } = useParams();
  const { workspaces, activeWorkspaceId: ws, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const navigate = useNavigate();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab>(() => {
    const h = window.location.hash.slice(1) as Tab;
    return TABS.some((t) => t.id === h) ? h : "plan";
  });
  const [mob, setMob] = useState<"chat" | "work">("chat");
  const [busy, setBusy] = useState("");
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [focusRun, setFocusRun] = useState<string | null>(null);

  // R56: an older read that comes back late (the 1.2 s poll racing a test run) must not paint over a newer one
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const f = await flowsApi.get(flowId);
      if (mine !== seq.current) return f;
      setFlow(f);
      setLoadErr("");
      return f;
    } catch (e) {
      setLoadErr(errorText(e, "This flow couldn’t be opened."));
      return null;
    }
  }, [flowId]);
  useEffect(() => { setFlow(null); load(); }, [load]);
  useEffect(() => {
    if (!flow) return;
    flowsApi.sources(flow.workspace_id).then(setSources).catch(() => setSources([]));
    flowsApi.people(flow.workspace_id).then(setPeople).catch(() => setPeople([]));
  }, [flow?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // while a run is going, keep the page current
  const running = !!flow?.running;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => { load(); }, 1200);
    return () => window.clearInterval(t);
  }, [running, load]);

  const goTab = (t: Tab) => {
    setTab(t);
    setMob("work");
    try { window.history.replaceState(null, "", `#${t}`); } catch { /* ignore */ }
  };
  const act = async (name: string, fn: () => Promise<any>, after?: (r: any) => void) => {
    setBusy(name);
    setErr("");
    try {
      const r = await fn();
      await load();
      after?.(r);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const replaceFlow = (f: Flow) => { seq.current++; setFlow(f); };

  if (loadErr) {
    return (
      <Frame ws={ws} workspaces={workspaces} switchWorkspace={switchWorkspace} handleWorkspaceCreated={handleWorkspaceCreated} name="Flow">
        <div className="fl-empty" style={{ paddingTop: 80 }}>{loadErr}<Link className="fl-btn" to="/automate">Back to Automate data</Link></div>
      </Frame>
    );
  }
  if (!flow) {
    return (
      <Frame ws={ws} workspaces={workspaces} switchWorkspace={switchWorkspace} handleWorkspaceCreated={handleWorkspaceCreated} name="Flow">
        <div className="fl-empty" style={{ paddingTop: 80 }}><span className="fl-typing"><span /><span /><span /></span>Opening the flow…</div>
      </Frame>
    );
  }
  const issues = flow.profile?.issues?.length || 0;
  const runsBad = flow.pending_fix ? 1 : 0;

  const checks = (flow.checks || []).filter((c) => c.enabled !== false).length;
  const sched = flow.spec?.schedule;
  const alertTo = (flow.spec?.policy?.alert_to || []).map((id) => people.find((p) => p.id === id)?.name?.split(" ")[0] || null).filter(Boolean) as string[];
  const lastRun = flow.running ? (flow.running.reason === "test" ? "Testing on today’s rows…" : "Running…")
    : flow.status === "draft" ? "Not tested yet · nothing runs until you turn it on"
    : flow.status === "tested" ? "Test passed · not live yet"
    : `${STATUS_WORD[flow.status]}${flow.last_status ? ` · ${RUN_WORD[flow.last_status].toLowerCase()} ${whenOf(flow.last_run_at)}` : ""}`;
  return (
    <Frame ws={ws} workspaces={workspaces} switchWorkspace={switchWorkspace} handleWorkspaceCreated={handleWorkspaceCreated} name={flow.name} studio>
      <div className="fl-mob" role="group" aria-label="Show">
        <button type="button" aria-pressed={mob === "chat"} onClick={() => setMob("chat")}>Conversation</button>
        <button type="button" aria-pressed={mob === "work"} onClick={() => setMob("work")}>The work{flow.pending_fix ? " · fix waiting" : ""}</button>
      </div>
      <div className="fl-studio sd-flow" data-mob={mob} data-flow-studio={flow.id}>
        <Thread flow={flow} onFlow={replaceFlow} onTab={goTab} onFocusRun={(id) => { setFocusRun(id); goTab("results"); }} reload={load} setErr={setErr}
          busy={busy} act={act} />
        <StudioFrame kind="pipeline" bodyClass="fl-body"
          tabs={[{ key: flow.id, icon: "flow", label: flow.output.name || flow.name, badge: "pipeline", on: true, onClick: () => goTab("plan") }]}
          addMenu={(close) => <>
            <button type="button" onClick={() => { close(); navigate("/automate"); }}><span>A new pipeline</span><small>describe another data job</small></button>
            <button type="button" onClick={() => { close(); navigate("/automate"); }}><span>All pipelines</span></button>
          </>}
          status={<span data-flow-status={flow.status}>{lastRun}</span>}
          actions={<Header flow={flow} busy={busy} act={act} setErr={setErr} onDeleted={() => navigate("/automate")} reload={load} />}
          tools={<>
            {TABS.map((t) => (
              <button key={t.id} type="button" className={`sd-tool${tab === t.id ? " on" : ""}`} onClick={() => goTab(t.id)} aria-current={tab === t.id ? "page" : undefined} data-tab={t.id}>
                <Ic n={t.icon} />{t.label}
                {t.id === "data" && issues > 0 && <span className="sd-chip warn" style={{ height: 18, padding: "0 6px" }}>{issues}</span>}
                {t.id === "runs" && runsBad > 0 && <span className="sd-chip bad" style={{ height: 18, padding: "0 6px" }}>fix</span>}
              </button>
            ))}
            <span className="sd-vr" />
            <button type="button" className="sd-tool" onClick={() => goTab("plan")} title="The checks every run must pass"><Ic n="test" />Checks · {checks}</button>
            <button type="button" className="sd-tool" onClick={() => goTab("settings")} title="When it runs"><Ic n="cal" />{sched ? `${sched.days?.length === 7 || !sched.days?.length ? "Daily" : sched.days.length === 5 ? "Weekdays" : `${sched.days.length} days a week`} ${sched.time}` : "Schedule"}</button>
            <button type="button" className="sd-tool" onClick={() => goTab("settings")} title="Who is told when something is wrong"><Ic n="bell" />{alertTo.length ? `Alerts: ${alertTo.slice(0, 2).join(", ")}${alertTo.length > 2 ? ` +${alertTo.length - 2}` : ""}` : "Alerts"}</button>
          </>}>
          {err && <div className="fl-banner bad" role="alert"><span style={{ flex: 1 }}>{err}</span><button type="button" className="fl-btn ghost sm" onClick={() => setErr("")}>Close</button></div>}
          {flow.pending_fix && tab !== "runs" && <FixCard flow={flow} busy={busy} act={act} compact onOpen={() => goTab("runs")} />}
          {tab === "data" && <DataTab flow={flow} sources={sources} act={act} busy={busy} />}
          {tab === "plan" && <PlanTab flow={flow} onSaved={replaceFlow} setErr={setErr} act={act} busy={busy} />}
          {tab === "results" && <ResultsTab flow={flow} focusRun={focusRun} />}
          {tab === "runs" && <RunsTab flow={flow} fixCard={flow.pending_fix ? <FixCard flow={flow} busy={busy} act={act} /> : null} />}
          {tab === "settings" && <SettingsTab flow={flow} people={people} onSaved={replaceFlow} setErr={setErr} act={act} busy={busy} />}
          {tab === "code" && <CodeTab flow={flow} />}
        </StudioFrame>
      </div>
    </Frame>
  );
}

function Frame({ children, ws, workspaces, switchWorkspace, handleWorkspaceCreated, name, studio = false }: any) {
  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={ws} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className={`flex-1 min-w-0 flex flex-col fl${studio ? " fl-studiopage" : ""}`}>
        {!studio && <TopNav breadcrumb={[{ label: "Automate", to: "/automations" }, { label: "Automate data", to: "/automate" }, { label: name }]} />}
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ header ---- */

function Header({ flow, busy, act, setErr, onDeleted, reload }: { flow: Flow; busy: string; act: any; setErr: (s: string) => void; onDeleted: () => void; reload: () => void }) {
  const [hist, setHist] = useState<{ version: number; note: string; by: string; at: string; current: boolean }[] | null>(null);
  const run = flow.running;
  const st = flow.status;
  const openHist = async () => {
    if (hist) { setHist(null); return; }
    try { setHist(await flowsApi.versions(flow.id)); } catch (e) { setErr(errorText(e)); }
  };
  void reload;
  void onDeleted;
  return (
    <div className="sd-flowacts">
      {run && <span className="fl-chip muted"><span className="fl-typing"><span /><span /><span /></span>{run.reason === "test" ? "Testing" : "Running"}</span>}
      <span style={{ position: "relative" }}>
        <button type="button" className="sd-pill" onClick={openHist} aria-expanded={!!hist} data-flow-history=""><Ic n="undo" s={15} />Version {flow.version}</button>
        {hist && (
          <div className="fl-card" role="dialog" aria-label="Versions" style={{ position: "absolute", right: 0, top: 36, width: 340, maxHeight: 360, overflowY: "auto", zIndex: 20, boxShadow: "0 18px 40px -16px rgb(0 0 0 / .45)" }}>
            <div className="fl-hd"><span className="fl-h2">History</span><span className="sp" /><button type="button" className="fl-btn ghost sm" onClick={() => setHist(null)} aria-label="Close">{I.x}</button></div>
            {hist.map((v) => (
              <div key={v.version} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 14px", borderTop: "1px solid var(--fl-line)" }}>
                <span className="mono fl-lbl" style={{ paddingTop: 2 }}>v{v.version}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{v.note}<span className="fl-lbl" style={{ display: "block" }}>{v.by} · {whenOf(v.at)}</span></span>
                {v.current ? <span className="fl-chip brand">Now</span> : flow.can_edit && (
                  <button type="button" className="fl-btn sm" disabled={!!busy} onClick={() => { setHist(null); act("restore", () => flowsApi.restore(flow.id, v.version)); }}>Go back</button>
                )}
              </div>
            ))}
          </div>
        )}
      </span>
      {flow.can_edit && (
        <>
          {st === "draft" && <button type="button" className="sd-btnp" disabled={!!run || !!busy} onClick={() => act("test", () => flowsApi.test(flow.id))} data-flow-primary="test"><Ic n="play" />Run test</button>}
          {st === "tested" && (
            <>
              <button type="button" className="sd-pill" disabled={!!run || !!busy} onClick={() => act("test", () => flowsApi.test(flow.id))}><Ic n="play" />Run test</button>
              <button type="button" className="sd-btnp" disabled={!!run || !!busy} onClick={() => act("on", () => flowsApi.patch(flow.id, { enabled: true }))} data-flow-primary="on">Turn on</button>
            </>
          )}
          {st === "live" && (
            <>
              <button type="button" className="sd-pill" disabled={!!busy} onClick={() => act("off", () => flowsApi.patch(flow.id, { enabled: false }))}>Pause</button>
              <button type="button" className="sd-btnp" disabled={!!run || !!busy} onClick={() => act("run", () => flowsApi.run(flow.id))} data-flow-primary="run"><Ic n="play" />Run now</button>
            </>
          )}
          {st === "paused" && (
            <>
              <button type="button" className="sd-pill" disabled={!!run || !!busy} onClick={() => act("run", () => flowsApi.run(flow.id))}>Run now</button>
              <button type="button" className="sd-btnp" disabled={!!busy} onClick={() => act("on", () => flowsApi.patch(flow.id, { enabled: true }))} data-flow-primary="on">Turn on</button>
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ thread ---- */

function FlowName({ flow, act }: { flow: Flow; act: any }) {
  const [name, setName] = useState(flow.name);
  useEffect(() => setName(flow.name), [flow.name]);
  const save = () => {
    const n = name.trim();
    if (!n || n === flow.name) { setName(flow.name); return; }
    act("name", () => flowsApi.patch(flow.id, { name: n }));
  };
  return (
    <input className="fl-title sd-flowname" value={name} disabled={!flow.can_edit} aria-label="Flow name" onChange={(e) => setName(e.target.value)} onBlur={save}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} maxLength={80} title="Rename" style={{ flex: "1 1 auto", width: "auto", fontWeight: 600 }} />
  );
}

function suggestions(f: Flow): string[] {
  if (f.running) return [];
  if (f.status === "draft") return ["Test it", "Run it every day at 7", "Hold if more than 20 rows look odd"];
  if (f.status === "tested") return ["Turn it on", "Only on weekdays", "Run it at 6:30"];
  if (f.status === "live") return ["Run it now", "Pause it", "Don’t send the daily message"];
  return ["Turn it on", "Run it now"];
}

function Thread({ flow, onFlow, onTab, onFocusRun, reload, setErr, busy, act }: {
  flow: Flow; onFlow: (f: Flow) => void; onTab: (t: Tab) => void; onFocusRun: (id: string) => void; reload: () => Promise<any>; setErr: (s: string) => void; busy: string; act: any;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const n = flow.thread.length;
  useEffect(() => { const b = box.current; if (b) b.scrollTop = b.scrollHeight; }, [n, !!flow.running, sending]);
  const send = async (t?: string) => {
    const msg = (t ?? text).trim();
    if (!msg || sending) return;
    setSending(msg);
    setText("");
    try {
      const r = await flowsApi.message(flow.id, msg);
      onFlow(r.flow);
      if (r.run_id) await reload();
    } catch (e) {
      setErr(errorText(e));
      setText(msg);
    } finally {
      setSending("");
    }
  };
  void busy;
  void act;
  return (
    <aside className="fl-thread" aria-label="Conversation">
      <div className="fl-thead">
        <Mark />
        <FlowName flow={flow} act={act} />
        <span style={{ flex: 1 }} />
        <Link to="/automate" className="fl-btn ghost sm" aria-label="All flows">All flows</Link>
      </div>
      <div className="fl-msgs" data-flow-thread="" ref={box}>
        {flow.thread.map((m) => <Message key={m.id} m={m} flow={flow} onTab={onTab} onFocusRun={onFocusRun} />)}
        {sending && <div className="fl-u">{sending}</div>}
        {(sending || flow.running) && (
          <div className="fl-g"><div className="fl-who"><Mark />Euliv</div>
            <div className="fl-st"><span className="fl-typing"><span /><span /><span /></span>{flow.running ? (flow.running.reason === "test" ? "Testing on today’s real data…" : "Running…") : "Thinking…"}</div>
          </div>
        )}
      </div>
      {flow.can_edit && (
        <div className="fl-composer">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {suggestions(flow).map((s) => <button key={s} type="button" className="fl-pill" onClick={() => send(s)} disabled={!!sending}>{s}</button>)}
          </div>
          <form className="fl-cmp" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <label htmlFor="fl-msg" style={{ position: "absolute", left: -9999 }}>Message Euliv</label>
            <textarea id="fl-msg" rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask, or tell Euliv what to change"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} data-flow-input="" />
            <button type="submit" className="fl-send" disabled={!text.trim() || !!sending} aria-label="Send">{I.up}</button>
          </form>
        </div>
      )}
    </aside>
  );
}

function Message({ m, flow, onTab, onFocusRun }: { m: Msg; flow: Flow; onTab: (t: Tab) => void; onFocusRun: (id: string) => void }) {
  if (m.role === "user") return <div className="fl-u">{m.text}</div>;
  const d = m.data || {};
  return (
    <div className="fl-g" data-msg-kind={m.kind}>
      <div className="fl-who"><Mark />Euliv<time>{timeOf(m.at)}</time></div>
      {m.kind === "read" && (
        <>
          {(d.sources || []).map((s: any) => <div className="fl-st" key={s.label}>{I.check}{s.label}{s.rows != null && <em>{fmtNum(s.rows)} rows</em>}</div>)}
          {d.link && <div className="fl-st">{I.check}Linked by “{d.link.left_on}” = “{d.link.right_on}”</div>}
        </>
      )}
      {m.kind === "run" && (
        <div className="fl-st" style={d.status === "success" ? undefined : { borderColor: "rgb(var(--color-danger) / .45)" }}>
          <span style={{ color: d.status === "success" ? "var(--fl-good)" : "var(--fl-bad)", display: "inline-flex" }}>{d.status === "success" ? I.check : I.warn}</span>
          {REASON_WORD[d.reason] || "Run"} · {d.status in RUN_WORD ? runWord(d.reason, d.status) : d.status}<em>{fmtSecs(d.secs)}</em>
        </div>
      )}
      <div>{m.text}</div>
      {m.kind === "read" && d.issues > 0 && <div><button type="button" className="fl-btn sm" onClick={() => onTab("data")}>See what I found</button></div>}
      {m.kind === "plan" && (
        <>
          {(d.notes || []).map((n: string) => <div key={n} className="fl-st">{I.warn}{n}</div>)}
          <div style={{ display: "flex", gap: 6 }}><button type="button" className="fl-btn sm" onClick={() => onTab("plan")}>Open the plan</button></div>
        </>
      )}
      {m.kind === "run" && d.run_id && <div><button type="button" className="fl-btn sm" onClick={() => onFocusRun(d.run_id)}>See the results</button></div>}
      {m.kind === "run" && d.fix_id && flow.pending_fix?.id === d.fix_id && <div><button type="button" className="fl-btn sm" onClick={() => onTab("runs")}>Review the fix</button></div>}
    </div>
  );
}

/* --------------------------------------------------------------- fix ---- */

function FixCard({ flow, busy, act, compact, onOpen }: { flow: Flow; busy: string; act: any; compact?: boolean; onOpen?: () => void }) {
  const f = flow.pending_fix!;
  return (
    <div className="fl-fix" data-flow-fix="">
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <span style={{ color: "var(--fl-bad)", width: 18, height: 18, display: "inline-flex", flex: "0 0 auto", marginTop: 2 }}>{I.warn}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <b style={{ fontSize: 14 }}>The last run was {flow.last_status === "held" ? "held" : "stopped"} - nothing wrong was saved.</b>
          <div className="fl-sub" style={{ marginTop: 2 }}>{f.cause}</div>
        </div>
      </div>
      {!compact && (
        <>
          <div style={{ fontSize: 13.5 }}><b>Proposed fix.</b> {f.summary}</div>
          <div className="fl-diff">{f.diff.map(([k, t], i) => <div key={i} className={k === "-" ? "m" : "p"}>{k} {t}</div>)}</div>
          <span className="fl-lbl">{f.evidence}</span>
        </>
      )}
      {flow.can_edit && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {compact ? <button type="button" className="fl-btn sm" onClick={onOpen}>Review the fix</button> : (
            <>
              <button type="button" className="fl-btn pri sm" disabled={!!busy || !!flow.running} onClick={() => act("fix", () => flowsApi.applyFix(flow.id))} data-fix-apply="">Apply fix and run again</button>
              <button type="button" className="fl-btn sm" disabled={!!busy} onClick={() => act("dismiss", () => flowsApi.dismissFix(flow.id))}>Not now</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- results ---- */

function ResultsTab({ flow, focusRun }: { flow: Flow; focusRun: string | null }) {
  const [which, setWhich] = useState<"test" | "live">(() => (flow.last_live ? "live" : "test"));
  const [focused, setFocused] = useState<Run | null>(null);
  useEffect(() => {
    if (!focusRun) { setFocused(null); return; }
    if (flow.last_test?.id === focusRun) { setWhich("test"); setFocused(null); return; }
    if (flow.last_live?.id === focusRun) { setWhich("live"); setFocused(null); return; }
    flowsApi.getRun(focusRun).then(setFocused).catch(() => setFocused(null));
  }, [focusRun, flow.last_test?.id, flow.last_live?.id]);
  const run: Run | null = focused || (which === "live" ? flow.last_live : flow.last_test) || flow.last_test || flow.last_live;
  if (!run) {
    return (
      <div className="fl-empty">Nothing has run yet. Test it to see the result on today’s real rows - nothing is saved by a test.
        {flow.can_edit && flow.status === "draft" && <span className="fl-lbl">Press “Test it” at the top right.</span>}
      </div>
    );
  }
  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {focused ? <span className="fl-chip">{REASON_WORD[focused.reason]} · {whenOf(focused.started_at)}</span> : (
          <div role="group" aria-label="Which run" style={{ display: "inline-flex", gap: 4 }}>
            <button type="button" className={`fl-pill${run.reason === "test" ? " on" : ""}`} disabled={!flow.last_test} onClick={() => setWhich("test")}>Latest test</button>
            <button type="button" className={`fl-pill${run.reason !== "test" ? " on" : ""}`} disabled={!flow.last_live} onClick={() => setWhich("live")}>Latest real run</button>
          </div>
        )}
        <span className="fl-lbl">{whenOf(run.started_at)} · version {run.version}{run.seconds != null ? ` · ${fmtSecs(run.seconds)}` : ""}</span>
      </div>
      <RunResult run={run} flow={flow} />
    </>
  );
}

export function RunResult({ run, flow }: { run: Run; flow: Flow }) {
  const s = run.stats || {};
  const neg = (v: any) => typeof v === "number" && v < 0;
  const status = run.status;
  return (
    <>
      {status === "running" ? <div className="fl-banner"><span className="fl-typing"><span /><span /><span /></span>Still running…</div>
        : status === "success" ? (
          <div className="fl-banner" style={{ borderColor: "rgb(var(--color-good) / .4)" }}>
            <span style={{ color: "var(--fl-good)", width: 16, height: 16, display: "inline-flex", flex: "0 0 auto" }}>{I.check}</span>
            <span>{run.reason === "test" ? "The test worked. Nothing was saved - turn it on to save this every day." : `Saved ${fmtNum(s.rows_out)} rows to ${flow.output.name}.`}</span>
          </div>
        ) : (
          <div className="fl-banner bad"><span style={{ width: 16, height: 16, display: "inline-flex", flex: "0 0 auto" }}>{I.warn}</span>
            <span>{status === "held" ? `Held: ${(run.events.find((e) => e.text.startsWith("Held:"))?.text || "").replace(/^Held: /, "") || "a check failed."} The last good table is still in place.` : `Stopped: ${run.error || "something went wrong."}`}</span>
          </div>
        )}
      {status !== "failed" && (
        <div className="fl-kpis" data-run-kpis="">
          {(() => {
            const src = Object.values((s.sources || {}) as Record<string, { label: string; rows: number }>);
            const total = src.reduce((n, x) => n + (x.rows || 0), 0);
            return <div className="fl-card fl-kpi"><span className="fl-lbl">Rows read</span><span className="v mono">{fmtNum(total)}</span><small title={src.map((x) => `${x.label}: ${x.rows}`).join(" · ")}>{src.map((x) => fmtNum(x.rows)).join(" + ")} from {src.length} source{src.length === 1 ? "" : "s"}</small></div>;
          })()}
          {!!s.right_rows && <div className="fl-card fl-kpi"><span className="fl-lbl">Matched</span><span className="v mono" style={{ color: "var(--fl-good)" }}>{fmtNum(s.matched_right)}</span><small>of {fmtNum(s.right_rows)}</small></div>}
          <div className="fl-card fl-kpi"><span className="fl-lbl">Typing mistakes fixed</span><span className="v mono">{fmtNum(s.fixed)}</span><small>{s.unreadable ? `${s.unreadable} unreadable, left empty` : "keys and numbers"}</small></div>
          <div className="fl-card fl-kpi"><span className="fl-lbl">Look odd</span><span className="v mono" style={{ color: s.flagged ? "var(--fl-warn)" : undefined }}>{fmtNum(s.flagged)}</span><small>limit {fmtNum(s.hold_above)}</small></div>
          <div className="fl-card fl-kpi"><span className="fl-lbl">Set aside</span><span className="v mono">{fmtNum(s.set_aside)}</span><small>listed below, not lost</small></div>
          <div className="fl-card fl-kpi"><span className="fl-lbl">Rows out</span><span className="v mono">{fmtNum(s.rows_out)}</span><small>{run.published ? "saved" : "not saved"}</small></div>
        </div>
      )}
      {run.checks.length > 0 && <CheckList checks={run.checks} />}
      {run.examples.length > 0 && (
        <div className="fl-card" style={{ overflow: "hidden" }}>
          <div className="fl-hd"><span className="fl-h2">Before and after</span><span className="sp" /><span className="fl-lbl">what the fixes did</span></div>
          <div className="fl-tw"><table className="fl-t"><thead><tr><th>Source</th><th>Column</th><th>Before</th><th>After</th></tr></thead><tbody>
            {run.examples.map((e, i) => <tr key={i}><td>{e.source}</td><td>{e.column}</td><td className="mono" style={{ color: "var(--fl-warn)" }}>{e.before}</td><td className="mono" style={{ color: "var(--fl-good)" }}>{String(e.after)}</td></tr>)}
          </tbody></table></div>
        </div>
      )}
      {(run.flagged_rows.length > 0 || run.set_aside.length > 0) && (
        <div className="fl-2col">
          {run.flagged_rows.length > 0 && (
            <div className="fl-card" style={{ overflow: "hidden" }} data-flagged="">
              <div className="fl-hd"><span className="fl-h2">{fmtNum(s.flagged)} rows look odd</span><span className="sp" /><span className="fl-lbl">{run.reason === "test" ? "a real run sends these on" : "sent on"}</span></div>
              <div className="fl-tw"><table className="fl-t"><thead><tr><th>Why</th>{Object.keys(run.flagged_rows[0].row).slice(0, 4).map((k) => <th key={k}>{k}</th>)}</tr></thead><tbody>
                {run.flagged_rows.slice(0, 12).map((r, i) => (
                  <tr key={i}><td style={{ color: "var(--fl-warn)" }}>{r.reasons[0]}</td>{Object.entries(r.row).slice(0, 4).map(([k, v]) => <td key={k} className={neg(v) ? "mono neg" : typeof v === "number" ? "mono" : ""}>{fmtCell(k, v)}</td>)}</tr>
                ))}
              </tbody></table></div>
            </div>
          )}
          {run.set_aside.length > 0 && (
            <div className="fl-card" style={{ overflow: "hidden" }} data-set-aside="">
              <div className="fl-hd"><span className="fl-h2">{fmtNum(s.set_aside)} set aside</span><span className="sp" /><span className="fl-lbl">couldn’t be matched</span></div>
              <div className="fl-tw"><table className="fl-t"><thead><tr><th>Why</th><th>From</th><th>Row</th></tr></thead><tbody>
                {run.set_aside.slice(0, 12).map((r, i) => (
                  <tr key={i}><td>{r.reason}</td><td>{r.source}</td><td className="mono" title={JSON.stringify(r.row)}>{Object.entries(r.row).slice(0, 3).map(([k, v]) => fmtCell(k, v)).join(" · ")}</td></tr>
                ))}
              </tbody></table></div>
            </div>
          )}
        </div>
      )}
      {run.preview?.rows?.length > 0 && (
        <div className="fl-card" style={{ overflow: "hidden" }}>
          <div className="fl-hd"><span className="fl-h2">{flow.output.name}</span><span className="fl-lbl">first {run.preview.rows.length} rows</span><span className="sp" />
            {flow.output.exists && flow.output.datasource_id && <Link className="fl-btn sm" to={`/workspace/${flow.output.datasource_id}`}>{I.open}Open the table</Link>}</div>
          <div className="fl-tw"><table className="fl-t"><thead><tr>{run.preview.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead><tbody>
            {run.preview.rows.map((r, i) => <tr key={i}>{run.preview.columns.map((c) => <td key={c} className={neg(r[c]) ? "mono neg" : typeof r[c] === "number" ? "mono" : ""}>{fmtCell(c, r[c])}</td>)}</tr>)}
          </tbody></table></div>
        </div>
      )}
      <UsedBy flow={flow} />
    </>
  );
}

function UsedBy({ flow }: { flow: Flow }) {
  if (!flow.output.exists) return null;
  return (
    <div className="fl-card" style={{ overflow: "hidden" }} data-used-by="">
      <div className="fl-hd"><span className="fl-h2">Uses {flow.output.name}</span><span className="sp" /><span className="fl-lbl">they update when it does</span></div>
      {flow.used_by.length === 0 ? (
        <div style={{ padding: "12px 16px", fontSize: 13.5, color: "var(--fl-2)" }}>Nothing uses it yet. Build a dashboard or ask questions on the table - it’s a normal data source in Data.</div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "12px 16px" }}>
          {flow.used_by.map((u) => <Link key={u.kind + u.id} to={u.link} className="fl-pill">{u.kind === "dashboard" ? "Dashboard" : u.kind === "doc" ? "Doc" : "Automation"} · {u.name}</Link>)}
        </div>
      )}
    </div>
  );
}

function CodeTab({ flow }: { flow: Flow }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(flow.code); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };
  return (
    <div className="fl-card" style={{ overflow: "hidden" }}>
      <div className="fl-hd"><span className="fl-h2">The same plan as SQL</span><span className="fl-lbl">for people who read SQL · shown, not run</span><span className="sp" />
        <button type="button" className="fl-btn sm" onClick={copy}>{I.copy}{copied ? "Copied" : "Copy"}</button></div>
      <pre className="fl-code" data-flow-code="">{flow.code}</pre>
    </div>
  );
}

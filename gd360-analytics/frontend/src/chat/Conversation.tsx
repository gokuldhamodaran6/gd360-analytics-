// 2026-10-14 (R46): one conversation. Turns on the left, the canvas on the right when something rich is open.
// 2026-10-19 (R56, the Studio): talk left, work right. With the canvas open the thread is a 400 px column with its
// own header (title ▾, new) and suggestion pills above a one-line composer; the canvas carries one tab for every
// piece of work in the conversation - each answer's steps, dashboards, documents and models.
// 2026-10-19 (R57, "ask flow fixes" boards 3-7): a Guided analysis opens its steps on the canvas the moment it is
// asked (the plan fills in live, each step waits for "Looks right"); a quick answer with numbers opens beside the
// chat too; a report opens while it is being written; the follow-up box has its own source picker.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { projectsApi, type ProjectRun } from "../api/projects";
import { v2Api, type Conversation as ConvT, type Mode, type ReportLength, type Turn as TurnT } from "../api/v2";
import ScopePicker, { type Scope } from "../spaces/ScopePicker";
import { AskContext } from "../project/WaysForward";
import { CanvasRouter, canvasFromArtifact, canvasKey, type CanvasItem } from "./Canvas";
import { Composer } from "./Composer";
import { Shell, useHome } from "./Shell";
import TopNav from "../components/TopNav";
import { TurnView } from "./Turn";
import { CardActionsContext, type About, type CardActions, type CardTarget } from "./cardActions";
import { MenuButton, type FrameTab } from "../studio/Frame";
import { Ic } from "../studio/icons";
import "../studio/studio.css";

const MODE_KEY = "gd360_c2_mode";
const loadMode = (): Mode => { try { const m = localStorage.getItem(MODE_KEY); return m === "quick" || m === "guided" ? m : "auto"; } catch { return "auto"; } };

function liveRun(r: ProjectRun | undefined | null): boolean {
  return !!r && !["done", "failed", "stopped", "needs_input", "replaced"].includes(r.status);
}

const onPhone = () => typeof window !== "undefined" && !!window.matchMedia?.("(max-width: 760px)").matches;

/** R57: a Guided analysis waiting for the person's OK - nothing to follow until they act on the canvas */
function waiting(r: ProjectRun | undefined | null): boolean {
  return !!r && !!r.guided && r.status === "planned" && !r.busy && !(r.steps || []).some((s) => s.status === "running");
}

/** A data answer opens as steps on the canvas once it has something to show beside the prose.
 * R57: any answer with numbers (a chart, a table or a key number), and a Guided analysis from its first second. */
function stepsWorthy(r: ProjectRun | null | undefined): boolean {
  if (!r) return false;
  if (r.guided && !["failed", "stopped", "needs_input"].includes(r.status)) return true;
  const res = r.result as any;
  return r.status === "done" && !!res && ((r.steps || []).length > 0) && ((res.visuals || []).length > 0 || (r.steps || []).length > 1 || (res.evidence || []).length > 0 || (res.kpis || []).length > 0);
}

const short = (s: string, n = 30) => { const t = (s || "").replace(/\?$/, "").trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

export default function ConversationPage() {
  const { conversationId = "" } = useParams();
  return (
    <Shell active="chat">
      <ConversationBody key={conversationId} conversationId={conversationId} />
    </Shell>
  );
}

function ConversationBody({ conversationId }: { conversationId: string }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { reload: reloadHome, home } = useHome();
  const [conv, setConv] = useState<ConvT | null>(null);
  const [runs, setRuns] = useState<Record<string, ProjectRun>>({});
  const [canvas, setCanvas] = useState<CanvasItem | null>(null);
  const [canvasVersion, setCanvasVersion] = useState(0);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<Mode>(loadMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const openedRef = useRef<Set<string>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);
  const kept = useRef<string[]>([]);
  // R57: the follow-up box's own source picker - starts on the thread's sources; a change goes with the next question
  const [scope, setScope] = useState<Scope | null>(null);
  const [scopeChanged, setScopeChanged] = useState(false);

  const turns = conv?.turns || [];
  const setTurn = useCallback((t: TurnT) => setConv((c) => (c ? { ...c, turns: c.turns.some((x) => x.id === t.id) ? c.turns.map((x) => (x.id === t.id ? t : x)) : [...c.turns, t] } : c)), []);
  const setRun = useCallback((r: ProjectRun) => setRuns((m) => ({ ...m, [r.id]: r })), []);

  const loadRun = useCallback(async (id: string) => {
    try { const r = await projectsApi.run(id); setRun(r); return r; } catch { return null; }
  }, [setRun]);

  const load = useCallback(async () => {
    try {
      const c = await v2Api.get(conversationId);
      setConv(c);
      setScope((cur) => cur || (c.space_id ? { kind: "space", spaceId: c.space_id } : (c.source_ids || []).length ? { kind: "sources", ids: c.source_ids } : { kind: "all" }));
      await Promise.all(c.turns.filter((t) => t.run_id).map((t) => loadRun(t.run_id!)));
    } catch (e: any) {
      setLoadErr(e?.response?.status === 404 ? "This conversation isn't here, or isn't shared with you." : "Couldn't open this conversation.");
    }
  }, [conversationId, loadRun]);
  useEffect(() => { void load(); }, [load]);

  // polling: message turns still working, runs still running
  useEffect(() => {
    const pending = turns.filter((t) => t.status === "working" || (t.run_id && liveRun(runs[t.run_id]) && !(t.kind === "guided" && runs[t.run_id]?.status === "planned") && !waiting(runs[t.run_id])) || (t.run_id && !runs[t.run_id]));
    if (!pending.length) return;
    const id = setInterval(async () => {
      for (const t of pending) {
        if (t.run_id) {
          const r = await loadRun(t.run_id);
          // a guided analysis rests at "planned" between steps: its turn is re-read then too
          if (r && (!liveRun(r) || (t.kind === "guided" && r.status === "planned") || waiting(r))) {
            try { setTurn(await v2Api.turn(conversationId, t.id)); } catch { /* next tick */ }
            if (t.kind === "data" && r.status === "done") void reloadHome();
          }
        } else {
          try {
            const nt = await v2Api.turn(conversationId, t.id);
            setTurn(nt);
            if (nt.status !== "working" && nt.kind !== "guided") {
              if (nt.kind === "dashboard") void load();
              void reloadHome();
            }
          } catch { /* next tick */ }
        }
      }
    }, 1000);
    return () => clearInterval(id);
  }, [turns, runs, conversationId, loadRun, setTurn, load, reloadHome]);

  // a finished dashboard, document, model or analysis opens on the canvas by itself, once; an edit refreshes the open one
  useEffect(() => {
    for (const t of turns) {
      if (openedRef.current.has(t.id)) continue;
      // R57: a Guided analysis opens its steps at once; a report opens while it is being written
      if (t.kind === "data" && t.guided && t.run_id && t === turns[turns.length - 1]) {
        openedRef.current.add(t.id);
        setCanvas({ type: "steps", turn: t });
        continue;
      }
      // R59: a question opens the studio at once - the steps fill in on the canvas while they run, and a
      // problem is shown there too (no more full-width chat while an answer is being worked out)
      if (t.kind === "data" && !t.guided && t.run_id && t === turns[turns.length - 1] && !onPhone()) {
        const r = runs[t.run_id];
        if (r && (liveRun(r) || r.status === "failed" || r.status === "stopped" || (r.status === "done" && (r.steps || []).length > 0))) {
          openedRef.current.add(t.id);
          setCanvas({ type: "steps", turn: t });
          continue;
        }
      }
      if (t.kind === "document" && t.status === "working" && t === turns[turns.length - 1]) {
        const a = (t.artifacts || []).find((x) => x.type === "document" && x.doc_id);
        if (a) { const item = canvasFromArtifact(a, t, conversationId); if (item) { setCanvas(item); setCanvasVersion((v) => v + 1); } }
        continue;
      }
      if (t.status !== "done") continue;
      const a = (t.artifacts || []).find((x) => x.type === "dashboard" || x.type === "document" || x.type === "analysis" || x.type === "model");
      if (a) {
        openedRef.current.add(t.id);
        const item = canvasFromArtifact(a, t, conversationId);
        if (!item) continue;
        if (a.refresh) {
          setCanvas((cur) => (cur && (cur.type === "dashboard" || cur.type === "board") && cur.id === a.id ? { ...cur, name: a.name || cur.name }
            : cur && cur.type === "doc" && cur.id === a.doc_id ? { ...cur, title: a.title || cur.title } : item));
          setCanvasVersion((v) => v + 1);
        } else if (t === turns[turns.length - 1] && !onPhone()) setCanvas(item);
        continue;
      }
      // R56: an answer with steps opens as the Analysis canvas (R57: on a phone the answer stays in front - the
      // canvas is a full screen there, opened by "Open the steps"; a Guided analysis still opens it, it needs your OK)
      if (t.kind === "data" && t.run_id && stepsWorthy(runs[t.run_id])) {
        openedRef.current.add(t.id);
        if (t === turns[turns.length - 1] && !onPhone()) setCanvas({ type: "steps", turn: t });
      }
    }
  }, [turns, runs, conversationId]);

  // R63: when the person picks an earlier turn, the thread stays where they are (no jump to the end)
  const pickedAt = useRef(0);
  // R50: land on the latest turn - again once the canvas has opened and the column has narrowed
  useEffect(() => {
    const toEnd = () => {
      if (Date.now() - pickedAt.current < 1500) return;
      const el = document.scrollingElement || document.documentElement; el.scrollTo({ top: el.scrollHeight });
    };
    toEnd();
    const id = window.setTimeout(toEnd, 450);
    return () => window.clearTimeout(id);
  }, [turns.length, busy, !!canvas, turns[turns.length - 1]?.status]);

  const send = useCallback(async (q: string, extra: { accepted?: string[]; intent?: string | null; length?: ReportLength | null;
    explain_target?: CardTarget | null; about_target?: CardTarget | null; context_run_id?: string | null } = {}) => {
    const message = q.trim();
    if (!message || busy) return;
    setBusy(true); setError(null);
    try {
      const pick = scopeChanged && scope ? { source_ids: scope.kind === "sources" ? scope.ids : scope.kind === "all" ? [] : null, space_id: scope.kind === "space" ? scope.spaceId : null } : {};
      const t = await v2Api.send(conversationId, { message, mode, accepted: extra.accepted || kept.current, intent: extra.intent || null, length: extra.length || null,
        explain_target: (extra.explain_target as Record<string, unknown>) || null, about_target: (extra.about_target as Record<string, unknown>) || null,
        context_run_id: extra.context_run_id || null, ...pick });
      kept.current = [];
      // R58: a question card still waiting is settled by this message (the server did the same)
      setConv((c) => (c ? { ...c, turns: c.turns.map((x) => (x.kind === "check" && x.status === "needs_input" ? { ...x, status: "done", settled: message.slice(0, 160) } : x)) } : c));
      if (scopeChanged) { setScopeChanged(false); void v2Api.get(conversationId).then((c) => setConv((cur) => (cur ? { ...cur, source_ids: c.source_ids, sources: c.sources, space_id: c.space_id, space_name: c.space_name } : cur))).catch(() => undefined); }
      setTurn(t);
      setText("");
      if (t.run_id) void loadRun(t.run_id);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || "That didn't send. Try again.");
    } finally { setBusy(false); }
  }, [busy, conversationId, mode, setTurn, loadRun, scope, scopeChanged]);

  // R58: a card's Ask - the box says what the question is about ("About: the chart “…” ×"); the text stays the person's own
  const [about, setAbout] = useState<About | null>(null);
  const cardActions: CardActions = useMemo(() => ({
    explain: (label, target, runId) => { void send(`Explain ${label}`, { intent: "explain", explain_target: target, context_run_id: runId }); },
    about: (a) => {
      setAbout(a);
      window.setTimeout(() => (document.getElementById("c2-ask") as HTMLTextAreaElement | null)?.focus(), 30);
    },
  }), [send]);
  const submit = () => {
    if (about) {
      // R62: Ask keeps the card in the box - ask as many questions about it as you like; × lets it go
      const a = about;
      void send(`${a.prefix}: ${text.trim()}`, { about_target: a.target, context_run_id: a.runId });
      return;
    }
    void send(text);
  };
  const prefill = useCallback((q: string) => {
    setText(q);
    window.setTimeout(() => { const el = document.getElementById("c2-ask") as HTMLTextAreaElement | null; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 30);
  }, []);
  const onMode = (m: Mode) => { setMode(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* fine */ } };
  const onConfirm = async (t: TurnT, approve: boolean) => {
    setBusy(true);
    try { setTurn(await v2Api.confirm(conversationId, t.id, approve)); void reloadHome(); } catch (e: any) { setError(e?.response?.data?.detail || "Couldn't confirm."); } finally { setBusy(false); }
  };
  const onRevise = async (t: TurnT, edits: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try { setTurn(await v2Api.revise(conversationId, t.id, edits)); } catch (e: any) { setError(e?.response?.data?.detail || "Couldn't change that."); } finally { setBusy(false); }
  };
  const onMakeDashboard = async (t?: TurnT | null) => {
    setBusy(true);
    try { setTurn(await v2Api.dashboard(conversationId, { run_ids: t?.run_id ? [t.run_id] : undefined })); } catch (e: any) { setError(e?.response?.data?.detail || "Couldn't start the dashboard."); } finally { setBusy(false); }
  };
  const sourcesLabel = useMemo(() => {
    if (!conv) return null;
    if (conv.space_name) return conv.space_name;
    const n = conv.sources?.length || 0;
    return n === 0 ? "No data yet · world questions and what-ifs" : n === 1 ? conv.sources[0].name : `${conv.sources[0].name} +${n - 1}`;
  }, [conv]);
  const title = conv?.title || "Conversation";
  const rename = async () => {
    const t = window.prompt("Name this conversation", title);
    if (t && t.trim() && conv) { await v2Api.update(conv.id, { title: t.trim() }); setConv({ ...conv, title: t.trim() }); void reloadHome(); }
  };
  useEffect(() => {
    const q = params.get("ask");
    if (q && conv && !busy) { setParams({}, { replace: true }); void send(q); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv]);

  // ---- the canvas tabs: every piece of work in this conversation ----
  const items = useMemo(() => {
    const out: { item: CanvasItem; icon: string; label: string; badge?: string | null }[] = [];
    const seen = new Set<string>();
    const push = (item: CanvasItem | null, icon: string, label: string, badge?: string | null) => {
      if (!item) return;
      const k = canvasKey(item);
      if (seen.has(k)) return;
      seen.add(k); out.push({ item, icon, label, badge });
    };
    for (const t of turns) {
      // R59: a question's own tab exists from the moment it is asked (working, didn't finish, stopped)
      const tr = t.kind === "data" && t.run_id ? runs[t.run_id] : null;
      if (tr && !t.guided && !stepsWorthy(tr) && (liveRun(tr) || tr.status === "failed" || tr.status === "stopped")) {
        push({ type: "steps", turn: t }, "trend", short(t.question), liveRun(tr) ? "working" : tr.status === "stopped" ? "stopped" : "didn't finish");
        continue;
      }
      if (t.status !== "done" && !(t.kind === "data" && t.guided) && !(t.kind === "document" && (t.artifacts || []).some((a) => a.doc_id))) continue;
      if (t.kind === "data" && t.run_id && stepsWorthy(runs[t.run_id])) {
        const r = runs[t.run_id]!;
        // R58: the same count as the thread ("Built 1 step") - the queries; charts and findings are not steps
        const n = (r.steps || []).filter((x) => x.status !== "skipped").length;
        const g = r.guided && r.status !== "done";
        push({ type: "steps", turn: t }, "trend", short(t.question), g ? (r.status === "planning" ? "planning" : `${(r.steps || []).filter((x) => x.status === "done").length} of ${(r.steps || []).length}`) : `${n} step${n === 1 ? "" : "s"}`);
      }
      for (const a of t.artifacts || []) {
        const it = canvasFromArtifact(a, t, conversationId);
        if (!it) continue;
        if (it.type === "board" || it.type === "dashboard") push(it, "grid", short(it.name, 28));
        else if (it.type === "doc" || it.type === "document") push(it, "doc", short(it.title, 28));
        else if (it.type === "analysis") push(it, "trend", short(t.analysis?.title || t.question), "analysis");
        else if (it.type === "model") push(it, "chip", short(it.name, 26), "model");
      }
    }
    for (const d of conv?.dashboards || []) {
      push(d.layout_version === 4 ? { type: "board", id: d.id, name: d.name } : { type: "dashboard", id: d.id, name: d.name, url: `/dashboard-builder/${d.id}` }, "grid", short(d.name, 28));
    }
    return out;
  }, [turns, runs, conv?.dashboards, conversationId]);
  const curKey = canvas ? canvasKey(canvas) : "";
  // R63: every turn opens its own work on the right - click turn 3 and the right shows turn 3's answer, its dashboard,
  // its document or its model; an Explain shows the answer it explains. The turn shown on the right is marked.
  const turnItem = useCallback((t: TurnT): CanvasItem | null => {
    if (t.kind === "data" && t.run_id) {
      const r = runs[t.run_id];
      if (r && (stepsWorthy(r) || (r.steps || []).length > 0 || liveRun(r) || r.status === "failed" || r.status === "stopped")) return { type: "steps", turn: t };
    }
    for (const a of t.artifacts || []) { const it = canvasFromArtifact({ ...a, refresh: false } as typeof a, t, conversationId); if (it) return it; }
    const pl = (t.placements || [])[0];
    if (pl) return { type: "dashboard", id: pl.dashboard_id, name: pl.dashboard_name, url: `/dashboard-builder/${pl.dashboard_id}`, pageId: pl.page_id };
    if (t.kind !== "data" && t.run_id) {
      const owner = turns.find((x) => x.kind === "data" && x.run_id === t.run_id);
      if (owner) return owner.run_id && runs[owner.run_id] ? { type: "steps", turn: owner } : null;
    }
    if (t.status === "done" && (t.trail || []).some((x) => x.sql)) return { type: "method", turn: t };
    return null;
  }, [runs, turns, conversationId]);
  const [picked, setPicked] = useState<string | null>(null);
  const activeTurnId = useMemo(() => {
    if (!canvas) return null;
    const p = picked ? turns.find((t) => t.id === picked) : null;
    if (p) { const it = turnItem(p); if (it && canvasKey(it) === curKey) return p.id; }
    for (let i = turns.length - 1; i >= 0; i--) { const it = turnItem(turns[i]); if (it && canvasKey(it) === curKey) return turns[i].id; }
    return null;
  }, [canvas, curKey, picked, turns, turnItem]);
  const selectTurn = useCallback((t: TurnT) => {
    const it = turnItem(t);
    if (!it) return;
    pickedAt.current = Date.now();
    setPicked(t.id);
    setCanvas(it);
  }, [turnItem]);
  // a tab picked on the right brings its turn into view on the left
  const lastActive = useRef<string | null>(null);
  useEffect(() => {
    if (!activeTurnId || activeTurnId === lastActive.current) return;
    const first = lastActive.current === null;
    lastActive.current = activeTurnId;
    if (first || Date.now() - pickedAt.current < 1500) return;
    document.querySelector(`[data-c2-turn-id="${activeTurnId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeTurnId]);
  const tabs: FrameTab[] = useMemo(() => {
    const t = items.map((x) => ({ key: canvasKey(x.item), icon: x.icon, label: x.label, badge: x.badge, on: canvasKey(x.item) === curKey, onClick: () => { setPicked(null); setCanvas(x.item); } }));
    if (canvas && !t.some((x) => x.on)) t.push({ key: curKey, icon: canvas.type === "method" ? "code" : "spark", label: canvas.type === "method" ? "How I worked it out" : "Open", badge: null, on: true, onClick: () => undefined });
    return t;
  }, [items, curKey, canvas]);
  // R60: reopening a conversation shows its latest work on the canvas - the answers' steps, the report and the
  // dashboards were hidden behind "Open the work" whenever the last turn had nothing of its own to open
  const landedRef = useRef<string | null>(null);
  useEffect(() => {
    if (landedRef.current === conversationId || !turns.length || !items.length) return;
    landedRef.current = conversationId;
    const last = turns[turns.length - 1];
    if (onPhone() || last.status === "working") return;   // a turn still working opens its own canvas
    if (!canvas) setCanvas(items[items.length - 1].item);
  }, [conversationId, turns, items, canvas]);
  const lastData = [...turns].reverse().find((t) => t.kind === "data" && t.run_id && runs[t.run_id]?.status === "done") || null;
  const addMenu = (close: () => void) => (
    <>
      <button type="button" disabled={!lastData || busy} onClick={() => { close(); void onMakeDashboard(lastData); }} data-sd-new="dashboard"><span>Dashboard</span><small>{lastData ? "live charts from the latest answer" : "ask a question about your data first"}</small></button>
      <button type="button" disabled={!turns.length || busy} onClick={() => { close(); void send("Write this up as a document"); }} data-sd-new="doc"><span>Document</span><small>a write-up with every number linked</small></button>
      <button type="button" onClick={() => { close(); prefill("Train a model to predict "); }} data-sd-new="model"><span>Model</span><small>say what to predict</small></button>
      <button type="button" onClick={() => { close(); navigate("/automate"); }} data-sd-new="pipeline"><span>Pipeline</span><small>a data job that runs on a schedule</small></button>
    </>
  );

  // ---- suggestion pills above the composer (Studio) ----
  const last = turns[turns.length - 1];
  const sugg: { label: string; icon: string; go: () => void }[] = [];
  if (last && last.status === "done") {
    const r = last.run_id ? runs[last.run_id] : null;
    if (last.kind === "data" && r?.status === "done") {
      if (!(last.placements || []).length && (r.result?.visuals || []).length) sugg.push({ label: "Make a dashboard", icon: "grid", go: () => void onMakeDashboard(last) });
      sugg.push({ label: "Write it up as a doc", icon: "doc", go: () => void send("Write this up as a document") });
      // R62: alerts are set on a dashboard, over its charts - an answer offers its follow-up questions instead
      for (const q of (r.result?.answer?.next_questions || []).slice(0, 2)) sugg.push({ label: short(q, 44), icon: "chat", go: () => void send(q) });
    } else if (last.kind === "dashboard" || last.kind === "dashboard_edit") {
      sugg.push({ label: "Alert me on a number", icon: "bell", go: () => prefill("Alert me when ") });
      sugg.push({ label: "Email it every Monday", icon: "clock", go: () => void send("Email this dashboard every Monday at 9am") });
      sugg.push({ label: "Write it up as a doc", icon: "doc", go: () => void send("Write this up as a document") });
      sugg.push({ label: "Undo the last change", icon: "undo", go: () => void send("undo") });
    } else if (last.kind === "document" || last.kind === "document_edit") {
      sugg.push({ label: "Add a risks section", icon: "plus", go: () => prefill("Add a section on the risks: ") });
      sugg.push({ label: "Make a dashboard of it", icon: "grid", go: () => void send("Make a dashboard from this") });
    } else if (last.kind === "model") {
      sugg.push({ label: "Who is most likely?", icon: "users", go: () => void send("Who is most at risk? Show the list") });
      sugg.push({ label: "Re-check it every Monday", icon: "cal", go: () => void send("Re-train this model every Monday at 6am") });
    } else if (last.kind === "analysis") {
      sugg.push({ label: "Show the high-risk list", icon: "table", go: () => void send("show the high-risk list") });
      sugg.push({ label: "Make a dashboard", icon: "grid", go: () => void send("make this a dashboard") });
    }
  }

  if (loadErr) {
    return (
      <div className="c2-col"><TopNav /><div className="c2-body"><div className="c2-thread"><div className="c2-err">{loadErr}</div><Link to="/chat" className="c2-nx" style={{ alignSelf: "flex-start" }}>Start a new conversation</Link></div></div></div>
    );
  }
  const studio = !!canvas;
  return (
    <AskContext.Provider value={(q: string) => void send(q)}>
      <div className="c2-col" data-c2-conversation={conversationId} data-sd-studio={studio ? "" : undefined}>
        {!studio && (
          <TopNav hidePlan
            title={<>
              <button type="button" onClick={rename} title="Rename" data-c2-title=""
                style={{ background: "transparent", border: 0, font: "inherit", fontWeight: 600, cursor: "pointer", color: "inherit", padding: 0, textAlign: "left", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</button>
              {conv?.space_name && <span className="c2-chip gx-hide-sm" style={{ height: 26, flex: "0 0 auto" }}><span style={{ width: 8, height: 8, borderRadius: 4, background: conv.space_color || "rgb(var(--color-primary))" }} />{conv.space_name}</span>}
            </>}
            actions={<>
              {items.length > 0 && (
                <button type="button" className="gx-sc" data-c2-open-dashboard="" onClick={() => setCanvas(items[items.length - 1].item)}>Open the work</button>
              )}
              <button type="button" className="gx-sc gx-hide-sm" onClick={() => { void navigator.clipboard?.writeText(window.location.href).catch(() => undefined); }} title="Copy link">Share</button>
            </>}
          />
        )}
        <div className={`c2-main${studio ? " has-canvas sd-studio" : ""}`} style={{ flex: 1, minHeight: 0 }}>
          <div className="c2-col" style={{ minHeight: 0 }}>
            {studio && (
              <div className="sd sd-th" data-sd-thread-head="">
                <MenuButton className="ttl" label={<span data-c2-title="">{title}</span>} caret data="thread" shrink>
                  {(close) => <>
                    <button type="button" onClick={() => { close(); void rename(); }}>Rename</button>
                    <button type="button" onClick={() => { close(); void navigator.clipboard?.writeText(window.location.href).catch(() => undefined); }}>Copy the link<small>people with access to this workspace can open it</small></button>
                    <button type="button" onClick={() => { close(); setCanvas(null); }}>Close the canvas<small>the thread full width</small></button>
                    {conv?.space_name && <span className="sd-note" style={{ padding: "6px 10px" }}>In the Space “{conv.space_name}”</span>}
                  </>}
                </MenuButton>
                <span className="sd-sp" />
                <Link to="/chat" className="sd-ib" title="New conversation" aria-label="New conversation"><Ic n="plus" s={18} /></Link>
              </div>
            )}
            <div className="c2-body">
              <div className="c2-thread" data-c2-thread="">
                {!conv && <span className="c2-working"><span className="c2-spin" /> Opening…</span>}
                {turns.map((t) => (
                  <TurnView key={t.id} turn={t} run={t.run_id ? runs[t.run_id] : null} conversationId={conversationId} busy={busy}
                    selectable={!!turnItem(t)} active={t.id === activeTurnId} onSelect={() => selectTurn(t)}
                    onCanvas={!!canvas && canvas.type === "steps" && canvas.turn.id === t.id}
                    onAsk={(q) => void send(q)}
                    onOpenArtifact={(a, tt) => { const item = canvasFromArtifact(a, tt, conversationId); if (item) setCanvas(item); }}
                    onOpenMethod={(tt) => setCanvas(tt.kind === "data" && tt.run_id && stepsWorthy(runs[tt.run_id]) ? { type: "steps", turn: tt } : { type: "method", turn: tt })}
                    onOpenSteps={(tt) => setCanvas({ type: "steps", turn: tt })}
                    onLength={(tt, len) => void send(`Write it as a ${len} report`, { intent: "document", length: len })}
                    onConfirm={onConfirm}
                    onPickCheck={(q, k) => { if (k) kept.current = [...kept.current, k]; void send(q); }}
                    onRunChanged={setRun}
                    onMakeDashboard={(tt) => void onMakeDashboard(tt)}
                    onRevise={onRevise}
                    onExplainMore={(tt) => void send("Explain it in detail", { intent: "explain", explain_target: (tt.explain?.target as CardTarget) || null, context_run_id: tt.run_id || null })}
                  />
                ))}
                {error && <div className="c2-err" data-c2-send-error="">{error}</div>}
                <div ref={endRef} />
              </div>
              <div className="c2-foot">
                {studio && sugg.length > 0 && (
                  <div className="sd sd-sugg" style={{ marginBottom: 10 }} data-sd-suggestions="">
                    {sugg.slice(0, 4).map((s) => <button key={s.label} type="button" className="sd-pill sm" disabled={busy} onClick={s.go}><Ic n={s.icon} s={14} />{s.label}</button>)}
                  </div>
                )}
                <Composer value={text} onChange={setText} onSubmit={submit} mode={mode} onMode={onMode} busy={busy} compact={studio}
                  placeholder={about ? "Ask about it…" : studio ? "Ask a follow-up, or say what to make…" : turns.length ? "Ask a follow-up, or say what to make…" : "Ask anything…"}
                  sourcesLabel={sourcesLabel} autoFocus
                  context={about ? (
                    <span className="c2-about" data-c2-about="">
                      <span className="k">About</span><span className="t" title={about.label}>{about.label}</span>
                      <button type="button" onClick={() => setAbout(null)} aria-label="Ask about the whole thread instead" data-c2-about-clear="">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                      </button>
                    </span>
                  ) : undefined}
                  scope={scope && (home?.sources || []).length ? (
                    <ScopePicker scope={scope} onChange={(sc) => { setScope(sc); setScopeChanged(true); }} sources={(home?.sources || []) as any} spaces={home?.spaces || []}
                      variant="compact" placement="above" disabled={busy} />
                  ) : undefined} />
              </div>
            </div>
          </div>
          {canvas && (
            <CardActionsContext.Provider value={cardActions}>
            <CanvasRouter item={canvas} frame={{ tabs, addMenu, onClose: () => setCanvas(null) }} version={canvasVersion} runs={runs}
              conversationId={conversationId} busy={busy}
              onAsk={(q) => void send(q)} onPrefill={prefill} onRunChanged={setRun}
              onTurnRefresh={async (turnId: string) => { try { setTurn(await v2Api.turn(conversationId, turnId)); } catch { /* next time */ } }}
              onMakeDashboard={(tt) => void onMakeDashboard(tt)}
              onOpenMethod={(tt) => setCanvas({ type: "method", turn: tt })}
              onOpen={(it) => setCanvas(it)}
              onSource={(src) => {
                // a source chip opens the step it points at: the analysis on the canvas, or the turn in the thread
                const t = turns.find((x) => x.id === src.turn_id);
                if (t && t.kind === "analysis" && t.analysis) { setCanvas({ type: "analysis", turn: t }); return; }
                if (t && t.kind === "data" && t.run_id && stepsWorthy(runs[t.run_id])) { setCanvas({ type: "steps", turn: t }); return; }
                if (src.kind === "dashboard" && src.turn_id) { setCanvas({ type: "board", id: src.turn_id, name: src.label.replace(/^Dashboard · /, "") }); return; }
                document.querySelector(`[data-c2-turn-id="${src.turn_id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
              }} />
            </CardActionsContext.Provider>
          )}
        </div>
      </div>
    </AskContext.Provider>
  );
}

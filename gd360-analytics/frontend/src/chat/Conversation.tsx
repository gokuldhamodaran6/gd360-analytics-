// 2026-10-14 (R46): one conversation. Turns on the left, the canvas on the right when something rich is open.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { projectsApi, type ProjectRun } from "../api/projects";
import { v2Api, type Artifact, type Conversation as ConvT, type Mode, type Turn as TurnT } from "../api/v2";
import { AskContext } from "../project/WaysForward";
import { Canvas, canvasFromArtifact, type CanvasItem } from "./Canvas";
import { Composer } from "./Composer";
import { Shell, ThemeButton, useHome } from "./Shell";
import { TurnView } from "./Turn";

const MODE_KEY = "gd360_c2_mode";
const loadMode = (): Mode => { try { const m = localStorage.getItem(MODE_KEY); return m === "quick" || m === "guided" ? m : "auto"; } catch { return "auto"; } };

function liveRun(r: ProjectRun | undefined | null): boolean {
  return !!r && !["done", "failed", "stopped", "needs_input", "replaced"].includes(r.status);
}

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
  const { reload: reloadHome } = useHome();
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
      await Promise.all(c.turns.filter((t) => t.run_id).map((t) => loadRun(t.run_id!)));
    } catch (e: any) {
      setLoadErr(e?.response?.status === 404 ? "This conversation isn't here, or isn't shared with you." : "Couldn't open this conversation.");
    }
  }, [conversationId, loadRun]);
  useEffect(() => { void load(); }, [load]);

  // polling: message turns still working, runs still running
  useEffect(() => {
    const pending = turns.filter((t) => t.status === "working" || (t.run_id && liveRun(runs[t.run_id]) && !(t.kind === "guided" && runs[t.run_id]?.status === "planned")) || (t.run_id && !runs[t.run_id]));
    if (!pending.length) return;
    const id = setInterval(async () => {
      for (const t of pending) {
        if (t.run_id) {
          const r = await loadRun(t.run_id);
          // a guided analysis rests at "planned" between steps: its turn is re-read then too
          if (r && (!liveRun(r) || (t.kind === "guided" && r.status === "planned"))) {
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

  // a finished dashboard or document opens on the canvas by itself, once; an edit refreshes the open one
  useEffect(() => {
    for (const t of turns) {
      if (t.status !== "done" || openedRef.current.has(t.id)) continue;
      const a = (t.artifacts || []).find((x) => x.type === "dashboard" || x.type === "document");
      if (a) {
        openedRef.current.add(t.id);
        const item = canvasFromArtifact(a, t, conversationId);
        if (!item) continue;
        if (a.refresh) {
          setCanvas((cur) => (cur && cur.type === "dashboard" && cur.id === a.id ? { ...cur, name: a.name || cur.name } : item));
          setCanvasVersion((v) => v + 1);
        } else if (t === turns[turns.length - 1]) setCanvas(item);
      }
    }
  }, [turns, conversationId]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [turns.length, busy]);

  const send = useCallback(async (q: string, extra: { accepted?: string[]; intent?: string | null } = {}) => {
    const message = q.trim();
    if (!message || busy) return;
    setBusy(true); setError(null);
    try {
      const t = await v2Api.send(conversationId, { message, mode, accepted: extra.accepted || kept.current, intent: extra.intent || null });
      kept.current = [];
      setTurn(t);
      setText("");
      if (t.run_id) void loadRun(t.run_id);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || "That didn't send. Try again.");
    } finally { setBusy(false); }
  }, [busy, conversationId, mode, setTurn, loadRun]);

  const onMode = (m: Mode) => { setMode(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* fine */ } };
  const onConfirm = async (t: TurnT, approve: boolean) => {
    setBusy(true);
    try { setTurn(await v2Api.confirm(conversationId, t.id, approve)); void reloadHome(); } catch (e: any) { setError(e?.response?.data?.detail || "Couldn't confirm."); } finally { setBusy(false); }
  };
  const onMakeDashboard = async (t: TurnT) => {
    setBusy(true);
    try { setTurn(await v2Api.dashboard(conversationId, { run_ids: t.run_id ? [t.run_id] : undefined })); } catch (e: any) { setError(e?.response?.data?.detail || "Couldn't start the dashboard."); } finally { setBusy(false); }
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

  if (loadErr) {
    return (
      <div className="c2-col"><div className="c2-head"><ThemeButton /></div><div className="c2-body"><div className="c2-thread"><div className="c2-err">{loadErr}</div><Link to="/chat" className="c2-nx" style={{ alignSelf: "flex-start" }}>Start a new conversation</Link></div></div></div>
    );
  }
  return (
    <AskContext.Provider value={(q: string) => void send(q)}>
      <div className="c2-col" data-c2-conversation={conversationId}>
        <div className="c2-main" style={{ flex: 1, minHeight: 0 }}>
          <div className="c2-col" style={{ minHeight: 0 }}>
        <div className="c2-head">
          <button type="button" className="title" onClick={rename} title="Rename" style={{ background: "transparent", border: 0, font: "inherit", cursor: "pointer", color: "inherit", padding: 0, textAlign: "left" }}>{title}</button>
          {conv?.space_name && <span className="c2-chip" style={{ height: 26 }}><span style={{ width: 8, height: 8, borderRadius: 4, background: conv.space_color || "rgb(var(--color-primary))" }} />{conv.space_name}</span>}
          <span style={{ flex: 1 }} />
          {conv && conv.dashboards.length > 0 && !canvas && (
            <button type="button" className="c2-nx sm" onClick={() => setCanvas({ type: "dashboard", id: conv.dashboards[0].id, name: conv.dashboards[0].name, url: `/dashboard-builder/${conv.dashboards[0].id}` })}>Open dashboard</button>
          )}
          <Link to={`/p/${conversationId}`} className="c2-nx sm ghost" title="The classic project page for this conversation">Classic view</Link>
          <button type="button" className="c2-nx sm" onClick={() => { void navigator.clipboard?.writeText(window.location.href); }} title="Copy link">Share</button>
          <ThemeButton />
        </div>
            <div className="c2-body">
              <div className="c2-thread" data-c2-thread="">
                {!conv && <span className="c2-working"><span className="c2-spin" /> Opening…</span>}
                {turns.map((t) => (
                  <TurnView key={t.id} turn={t} run={t.run_id ? runs[t.run_id] : null} conversationId={conversationId} busy={busy}
                    onAsk={(q) => void send(q)}
                    onOpenArtifact={(a, tt) => { const item = canvasFromArtifact(a, tt, conversationId); if (item) setCanvas(item); }}
                    onOpenMethod={(tt) => setCanvas({ type: "method", turn: tt })}
                    onConfirm={onConfirm}
                    onPickCheck={(q, k) => { if (k) kept.current = [...kept.current, k]; void send(q); }}
                    onRunChanged={setRun}
                    onMakeDashboard={onMakeDashboard}
                  />
                ))}
                {error && <div className="c2-err" data-c2-send-error="">{error}</div>}
                <div ref={endRef} />
              </div>
              <div className="c2-foot">
                <Composer value={text} onChange={setText} onSubmit={() => void send(text)} mode={mode} onMode={onMode} busy={busy}
                  placeholder={turns.length ? "Ask a follow-up, or say what to make…" : "Ask anything…"} sourcesLabel={sourcesLabel} autoFocus />
              </div>
            </div>
          </div>
          {canvas && <Canvas item={canvas} onClose={() => setCanvas(null)} version={canvasVersion} run={canvas.type === "method" && canvas.turn.run_id ? runs[canvas.turn.run_id] : null} />}
        </div>
      </div>
    </AskContext.Provider>
  );
}

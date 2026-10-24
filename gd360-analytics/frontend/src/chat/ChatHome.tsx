// 2026-10-14 (R46): Home - one box, your Spaces, what you asked last. Not a chat list.
// 2026-10-15 (R50, mockup board 01): the one shell's top bar; the greeting with your name; questions written
// from your own measures; Spaces with their real counts (sources, dashboards, conversations); Recent with the
// written title, the finding under it, its Space and what it holds ("analysis + dashboard"), and when.
// "/chat" (the rail's New) is the same box on its own - no Spaces, no Recent - ready to type.
// 2026-10-19 (R55, Studio mockup "Home: one box, starter chips"): only the greeting, one large box (+, sources,
// Deep analysis, mic, send), five starters that each open a short explanation with steps and examples, a
// "things need you" pill in the top bar and one honest line at the bottom. Recent work lives in Library.
// 2026-10-19 (R57, "ask flow fixes" board 1): the starters, their panels and the sample questions are gone (they
// were about churn even with a sales table picked). Home is the greeting and the box; the box says which data it
// asks, and "Deep analysis" became a plain two-way switch - Quick answer or Guided analysis.
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { ProjectSource } from "../api/projects";
import { v2Api, type ConversationRow, type Mode } from "../api/v2";
import TopNav from "../components/TopNav";
import ScopePicker, { loadScope, saveScope, type Scope } from "../spaces/ScopePicker";
import { MicButton, useDictation } from "../thread/Dictation";
import { ModeSeg } from "./Composer";
import { opsApi } from "../api/ops";
import { flowsApi } from "../api/flows";
import { Shell, useHome } from "./Shell";

const MODE_KEY = "gd360_c2_mode";
const loadMode = (): Mode => { try { const m = localStorage.getItem(MODE_KEY); return m === "guided" ? "guided" : "auto"; } catch { return "auto"; } };

export function greeting(first: string | undefined, now = new Date()): string {
  const h = now.getHours();
  const part = h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const name = first ? first.charAt(0).toUpperCase() + first.slice(1) : "";
  return name ? `${part}, ${name}.` : `${part}.`;
}

/** Today: 21:14 · this week: Tue · older: Oct 9 */
export function when(iso: string, now = Date.now()): string {
  const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return "";
  const days = (now - d.getTime()) / 86400000;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (days < 6) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function ChatHome() {
  return (
    <Shell active="home">
      <HomeBody />
    </Shell>
  );
}


export function RecentRow({ c }: { c: ConversationRow }) {
  const label = [c.space_name, c.work].filter(Boolean).join(" · ") || c.work || "conversation";
  return (
    <Link to={`/chat/${c.id}`} className="c2-rc" data-c2-recent-row="">
      <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
        <span className="t">{c.title}</span>
        {c.headline && <span className="h">{c.headline}</span>}
      </span>
      <span className="k"><span className="dot" style={{ background: c.space_color || "rgb(var(--color-border-strong))" }} />{label}</span>
      <span className="d">{when(c.last_at)}</span>
    </Link>
  );
}

const SI = {
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>,
  up: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>,
};

function HomeComposer({ value, onChange, onSubmit, mode, onMode, busy, scope, placeholder }: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; mode: Mode; onMode: (m: Mode) => void; busy: boolean; scope: JSX.Element; placeholder: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const dict = useDictation({ getText: () => value, setText: onChange });
  useEffect(() => { const el = ref.current; if (!el) return; el.style.height = "auto"; el.style.height = `${Math.min(240, Math.max(56, el.scrollHeight))}px`; }, [value]);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="hm-cmp" data-c2-composer="">
      <label htmlFor="c2-ask" className="gx-sr">Ask Euliv</label>
      <textarea id="c2-ask" ref={ref} rows={2} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (value.trim() && !busy) onSubmit(); } }} />
      {dict.error && <span style={{ fontSize: 12.5, color: "rgb(var(--color-danger))", padding: "0 22px" }}>{dict.error}</span>}
      <div className="bar">
        <Link to="/data" className="hm-ib line" aria-label="Add a file or a source" title="Add a file or a source">{SI.plus}</Link>
        {scope}
        <ModeSeg mode={mode} onMode={onMode} disabled={busy} />
        <span style={{ flex: 1 }} />
        {dict.supported && <MicButton listening={dict.listening} onClick={dict.toggle} size="sm" />}
        <button type="button" className="hm-send" onClick={onSubmit} disabled={!value.trim() || busy} aria-label="Send" data-c2-send="">
          {busy ? <span className="c2-spin" style={{ borderColor: "rgb(var(--color-on-primary))", borderTopColor: "transparent" }} /> : SI.up}
        </button>
      </div>
    </div>
  );
}

function HomeBody() {
  const { home, workspaceId } = useHome();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const isNew = pathname.startsWith("/chat");
  const [params] = useSearchParams();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<Mode>(loadMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needs, setNeeds] = useState<{ n: number; to: string; titles: string[] }>({ n: 0, to: "/automations", titles: [] });
  const [scope, setScope] = useState<Scope>(() => loadScope(workspaceId) || { kind: "all" });
  useEffect(() => { const saved = loadScope(workspaceId); if (saved) setScope(saved); }, [workspaceId]);
  // R56: "Ask about it" on a source (Data) and "Start with this data" after connecting open Home on that source
  useEffect(() => { const sid = params.get("source"); if (sid) setScope({ kind: "sources", ids: [sid] }); }, [params]);
  // R56: "?ask=" (Models, a model page, a source) and the first question picked while signing up wait in the box -
  // filled in, never sent on their own
  useEffect(() => {
    const q = params.get("ask");
    if (q) { setText(q); window.setTimeout(() => document.getElementById("c2-ask")?.focus(), 0); return; }
    try {
      const first = sessionStorage.getItem("gd360_first_question");
      if (first) { setText(first); sessionStorage.removeItem("gd360_first_question"); }
    } catch { /* storage may be blocked */ }
  }, [params]);
  const sources = (home?.sources || []) as unknown as ProjectSource[];
  const spaces = home?.spaces || [];
  const hasData = sources.length > 0;
  const showPlan = params.get("plan") === "1";
  useEffect(() => {
    let live = true;
    Promise.all([
      opsApi.overview(workspaceId || null).then((o) => o.attention || []).catch(() => []),
      flowsApi.list(workspaceId || null).then((f) => f.filter((x) => x.needs_fix)).catch(() => []),
    ]).then(([att, fl]) => {
      if (!live) return;
      const titles = [...fl.map((f) => `${f.name} was held`), ...att.map((a: any) => a.title)];
      setNeeds({ n: titles.length, to: fl.length && !att.length ? `/automate/${fl[0].id}` : "/automations", titles });
    });
    return () => { live = false; };
  }, [workspaceId]);
  // R56 (mobile board "Today"): on a phone Home is also the day's list - what needs you, and the last answers
  const [recent, setRecent] = useState<ConversationRow[] | null>(null);
  useEffect(() => {
    if (isNew || typeof window === "undefined" || !window.matchMedia?.("(max-width: 760px)").matches) return;
    let live = true;
    v2Api.list(workspaceId || null).then((r) => live && setRecent(r.filter((c) => c.v2).slice(0, 5))).catch(() => live && setRecent([]));
    return () => { live = false; };
  }, [workspaceId, isNew]);
  // R57: the box says which data it asks - the picked sources, the Space, or the only source there is
  const scopeName = (() => {
    if (scope.kind === "space") return spaces.find((x: any) => x.id === scope.spaceId)?.name || "this Space";
    if (scope.kind === "sources") {
      const names = scope.ids.map((id) => sources.find((x) => x.id === id)?.name).filter(Boolean) as string[];
      return names.length === 1 ? names[0] : names.length ? `${names[0]} and ${names.length - 1} more` : "your data";
    }
    return sources.length === 1 ? sources[0].name : "your business";
  })();

  const start = async (q: string) => {
    const message = q.trim();
    if (!message || busy) return;
    setBusy(true); setError(null);
    try {
      saveScope(workspaceId, scope);
      const body = { message, mode, workspace_id: workspaceId || null, space_id: scope.kind === "space" ? scope.spaceId : null, source_ids: scope.kind === "sources" ? scope.ids : null };
      const out = await v2Api.start(body);
      navigate(`/chat/${out.conversation.id}`);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || "That didn't start. Try again.");
      setBusy(false);
    }
  };
  const onMode = (m: Mode) => { setMode(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* fine */ } };
  const first = home?.user?.first_name;
  const hello = greeting(first).replace(/\.$/, "");

  return (
    <div className="c2-col">
      <TopNav breadcrumb={[{ label: isNew ? "New" : "Home" }]}
        actions={needs.n > 0 ? <Link to={needs.to} className="hm-need" data-c2-needs="" title={needs.titles.slice(0, 3).join(" · ")}><i />{needs.n} thing{needs.n === 1 ? "" : "s"} need{needs.n === 1 ? "s" : ""} you</Link> : undefined} />
      <div className="hm" data-c2-home="">
        <div className="hm-in">
          <h1 data-c2-greeting="">{isNew ? "What do you want to know or build?" : hello}</h1>
          <HomeComposer value={text} onChange={setText} onSubmit={() => void start(text)} mode={mode} onMode={onMode} busy={busy}
            placeholder={hasData ? `Ask anything about ${scopeName}, or tell Euliv what to build` : "Ask anything. Connect data when you're ready."}
            scope={<ScopePicker scope={scope} onChange={setScope} sources={sources} spaces={spaces} variant="compact" placement="below" disabled={busy} />} />
          {error && <div className="c2-err">{error}</div>}
          <p className="hm-how" data-c2-how="">
            <b>Quick answer</b> gives the number, a chart and the reason in about 20 seconds. <b>Guided analysis</b> plans the steps, shows each step's numbers and waits for your OK.
          </p>
          {!isNew && recent && (
            <div className="hm-today" data-c2-today="">
              {needs.n > 0 && (
                <section>
                  <h2>Needs you <em>{needs.n}</em></h2>
                  {needs.titles.slice(0, 3).map((t) => <Link key={t} to={needs.to} className="row need"><i />{t}</Link>)}
                </section>
              )}
              <section>
                <h2>Recent answers</h2>
                {recent.length === 0 && <p className="none">Nothing yet. Your answers will be here.</p>}
                {recent.map((c) => (
                  <Link key={c.id} to={`/chat/${c.id}`} className="row" data-c2-today-row="">
                    <b>{c.title || "Untitled"}</b>
                    {c.headline && <span>{c.headline}</span>}
                  </Link>
                ))}
              </section>
            </div>
          )}
          {!hasData && home && (
            <div className="hm-nodata">No data connected yet - you can already ask world questions and what-ifs. <Link to="/data">Add data</Link></div>
          )}
        </div>
        <p className="hm-foot">Euliv can make mistakes. Every number links to the data it came from.</p>
      </div>
      {showPlan && <Navigate to="/settings/plan" replace />}
    </div>
  );
}

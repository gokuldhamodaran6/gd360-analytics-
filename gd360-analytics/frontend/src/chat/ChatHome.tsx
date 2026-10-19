// 2026-10-14 (R46): Home - one box, your Spaces, what you asked last. Not a chat list.
// 2026-10-15 (R50, mockup board 01): the one shell's top bar; the greeting with your name; questions written
// from your own measures; Spaces with their real counts (sources, dashboards, conversations); Recent with the
// written title, the finding under it, its Space and what it holds ("analysis + dashboard"), and when.
// "/chat" (the rail's New) is the same box on its own - no Spaces, no Recent - ready to type.
// 2026-10-19 (R55, Studio mockup "Home: one box, starter chips"): only the greeting, one large box (+, sources,
// Deep analysis, mic, send), five starters that each open a short explanation with steps and examples, a
// "things need you" pill in the top bar and one honest line at the bottom. Recent work lives in Library.
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { ProjectSource } from "../api/projects";
import { v2Api, type ConversationRow, type Mode } from "../api/v2";
import TopNav from "../components/TopNav";
import ScopePicker, { loadScope, saveScope, type Scope } from "../spaces/ScopePicker";
import { MicButton, useDictation } from "../thread/Dictation";
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

function examples(hasData: boolean, web: boolean): string[] {
  const out: string[] = [];
  if (hasData) out.push("Why are customers leaving?", "Revenue by region, last 90 days", "Which campaigns performed best this week?");
  else out.push("What if I add two baristas at the morning rush?", "NPV of a $50k machine returning $14k a year for 5 years at 8%");
  if (web) out.push("Who is the chief minister of Tamil Nadu?");
  out.push("Alert me if churn goes above 3%");
  return out.slice(0, 5);
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

type Starter = { key: string; label: string; icon: JSX.Element; title: string; desc: string; steps: string[]; examples: [string, string][]; go: "ask" | "automate" | "data" };
const SI = {
  chat: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>,
  grid: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="8" height="10" rx="1.5" /><rect x="13" y="3" width="8" height="6" rx="1.5" /><rect x="13" y="11" width="8" height="10" rx="1.5" /><rect x="3" y="15" width="8" height="6" rx="1.5" /></svg>,
  flow: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="12" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M8.5 6H12a3 3 0 0 1 3 3v.5M8.5 18H12a3 3 0 0 0 3-3v-.5" /></svg>,
  trend: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>,
  plug: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4" /></svg>,
  arrow: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>,
  x: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>,
  deep: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="2" /><ellipse cx="12" cy="12" rx="10" ry="4" /><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" /><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" /></svg>,
  up: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>,
};

function starters(ask: string[], hasData: boolean): Starter[] {
  return [
    { key: "ans", label: "Ask a question", icon: SI.chat, title: "Ask a question", go: "ask",
      desc: "Get a straight answer: the number, a chart, the reason and every source. About 20 seconds.",
      steps: ["Ask", "Answer with chart and reason", "Follow up, pin or share"],
      examples: ask.slice(0, 4).map((q) => [q, hasData ? "Your data" : "No data needed"]) },
    { key: "dash", label: "Build a dashboard", icon: SI.grid, title: "Build a dashboard", go: "ask",
      desc: "GD360 drafts a page of charts next to the chat. You change any chart by asking, then publish it to your team.",
      steps: ["Ask", "Approve the chart list", "Edit by chatting", "Publish and schedule"],
      examples: [["Make a weekly sales dashboard for store managers", "Sales"], ["Make a dashboard of revenue, orders and refunds by month", "Sales"],
        ["Make a dashboard of ad spend against revenue by channel", "Ads · Sales"], ["Make a dashboard of customers at risk of leaving", "Customers"]] },
    { key: "auto", label: "Automate data", icon: SI.flow, title: "Automate data", go: "automate",
      desc: "Combine and clean data on a schedule so reports are always ready. Engineers call this a pipeline.",
      steps: ["Ask", "Check the steps and tests", "Test on real rows", "Turn on"],
      examples: [["Every morning, combine Shopify orders with the refunds sheet and flag anything odd", "Shopify · Google Sheets"],
        ["Every day at 7, join the sales file with the store list", "Files"], ["Clean the supplier invoices sheet every morning", "Google Sheets"],
        ["Remove duplicate customers across the CRM and the shop", "CRM · Shop"]] },
    { key: "pred", label: "Predict", icon: SI.trend, title: "Predict", go: "ask",
      desc: "Forecast or score what is likely to happen, and see how often it was right before. Also called a model.",
      steps: ["Ask", "Agree what to predict", "See accuracy on past data", "Use the list or forecast"],
      examples: [["Forecast sales for the next 4 weeks", "Sales"], ["Which customers are likely to stop buying, and why?", "Customers"],
        ["Predict which leads will convert", "CRM"], ["How much stock should we order for next week?", "Inventory"]] },
    { key: "conn", label: "Connect data", icon: SI.plug, title: "Connect data", go: "data",
      desc: "Add a source in about two minutes. Read-only, nothing is copied unless you ask.",
      steps: ["Pick a source", "Sign in", "GD360 reads the structure", "Ask your first question"],
      examples: [["Upload a spreadsheet or CSV", "File"], ["Connect Google Sheets", "Sheets"], ["Connect Shopify", "App"], ["Connect a database or warehouse", "Database"]] },
  ];
}

function HomeComposer({ value, onChange, onSubmit, deep, onDeep, busy, scope, placeholder }: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; deep: boolean; onDeep: (v: boolean) => void; busy: boolean; scope: JSX.Element; placeholder: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const dict = useDictation({ getText: () => value, setText: onChange });
  useEffect(() => { const el = ref.current; if (!el) return; el.style.height = "auto"; el.style.height = `${Math.min(240, Math.max(56, el.scrollHeight))}px`; }, [value]);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="hm-cmp" data-c2-composer="">
      <label htmlFor="c2-ask" className="gx-sr">Ask GD360</label>
      <textarea id="c2-ask" ref={ref} rows={2} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (value.trim() && !busy) onSubmit(); } }} />
      {dict.error && <span style={{ fontSize: 12.5, color: "rgb(var(--color-danger))", padding: "0 22px" }}>{dict.error}</span>}
      <div className="bar">
        <Link to="/data" className="hm-ib line" aria-label="Add a file or a source" title="Add a file or a source">{SI.plus}</Link>
        {scope}
        <button type="button" className={`hm-tg${deep ? " on" : ""}`} aria-pressed={deep} onClick={() => onDeep(!deep)} data-c2-deep=""
          title="Deep analysis: every step shown and paused, so you can change a definition and it re-runs from there">{SI.deep}Deep analysis</button>
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
  const [open, setOpen] = useState<string | null>(null);
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
  const askExamples = home?.examples?.length ? home.examples : examples(hasData, !!home?.web);
  const list = starters(askExamples, hasData);
  const cur = list.find((x) => x.key === open) || null;

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
  const onDeep = (on: boolean) => { const m: Mode = on ? "guided" : "auto"; setMode(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* fine */ } };
  const pick = (st: Starter, q: string) => {
    if (st.go === "automate") { navigate(`/automate?q=${encodeURIComponent(q)}`); return; }
    if (st.go === "data") { navigate("/data"); return; }
    void start(q);
  };
  const first = home?.user?.first_name;
  const hello = greeting(first).replace(/\.$/, "");

  return (
    <div className="c2-col">
      <TopNav breadcrumb={[{ label: isNew ? "New" : "Home" }]}
        actions={needs.n > 0 ? <Link to={needs.to} className="hm-need" data-c2-needs="" title={needs.titles.slice(0, 3).join(" · ")}><i />{needs.n} thing{needs.n === 1 ? "" : "s"} need{needs.n === 1 ? "s" : ""} you</Link> : undefined} />
      <div className="hm" data-c2-home="">
        <div className="hm-in">
          <h1 data-c2-greeting="">{isNew ? "What do you want to know or build?" : hello}</h1>
          <HomeComposer value={text} onChange={setText} onSubmit={() => void start(text)} deep={mode === "guided"} onDeep={onDeep} busy={busy}
            placeholder={hasData ? "Ask anything about your business, or tell GD360 what to build" : "Ask anything. Connect data when you're ready."}
            scope={<ScopePicker scope={scope} onChange={setScope} sources={sources} spaces={spaces} variant="compact" placement="below" disabled={busy} />} />
          {error && <div className="c2-err">{error}</div>}
          <div className="hm-st">
            <div className="hm-pills" role="tablist" aria-label="Things you can ask for">
              {list.map((st) => (
                <button key={st.key} type="button" role="tab" aria-selected={open === st.key} className={`hm-pill${open === st.key ? " on" : ""}`} data-c2-starter={st.key}
                  onClick={() => setOpen(open === st.key ? null : st.key)}>{st.icon}{st.label}</button>
              ))}
            </div>
            {cur && (
              <div className="hm-pn" role="tabpanel" aria-label={cur.title} data-c2-panel={cur.key}>
                <div className="hd">
                  <span className="ic">{cur.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b>{cur.title}</b>
                    <p>{cur.desc}</p>
                    <div className="stp">{cur.steps.map((s, i) => <span key={s} style={{ display: "contents" }}><span><em>{i + 1}</em>{s}</span>{i < cur.steps.length - 1 && <span className="sep" />}</span>)}</div>
                  </div>
                  <button type="button" className="cls" aria-label="Close" onClick={() => setOpen(null)}>{SI.x}</button>
                </div>
                <div data-c2-examples="">
                  {cur.examples.map(([q, m]) => (
                    <button key={q} type="button" className="ex" onClick={() => pick(cur, q)} disabled={busy}>{SI.arrow}<span>{q}</span><small>{m}</small></button>
                  ))}
                </div>
              </div>
            )}
          </div>
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
        <p className="hm-foot">GD360 can make mistakes. Every number links to the data it came from.</p>
      </div>
      {showPlan && <Navigate to="/settings/plan" replace />}
    </div>
  );
}

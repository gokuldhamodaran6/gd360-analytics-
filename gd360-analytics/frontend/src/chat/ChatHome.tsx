// 2026-10-14 (R46): Home - one box, your Spaces, what you asked last. Not a chat list.
// 2026-10-15 (R50, mockup board 01): the one shell's top bar; the greeting with your name; questions written
// from your own measures; Spaces with their real counts (sources, dashboards, conversations); Recent with the
// written title, the finding under it, its Space and what it holds ("analysis + dashboard"), and when.
// "/chat" (the rail's New) is the same box on its own - no Spaces, no Recent - ready to type.
import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { ProjectSource } from "../api/projects";
import { v2Api, type ConversationRow, type Mode, type PlanSummary } from "../api/v2";
import TopNav from "../components/TopNav";
import ScopePicker, { loadScope, saveScope, type Scope } from "../spaces/ScopePicker";
import { Composer } from "./Composer";
import { Shell, useHome } from "./Shell";

const MODE_KEY = "gd360_c2_mode";
const loadMode = (): Mode => { try { const m = localStorage.getItem(MODE_KEY); return m === "quick" || m === "guided" ? m : "auto"; } catch { return "auto"; } };

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

function plural(n: number, one: string, many = `${one}s`) { return `${n} ${n === 1 ? one : many}`; }

function RecentRow({ c }: { c: ConversationRow }) {
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

function HomeBody() {
  const { home, workspaceId } = useHome();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const isNew = pathname.startsWith("/chat");
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<Mode>(loadMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>(() => loadScope(workspaceId) || { kind: "all" });
  useEffect(() => { const saved = loadScope(workspaceId); if (saved) setScope(saved); }, [workspaceId]);
  const sources = (home?.sources || []) as unknown as ProjectSource[];
  const spaces = home?.spaces || [];
  const hasData = sources.length > 0;
  const showPlan = params.get("plan") === "1";
  const recent = useMemo(() => (home?.conversations || []).slice(0, 6), [home]);

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
  const spaceMeta = (s: (typeof spaces)[number]) => {
    const srcs = (s.sources || []).map((x) => x.name);
    const lead = srcs.length ? (srcs.length > 1 ? `${srcs[0]} +${srcs.length - 1}` : srcs[0]) : "No data yet";
    const convs = s.stats?.conversations ?? (home?.conversations || []).filter((c) => c.space_id === s.id).length;
    return `${lead} · ${plural(s.stats?.dashboards || 0, "dashboard")} · ${plural(convs, "conversation")}`;
  };

  return (
    <div className="c2-col">
      <TopNav breadcrumb={[{ label: isNew ? "New conversation" : "Home" }]} />
      <div className={`c2-home${isNew ? " new" : ""}`} data-c2-home="">
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <h1 data-c2-greeting="">{isNew ? "What would you like to know?" : greeting(home?.user?.first_name)}</h1>
          <Composer value={text} onChange={setText} onSubmit={() => void start(text)} mode={mode} onMode={onMode} busy={busy} autoFocus
            placeholder={hasData ? "Ask about your customers, or anything else…" : "Ask anything. Connect data when you're ready."}
            scope={<ScopePicker scope={scope} onChange={setScope} sources={sources} spaces={spaces} variant="compact" placement="below" disabled={busy} />} />
          {error && <div className="c2-err">{error}</div>}
          <div className="ex" data-c2-examples="">
            {(home?.examples?.length ? home.examples : examples(hasData, !!home?.web)).map((q) => (
              <button key={q} type="button" className="c2-ex" onClick={() => void start(q)} disabled={busy}>{q}</button>
            ))}
          </div>
        </div>
        {showPlan && <Navigate to="/settings/plan" replace />}
        {!isNew && spaces.length > 0 && (
          <section style={{ display: "flex", flexDirection: "column", gap: 14 }} aria-labelledby="hd-spaces">
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}><h2 className="c2-eb" id="hd-spaces">Spaces</h2><Link to="/data?tab=spaces" className="c2-link">Manage</Link></div>
            <div className="c2-spaces" data-c2-spaces="">
              {spaces.map((s) => (
                <Link key={s.id} to={`/spaces/${s.id}`} className="c2-space" data-c2-space={s.id}>
                  <span className="t"><span style={{ width: 9, height: 9, borderRadius: 5, background: s.color || "rgb(var(--color-primary))", flex: "0 0 9px" }} />{s.name}</span>
                  <span className="m">{spaceMeta(s)}</span>
                </Link>
              ))}
            </div>
          </section>
        )}
        {!hasData && home && (
          <div className="c2-card" style={{ background: "rgb(var(--c2-panel))", border: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>No data connected yet</span>
            <p style={{ margin: 0, fontSize: 14, color: "rgb(var(--color-secondary))", lineHeight: 1.55 }}>You can already ask world questions and what-ifs. Upload a file or connect an app and the same box answers from your data.</p>
            <Link to="/data" className="c2-nx dark" style={{ alignSelf: "flex-start" }}>Add data</Link>
          </div>
        )}
        {!isNew && recent.length > 0 && (
          <section style={{ display: "flex", flexDirection: "column", gap: 6 }} aria-labelledby="hd-recent">
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}><h2 className="c2-eb" id="hd-recent">Recent</h2><Link to="/library" className="c2-link">Library</Link></div>
            <div className="c2-recent" data-c2-recent="">
              {recent.map((c) => <RecentRow key={c.id} c={c} />)}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

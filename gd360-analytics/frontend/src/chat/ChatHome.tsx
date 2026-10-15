// 2026-10-14 (R46): Home - one box, your Spaces, what you asked last. Not a chat list.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { ProjectSource } from "../api/projects";
import { v2Api, type Mode, type PlanSummary } from "../api/v2";
import ScopePicker, { loadScope, saveScope, type Scope } from "../spaces/ScopePicker";
import { Composer } from "./Composer";
import { Shell, ThemeButton, useHome } from "./Shell";

const MODE_KEY = "gd360_c2_mode";
const loadMode = (): Mode => { try { const m = localStorage.getItem(MODE_KEY); return m === "quick" || m === "guided" ? m : "auto"; } catch { return "auto"; } };

function greeting(first: string | undefined): string {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return first ? `${part}, ${first}.` : `${part}.`;
}

function examples(hasData: boolean, web: boolean): string[] {
  const out: string[] = [];
  if (hasData) out.push("Why are customers leaving?", "Revenue by region, last 90 days", "Which campaigns performed best this week?");
  else out.push("What if I add two baristas at the morning rush?", "NPV of a $50k machine returning $14k a year for 5 years at 8%");
  if (web) out.push("Who is the chief minister of Tamil Nadu?");
  out.push("Alert me if churn goes above 3%");
  return out.slice(0, 5);
}

function PlanPanel({ plan, onClose }: { plan: PlanSummary; onClose: () => void }) {
  return (
    <div className="c2-card" data-c2-plan="">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 16, fontWeight: 600 }}>{plan.label} plan</span>
        <span className="c2-chip" style={{ height: 24 }}>every feature</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="c2-nx sm ghost" onClick={onClose}>Close</button>
      </div>
      <p style={{ margin: 0, fontSize: 14, color: "rgb(var(--color-secondary))", lineHeight: 1.55 }}>
        Plans differ by limits, governance and where it runs, never by hiding a capability.{plan.enforced ? "" : " Limits are shown, not enforced, until billing is switched on."}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
        {plan.meters.map((m) => (
          <div key={m.key} className="c2-meter">
            <span>{m.label}</span>
            <span style={{ color: "rgb(var(--color-text))", fontSize: 15, fontWeight: 600 }} className="c2-mono">{m.used}{m.limit ? ` / ${m.limit}` : ""}</span>
            <span className="bar"><i style={{ width: m.limit ? `${Math.min(100, (100 * m.used) / m.limit)}%` : "0%" }} /></span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 13, color: "rgb(var(--color-muted))" }}>
        {Object.entries(plan.plans).map(([k, p]) => (
          <span key={k} className="c2-chip" style={{ background: k === plan.plan ? "rgb(var(--color-tint))" : undefined, color: k === plan.plan ? "rgb(var(--color-primary))" : undefined }}>{p.label} · {p.who}</span>
        ))}
        <Link to="/pricing" className="c2-nx sm ghost">Compare plans</Link>
      </div>
    </div>
  );
}

export default function ChatHome() {
  return (
    <Shell active="home">
      <HomeBody />
    </Shell>
  );
}

function HomeBody() {
  const { home, workspaceId, spaceId } = useHome();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<Mode>(loadMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>(() => loadScope(workspaceId) || { kind: "all" });
  useEffect(() => { if (spaceId) setScope({ kind: "space", spaceId }); }, [spaceId]);
  useEffect(() => { const saved = loadScope(workspaceId); if (saved && !spaceId) setScope(saved); }, [workspaceId, spaceId]);
  const sources = (home?.sources || []) as unknown as ProjectSource[];
  const spaces = home?.spaces || [];
  const hasData = sources.length > 0;
  const showPlan = params.get("plan") === "1";
  const recent = useMemo(() => (home?.conversations || []).filter((c) => !spaceId || c.space_id === spaceId).slice(0, 8), [home, spaceId]);

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
  const when = (iso: string) => { const d = new Date(iso); const days = (Date.now() - d.getTime()) / 86400000; return days < 1 ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : days < 7 ? d.toLocaleDateString([], { weekday: "short" }) : d.toLocaleDateString([], { month: "short", day: "numeric" }); };

  return (
    <div className="c2-col">
      <div className="c2-head">
        <span className="title">{spaceId ? spaces.find((s) => s.id === spaceId)?.name || "Space" : "Home"}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="c2-nx sm ghost" onClick={() => setParams(showPlan ? {} : { plan: "1" })}>{home?.plan ? `${home.plan.label} plan` : "Plan"}</button>
        <ThemeButton />
      </div>
      <div className="c2-home" data-c2-home="">
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <h1>{greeting(home?.user?.first_name)}<br /><span style={{ color: "rgb(var(--color-muted))" }}>What would you like to know?</span></h1>
          <Composer value={text} onChange={setText} onSubmit={() => void start(text)} mode={mode} onMode={onMode} busy={busy} autoFocus
            placeholder={hasData ? "Ask about your data, or anything else…" : "Ask anything. Connect data when you're ready."}
            scope={<ScopePicker scope={scope} onChange={setScope} sources={sources} spaces={spaces} variant="compact" placement="below" disabled={busy} />} />
          {error && <div className="c2-err">{error}</div>}
          <div className="ex" data-c2-examples="">
            {(home?.examples?.length ? home.examples : examples(hasData, !!home?.web)).map((q) => (
              <button key={q} type="button" className="c2-nx sm" onClick={() => void start(q)} disabled={busy}>{q}</button>
            ))}
          </div>
        </div>
        {showPlan && home?.plan && <PlanPanel plan={home.plan} onClose={() => setParams({})} />}
        {spaces.length > 0 && !spaceId && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}><span className="c2-eb">Spaces</span><Link to="/data?tab=spaces" className="c2-nx sm ghost">Manage</Link></div>
            <div className="c2-spaces">
              {spaces.map((s) => (
                <Link key={s.id} to={`/spaces/${s.id}`} className="c2-space">
                  <span className="t"><span style={{ width: 9, height: 9, borderRadius: 5, background: s.color || "rgb(var(--color-primary))" }} />{s.name}</span>
                  <span className="m">{s.stats?.sources || 0} source{s.stats?.sources === 1 ? "" : "s"} · {s.stats?.dashboards || 0} dashboard{s.stats?.dashboards === 1 ? "" : "s"} · {(home?.conversations || []).filter((c) => c.space_id === s.id).length} conversations</span>
                </Link>
              ))}
            </div>
          </div>
        )}
        {!hasData && (
          <div className="c2-card" style={{ background: "rgb(var(--c2-panel))", border: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>No data connected yet</span>
            <p style={{ margin: 0, fontSize: 14, color: "rgb(var(--color-secondary))", lineHeight: 1.55 }}>You can already ask world questions and what-ifs. Upload a file or connect an app and the same box answers from your data.</p>
            <Link to="/data" className="c2-nx dark" style={{ alignSelf: "flex-start" }}>Add data</Link>
          </div>
        )}
        {recent.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}><span className="c2-eb">Recent</span><Link to="/library" className="c2-nx sm ghost">Library</Link></div>
            <div className="c2-recent" data-c2-recent="">
              {recent.map((c) => (
                <Link key={c.id} to={`/chat/${c.id}`}>
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}><span className="t">{c.title}</span>{c.headline && <span className="h">{c.headline}</span>}</span>
                  <span className="d">{when(c.last_at)}</span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

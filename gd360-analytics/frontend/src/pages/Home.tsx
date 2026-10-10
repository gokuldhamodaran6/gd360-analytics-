// 2026-10-08 (round 11): the signed-in home page.
// 2026-10-09 (round 15): the scope chip asks one Space, chosen sources or
// everything (spaces/ScopePicker.tsx). ?space=<id> preselects a Space.
// 2026-10-10 (Clarity Blueprint, round 2): Home offers the two ways to work
// with data - dashboards are made FROM either one, so they are not a third
// door here:
//   Instant Answers  -> ask in plain English, answered in seconds across
//                       every source, with the evidence (/p/:id)
//   Guided Analysis  -> work step by step on one or more sources, seeing and
//                       changing every step (/workspace/:id?extra=&draft=)
// ?intent=guided preselects Guided Analysis (?intent=analyze still works).
// ?source=<id>[&connected=1] starts both on one source - where "Try it now"
// lands right after connecting data.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { conversationApi, ConversationSummary, dashboardApi, DashboardSummary } from "../api/client";
import { projectsApi, ProjectSource } from "../api/projects";
import { timeAgo, autoRunPreference } from "../project/format";
import { useAuth } from "../api/AuthContext";
import { Space, spacesApi } from "../api/spaces";
import ScopePicker, { Scope, loadScope, saveScope, scopeSummary } from "../spaces/ScopePicker";
import { conversationHref, conversationKind, dashboardHref, Kind, KindIcon, KindPill, KindTile } from "../lib/kinds";

// 2026-10-10: Home greets in the person's own time of day (their browser's
// time zone) - a different, hand-written line each part of the day, steady
// for that part of the day so it never flickers between visits.
type Daypart = "morning" | "afternoon" | "evening" | "night";
const GREETINGS: Record<Daypart, [string, string][]> = {
  morning: [
    ["Good morning, {n}.", "Fresh numbers, clear head. Where shall we start?"],
    ["Morning, {n}.", "Yesterday's data is in. Ask it anything."],
    ["Rise and analyze, {n}.", "Your sources are ready when you are."],
    ["A bright start, {n}.", "One good question sets up the whole day."],
  ],
  afternoon: [
    ["Good afternoon, {n}.", "What's worth knowing before the day is out?"],
    ["Afternoon, {n}.", "Pick up a thread, or pull a new one."],
    ["Hello again, {n}.", "The numbers have moved since this morning."],
    ["Halfway there, {n}.", "Let's see how today is really going."],
  ],
  evening: [
    ["Good evening, {n}.", "Close the day with a clear picture."],
    ["Evening, {n}.", "Let's see how the day really went."],
    ["Still curious, {n}?", "So is your data. Ask away."],
    ["Winding down, {n}?", "One last look before tomorrow."],
  ],
  night: [
    ["Burning the midnight oil, {n}?", "Your data never sleeps either."],
    ["Late one, {n}.", "Quiet hours, sharp answers."],
    ["The night shift, {n}.", "Let's make it count."],
    ["Up late, {n}?", "Good questions don't keep office hours."],
  ],
};

function daypart(h: number): Daypart {
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 22) return "evening";
  return "night";
}

function greeting(first: string, now: Date): { title: string; line: string } {
  const n = first || "there";
  const part = daypart(now.getHours());
  const day = now.getDay();
  const seed = now.getFullYear() * 400 + now.getMonth() * 32 + now.getDate() + ["morning", "afternoon", "evening", "night"].indexOf(part) * 7;
  const fill = (t: [string, string]) => ({ title: t[0].replace("{n}", n), line: t[1] });
  if (day === 1 && part === "morning") return fill(["Happy Monday, {n}.", "A fresh week of numbers. Where do we begin?"]);
  if (day === 5 && (part === "afternoon" || part === "evening")) return fill(["Happy Friday, {n}.", "Close the week knowing exactly where you stand."]);
  if ((day === 0 || day === 6) && part !== "night" && seed % 2 === 0) return fill(["Weekend mode, {n}.", "Curiosity doesn't keep office hours."]);
  const set = GREETINGS[part];
  return fill(set[seed % set.length]);
}

/** "Kolkata" from the browser's time zone ("Asia/Kolkata"). */
function timeZoneCity(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const raw = (tz.split("/").pop() || "").replace(/_/g, " ");
    // older zone names some browsers still report
    const city = ({ Calcutta: "Kolkata", Saigon: "Ho Chi Minh City", Kiev: "Kyiv", Rangoon: "Yangon", Katmandu: "Kathmandu" } as Record<string, string>)[raw] || raw;
    return city && city !== "UTC" ? city : null;
  } catch {
    return null;
  }
}

/** The current time, refreshed every minute. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

type Tab = "recent" | "pinned" | "shared";
type Intent = "instant" | "guided";

const INTENTS: { id: Intent; kind: Kind; title: string; sub: string }[] = [
  { id: "instant", kind: "answer", title: "Instant Answers", sub: "Answered in seconds, with the evidence" },
  { id: "guided", kind: "analysis", title: "Guided Analysis", sub: "Step by step — you check every step" },
];

const GUIDED_DEFAULT = "Give me an overview of this data: the headline numbers, how they change over time, and the biggest segments.";

// Sources people analyze first: warehouses, databases and files before apps.
const CORE_KINDS = new Set(["bigquery", "snowflake", "postgres", "mysql", "redshift", "sqlserver", "databricks", "supabase", "csv", "excel", "file"]);

function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  return typeof d === "string" && d.trim() ? d : fallback;
}

const lastSourceKey = (ws: string) => `gd360_home_source:${ws}`;

function loadLastSource(ws: string): string | null {
  try {
    return localStorage.getItem(lastSourceKey(ws));
  } catch {
    return null;
  }
}

function saveLastSource(ws: string, id: string) {
  try {
    localStorage.setItem(lastSourceKey(ws), id);
  } catch {
    /* per-browser convenience only */
  }
}

type RecentItem =
  | { type: "conv"; id: string; at: string; c: ConversationSummary }
  | { type: "dash"; id: string; at: string; d: DashboardSummary };

export default function Home() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [searchParams, setSearchParams] = useSearchParams();
  const spaceParam = searchParams.get("space");
  const sourceParam = searchParams.get("source");
  const justConnected = searchParams.get("connected") === "1";
  const intentParam = searchParams.get("intent");
  const intent: Intent = intentParam === "guided" || intentParam === "analyze" ? "guided" : "instant";
  const [question, setQuestion] = useState("");
  const [instruction, setInstruction] = useState("");
  const [guidedIds, setGuidedIds] = useState<string[]>([]);
  const [sources, setSources] = useState<ProjectSource[] | null>(null);
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [scope, setScopeState] = useState<Scope>({ kind: "all" });
  const [projects, setProjects] = useState<ConversationSummary[] | null>(null);
  const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null);
  const [tab, setTab] = useState<Tab>("recent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const boxRef = useRef<HTMLTextAreaElement>(null);

  const setIntent = (next: Intent) => {
    const p = new URLSearchParams(searchParams);
    if (next === "instant") p.delete("intent");
    else p.set("intent", next);
    setSearchParams(p, { replace: true });
    setError("");
  };

  // 2026-10-09: the first question picked on the public "Get started" page
  // waits here after sign-up.
  useEffect(() => {
    if (!activeWorkspaceId || !sources || sources.length === 0) return;
    try {
      const q = sessionStorage.getItem("gd360_first_question");
      if (q) {
        setQuestion(q);
        sessionStorage.removeItem("gd360_first_question");
      }
    } catch {
      /* storage may be blocked */
    }
  }, [activeWorkspaceId, sources]);

  const setScope = (next: Scope) => {
    setScopeState(next);
    if (activeWorkspaceId) saveScope(activeWorkspaceId, next);
  };

  useEffect(() => {
    if (!activeWorkspaceId) return;
    setSources(null);
    setSpaces(null);
    projectsApi.sources(activeWorkspaceId).then(setSources).catch(() => setSources([]));
    spacesApi.list(activeWorkspaceId).then(setSpaces).catch(() => setSpaces([]));
    conversationApi.list(activeWorkspaceId).then(setProjects).catch(() => setProjects([]));
    dashboardApi.list().then(setDashboards).catch(() => setDashboards([]));
  }, [activeWorkspaceId]);

  // The starting scope: ?source=<id> (just connected) wins, then ?space=<id>,
  // else the last one used here.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    if (sourceParam) setScopeState({ kind: "sources", ids: [sourceParam] });
    else if (spaceParam) setScope({ kind: "space", spaceId: spaceParam });
    else setScopeState(loadScope(activeWorkspaceId) || { kind: "all" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId, spaceParam, sourceParam]);

  // Drop a remembered Space or sources that are gone (or not in this workspace).
  useEffect(() => {
    if (!sources || !spaces) return;
    if (scope.kind === "space" && !spaces.some((s) => s.id === scope.spaceId)) setScopeState({ kind: "all" });
    if (scope.kind === "sources") {
      const known = new Set(sources.map((s) => s.id));
      const ids = scope.ids.filter((id) => known.has(id));
      if (ids.length !== scope.ids.length) setScopeState(ids.length ? { kind: "sources", ids } : { kind: "all" });
    }
  }, [sources, spaces, scope]);

  const orderedSources = useMemo(() => {
    const list = [...(sources || [])];
    list.sort((a, b) => Number(CORE_KINDS.has(b.kind)) - Number(CORE_KINDS.has(a.kind)));
    return list;
  }, [sources]);
  // Guided Analysis starts on: the just-connected source, else the last one
  // used here, else the first warehouse, database or file.
  useEffect(() => {
    if (!activeWorkspaceId || !orderedSources.length) return;
    const known = new Set(orderedSources.map((s) => s.id));
    setGuidedIds((cur) => {
      if (sourceParam && known.has(sourceParam)) return [sourceParam];
      const kept = cur.filter((id) => known.has(id));
      if (kept.length) return kept;
      const last = loadLastSource(activeWorkspaceId);
      if (last && known.has(last)) return [last];
      return [orderedSources[0].id];
    });
  }, [activeWorkspaceId, orderedSources, sourceParam]);
  const setGuided = (ids: string[]) => {
    setGuidedIds(ids);
    if (activeWorkspaceId && ids[0]) saveLastSource(activeWorkspaceId, ids[0]);
  };

  const chosenSpace = scope.kind === "space" ? (spaces || []).find((s) => s.id === scope.spaceId) || null : null;
  const summary = scopeSummary(scope, sources, spaces);
  const connectedSource = sourceParam ? (sources || []).find((s) => s.id === sourceParam) || null : null;

  const recent = useMemo<RecentItem[]>(() => {
    const convs = projects || [];
    const dashes = dashboards || [];
    let items: RecentItem[] = [];
    if (tab === "pinned") {
      items = convs.filter((c) => c.pinned).map((c) => ({ type: "conv" as const, id: c.id, at: c.updated_at, c }));
    } else {
      const cs = tab === "shared" ? convs.filter((c) => !c.is_own) : convs;
      const ds = tab === "shared" ? dashes.filter((d) => !d.is_own) : dashes;
      items = [
        ...cs.map((c) => ({ type: "conv" as const, id: c.id, at: c.updated_at, c })),
        ...ds.map((d) => ({ type: "dash" as const, id: d.id, at: d.created_at, d })),
      ];
      items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    }
    return items.slice(0, 6);
  }, [projects, dashboards, tab]);

  const ask = async (text?: string) => {
    const q = (text ?? question).trim();
    if (q.length < 2 || busy) return;
    if (!summary.count) {
      setError(chosenSpace ? `${chosenSpace.name} has no sources you can use yet.` : "Pick at least one source to ask about.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // A Space sends space_id, picked sources send source_ids - never both.
      const all = (sources || []).length;
      const out = await projectsApi.create({
        question: q,
        space_id: scope.kind === "space" && chosenSpace ? chosenSpace.id : undefined,
        source_ids: scope.kind === "sources" && scope.ids.length < all ? scope.ids : undefined,
        workspace_id: activeWorkspaceId || undefined,
        auto_run: autoRunPreference(),
      });
      navigate(`/p/${out.project_id}?run=${out.run_id}`);
    } catch (e: any) {
      setError(errorText(e, "Couldn't start that question. Please try again."));
      setBusy(false);
    }
  };

  // A Guided Analysis is the Instant Answers engine run one step at a time,
  // on every source picked here (pages/GuidedAnalysis.tsx).
  const startGuided = async () => {
    if (!guidedIds.length) {
      setError("Pick at least one source to analyze.");
      return;
    }
    if (busy) return;
    const q = instruction.trim().length >= 2 ? instruction.trim() : GUIDED_DEFAULT;
    setBusy(true);
    setError("");
    try {
      const out = await projectsApi.create({
        question: q, source_ids: guidedIds, workspace_id: activeWorkspaceId || undefined, mode: "guided",
      });
      navigate(`/g/${out.project_id}`);
    } catch (e: any) {
      setError(errorText(e, "Couldn't start the analysis. Please try again."));
      setBusy(false);
    }
  };

  const firstName = (user?.full_name || "").split(" ")[0];
  const noSources = sources !== null && sources.length === 0;
  const submit = () => (intent === "instant" ? ask() : startGuided());
  const now = useNow();
  const hello = useMemo(() => greeting(firstName, now), [firstName, now.getHours(), now.toDateString()]); // eslint-disable-line react-hooks/exhaustive-deps
  const place = useMemo(() => timeZoneCity(), []);
  const night = now.getHours() < 6 || now.getHours() >= 19;

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onWorkspaceSwitch={switchWorkspace}
        onWorkspaceCreated={handleWorkspaceCreated}
      />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />
        <main className="flex flex-col items-center px-4 sm:px-8 pt-14 sm:pt-[12vh] pb-16 gap-12">
          <div className="w-full max-w-[760px] flex flex-col items-center gap-7 text-center">
            {justConnected && connectedSource && (
              <div role="status" data-connected-banner="" className="w-full rounded-card border border-kind-answer-border bg-kind-answer-fill px-4 py-3 flex items-center gap-3 text-left">
                <span className="w-7 h-7 rounded-full bg-kind-answer text-[rgb(var(--color-base))] grid place-items-center shrink-0" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
                </span>
                <span className="text-ui text-text leading-snug">
                  <b>{connectedSource.name}</b> is connected. Ask it anything, or work through it step by step.
                </span>
              </div>
            )}
            <div className="flex flex-col items-center gap-3" data-home-greeting="">
              <span className="inline-flex items-center gap-2 h-7 px-3 rounded-full border border-border bg-surface/70 font-mono text-[11.5px] tracking-[0.04em] text-muted">
                {night ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
                )}
                {now.toLocaleDateString(undefined, { weekday: "long" })} · {now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                {place ? ` · ${place}` : ""}
              </span>
              <h1 className="m-0 text-[34px] sm:text-[46px] leading-[1.08] font-semibold tracking-[-0.03em] text-text text-balance">{hello.title}</h1>
              <p className="m-0 text-[16px] sm:text-[17px] text-muted text-balance">{hello.line}</p>
            </div>

            {noSources ? (
              <div className="w-full rounded-card border border-border bg-surface p-6 text-left flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
                <div>
                  <div className="text-section font-semibold text-text">Connect your first source</div>
                  <div className="text-ui text-muted mt-1">
                    A warehouse, a database, a spreadsheet, or an app like Shopify, Google Analytics or your ad accounts.
                  </div>
                </div>
                <Link to="/data" className="btn-primary text-sm shrink-0">Connect data</Link>
              </div>
            ) : (
              <div
                className={`w-full text-left rounded-[22px] border bg-surface shadow-pop p-3 sm:p-3.5 flex flex-col gap-2 transition-colors ${
                  intent === "instant" ? "border-border focus-within:border-kind-answer-border" : "border-border focus-within:border-kind-analysis-border"
                }`}
                data-home-composer={intent}
              >
                <div className="flex items-center justify-between gap-3 flex-wrap px-1 pt-0.5">
                  <div role="tablist" aria-label="How do you want to work" className="inline-flex p-[3px] rounded-full border border-border bg-base" data-home-intents="">
                    {INTENTS.map((it) => {
                      const on = it.id === intent;
                      return (
                        <button
                          key={it.id}
                          type="button"
                          role="tab"
                          aria-selected={on}
                          data-intent={it.id}
                          onClick={() => setIntent(it.id)}
                          className={`ui-focus inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full text-ui font-medium transition-colors ${
                            on
                              ? it.kind === "answer" ? "bg-kind-answer-fill text-kind-answer" : "bg-kind-analysis-fill text-kind-analysis"
                              : "text-muted hover:text-text"
                          }`}
                        >
                          <KindIcon kind={it.kind} size={14} />
                          {it.title}
                        </button>
                      );
                    })}
                  </div>
                  <span className="hidden sm:inline text-caption text-muted pr-1">{INTENTS.find((i) => i.id === intent)?.sub}</span>
                </div>
                <label htmlFor="home-box" className="sr-only">
                  {intent === "instant" ? "Your question" : "What do you want to find out"}
                </label>
                <textarea
                  id="home-box"
                  ref={boxRef}
                  rows={2}
                  value={intent === "instant" ? question : instruction}
                  onChange={(e) => (intent === "instant" ? setQuestion : setInstruction)(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={intent === "instant" ? "Ask anything about your business…" : "What do you want to work out, step by step?"}
                  className="w-full min-h-[64px] resize-none bg-transparent border-0 outline-none px-2 pt-2 text-[18px] leading-relaxed text-text placeholder:text-faint"
                  disabled={busy}
                />
                <div className="flex items-center justify-between gap-3 flex-wrap px-1 pb-0.5">
                  {intent === "instant" ? (
                    <ScopePicker scope={scope} onChange={setScope} sources={sources} spaces={spaces} />
                  ) : (
                    <SourceMultiSelect sources={orderedSources} value={guidedIds} onChange={setGuided} />
                  )}
                  {intent === "instant" ? (
                    <button
                      type="button"
                      aria-label="Ask"
                      onClick={() => ask()}
                      disabled={busy || question.trim().length < 2}
                      className="ui-focus w-11 h-11 rounded-[14px] bg-primary text-on-primary grid place-items-center disabled:opacity-40"
                    >
                      {busy ? (
                        <span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                      ) : (
                        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      )}
                    </button>
                  ) : (
                    <button type="button" onClick={startGuided} disabled={!guidedIds.length || busy} className="btn-primary text-sm inline-flex items-center gap-2 h-11" data-open-studio="">
                      {busy ? (
                        <span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" aria-hidden="true" />
                      ) : (
                        <KindIcon kind="analysis" size={15} />
                      )}
                      {busy ? "Planning…" : "Start"}
                    </button>
                  )}
                </div>
              </div>
            )}
            {error && <div role="alert" className="text-ui text-danger">{error}</div>}
          </div>

          <section aria-label="Pick up where you left off" className="w-full max-w-[880px] flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Pick up where you left off</span>
                <div className="flex gap-0.5 rounded-ctl border border-border bg-surface p-[3px]" role="tablist">
                  {(["recent", "pinned", "shared"] as Tab[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="tab"
                      aria-selected={tab === t}
                      onClick={() => setTab(t)}
                      className={`h-8 px-3 rounded-[7px] text-ui ${tab === t ? "bg-subtle text-text" : "text-muted hover:text-text"}`}
                    >
                      {t === "recent" ? "Recent" : t === "pinned" ? "Pinned" : "Shared with me"}
                    </button>
                  ))}
                </div>
              </div>
              <Link to="/library" className="text-ui text-muted hover:text-text">Open Library →</Link>
            </div>
            <div className="rounded-card border border-border overflow-hidden bg-surface">
              {(projects === null || dashboards === null) && <div className="p-5 text-ui text-muted">Loading…</div>}
              {projects !== null && dashboards !== null && recent.length === 0 && (
                <div className="p-6 text-ui text-muted">
                  {tab === "recent" ? "Nothing yet — your answers, analyses and dashboards will appear here." : tab === "pinned" ? "Nothing pinned yet." : "Nothing shared with you yet."}
                </div>
              )}
              {projects !== null && dashboards !== null && recent.map((item) => {
                if (item.type === "conv") {
                  const c = item.c;
                  const kind = conversationKind(c);
                  const to = conversationHref(c) || "/library";
                  const n = c.dashboard_count || 0;
                  return (
                    <Link key={`c-${c.id}`} to={to} data-recent-kind={kind} className="grid grid-cols-[36px_minmax(0,1fr)_auto] gap-3.5 items-center px-4 py-3 border-t first:border-t-0 border-border hover:bg-subtle">
                      <KindTile kind={kind} />
                      <span className="min-w-0 flex flex-col gap-0.5">
                        <span className="text-body text-text truncate">{c.title}</span>
                        <span className="text-caption text-muted truncate">
                          <KindPill kind={kind} className="h-[18px] px-1.5 text-[10.5px] mr-1.5 align-[1px]" />
                          {c.datasource_name || "No source"}
                          {n > 0 ? ` · ${n} dashboard${n === 1 ? "" : "s"}` : ""}
                        </span>
                      </span>
                      <span className="font-mono text-caption text-muted whitespace-nowrap">{timeAgo(c.updated_at)}</span>
                    </Link>
                  );
                }
                const d = item.d;
                return (
                  <Link key={`d-${d.id}`} to={dashboardHref(d)} data-recent-kind="dashboard" className="grid grid-cols-[36px_minmax(0,1fr)_auto] gap-3.5 items-center px-4 py-3 border-t first:border-t-0 border-border hover:bg-subtle">
                    <KindTile kind="dashboard" />
                    <span className="min-w-0 flex flex-col gap-0.5">
                      <span className="text-body text-text truncate">{d.name}</span>
                      <span className="text-caption text-muted truncate">
                        <KindPill kind="dashboard" className="h-[18px] px-1.5 text-[10.5px] mr-1.5 align-[1px]" />
                        {d.source_kind && d.source_title ? `From ${d.source_kind} “${d.source_title}”` : d.workspace_name ? `Shared with ${d.workspace_name}` : "Personal"}
                      </span>
                    </span>
                    <span className="font-mono text-caption text-muted whitespace-nowrap">{timeAgo(d.created_at)}</span>
                  </Link>
                );
              })}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

// The sources Guided Analysis works on: the first one is the main table,
// the rest are joined in. A chip per source and an "Add source" menu.
function SourceMultiSelect({ sources, value, onChange }: { sources: ProjectSource[]; value: string[]; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") setOpen(false);
        return;
      }
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const byId = new Map(sources.map((s) => [s.id, s]));
  const toggle = (id: string) => {
    if (value.includes(id)) {
      const next = value.filter((x) => x !== id);
      onChange(next.length ? next : value);
    } else onChange([...value, id]);
  };
  return (
    <div className="relative flex items-center gap-1.5 flex-wrap" ref={ref} data-source-multi="">
      {value.map((id) => {
        const s = byId.get(id);
        if (!s) return null;
        return (
          <span key={id} className="inline-flex items-center gap-1.5 h-8 pl-3 pr-1.5 rounded-full border border-border-strong bg-base text-ui font-medium text-text max-w-[260px]">
            <span className="truncate">{s.name}</span>
            <span className="text-caption text-muted shrink-0">{s.label}</span>
            {value.length > 1 && (
              <button type="button" onClick={() => toggle(id)} aria-label={`Remove ${s.name}`} className="ui-focus w-5 h-5 grid place-items-center rounded-full text-muted hover:text-text hover:bg-subtle">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            )}
          </span>
        );
      })}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-add-source=""
        className="ui-focus inline-flex items-center gap-1 h-8 px-3 rounded-full border border-dashed border-border-strong text-ui text-muted hover:text-text"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        {value.length ? "Add source" : "Pick sources"}
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-[calc(100%+6px)] z-30 w-[320px] max-w-[calc(100vw-48px)] max-h-[320px] overflow-y-auto rounded-card border border-border bg-surface shadow-pop p-1.5">
          {sources.map((s) => {
            const on = value.includes(s.id);
            return (
              <button
                key={s.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                onClick={() => toggle(s.id)}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-ctl text-left hover:bg-subtle"
              >
                <span className={`w-4 h-4 rounded-[5px] border grid place-items-center shrink-0 ${on ? "bg-kind-analysis border-kind-analysis text-[rgb(var(--color-base))]" : "border-border-strong"}`} aria-hidden="true">
                  {on && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>}
                </span>
                <span className="min-w-0 flex-1 truncate text-ui text-text">{s.name}</span>
                <span className="text-caption text-muted shrink-0">{s.label}</span>
              </button>
            );
          })}
          <p className="m-0 px-3 pt-2 pb-1 text-caption text-muted">GD360 plans across every source you pick and joins them where they match.</p>
        </div>
      )}
    </div>
  );
}

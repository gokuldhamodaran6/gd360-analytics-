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
// 2026-10-11 (Ask Journey, canvas A1/A2): ONE box for both. The sources are
// chosen the same way for Quick answer and Guided (spaces/ScopePicker - a
// Space, or ticked sources), and the mode sits right beside Send. "Needs
// you" shows a Guided step waiting for this person's check.
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
import ScopePicker, { Scope, loadScope, saveScope, scopeSummary, startersFor } from "../spaces/ScopePicker";
import { conversationHref, conversationKind, dashboardHref, KindPill, KindTile } from "../lib/kinds";
import { ArrowUpIcon, AskMode, BoltIcon, MODE_HINT, ModeSwitch, Spinner, StepsIcon, useAutoGrow } from "../thread/parts";

// 2026-10-10: Home greets in the person's own time of day (their browser's
// time zone) - plain and professional: "Good morning, Gokul." with a short,
// calm second line that changes by part of the day.
type Daypart = "morning" | "afternoon" | "evening";
const LINES: Record<Daypart, string[]> = {
  morning: ["What would you like to look into today?", "Your sources are ready when you are."],
  afternoon: ["What would you like to look into?", "Pick up where you left off, or start something new."],
  evening: ["What would you like to look into?", "A clear picture before the day closes."],
};

function daypart(h: number): Daypart {
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  return "evening";
}

function capitalise(name: string): string {
  return name
    .split(/([\s-])/)
    .map((w) => (w.length > 1 && /[a-z]/.test(w[0]) ? w[0].toUpperCase() + w.slice(1) : w))
    .join("");
}

function greeting(first: string, now: Date): { title: string; line: string } {
  const part = daypart(now.getHours());
  const n = capitalise((first || "").trim());
  const hello = part === "morning" ? "Good morning" : part === "afternoon" ? "Good afternoon" : "Good evening";
  const set = LINES[part];
  const seed = now.getFullYear() * 400 + now.getMonth() * 32 + now.getDate();
  return { title: n ? `${hello}, ${n}.` : `${hello}.`, line: set[seed % set.length] };
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

const GUIDED_DEFAULT = "Give me an overview of this data: the headline numbers, how they change over time, and the biggest segments.";

function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  return typeof d === "string" && d.trim() ? d : fallback;
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
  const qParam = searchParams.get("q");
  const mode: AskMode = intentParam === "guided" || intentParam === "analyze" ? "guided" : "quick";
  const [question, setQuestion] = useState(() => (qParam || "").slice(0, 2000));
  const [sources, setSources] = useState<ProjectSource[] | null>(null);
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [scope, setScopeState] = useState<Scope>({ kind: "all" });
  const [projects, setProjects] = useState<ConversationSummary[] | null>(null);
  const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null);
  const [tab, setTab] = useState<Tab>("recent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(boxRef, question, 260);

  const setMode = (next: AskMode) => {
    const p = new URLSearchParams(searchParams);
    if (next === "quick") p.delete("intent");
    else p.set("intent", "guided");
    setSearchParams(p, { replace: true });
    setError("");
    window.setTimeout(() => boxRef.current?.focus(), 0);
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

  // One box, two ways: a Quick answer (/p/:id) or a Guided Analysis
  // (/g/:id) - both asked across the SAME chosen scope. A Space sends
  // space_id, picked sources send source_ids - never both.
  const submit = async () => {
    const typed = question.trim();
    const q = mode === "guided" && typed.length < 2 ? GUIDED_DEFAULT : typed;
    if (q.length < 2 || busy) return;
    if (!summary.count) {
      setError(chosenSpace ? `${chosenSpace.name} has no sources you can use yet.` : "Pick at least one source to ask about.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const all = (sources || []).length;
      const out = await projectsApi.create({
        question: q,
        space_id: scope.kind === "space" && chosenSpace ? chosenSpace.id : undefined,
        source_ids: scope.kind === "sources" && scope.ids.length < all ? scope.ids : undefined,
        workspace_id: activeWorkspaceId || undefined,
        auto_run: mode === "quick" ? autoRunPreference() : undefined,
        mode: mode === "guided" ? "guided" : undefined,
      });
      navigate(mode === "guided" ? `/g/${out.project_id}` : `/p/${out.project_id}?run=${out.run_id}`);
    } catch (e: any) {
      setError(errorText(e, mode === "guided" ? "Couldn't start the analysis. Please try again." : "Couldn't start that question. Please try again."));
      setBusy(false);
    }
  };

  const firstName = (user?.full_name || "").split(" ")[0];
  const noSources = sources !== null && sources.length === 0;
  const sourceCount = summary.count;
  const starters = useMemo(() => startersFor(chosenSpace), [chosenSpace]);
  const needsYou = useMemo(() => (projects || []).filter((c) => c.needs_you && c.kind === "guided").slice(0, 2), [projects]);
  const canSend = !busy && (mode === "guided" || question.trim().length >= 2);
  const now = useNow();
  const hello = useMemo(() => greeting(firstName, now), [firstName, now.getHours(), now.toDateString()]); // eslint-disable-line react-hooks/exhaustive-deps
  const place = useMemo(() => timeZoneCity(), []);
  const night = now.getHours() < 6 || now.getHours() >= 19;
  const subline = sources === null || noSources
    ? hello.line
    : `Ask anything about ${chosenSpace ? chosenSpace.name : "your business"}. GD360 checks ${sourceCount} connected source${sourceCount === 1 ? "" : "s"} and shows its working.`;

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
          <div className="w-full max-w-[880px] flex flex-col items-center gap-7 text-center">
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
              <p className="m-0 text-[16px] sm:text-[18px] leading-relaxed text-secondary text-balance max-w-[620px]" data-home-subline="">{subline}</p>
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
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
                className={`w-full text-left rounded-[26px] border bg-surface p-4 sm:p-5 sm:pl-6 flex flex-col gap-3 transition-[border-color,box-shadow] duration-200 shadow-[0_30px_80px_-40px_rgb(0_0_0/0.85)] ${
                  mode === "quick"
                    ? "border-border-strong focus-within:border-kind-answer-border focus-within:shadow-[0_0_0_4px_rgb(var(--color-kind-answer)/0.07),0_30px_80px_-40px_rgb(0_0_0/0.85)]"
                    : "border-kind-analysis-border/70 focus-within:border-kind-analysis-border focus-within:shadow-[0_0_0_4px_rgb(var(--color-kind-analysis)/0.08),0_30px_80px_-40px_rgb(0_0_0/0.85)]"
                }`}
                data-home-composer={mode === "quick" ? "instant" : "guided"}
              >
                <label htmlFor="home-box" className="sr-only">
                  {mode === "quick" ? "Your question" : "What do you want to work out"}
                </label>
                <textarea
                  id="home-box"
                  ref={boxRef}
                  rows={3}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={
                    mode === "quick"
                      ? `Ask anything about ${chosenSpace ? chosenSpace.name : "your business"}…`
                      : "What do you want to work out, step by step?"
                  }
                  className="w-full min-h-[84px] resize-none bg-transparent border-0 outline-none pt-1 text-[19px] sm:text-[20px] leading-[1.5] text-text placeholder:text-faint"
                  disabled={busy}
                />
                <div className="flex items-center gap-2.5 flex-wrap">
                  <Link
                    to="/data"
                    aria-label="Add data: connect a source or upload a file"
                    title="Connect a source or upload a file"
                    className="ui-focus w-11 h-11 rounded-full border border-border-strong grid place-items-center text-secondary hover:text-text hover:bg-subtle/60 shrink-0"
                    data-home-add=""
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                  </Link>
                  <ScopePicker scope={scope} onChange={setScope} sources={sources} spaces={spaces} variant="composer" disabled={busy} />
                  <span className="flex-1" />
                  <ModeSwitch mode={mode} onChange={setMode} disabled={busy} />
                  <button
                    type="submit"
                    aria-label={mode === "quick" ? "Ask for a quick answer" : "Start a guided analysis"}
                    disabled={!canSend}
                    className="ui-focus w-12 h-12 rounded-full bg-primary text-on-primary grid place-items-center shrink-0 transition-[opacity,transform] hover:scale-[1.04] active:scale-[0.97] disabled:opacity-35 disabled:hover:scale-100"
                    data-home-send=""
                  >
                    {busy ? <Spinner /> : <ArrowUpIcon size={19} />}
                  </button>
                </div>
              </form>
            )}
            {error && <div role="alert" className="text-ui text-danger -mt-2">{error}</div>}
            {!noSources && (
              <div className="flex flex-col items-center gap-2 -mt-1 text-[14px]" data-home-hints="">
                <span className={`inline-flex items-center gap-2 transition-colors ${mode === "quick" ? "text-secondary" : "text-faint"}`}>
                  <BoltIcon size={14} className="text-kind-answer" /> {MODE_HINT.quick}
                </span>
                <span className={`inline-flex items-center gap-2 transition-colors ${mode === "guided" ? "text-secondary" : "text-faint"}`}>
                  <StepsIcon size={14} className="text-kind-analysis" /> {MODE_HINT.guided} — then keep asking
                </span>
              </div>
            )}
            {!noSources && sources !== null && (
              <div className="flex gap-2 flex-wrap justify-center" data-home-starters="">
                {starters.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      setQuestion(t);
                      window.setTimeout(() => boxRef.current?.focus(), 0);
                    }}
                    className="ui-focus h-[34px] px-3.5 rounded-full border border-border bg-surface/50 text-[13px] text-secondary hover:text-text hover:border-border-strong transition-colors"
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>

          {needsYou.length > 0 && (
            <section aria-label="Needs you" className="w-full max-w-[880px] flex flex-col gap-3 -mb-4" data-home-needs-you="">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Needs you · {needsYou.length}</span>
              <div className="grid gap-3 sm:grid-cols-2">
                {needsYou.map((c) => {
                  const n = c.needs_you!;
                  return (
                    <Link
                      key={c.id}
                      to={`/g/${c.id}?run=${n.run_id}`}
                      className="group rounded-[18px] border border-kind-analysis-border bg-surface p-4 flex flex-col gap-2.5 text-left hover:shadow-[0_0_0_4px_rgb(var(--color-kind-analysis)/0.07)] transition-shadow"
                    >
                      <span className="self-start inline-flex items-center gap-1.5 h-[22px] px-2 rounded-full bg-kind-analysis-fill text-kind-analysis text-[11.5px] font-semibold">
                        <StepsIcon size={12} /> Guided · step {n.step} of {n.steps}
                      </span>
                      <span className="text-[15px] font-semibold text-text leading-snug truncate">{c.title}</span>
                      <span className="text-ui text-secondary leading-snug line-clamp-2">
                        “{n.step_title || `Step ${n.step}`}” is ready for you to check and approve.
                      </span>
                      <span className="text-ui text-kind-analysis group-hover:underline">Review step {n.step} →</span>
                    </Link>
                  );
                })}
              </div>
            </section>
          )}

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
                          {(c.question_count || 0) > 1 ? ` · ${c.question_count} questions` : ""}
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

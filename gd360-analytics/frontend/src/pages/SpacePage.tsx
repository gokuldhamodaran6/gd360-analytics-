// 2026-10-09 (round 15): one Space at /spaces/:id. A marketing Space opens
// as a channel hub (MarketingHub.dc.html): headline numbers for the chosen
// period against the period before, weekly organic and paid reach, every
// channel side by side, top posts and search queries. Any other Space shows
// a clean overview: its sources and their tables. Both have an "Ask <Space>"
// box that starts a Project answered from this Space's sources only.
// Backend: routers/spaces.py (GET /spaces/{id}, /spaces/{id}/overview).
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import BrandTile from "../components/BrandTile";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { Space, SpaceOverview, OverviewKpi, spacesApi } from "../api/spaces";
import { projectsApi } from "../api/projects";
import { Automation, automationsApi } from "../api/automations";
import { autoRunPreference, timeAgo } from "../project/format";
import WeeklyReachChart, { hasWeeklyData } from "../spaces/WeeklyReachChart";
import ChannelTable, { chipClass } from "../spaces/ChannelTable";
import { compact, pct, position } from "../spaces/format";

const PERIODS = [
  { days: 7, label: "Last 7 days" },
  { days: 28, label: "Last 28 days" },
  { days: 90, label: "Last 90 days" },
] as const;

function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  return typeof d === "string" && d.trim() ? d : fallback;
}

function Card({ title, id, children, className = "" }: { title: string; id: string; children: React.ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={`rounded-card border border-border bg-surface p-4 sm:p-5 flex flex-col gap-3 min-w-0 ${className}`}>
      <h2 id={id} className="m-0 text-section font-semibold text-text">{title}</h2>
      {children}
    </section>
  );
}

function Skeleton({ className }: { className: string }) {
  return <div className={`rounded-card bg-subtle animate-pulse ${className}`} aria-hidden="true" />;
}

function KpiTile({ k }: { k: OverviewKpi }) {
  if (!k.available) {
    const hint = k.source_note || "Connect a source";
    return (
      <div className="rounded-card border border-dashed border-border bg-surface/50 px-4 py-4 flex flex-col gap-1.5 min-w-0">
        <span className="text-ui text-muted">{k.label}</span>
        <span className="font-mono text-[24px] leading-tight text-faint">—</span>
        <span className="text-caption text-muted">{/^connect/i.test(hint) && !/see/i.test(hint) ? `${hint} to see this` : hint}</span>
      </div>
    );
  }
  const neutral = k.key === "ad_spend";
  const delta = k.delta_points != null ? k.delta_points : k.delta_pct;
  const unit = k.delta_points != null ? " pts" : "%";
  // a change that rounds to 0.0 is no change - no arrow, no colour
  const dir = delta == null ? null : Math.abs(delta) < 0.05 ? "flat" : delta > 0 ? "up" : "down";
  const tone = dir === "up" && !neutral ? "text-good" : dir === "down" && !neutral ? "text-danger" : "text-secondary";
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-4 flex flex-col gap-1.5 min-w-0">
      <span className="text-ui text-muted">{k.label}</span>
      <span className="font-mono text-[24px] sm:text-[26px] leading-tight tracking-tight text-text">{k.display}</span>
      {delta != null ? (
        <span className={`text-caption ${tone}`}>
          {dir === "up" ? "▲ " : dir === "down" ? "▼ " : ""}
          {Math.abs(delta).toFixed(1)}
          {unit}
          {k.previous_display && k.previous_display !== "—" && <span className="text-muted"> · was {k.previous_display}</span>}
        </span>
      ) : (
        <span className="text-caption text-muted">No earlier period to compare</span>
      )}
      {k.source_note && <span className="text-[11px] leading-snug text-muted">{k.source_note}</span>}
    </div>
  );
}

function sourceStatus(s: Space["sources"][number]): { text: string; warn: boolean } {
  if (s.sync_error) return { text: `Sync problem: ${s.sync_error}`, warn: true };
  if (s.mode === "live") return { text: "Live - queried where it lives", warn: false };
  if (s.mode === "file") return { text: s.last_synced_at ? `File · uploaded ${timeAgo(s.last_synced_at)}` : "File", warn: false };
  return s.last_synced_at ? { text: `Synced ${timeAgo(s.last_synced_at)}`, warn: false } : { text: "Waiting for its first sync", warn: true };
}

/** Automations that read or sync one of this Space's sources. */
function watching(list: Automation[], ids: Set<string>): Automation[] {
  return list.filter(
    (a) =>
      (a.trigger.type === "new_data" && ids.has(a.trigger.datasource_id)) ||
      a.steps.some((st) => st.datasource_id && ids.has(st.datasource_id)),
  );
}

export default function SpacePage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [space, setSpace] = useState<Space | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [days, setDays] = useState<7 | 28 | 90>(28);
  const [overview, setOverview] = useState<SpaceOverview | null>(null);
  const [ovLoading, setOvLoading] = useState(true);
  const [ovError, setOvError] = useState("");
  const [autos, setAutos] = useState<Automation[] | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [askError, setAskError] = useState("");
  const [reload, setReload] = useState(0);
  const askRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    setSpace(null);
    setNotFound(false);
    setLoadError("");
    setOverview(null);
    spacesApi
      .get(id)
      .then((s) => live && setSpace(s))
      .catch((e) => {
        if (!live) return;
        const st = e?.response?.status;
        if (st === 404 || st === 403) setNotFound(true);
        else setLoadError(errorText(e, "Couldn't load this Space."));
      });
    automationsApi
      .list()
      .then((r) => live && setAutos(r.automations))
      .catch(() => live && setAutos(null));
    return () => {
      live = false;
    };
  }, [id]);

  useEffect(() => {
    let live = true;
    setOvLoading(true);
    setOvError("");
    spacesApi
      .overview(id, days)
      .then((o) => live && setOverview(o))
      .catch((e) => {
        if (!live) return;
        if (e?.response?.status === 404) setNotFound(true);
        else setOvError(errorText(e, "Couldn't work out the numbers for this period."));
      })
      .finally(() => live && setOvLoading(false));
    return () => {
      live = false;
    };
  }, [id, days, reload]);

  const isMarketing = !!overview && overview.channels.length > 0;
  const watched = useMemo(() => (space && autos ? watching(autos, new Set(space.source_ids)) : []), [space, autos]);
  const kpis = overview?.kpis || [];
  const anyKpi = kpis.some((k) => k.available);

  const ask = async () => {
    const q = question.trim();
    if (q.length < 2 || busy || !space) return;
    setBusy(true);
    setAskError("");
    try {
      const out = await projectsApi.create({
        question: q,
        space_id: space.id,
        workspace_id: space.workspace_id || activeWorkspaceId || undefined,
        auto_run: autoRunPreference(),
      });
      navigate(`/p/${out.project_id}?run=${out.run_id}`);
    } catch (e: any) {
      setAskError(errorText(e, "Couldn't start that question. Please try again."));
      setBusy(false);
    }
  };

  const shell = (content: React.ReactNode) => (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onWorkspaceSwitch={switchWorkspace}
        onWorkspaceCreated={handleWorkspaceCreated}
      />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo breadcrumb={[{ label: "Spaces", to: "/data?tab=spaces" }, { label: space?.name || "Space" }]} />
        <main className="w-full max-w-[1240px] mx-auto px-4 sm:px-8 pt-6 sm:pt-8 pb-16 flex flex-col gap-5 min-w-0">{content}</main>
      </div>
    </div>
  );

  if (notFound) {
    return shell(
      <div className="rounded-card border border-border bg-surface p-6 sm:p-8 flex flex-col gap-3 max-w-[560px]">
        <h1 className="m-0 text-title font-semibold text-text">This Space doesn't exist or isn't shared with you</h1>
        <p className="m-0 text-ui text-muted">It may have been deleted, or its owner hasn't given you access. Ask them to add you, or pick another Space.</p>
        <Link to="/data?tab=spaces" className="text-ui text-brand-ink hover:underline self-start">← Back to all Spaces</Link>
      </div>,
    );
  }

  if (loadError) {
    return shell(
      <div role="alert" className="rounded-card border border-danger-border bg-danger-fill p-5 text-ui text-danger">
        {loadError}{" "}
        <button type="button" className="underline" onClick={() => window.location.reload()}>Try again</button>
      </div>,
    );
  }

  if (!space) {
    return shell(
      <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading this Space">
        <Skeleton className="h-16 w-full max-w-[520px]" />
        <Skeleton className="h-14 w-full" />
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 230px), 1fr))" }}>
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>,
    );
  }

  const nSources = space.stats?.sources ?? space.sources.length;
  const freshTone = space.fresh?.status === "warning" ? "text-warning" : "text-secondary";

  return shell(
    <>
      <header className="flex justify-between items-end gap-4 flex-wrap">
        <div className="flex flex-col gap-2 min-w-0">
          <span className="inline-flex items-center gap-2 text-caption text-secondary flex-wrap">
            <span className="w-[9px] h-[9px] rounded-[3px] shrink-0" style={{ background: space.color }} aria-hidden="true" />
            Space · {nSources} {nSources === 1 ? "source" : "sources"}
            {space.fresh?.text && <span className={freshTone}>· {space.fresh.text}</span>}
          </span>
          <h1 className="m-0 text-[26px] sm:text-[32px] font-semibold tracking-tight text-text break-words">{space.name}</h1>
          {space.description && <p className="m-0 text-ui text-muted max-w-[70ch]">{space.description}</p>}
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          {isMarketing && (
            <>
              <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Period">
                {PERIODS.map((p) => (
                  <button key={p.days} type="button" className={chipClass(days === p.days)} aria-pressed={days === p.days} onClick={() => setDays(p.days)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <span className="text-caption text-muted">vs the period before</span>
            </>
          )}
          {space.can_edit && (
            <Link to={`/data?tab=spaces&edit=${space.id}`} className="ui-focus inline-flex items-center h-8 px-3 rounded-full border border-border text-ui text-secondary hover:text-text">
              Settings
            </Link>
          )}
        </div>
      </header>

      {/* Ask this Space */}
      <form
        className="flex items-center gap-2.5 pl-4 pr-2 py-2 rounded-[14px] border border-tint-border bg-surface shadow-card"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0 text-brand-ink">
          <path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
        <label htmlFor="space-ask" className="sr-only">Ask {space.name}</label>
        <input
          id="space-ask"
          ref={askRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={busy}
          placeholder={isMarketing ? `Ask ${space.name} - e.g. which posts brought people to the store?` : `Ask ${space.name} anything`}
          className="flex-1 min-w-0 h-10 bg-transparent border-0 outline-none text-[15px] text-text placeholder:text-faint"
        />
        <button type="submit" disabled={busy || question.trim().length < 2} className="ui-focus h-10 px-4 rounded-[11px] bg-primary text-on-primary text-ui font-semibold shrink-0 disabled:opacity-40 inline-flex items-center gap-2">
          {busy && <span className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" aria-hidden="true" />}
          Ask
        </button>
      </form>
      {askError && <div role="alert" className="text-ui text-danger -mt-2">{askError}</div>}

      {ovError && (
        <div role="alert" className="rounded-card border border-warning-border bg-warning-fill px-4 py-3 text-ui text-warning flex flex-wrap gap-2 items-center justify-between">
          <span>{ovError}</span>
          <button type="button" className="underline" onClick={() => setReload((n) => n + 1)}>Try again</button>
        </div>
      )}

      {ovLoading && !overview && (
        <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading the numbers">
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
          </div>
          <Skeleton className="h-72 w-full" />
        </div>
      )}

      {overview && isMarketing && (
        <div className={`flex flex-col gap-5 transition-opacity ${ovLoading ? "opacity-60" : ""}`} aria-busy={ovLoading}>
          {anyKpi && (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(170px, 100%), 1fr))" }}>
              {kpis.map((k) => <KpiTile key={k.key} k={k} />)}
            </div>
          )}

          <div className="flex gap-4 flex-wrap items-stretch">
            {hasWeeklyData(overview.weekly) && (
              <Card id="space-weekly-h" title="Weekly reach — organic and paid" className="flex-[3_1_520px]">
                <WeeklyReachChart rows={overview.weekly} />
              </Card>
            )}
            {autos && (
              <Card id="space-watch-h" title="Watching this Space" className="flex-[2_1_300px]">
                {watched.length === 0 ? (
                  <p className="m-0 text-ui text-muted">Nothing is watching these sources yet. An alert can tell you when a number moves; a weekly report can land in your inbox.</p>
                ) : (
                  <ul className="m-0 p-0 list-none flex flex-col gap-2">
                    {watched.slice(0, 4).map((a) => (
                      <li key={a.id}>
                        <Link to={`/automations/${a.id}`} className="flex gap-3 items-start p-3 rounded-ctl border border-border bg-base hover:bg-subtle">
                          <span
                            className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${!a.enabled ? "bg-faint" : a.last_status === "failed" ? "bg-danger" : a.last_condition ? "bg-warning" : "bg-good"}`}
                            aria-hidden="true"
                          />
                          <span className="flex flex-col gap-0.5 min-w-0">
                            <span className="text-ui text-text">{a.name}</span>
                            <span className="text-caption text-muted">
                              {!a.enabled ? "Off" : a.sentence?.when || ""}
                              {a.last_run_at ? ` · last ran ${timeAgo(a.last_run_at)}` : ""}
                            </span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                <Link to="/automations/new" className="text-ui text-brand-ink hover:underline self-start">+ Add an alert or weekly report</Link>
              </Card>
            )}
          </div>

          <ChannelTable channels={overview.channels} />

          {(overview.top_posts.length > 0 || overview.queries.length > 0) && (
            <div className="flex gap-4 flex-wrap items-stretch">
              {overview.top_posts.length > 0 && (
                <Card id="space-posts-h" title="Top posts this period" className="flex-[1_1_380px]">
                  <ul className="m-0 p-0 list-none">
                    {overview.top_posts.map((p, i) => {
                      const text = p.text?.trim() || (p.type ? `${p.type[0].toUpperCase()}${p.type.slice(1)}` : "Post");
                      const meta = [p.account, p.type, p.posted_at ? timeAgo(p.posted_at) : null].filter(Boolean).join(" · ");
                      const inner = (
                        <>
                          <BrandTile kind={p.kind} name={p.account || p.kind} size={26} />
                          <span className="flex flex-col gap-0.5 min-w-0">
                            <span className="text-ui text-text truncate" title={text}>{text}</span>
                            <span className="text-caption text-muted truncate">{meta}</span>
                          </span>
                          <span className="font-mono text-[12.5px] text-right leading-snug">
                            <span className="text-text">{compact(p.reach)}</span>
                            <br />
                            <span className="text-muted">{pct(p.engagement_rate)}</span>
                          </span>
                        </>
                      );
                      const cls = "grid grid-cols-[26px_minmax(0,1fr)_auto] gap-3 items-center py-2.5 border-t border-border first:border-t-0";
                      return (
                        <li key={`${p.source_id}-${i}`}>
                          {p.url ? (
                            <a href={p.url} target="_blank" rel="noopener noreferrer" className={`${cls} ui-focus rounded-sm hover:bg-subtle/60`} aria-label={`${text}, reach ${compact(p.reach)}, engagement ${pct(p.engagement_rate)} (opens in a new tab)`}>
                              {inner}
                            </a>
                          ) : (
                            <div className={cls}>{inner}</div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <span className="text-caption text-muted">Reach, then engagement rate.</span>
                </Card>
              )}
              {overview.queries.length > 0 && (
                <Card id="space-queries-h" title="Search — what people typed to find you" className="flex-[1_1_380px]">
                  <div className="overflow-x-auto -mx-1">
                    <table className="w-full min-w-[440px] border-collapse tabular-nums">
                      <thead>
                        <tr>
                          {["Query", "Clicks", "Impressions", "CTR", "Position"].map((h, i) => (
                            <th key={h} scope="col" className={`px-3 py-2 text-caption font-medium text-muted border-b border-border whitespace-nowrap ${i ? "text-right" : "text-left"}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {overview.queries.map((q) => (
                          <tr key={q.query} className="border-b border-border last:border-0">
                            <td className="px-3 py-2.5 text-ui text-text max-w-[260px] truncate" title={q.query}>{q.query}</td>
                            <td className="px-3 py-2.5 text-right font-mono text-[13px] text-text">{q.clicks.toLocaleString("en-US")}</td>
                            <td className="px-3 py-2.5 text-right font-mono text-[13px] text-text">{compact(q.impressions)}</td>
                            <td className="px-3 py-2.5 text-right font-mono text-[13px] text-text">{pct(q.ctr)}</td>
                            <td className="px-3 py-2.5 text-right font-mono text-[13px] text-text">{position(q.position)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <span className="text-caption text-muted">From Search Console.</span>
                </Card>
              )}
            </div>
          )}
        </div>
      )}

      {overview && overview.missing.length > 0 && (
        <section aria-labelledby="space-missing-h" className="flex flex-col gap-2 px-1">
          <h2 id="space-missing-h" className="m-0 text-ui font-medium text-secondary">Not in this view yet</h2>
          <ul className="m-0 pl-5 flex flex-col gap-1 text-ui text-muted list-disc">
            {overview.missing.map((m) => <li key={m}>{m}</li>)}
          </ul>
          <Link to="/data?tab=catalog" className="text-ui text-brand-ink hover:underline self-start">Connect a source</Link>
        </section>
      )}

      <div className="flex gap-4 flex-wrap items-start">
        <Card id="space-sources-h" title="Sources in this Space" className="flex-[1_1_360px]">
          {space.sources.length === 0 ? (
            <p className="m-0 text-ui text-muted">
              No sources you can use yet.{" "}
              {space.can_edit ? <Link to={`/data?tab=spaces&edit=${space.id}`} className="text-brand-ink hover:underline">Add sources</Link> : "Ask the Space's owner to share one."}
            </p>
          ) : (
            <ul className="m-0 p-0 list-none">
              {space.sources.map((s) => {
                const st = sourceStatus(s);
                return (
                  <li key={s.id}>
                    <Link to={`/workspace/${s.id}`} className="grid grid-cols-[26px_minmax(0,1fr)] gap-3 items-center py-2.5 border-t border-border first:border-t-0 hover:bg-subtle/60 rounded-sm">
                      <BrandTile kind={s.kind} name={s.name} size={26} />
                      <span className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-ui text-text truncate">{s.name}</span>
                        <span className="text-caption truncate">
                          <span className="text-muted">{s.label} · </span>
                          <span className={st.warn ? "text-warning" : "text-muted"}>{st.text}</span>
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {overview && !isMarketing && (
          <Card id="space-tables-h" title="Tables" className="flex-[2_1_420px]">
            {overview.tables.length === 0 ? (
              <p className="m-0 text-ui text-muted">No tables to show yet. Synced apps list their tables here after the first sync.</p>
            ) : (
              <div className="overflow-x-auto -mx-1">
                <table className="w-full min-w-[480px] border-collapse tabular-nums">
                  <thead>
                    <tr>
                      {["Source", "Table", "Rows", "Synced"].map((h, i) => (
                        <th key={h} scope="col" className={`px-3 py-2 text-caption font-medium text-muted border-b border-border whitespace-nowrap ${i >= 2 ? "text-right" : "text-left"}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {overview.tables.map((t) => (
                      <tr key={`${t.source_id}-${t.table}`} className="border-b border-border last:border-0">
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className="flex items-center gap-2">
                            <BrandTile kind={t.kind} name={t.source} size={22} />
                            <span className="text-ui text-text truncate max-w-[200px]">{t.source}</span>
                          </span>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-[12.5px] text-secondary whitespace-nowrap">{t.table}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-[13px] text-text">{t.rows == null ? "—" : t.rows.toLocaleString("en-US")}</td>
                        <td className="px-3 py-2.5 text-right text-caption text-muted whitespace-nowrap">{t.synced_at ? timeAgo(t.synced_at) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </div>
    </>,
  );
}

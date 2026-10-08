// 2026-10-08 (round 11): a live dashboard built from a Project answer. It
// re-runs the answer's checked queries in every source on Refresh (no AI
// involved), and can be arranged: rename, hide, reorder, resize and change
// the chart of any tile.
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import WorkspaceChart from "../components/WorkspaceChart";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { ChartThemeProvider } from "../dashboard/theme/ChartThemeContext";
import { dashboardApi } from "../api/client";
import { DashTile, ProjectDashboard as PD, projectsApi } from "../api/projects";
import { KpiRow, SourceTags, VisualCard } from "../project/Visuals";
import { ModeBadge } from "../project/RunPanels";
import { timeAgo } from "../project/format";

const CHART_CHOICES = [
  ["", "Auto"], ["line", "Line"], ["area", "Area"], ["bar", "Bar"], ["horizontal_bar", "Horizontal bar"], ["table", "Table"],
] as const;

function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  return typeof d === "string" && d.trim() ? d : fallback;
}

export default function ProjectDashboard() {
  const { dashboardId = "" } = useParams();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [dash, setDash] = useState<PD | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DashTile[]>([]);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    projectsApi
      .dashboard(dashboardId)
      .then((d) => { setDash(d); setName(d.name); })
      .catch((e) => (e?.response?.status === 404 ? setNotFound(true) : setError(errorText(e, "Couldn't load this dashboard."))));
  }, [dashboardId]);

  const refresh = async () => {
    setRefreshing(true);
    setError("");
    try {
      const d = await projectsApi.refreshDashboard(dashboardId);
      setDash(d);
    } catch (e: any) {
      setError(errorText(e, "The refresh didn't finish. The numbers shown are from the last successful run."));
    } finally {
      setRefreshing(false);
    }
  };

  const startEdit = () => {
    if (!dash) return;
    setDraft(dash.tiles.map((t) => ({ ...t })));
    setName(dash.name);
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const d = await projectsApi.updateDashboard(dashboardId, { name, tiles: draft });
      setDash(d);
      setEditing(false);
    } catch (e: any) {
      setError(errorText(e, "Couldn't save the layout."));
    } finally {
      setSaving(false);
    }
  };

  const tiles = editing ? draft : dash?.tiles || [];
  const kpiMap = useMemo(() => new Map((dash?.snapshot.kpis || []).map((k) => [k.key, k])), [dash]);
  const ctxMap = useMemo(() => new Map((dash?.snapshot.context || []).map((c) => [c.id, c])), [dash]);
  const kpiTiles = tiles.filter((t) => t.kind === "kpi" && (editing || !t.hidden));
  const bodyTiles = tiles.filter((t) => t.kind !== "kpi" && (editing || !t.hidden));

  const patch = (id: string, change: Partial<DashTile>) => setDraft((d) => d.map((t) => (t.id === id ? { ...t, ...change } : t)));
  const move = (id: string, dir: -1 | 1) =>
    setDraft((d) => {
      const i = d.findIndex((t) => t.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.length) return d;
      const next = [...d];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  if (notFound) {
    return (
      <div className="min-h-screen grid place-items-center bg-base px-6">
        <div className="text-center">
          <div className="text-section font-semibold text-text">This dashboard doesn't exist or isn't shared with you.</div>
          <Link to="/dashboards" className="btn-primary text-sm mt-4 inline-flex">All dashboards</Link>
        </div>
      </div>
    );
  }

  const shared = !!dash?.workspace_id;

  return (
    <ChartThemeProvider localScope={`project-dashboard:${dashboardId}`}>
      <div className="dash-shell flex min-h-screen">
        <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
        <div className="flex-1 min-w-0">
          <TopNav hideLogo />
          <main className="px-4 sm:px-8 py-6 max-w-[1360px] mx-auto flex flex-col gap-5">
            {!dash && !error && <div className="text-ui text-muted">Loading…</div>}
            {dash && (
              <>
                <div className="flex items-end justify-between gap-4 flex-wrap">
                  <div className="flex flex-col gap-2 min-w-0">
                    {dash.project_id && (
                      <Link to={`/p/${dash.project_id}`} className="font-mono text-caption text-muted uppercase hover:text-text truncate">
                        ← From project “{dash.question}”
                      </Link>
                    )}
                    {editing ? (
                      <input
                        aria-label="Dashboard name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="text-[28px] font-semibold tracking-tight bg-transparent border-b border-border-strong text-text outline-none"
                      />
                    ) : (
                      <h1 className="m-0 text-[28px] sm:text-[32px] font-bold tracking-tight text-text">{dash.name}</h1>
                    )}
                    <div className="flex gap-3.5 flex-wrap text-caption text-muted">
                      {dash.sources.map((s) => (
                        <span key={s.id} className="inline-flex items-center gap-1.5">
                          <span className={`w-1.5 h-1.5 rounded-full ${s.mode === "live" ? "bg-good" : s.mode === "synced" ? "bg-[rgb(var(--color-series-1))]" : "bg-border-strong"}`} />
                          {s.name} · {s.freshness}
                        </span>
                      ))}
                      {dash.snapshot_at && <span>· numbers from {timeAgo(dash.snapshot_at)}</span>}
                    </div>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {editing ? (
                      <>
                        <button type="button" className="btn-secondary text-sm" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
                        <button type="button" className="btn-primary text-sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save layout"}</button>
                      </>
                    ) : (
                      <>
                        {dash.can_edit && <button type="button" className="btn-secondary text-sm" onClick={startEdit}>Edit</button>}
                        <button type="button" className="btn-secondary text-sm" onClick={refresh} disabled={refreshing}>
                          {refreshing ? "Refreshing…" : "Refresh"}
                        </button>
                        {dash.can_edit && (
                          <Link to={`/automations/new?dashboard=${dash.id}`} className="btn-secondary text-sm">
                            Deliver on a schedule…
                          </Link>
                        )}
                        {dash.can_edit && activeWorkspaceId && (
                          <button
                            type="button"
                            className={shared ? "btn-secondary text-sm" : "btn-primary text-sm"}
                            onClick={async () => {
                              try {
                                await dashboardApi.setWorkspace(dash.id, shared ? null : activeWorkspaceId);
                                setDash({ ...dash, workspace_id: shared ? null : activeWorkspaceId });
                              } catch (e: any) {
                                setError(errorText(e, "Couldn't change who can see this dashboard."));
                              }
                            }}
                          >
                            {shared ? "Shared with workspace ✓" : "Share"}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {error && <div role="alert" className="rounded-card border border-danger-border bg-danger-fill p-3 text-ui text-text">{error}</div>}
                {(dash.snapshot.warnings || []).length > 0 && !editing && (
                  <div className="rounded-card border border-warning-border bg-warning-fill p-3 text-ui text-warning">{dash.snapshot.warnings!.join(" ")}</div>
                )}

                {kpiTiles.length > 0 && (
                  editing ? (
                    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                      {kpiTiles.map((t) => (
                        <EditFrame key={t.id} tile={t} onPatch={patch} onMove={move} showSpan={false}>
                          {kpiMap.get(String(t.ref)) ? <KpiRow items={[{ ...kpiMap.get(String(t.ref))!, label: t.title }]} /> : <Missing />}
                        </EditFrame>
                      ))}
                    </div>
                  ) : (
                    <KpiRow
                      items={kpiTiles.flatMap((t) => {
                        const k = kpiMap.get(String(t.ref));
                        return k ? [{ ...k, key: t.id, label: t.title }] : [];
                      })}
                    />
                  )
                )}

                <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
                  {bodyTiles.map((t) => {
                    let body: JSX.Element = <Missing />;
                    if (t.kind === "visual") {
                      const v = (dash.snapshot.visuals || [])[Number(t.ref)];
                      if (v) body = <VisualCard visual={v.type === "chart" ? { ...v, title: t.title } : { ...v, title: t.title } as any} id={`${dash.id}:${t.id}`} chartType={t.chart_type} />;
                    } else {
                      const c = ctxMap.get(String(t.ref));
                      if (c) {
                        body = (
                          <section className="rounded-card border border-border bg-surface p-4 sm:p-5 flex flex-col gap-2 min-w-0 [&>div.card]:border-0 [&>div.card]:bg-transparent [&>div.card]:p-0 [&>div.card]:shadow-none [&>div.card]:rounded-none [&>div.card:hover]:shadow-none">
                            <div className="flex items-start justify-between gap-3">
                              <h3 className="m-0 text-section font-semibold text-text leading-snug">{t.title}</h3>
                              <SourceTags names={c.source ? [c.source] : []} />
                            </div>
                            <WorkspaceChart columns={c.columns as any} rows={c.rows as any} chartType={t.chart_type || null} title={t.title} id={`${dash.id}:${t.id}`} variant="full" minHeight={240} />
                          </section>
                        );
                      }
                    }
                    return (
                      <div key={t.id} className={`min-w-0 ${t.span === 2 ? "lg:col-span-2" : ""} ${editing && t.hidden ? "opacity-50" : ""}`}>
                        {editing ? (
                          <EditFrame tile={t} onPatch={patch} onMove={move} showSpan showChart={t.kind !== "visual" || ((dash.snapshot.visuals || [])[Number(t.ref)] as any)?.type === "chart"}>
                            {body}
                          </EditFrame>
                        ) : (
                          body
                        )}
                      </div>
                    );
                  })}
                </div>

                {!editing && (dash.snapshot.steps || []).length > 0 && (
                  <details className="rounded-card border border-border bg-surface p-4">
                    <summary className="cursor-pointer text-ui text-muted">How these numbers are computed ({(dash.snapshot.steps || []).length} queries)</summary>
                    <div className="mt-3 flex flex-col gap-2">
                      {(dash.snapshot.steps || []).map((s) => (
                        <div key={s.id} className="flex items-center gap-2 text-ui flex-wrap">
                          <ModeBadge mode={s.mode} />
                          <span className="text-text">{s.title}</span>
                          <span className="text-muted">· {s.kind === "combine" ? "combined" : s.source_name}</span>
                          {s.status === "failed" && <span className="text-danger">· {s.error}</span>}
                        </div>
                      ))}
                      {dash.assumptions.length > 0 && <div className="text-caption text-muted mt-2">Assumptions: {dash.assumptions.join(" ")}</div>}
                    </div>
                  </details>
                )}
              </>
            )}
          </main>
        </div>
      </div>
    </ChartThemeProvider>
  );
}

function Missing() {
  return <div className="rounded-card border border-dashed border-border p-6 text-ui text-muted">This tile has no data in the latest refresh.</div>;
}

function EditFrame({
  tile, onPatch, onMove, showSpan, showChart = false, children,
}: {
  tile: DashTile; onPatch: (id: string, c: Partial<DashTile>) => void; onMove: (id: string, d: -1 | 1) => void;
  showSpan: boolean; showChart?: boolean; children: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-dashed border-tint-border p-2 flex flex-col gap-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <input
          aria-label="Tile title"
          value={tile.title}
          onChange={(e) => onPatch(tile.id, { title: e.target.value })}
          className="flex-1 min-w-[140px] h-8 rounded-ctl border border-border bg-base px-2 text-ui text-text"
        />
        {showChart && (
          <select
            aria-label="Chart type"
            value={tile.chart_type || ""}
            onChange={(e) => onPatch(tile.id, { chart_type: e.target.value || null })}
            className="h-8 rounded-ctl border border-border bg-base px-2 text-ui text-text"
          >
            {CHART_CHOICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        )}
        {showSpan && (
          <button type="button" className="btn-secondary text-xs h-8" onClick={() => onPatch(tile.id, { span: tile.span === 2 ? 1 : 2 })}>
            {tile.span === 2 ? "Half width" : "Full width"}
          </button>
        )}
        <button type="button" aria-label="Move earlier" className="btn-secondary text-xs h-8 px-2" onClick={() => onMove(tile.id, -1)}>↑</button>
        <button type="button" aria-label="Move later" className="btn-secondary text-xs h-8 px-2" onClick={() => onMove(tile.id, 1)}>↓</button>
        <button type="button" className="btn-secondary text-xs h-8" onClick={() => onPatch(tile.id, { hidden: !tile.hidden })}>
          {tile.hidden ? "Show" : "Hide"}
        </button>
      </div>
      {children}
    </div>
  );
}

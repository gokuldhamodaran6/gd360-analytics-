// 2026-10-10 (Clarity Blueprint, Option 1 - one kind of dashboard): an
// Answer's "Create dashboard". It builds the SAME full dashboard as every
// other path in GD360 (filters, cross-filter, canvas, publish), computed
// live on one of the sources the answer used, and linked back to the
// answer ("Made from answer"). The person picks a name, which source it
// computes on (only asked when the answer used more than one), and whether
// it is a new dashboard or new pages on an existing one built on that same
// source. Also used to upgrade a classic answer dashboard in place.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { dashboardBuilderApi, DashboardPickerEntry } from "../api/client";
import { projectsApi, ProjectRun, ProjectSource } from "../api/projects";
import { KindIcon, KindPill } from "../lib/kinds";

const PHASES = [
  "Reading the answer…",
  "Planning the blocks…",
  "Checking every query against your data…",
  "Adding filters and laying it out…",
];

function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  if (typeof d === "string" && d.trim()) return d;
  if (e?.code === "ECONNABORTED") return "This is taking longer than usual. Check Dashboards in a minute - it may still appear.";
  return fallback;
}

/** The sources an answer's queries ran in, most-used first. */
export function answerSources(run: ProjectRun | null, all: ProjectSource[]): { source: ProjectSource; queries: number }[] {
  const counts = new Map<string, number>();
  for (const st of run?.plan?.steps || []) {
    if (st.source_id) counts.set(st.source_id, (counts.get(st.source_id) || 0) + 1);
  }
  const used = all
    .filter((s) => counts.has(s.id))
    .map((s) => ({ source: s, queries: counts.get(s.id) || 0 }))
    .sort((a, b) => b.queries - a.queries);
  return used.length ? used : all.slice(0, 1).map((s) => ({ source: s, queries: 0 }));
}

export default function CreateDashboardSheet({
  open,
  onClose,
  projectId,
  run,
  sources,
  replaceDashboardId,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  run: ProjectRun | null;
  sources: ProjectSource[];
  // set: upgrade this classic answer dashboard in place instead
  replaceDashboardId?: string | null;
}) {
  const navigate = useNavigate();
  const candidates = useMemo(() => answerSources(run, sources), [run, sources]);
  const [name, setName] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [mode, setMode] = useState<"new" | "add">("new");
  const [existing, setExisting] = useState<DashboardPickerEntry[] | null>(null);
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState(0);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const upgrading = Boolean(replaceDashboardId);

  useEffect(() => {
    if (!open) return;
    setError("");
    setBusy(false);
    setPhase(0);
    setMode("new");
    setName((run?.plan?.title || run?.question || "").slice(0, 120));
    setSourceId(candidates[0]?.source.id || "");
    if (!upgrading) {
      dashboardBuilderApi.listMine().then(setExisting).catch(() => setExisting([]));
    }
    const t = window.setTimeout(() => nameRef.current?.focus(), 40);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, run?.id]);

  // Only dashboards built on the chosen source can take new pages from it.
  const sameSource = useMemo(
    () => (existing || []).filter((d) => d.can_edit && d.datasource_id && d.datasource_id === sourceId),
    [existing, sourceId],
  );
  useEffect(() => {
    if (!sameSource.some((d) => d.id === targetId)) setTargetId(sameSource[0]?.id || "");
    if (!sameSource.length && mode === "add") setMode("new");
  }, [sameSource, targetId, mode]);

  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => setPhase((p) => Math.min(PHASES.length - 1, p + 1)), 2600);
    return () => window.clearInterval(t);
  }, [busy]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open || !run) return null;

  const visuals = (run.result?.visuals || []).filter((v) => v.type !== "kpis").map((v) => (v as { title?: string }).title).filter(Boolean) as string[];
  const kpis = (run.result?.visuals || []).find((v) => v.type === "kpis");
  const kpiCount = kpis && kpis.type === "kpis" ? kpis.items.length : 0;
  const chosen = candidates.find((c) => c.source.id === sourceId)?.source;

  const create = async () => {
    if (!sourceId || busy) return;
    if (mode === "add" && !targetId) return;
    setBusy(true);
    setError("");
    setPhase(0);
    try {
      const out = await projectsApi.makeDashboard(projectId, {
        run_id: run.id,
        name: upgrading || mode === "add" ? undefined : name.trim() || undefined,
        datasource_id: sourceId,
        add_to_dashboard_id: mode === "add" ? targetId : undefined,
        replace_dashboard_id: replaceDashboardId || undefined,
      });
      navigate(`/dashboard-builder/${out.dashboard_id}`);
    } catch (e: any) {
      setError(errorText(e, "Couldn't create the dashboard. Please try again."));
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[60] bg-black/55 flex justify-end"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cds-title"
        data-create-dashboard-sheet=""
        className="w-full sm:w-[520px] max-w-full h-full overflow-y-auto bg-base border-l border-border shadow-pop p-5 sm:p-7 flex flex-col gap-5"
      >
        <div className="flex items-start gap-3">
          <div className="flex flex-col gap-2 min-w-0">
            <KindPill kind="dashboard" className="self-start" />
            <h2 id="cds-title" className="m-0 text-title font-semibold text-text text-balance">
              {upgrading ? "Upgrade to a live dashboard" : "Create a dashboard from this answer"}
            </h2>
            <p className="m-0 text-ui text-muted leading-relaxed">
              {upgrading
                ? "Same name and link. It becomes the full kind: filters, cross-filter, canvas and publishing - computed live on your data."
                : "The same full dashboard as everywhere in GD360: filters, cross-filter, canvas and publishing - computed live on your data, with a link back to this answer."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="ui-focus ml-auto shrink-0 w-9 h-9 grid place-items-center rounded-ctl border border-border text-muted hover:text-text disabled:opacity-40"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        {!upgrading && (
          <div className="flex flex-col gap-2">
            <span className="text-caption font-medium text-secondary">Where should it go?</span>
            <div className="grid gap-2" role="radiogroup" aria-label="Where should it go">
              <label className={`flex gap-3 items-start p-3 rounded-card border cursor-pointer ${mode === "new" ? "border-kind-dashboard-border bg-kind-dashboard-fill" : "border-border hover:bg-surface"}`}>
                <input type="radio" name="cds-mode" className="mt-1 accent-[rgb(var(--color-kind-dashboard))]" checked={mode === "new"} onChange={() => setMode("new")} disabled={busy} />
                <span className="flex flex-col gap-0.5">
                  <span className="text-ui font-semibold text-text">A new dashboard</span>
                  <span className="text-caption text-muted">Private to you until you share or publish it.</span>
                </span>
              </label>
              <label className={`flex gap-3 items-start p-3 rounded-card border ${sameSource.length ? "cursor-pointer" : "opacity-60 cursor-not-allowed"} ${mode === "add" ? "border-kind-dashboard-border bg-kind-dashboard-fill" : "border-border hover:bg-surface"}`}>
                <input type="radio" name="cds-mode" className="mt-1 accent-[rgb(var(--color-kind-dashboard))]" checked={mode === "add"} onChange={() => setMode("add")} disabled={busy || !sameSource.length} />
                <span className="flex flex-col gap-1 min-w-0 flex-1">
                  <span className="text-ui font-semibold text-text">Add to an existing dashboard</span>
                  {existing === null ? (
                    <span className="text-caption text-muted">Looking for your dashboards…</span>
                  ) : sameSource.length ? (
                    <select
                      value={targetId}
                      onChange={(e) => { setTargetId(e.target.value); setMode("add"); }}
                      disabled={busy}
                      className="input h-9 text-sm w-full"
                      aria-label="Dashboard to add to"
                    >
                      {sameSource.map((d) => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-caption text-muted">None of your dashboards are built on {chosen?.name || "this source"} yet.</span>
                  )}
                  {mode === "add" && <span className="text-caption text-muted">Lands as a new page, after its existing pages.</span>}
                </span>
              </label>
            </div>
          </div>
        )}

        {!upgrading && mode === "new" && (
          <label className="flex flex-col gap-1.5 text-caption font-medium text-secondary">
            Name
            <input
              ref={nameRef}
              className="input h-10 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              disabled={busy}
              placeholder="e.g. Hotel performance"
            />
          </label>
        )}

        {candidates.length > 1 && (
          <div className="flex flex-col gap-2">
            <span className="text-caption font-medium text-secondary">Computes live on</span>
            <p className="m-0 text-caption text-muted">
              This answer used {candidates.length} sources. A dashboard computes on one, so its filters work on every block - pick the one that matters most.
            </p>
            <div className="grid gap-1.5" role="radiogroup" aria-label="Source the dashboard computes on">
              {candidates.map(({ source, queries }, i) => (
                <label key={source.id} className={`flex items-center gap-3 px-3 py-2.5 rounded-ctl border cursor-pointer ${sourceId === source.id ? "border-border-strong bg-surface" : "border-border hover:bg-surface"}`}>
                  <input type="radio" name="cds-source" className="accent-[rgb(var(--color-primary))]" checked={sourceId === source.id} onChange={() => setSourceId(source.id)} disabled={busy} />
                  <span className="min-w-0 flex-1 truncate text-ui text-text">{source.name}</span>
                  <span className="text-caption text-muted whitespace-nowrap">{source.label}{queries ? ` · ${queries} quer${queries === 1 ? "y" : "ies"}` : ""}</span>
                  {i === 0 && queries > 0 && <span className="text-[10.5px] font-semibold uppercase tracking-caps text-kind-answer">Used most</span>}
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-card border border-border bg-surface p-4 flex flex-col gap-2.5">
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">What goes on it</span>
          <ul className="m-0 pl-0 list-none flex flex-col gap-1.5 text-ui text-secondary">
            {kpiCount > 0 && <li>· The headline numbers as KPI tiles</li>}
            {visuals.slice(0, 5).map((t) => (
              <li key={t}>· {t}</li>
            ))}
            {!visuals.length && !kpiCount && <li>· The numbers and breakdowns behind “{run.question}”</li>}
            <li>· Filters for the main categories, and a date range when there's a date</li>
          </ul>
          <span className="text-caption text-muted">
            Computed on {chosen?.name || "your data"} every time it's opened - you can edit, add or remove any block afterwards.
          </span>
        </div>

        {error && <div role="alert" className="rounded-ctl border border-danger-border bg-danger-fill px-3 py-2.5 text-ui text-text">{error}</div>}

        <div className="mt-auto flex items-center gap-2.5 pt-1">
          <button type="button" className="btn-secondary text-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={create}
            disabled={busy || !sourceId || (mode === "add" && !targetId)}
            data-create-dashboard=""
            className="ui-focus inline-flex items-center gap-2 h-10 px-4 rounded-ctl font-semibold text-sm bg-kind-dashboard text-[rgb(var(--color-base))] hover:opacity-90 disabled:opacity-50"
          >
            {busy ? (
              <span className="w-4 h-4 rounded-full border-2 border-current/30 border-t-current animate-spin" style={{ borderColor: "currentColor", borderTopColor: "transparent" }} />
            ) : (
              <KindIcon kind="dashboard" size={15} />
            )}
            {busy ? PHASES[phase] : upgrading ? "Upgrade dashboard" : mode === "add" ? "Add to dashboard" : "Create dashboard"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

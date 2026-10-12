// 2026-10-12 (round 35b): "New dashboard" - the one way to start one on the Dashboards page.
// Name it, then start from
//   - Your data: sources chosen with Home's own picker (ScopePicker - same chip, same Spaces |
//     Pick sources panel), one page per source when there are several; or
//   - Merge existing dashboards: two or more, in the order picked, each page on its own source,
//     filters on the same column shared.
// Answers and analyses keep their own "Create dashboard"; this replaces the four start tiles and
// the old describe-it builder page.
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { dashboardApi, dashboardBuilderApi } from "../api/client";
import { projectsApi, type ProjectSource } from "../api/projects";
import { spacesApi, type Space } from "../api/spaces";
import ScopePicker, { type Scope } from "../spaces/ScopePicker";
import { Button, CloseIcon, DatabaseIcon, MergeIcon, WarningIcon, cn } from "../ui";
import { DashboardChecklist } from "./DashboardChecklist";
import { isLiveKind } from "./DataFreshness";

type Start = "data" | "merge";
const MAX_SOURCES = 6;

export function NewDashboardSheet({ open, onClose, workspaceId, initialStart = "data", initialPicked = [] }: { open: boolean; onClose: () => void; workspaceId: string; initialStart?: Start; initialPicked?: string[] }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [start, setStart] = useState<Start>(initialStart);
  const [sources, setSources] = useState<ProjectSource[] | null>(null);
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [scope, setScope] = useState<Scope>({ kind: "sources", ids: [] });
  const [picked, setPicked] = useState<string[]>([]);
  const [keepOriginals, setKeepOriginals] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStart(initialStart);
    setPicked(initialPicked);
    setError(null);
    projectsApi.sources(workspaceId || undefined).then(setSources).catch(() => setSources([]));
    spacesApi.list(workspaceId || undefined).then(setSpaces).catch(() => setSpaces([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId, initialStart]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy && !document.querySelector("[data-scope-popover]")) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  // The scope as the list of sources it means (Everything / a Space / picked ones)
  const chosen = useMemo<ProjectSource[]>(() => {
    const all = sources || [];
    if (scope.kind === "all") return all;
    if (scope.kind === "space") {
      const sp = (spaces || []).find((s) => s.id === scope.spaceId);
      const ids = new Set(sp?.source_ids || []);
      return all.filter((s) => ids.has(s.id));
    }
    const ids = new Set(scope.ids);
    return all.filter((s) => ids.has(s.id));
  }, [scope, sources, spaces]);
  const tooMany = chosen.length > MAX_SOURCES;
  const canCreate = !busy && (start === "data" ? chosen.length > 0 && !tooMany : picked.length >= 2);

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      if (start === "data") {
        const d = await dashboardBuilderApi.createBlankOnSources(chosen.map((s) => s.id), name.trim() || undefined);
        navigate(`/dashboard-builder/${d.id}`);
      } else {
        const d = await dashboardApi.merge(picked, name.trim() || undefined, keepOriginals);
        navigate(`/dashboard-builder/${d.id}`);
      }
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Couldn't create the dashboard. Please try again.");
      setBusy(false);
    }
  };

  if (!open || typeof document === "undefined") return null;
  const mixed = chosen.some((s) => isLiveKind(s.kind)) && chosen.some((s) => !isLiveKind(s.kind));

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:pt-[8vh]" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="new-dash-title" className="mb-8 flex w-full max-w-[640px] flex-col rounded-[18px] border border-border bg-surface shadow-pop" data-new-dashboard-sheet="">
        <div className="flex items-start justify-between gap-3 border-b border-border px-6 pb-4 pt-5">
          <div className="flex flex-col gap-1">
            <h2 id="new-dash-title" className="m-0 text-[20px] font-semibold text-text">New dashboard</h2>
            <p className="m-0 text-caption text-muted">Name it, choose where it starts. You can add, merge or change anything after.</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} disabled={busy} className="ui-focus grid h-8 w-8 place-items-center rounded-[9px] text-muted hover:text-text"><CloseIcon size={16} /></button>
        </div>

        <div className="flex flex-col gap-5 px-6 py-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11.5px] font-semibold uppercase tracking-caps text-muted">Name</span>
            <input
              autoFocus
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") create(); }}
              placeholder="e.g. Weekly sales"
              className="ui-focus h-11 rounded-ctl border border-border bg-base px-3 text-body text-text placeholder:text-faint"
              data-new-dash-name=""
            />
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-[11.5px] font-semibold uppercase tracking-caps text-muted">Start from</span>
            <div role="radiogroup" aria-label="Start from" className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {([
                ["data", "Your data", "Pick sources the same way as on Home. Add blocks yourself or ask AI.", <DatabaseIcon key="d" size={16} />],
                ["merge", "Merge existing dashboards", "Combine two or more into one. Each keeps its own pages.", <MergeIcon key="m" size={16} />],
              ] as [Start, string, string, JSX.Element][]).map(([k, title, text, icon]) => {
                const on = start === k;
                return (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setStart(k)}
                    data-start-from={k}
                    className={cn(
                      "ui-focus flex gap-3 rounded-[12px] border p-3.5 text-left transition-colors",
                      on ? (k === "data" ? "border-brand-ink bg-tint" : "border-kind-dashboard bg-kind-dashboard-fill") : "border-border bg-base hover:border-border-strong"
                    )}
                  >
                    <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-[10px]", k === "data" ? "bg-tint text-brand-ink" : "bg-kind-dashboard-fill text-kind-dashboard")}>{icon}</span>
                    <span className="flex flex-col gap-0.5"><b className="text-ui text-text">{title}</b><span className="text-caption leading-snug text-secondary">{text}</span></span>
                  </button>
                );
              })}
            </div>
          </div>

          {start === "data" ? (
            <div className="flex flex-col gap-2" data-new-dash-data="">
              <span className="text-[11.5px] font-semibold uppercase tracking-caps text-muted">Data</span>
              <div className="flex flex-wrap items-center gap-2.5">
                <ScopePicker scope={scope} onChange={setScope} sources={sources} spaces={spaces} variant="composer" disabled={busy} />
                {chosen.length > 0 && !tooMany && (
                  <span className="text-caption text-muted" data-new-dash-pages="">
                    {chosen.length === 1 ? `One page on ${chosen[0].name}` : `${chosen.length} pages - one per source${mixed ? " · Live + file" : ""}`}
                  </span>
                )}
              </div>
              {chosen.length === 0 && sources !== null && (
                <p className="m-0 text-caption text-muted">{sources.length ? "Pick at least one source." : "No sources connected yet - connect one on Data first."}</p>
              )}
              {tooMany && (
                <p className="m-0 inline-flex items-center gap-1.5 text-caption text-warning"><WarningIcon size={13} /> {chosen.length} sources would be {chosen.length} pages - pick up to {MAX_SOURCES}, or merge dashboards instead.</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2" data-new-dash-merge="">
              <span className="text-[11.5px] font-semibold uppercase tracking-caps text-muted">Choose dashboards{picked.length ? ` · ${picked.length} selected` : ""}</span>
              <DashboardChecklist value={picked} onChange={setPicked} />
              {picked.length >= 2 && (
                <div className="flex flex-col gap-1.5 rounded-[12px] border border-kind-dashboard-border bg-kind-dashboard-fill/60 px-3.5 py-3 text-caption text-secondary">
                  <b className="text-[11px] uppercase tracking-caps text-kind-dashboard">What you get</b>
                  <span>One dashboard with every page of the {picked.length} you picked, in that order. Each page keeps reading its own source; filters on the same column become one shared filter.</span>
                  <label className="inline-flex items-center gap-2 text-text">
                    <input type="checkbox" checked={keepOriginals} onChange={(e) => setKeepOriginals(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--color-kind-dashboard))]" data-keep-originals="" />
                    Keep the originals (recommended)
                  </label>
                </div>
              )}
              {picked.length === 1 && <p className="m-0 text-caption text-muted">Pick one more to merge.</p>}
            </div>
          )}

          {error && (
            <div role="alert" className="flex items-start gap-1.5 rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-caption text-danger">
              <WarningIcon size={13} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
          <span className="text-caption text-muted">Only you · share it any time</span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={create} loading={busy} disabled={!canCreate} data-new-dash-create="">
              {start === "merge" ? "Merge into one dashboard" : "Create dashboard"}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// 2026-10-09 (round 15): the Spaces tab - a card per Space (its sources,
// freshness, what is built on it, Ask / Open), starter Spaces when there are
// none, and "Every source, and the Spaces it is in" with bulk add.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import BrandTile from "../components/BrandTile";
import type { DataSourceSummary } from "../api/client";
import { Space, spacesApi } from "../api/spaces";
import { connectionKindMeta } from "../components/DataSourceForm";
import {
  BulkAddBar, chipClass, errorText, ErrorNote, FreshDot, Freshness, Skeleton, sourceFreshness, SpaceTag, spacesBySource,
} from "./shared";

const STARTERS: { name: string; color: string; d: string }[] = [
  { name: "Marketing & Brand", color: "#C9A7FF", d: "Social pages, ads, web and search" },
  { name: "Sales", color: "#43E5A0", d: "Store, marketplaces, payments, CRM" },
  { name: "Finance", color: "#F2B84B", d: "Books, payouts and revenue" },
  { name: "HR & People", color: "#FF8FA3", d: "Headcount, hiring, payroll" },
  { name: "Product & Testing", color: "#7AA7FF", d: "App data, experiments, tickets" },
];

function accessText(s: Space): string {
  if (s.access === "private") return "Only me";
  if (s.access === "workspace") return "Everyone in this workspace";
  const n = s.member_ids?.length || 0;
  return `${n} ${n === 1 ? "person" : "people"}`;
}

function LockGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="2.5" y="5.5" width="7" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function PencilGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function spaceFresh(s: Space): Freshness {
  const tone = s.fresh?.status === "ok" ? "good" : s.fresh?.status === "warning" ? "warning" : "info";
  return { text: s.fresh?.text || (s.stats.sources ? "" : "No sources yet"), tone: s.stats.sources ? tone : "muted" };
}

function SpaceCard({ s, onEdit }: { s: Space; onEdit: () => void }) {
  const navigate = useNavigate();
  const stats: [number, string, string][] = [
    [s.stats.sources, "source", "sources"],
    [s.stats.projects, "project", "projects"],
    [s.stats.dashboards, "dashboard", "dashboards"],
  ];
  const fresh = spaceFresh(s);
  return (
    <article className="border border-border rounded-[18px] bg-surface p-5 flex flex-col gap-4 min-w-0" aria-label={s.name}>
      <div className="flex justify-between gap-3 items-start">
        <div className="flex gap-3 items-start min-w-0">
          <span className="w-10 h-10 rounded-[12px] grid place-items-center shrink-0" style={{ background: `${s.color}26` }} aria-hidden="true">
            <span className="w-3.5 h-3.5 rounded-[4px]" style={{ background: s.color }} />
          </span>
          <span className="flex flex-col gap-1 min-w-0">
            <span className="text-[17px] font-semibold tracking-[-0.01em] text-text leading-snug">{s.name}</span>
            {s.description && <span className="text-[12.5px] text-secondary line-clamp-2">{s.description}</span>}
            <span className="inline-flex self-start items-center gap-1.5 h-6 px-2 mt-0.5 rounded-[7px] bg-surface2 text-secondary text-[12px] whitespace-nowrap">
              <LockGlyph />
              {accessText(s)}
            </span>
          </span>
        </div>
        {s.can_edit && (
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${s.name}`}
            className="ui-focus w-8 h-8 shrink-0 rounded-[9px] grid place-items-center text-muted hover:text-text hover:bg-surface2"
          >
            <PencilGlyph />
          </button>
        )}
      </div>
      <div className="flex justify-between items-center gap-3 flex-wrap">
        <div className="flex items-center min-w-0">
          {s.sources.slice(0, 6).map((src) => (
            <span key={src.id} title={src.name} className="-mr-1.5 rounded-[8px] shadow-[0_0_0_2px_rgb(var(--color-surface))]">
              <BrandTile kind={src.kind} name={src.name} size={28} />
            </span>
          ))}
          <span className={`${s.sources.length ? "ml-3.5" : ""} text-[13px] text-secondary`}>
            {s.stats.sources} {s.stats.sources === 1 ? "source" : "sources"}
            {s.sources.length > 6 ? ` · +${s.sources.length - 6} more` : ""}
          </span>
        </div>
        {fresh.text && <FreshDot f={fresh} className="text-[12.5px]" />}
      </div>
      <div className="grid grid-cols-3 gap-2 p-3 rounded-[12px] bg-base border border-border">
        {stats.map(([v, one, many]) => (
          <span key={many} className="flex flex-col gap-0.5">
            <span className="font-mono text-[16px] text-text">{v}</span>
            <span className="text-[11.5px] text-muted">{v === 1 ? one : many}</span>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <button type="button" className="btn-secondary flex-1 h-10 text-[14px] px-2" onClick={() => navigate(`/?space=${encodeURIComponent(s.id)}`)}>
          Ask this Space
        </button>
        <button type="button" className="btn-secondary flex-1 h-10 text-[14px] px-2" onClick={() => navigate(`/spaces/${encodeURIComponent(s.id)}`)} aria-label={`Open ${s.name}`}>
          Open
        </button>
      </div>
    </article>
  );
}

export function SourceSpaceTable({
  sources,
  spaces,
  canAssign,
  onSpaceUpdated,
}: {
  sources: DataSourceSummary[] | null;
  spaces: Space[] | null;
  canAssign: boolean;
  onSpaceUpdated: (s: Space) => void;
}) {
  const navigate = useNavigate();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const bySource = useMemo(() => spacesBySource(spaces), [spaces]);
  const rows = sources || [];
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.id));

  const add = async (space: Space) => {
    const ids = Array.from(sel);
    setBusy(true);
    setMsg(null);
    try {
      const out = await spacesApi.assign(space.id, ids);
      onSpaceUpdated(out);
      setSel(new Set());
      setMsg({ ok: true, text: `Added ${ids.length} ${ids.length === 1 ? "source" : "sources"} to ${space.name}.` });
    } catch (e: any) {
      setMsg({ ok: false, text: errorText(e, `Couldn't add those to ${space.name}. Please try again.`) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="every-source">
      <div className="flex justify-between items-center gap-3 flex-wrap min-h-[44px]">
        <h2 id="every-source" className="m-0 text-[18px] font-semibold text-text">Every source, and the Spaces it is in</h2>
        {canAssign && sel.size > 0 && (
          <BulkAddBar count={sel.size} spaces={spaces || []} busy={busy} onAdd={add} onClear={() => setSel(new Set())} />
        )}
      </div>
      {msg && (
        <div role="status" className={`text-[13px] ${msg.ok ? "text-good" : "text-danger"}`}>
          {msg.text}
        </div>
      )}
      {sources === null ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-6 rounded-[16px] border border-dashed border-border-strong text-[14px] text-secondary">
          No sources in this workspace yet. Connect one from the Catalog and it shows up here.
        </div>
      ) : (
        <div className="overflow-x-auto border border-border rounded-[16px] bg-surface">
          <table className="w-full border-collapse min-w-[640px]">
            <thead>
              <tr>
                {canAssign && (
                  <th className="w-9 px-3.5 py-2.5 border-b border-border text-left">
                    <input
                      type="checkbox"
                      aria-label="Select every source"
                      className="w-4 h-4"
                      checked={allOn}
                      onChange={() => setSel(allOn ? new Set() : new Set(rows.map((r) => r.id)))}
                    />
                  </th>
                )}
                {["Source", "Kind", "Spaces", "Freshness"].map((h) => (
                  <th key={h} className="font-medium text-[12px] text-muted text-left px-3.5 py-2.5 border-b border-border whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const on = sel.has(r.id);
                const tags = bySource.get(r.id) || [];
                return (
                  <tr key={r.id} className={on ? "bg-primary/5" : ""}>
                    {canAssign && (
                      <td className="px-3.5 py-3 border-b border-border/60">
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.name}`}
                          className="w-4 h-4"
                          checked={on}
                          onChange={() =>
                            setSel((p) => {
                              const next = new Set(p);
                              if (next.has(r.id)) next.delete(r.id);
                              else next.add(r.id);
                              return next;
                            })
                          }
                        />
                      </td>
                    )}
                    <td className="px-3.5 py-3 border-b border-border/60 text-[13.5px]">
                      <button type="button" onClick={() => navigate(`/workspace/${r.id}`)} className="ui-focus flex items-center gap-2.5 text-left font-medium text-text hover:underline">
                        <BrandTile kind={r.kind} name={r.name} size={28} />
                        <span className="truncate max-w-[220px]">{r.name}</span>
                      </button>
                    </td>
                    <td className="px-3.5 py-3 border-b border-border/60 text-[13.5px] text-secondary whitespace-nowrap">{connectionKindMeta(r.kind).label}</td>
                    <td className="px-3.5 py-3 border-b border-border/60">
                      {tags.length ? (
                        <span className="flex gap-1.5 flex-wrap">
                          {tags.map((t) => (
                            <SpaceTag key={t.id} space={t} />
                          ))}
                        </span>
                      ) : (
                        <span className="text-[12.5px] text-muted">None yet</span>
                      )}
                    </td>
                    <td className="px-3.5 py-3 border-b border-border/60 whitespace-nowrap">
                      <FreshDot f={sourceFreshness(r)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function SpacesPanel({
  spaces,
  spacesError,
  sources,
  workspaceId,
  canManage,
  onRetry,
  onNew,
  onEdit,
  onSpaceUpdated,
}: {
  spaces: Space[] | null;
  spacesError: string;
  sources: DataSourceSummary[] | null;
  workspaceId?: string | null;
  canManage: boolean;
  onRetry: () => void;
  onNew: () => void;
  onEdit: (s: Space) => void;
  onSpaceUpdated: (s: Space) => void;
}) {
  const [creating, setCreating] = useState<string | null>(null);
  const [starterError, setStarterError] = useState("");

  const createStarter = async (name: string) => {
    setCreating(name);
    setStarterError("");
    try {
      const out = await spacesApi.create({ name, workspace_id: workspaceId || null });
      onSpaceUpdated(out);
    } catch (e: any) {
      setStarterError(errorText(e, `Couldn't create ${name}. Please try again.`));
    } finally {
      setCreating(null);
    }
  };

  const existingNames = new Set((spaces || []).map((s) => s.name.toLowerCase()));
  const starters = STARTERS.filter((s) => !existingNames.has(s.name.toLowerCase()));

  return (
    <div className="flex flex-col gap-[26px]">
      {spacesError && (
        <ErrorNote className="flex items-center justify-between gap-3 flex-wrap">
          <span>{spacesError}</span>
          <button type="button" className="btn-secondary text-sm" onClick={onRetry}>
            Try again
          </button>
        </ErrorNote>
      )}

      {spaces === null && !spacesError && (
        <div className="grid gap-3.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(330px, 100%), 1fr))" }} aria-busy="true" aria-label="Loading Spaces">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[268px] rounded-[18px]" />
          ))}
        </div>
      )}

      {spaces && spaces.length === 0 && (
        <div className="rounded-[18px] border border-dashed border-border-strong p-6 flex flex-col gap-4">
          <div className="text-section font-semibold text-text">No Spaces yet</div>
          <p className="m-0 text-ui text-secondary max-w-[62ch] leading-relaxed">
            {canManage
              ? "Group the sources each team works from — then ask a Space a question, give it dashboards, and decide who sees it. Start with one of these, or make your own:"
              : "No Spaces have been shared with you in this workspace yet."}
          </p>
          {canManage && (
            <div className="flex gap-2 flex-wrap">
              {STARTERS.map((s) => (
                <button key={s.name} type="button" disabled={!!creating} onClick={() => createStarter(s.name)} className={chipClass(false, "disabled:opacity-50")} title={s.d}>
                  <span className="w-2 h-2 rounded-[3px]" style={{ background: s.color }} aria-hidden="true" />
                  {creating === s.name ? `Creating ${s.name}…` : `+ ${s.name}`}
                </button>
              ))}
              <button type="button" className={chipClass(false)} onClick={onNew} disabled={!!creating}>
                + Your own
              </button>
            </div>
          )}
          {starterError && <ErrorNote>{starterError}</ErrorNote>}
        </div>
      )}

      {spaces && spaces.length > 0 && (
        <>
          <div className="grid gap-3.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(330px, 100%), 1fr))" }}>
            {spaces.map((s) => (
              <SpaceCard key={s.id} s={s} onEdit={() => onEdit(s)} />
            ))}
          </div>
          {canManage && starters.length > 0 && spaces.length < 3 && (
            <div className="flex gap-2 flex-wrap items-center">
              <span className="text-[13px] text-muted">More starters:</span>
              {starters.map((s) => (
                <button key={s.name} type="button" disabled={!!creating} onClick={() => createStarter(s.name)} className={chipClass(false, "disabled:opacity-50")} title={s.d}>
                  <span className="w-2 h-2 rounded-[3px]" style={{ background: s.color }} aria-hidden="true" />
                  {creating === s.name ? `Creating ${s.name}…` : `+ ${s.name}`}
                </button>
              ))}
              {starterError && <ErrorNote className="w-full">{starterError}</ErrorNote>}
            </div>
          )}
        </>
      )}

      <SourceSpaceTable sources={sources} spaces={spaces} canAssign={canManage} onSpaceUpdated={onSpaceUpdated} />
    </div>
  );
}

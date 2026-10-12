// 2026-10-12 (round 35): how fresh a dashboard's numbers are, and the one way to refresh them.
//
//   live   - a warehouse, database, Google Sheets, a synced app or a stream: the numbers can move,
//            so it says when they were computed and offers Refresh.
//   file   - an uploaded CSV / Excel / JSON / Parquet: a fixed copy - nothing to refresh until a new
//            version is uploaded, so there is no button, only "as of" the upload.
//   mixed  - both: Refresh is offered (it updates the live part; the file stays as it is).
//
// The pill opens a small panel with the detail an enterprise reader asks for: which source, the
// exact time, where it was computed, and what Refresh will do.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { RefreshInterval } from "../api/client";
import { Popover, ProviderBadge, RefreshIcon, cn, providerDisplayName } from "../ui";

// 2026-10-12 (round 35b): auto-refresh, set in the same panel. Real-time re-runs every minute only
// while the dashboard is open; the others run on the server and keep its snapshot fresh.
export const AUTO_OPTIONS: { value: RefreshInterval; label: string; hint: string; perDay: number | null }[] = [
  { value: "off", label: "Off", hint: "Refresh by hand", perDay: 0 },
  { value: "realtime", label: "Real-time", hint: "Every minute, only while someone has it open", perDay: null },
  { value: "5m", label: "Every 5 minutes", hint: "", perDay: 288 },
  { value: "15m", label: "Every 15 minutes", hint: "Good for sales and operations", perDay: 96 },
  { value: "30m", label: "Every 30 minutes", hint: "", perDay: 48 },
  { value: "1h", label: "Every hour", hint: "", perDay: 24 },
  { value: "6h", label: "Every 6 hours", hint: "", perDay: 4 },
  { value: "daily", label: "Once a day", hint: "24 hours after you set it", perDay: 1 },
];
const AUTO_SHORT: Record<string, string> = { realtime: "real-time", "5m": "auto every 5 min", "15m": "auto every 15 min", "30m": "auto every 30 min", "1h": "auto hourly", "6h": "auto every 6 h", daily: "auto daily" };

function bytesText(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export type FreshnessSchedule = {
  interval: RefreshInterval;
  canEdit: boolean;
  onChange?: (i: RefreshInterval) => void;
  saving?: boolean;
  nextAt?: string | null;
  paused?: boolean;
  // what one refresh costs, from the blocks' last runs (warehouse only)
  bytesPerRefresh?: number | null;
  queriesPerRefresh?: number | null;
};

export type DataMode = "live" | "file" | "mixed";

const UPLOAD_KINDS = new Set(["csv", "tsv", "excel", "xlsx", "xls", "json", "parquet", "file", "upload"]);

export function isLiveKind(kind: string | null | undefined): boolean {
  const k = (kind || "").toLowerCase().trim();
  return Boolean(k) && !UPLOAD_KINDS.has(k);
}

export function dataModeOf(kinds: (string | null | undefined)[]): DataMode | null {
  const ks = kinds.filter(Boolean) as string[];
  if (!ks.length) return null;
  const live = ks.some(isLiveKind);
  const file = ks.some((k) => !isLiveKind(k));
  return live && file ? "mixed" : live ? "live" : "file";
}

const MODE_LABEL: Record<DataMode, string> = { live: "Live", file: "Uploaded file", mixed: "Live + file" };

/** "just now", "3 min ago", "2 h ago", then "12 Oct, 3:32 PM". */
export function asOfText(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function fullTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? null : t.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export type DataFreshnessProps = {
  mode: DataMode | null;
  // round 37: a synced app (GA4, Shopify...) - its numbers are as of its last sync, not "live"
  sources: { name: string | null; kind: string | null; synced?: boolean; syncedAt?: string | null }[];
  asOf: string | null;
  // A run in flight: "Updating…" in place of the time (the page keeps its numbers)
  working: boolean;
  onRefresh?: () => void;
  // Why Refresh isn't offered to this viewer (e.g. view-only on a file-backed live source)
  refreshNote?: string | null;
  computedIn?: string | null;
  durationMs?: number | null;
  fromSnapshot?: boolean;
  error?: string | null;
  className?: string;
  // "sm": inline under a dashboard's name; "md": a toolbar control
  size?: "sm" | "md";
  schedule?: FreshnessSchedule | null;
};

export function DataFreshness({ mode, sources, asOf, working, onRefresh, refreshNote, computedIn, durationMs, fromSnapshot, error, className, size = "md", schedule = null }: DataFreshnessProps) {
  const sm = size === "sm";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);
  if (!mode) return null;
  const live = mode !== "file";
  const named = sources.filter((s) => s.name || s.kind);
  const synced = named.length > 0 && named.every((s) => s.synced);
  const syncedAt = synced ? named.map((s) => s.syncedAt).filter(Boolean).sort()[0] || null : null;
  const when = asOfText(asOf, now);
  const syncedWhen = asOfText(syncedAt, now);
  const auto = mode !== "file" && schedule && schedule.interval !== "off" ? (schedule.paused ? "auto-refresh paused" : AUTO_SHORT[schedule.interval]) : null;
  const label = working ? "Updating…" : synced ? (syncedWhen || "not yet")
    : mode === "file" ? (when ? `as of ${when}` : "fixed copy") : [auto, when ? `updated ${when}` : "not run yet"].filter(Boolean).join(" · ");
  const opt = schedule ? AUTO_OPTIONS.find((o) => o.value === schedule.interval) : null;
  const dot = working ? (
    <span className="ui-spinner !h-3 !w-3 !border-[1.5px]" aria-hidden="true" />
  ) : (
    <span aria-hidden="true" className={cn("relative inline-flex h-2 w-2 shrink-0 rounded-full", error ? "bg-warning" : live ? "bg-good" : "bg-muted")}>
      {live && !synced && !error && <span className="absolute inset-0 animate-ping rounded-full bg-good opacity-40 motion-reduce:hidden" />}
    </span>
  );
  const canRefresh = live && Boolean(onRefresh);
  return (
    <div className={cn("inline-flex items-stretch overflow-hidden rounded-ctl border border-border bg-surface print:hidden", sm ? "h-7" : "h-9", className)} data-freshness={mode} data-freshness-working={working ? "" : undefined}>
      <Popover
        align={sm ? "start" : "end"}
        width={300}
        portal
        ariaLabel="About this data"
        trigger={(api) => (
          <button
            type="button"
            {...api.props}
            data-freshness-pill=""
            className={cn("ui-focus inline-flex items-center gap-2 text-secondary hover:bg-subtle hover:text-text", sm ? "px-2.5 text-caption" : "px-3 text-ui")}
            title={fullTime(asOf) ? `Numbers as of ${fullTime(asOf)}` : undefined}
          >
            {dot}
            <span className="font-medium text-text">{synced ? "Synced" : MODE_LABEL[mode]}</span>
            <span className="hidden text-muted sm:inline" data-freshness-label="">· {label}</span>
          </button>
        )}
      >
        {() => (
          <div className="flex flex-col gap-3 p-3.5 text-ui" data-freshness-panel="">
            <div className="flex items-center gap-2">
              {dot}
              <span className="font-semibold text-text">{synced ? "Synced from the app" : mode === "live" ? "Live data" : mode === "file" ? "Uploaded file" : "Live data + an uploaded file"}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {sources.filter((s) => s.name || s.kind).map((s, i) => (
                <div key={i} className="flex min-w-0 items-center gap-2 text-caption">
                  {s.kind && <ProviderBadge provider={s.kind} />}
                  <span className="truncate text-secondary" title={s.name || undefined}>{s.name || providerDisplayName(s.kind)}</span>
                  <span className="ml-auto shrink-0 text-faint">{s.synced ? "synced" : isLiveKind(s.kind) ? "live" : "file"}</span>
                </div>
              ))}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-caption">
              {synced && (
                <>
                  <dt className="text-muted">Last sync</dt>
                  <dd className="text-text tabular-nums" data-freshness-synced="">{fullTime(syncedAt) || "not yet"}</dd>
                </>
              )}
              <dt className="text-muted">{synced ? "Computed" : "Numbers as of"}</dt>
              <dd className="text-text tabular-nums" data-freshness-asof="">{working ? "updating now…" : fullTime(asOf) || "—"}</dd>
              {live && schedule && schedule.interval !== "off" && schedule.interval !== "realtime" && (
                <>
                  <dt className="text-muted">Next refresh</dt>
                  <dd className="text-text tabular-nums" data-freshness-next="">{schedule.paused ? "paused - opening it resumes" : fullTime(schedule.nextAt) || "—"}</dd>
                </>
              )}
              {computedIn && live && (
                <>
                  <dt className="text-muted">Computed in</dt>
                  <dd className="text-text">{providerDisplayName(computedIn)}{typeof durationMs === "number" && durationMs >= 100 ? ` · ${(durationMs / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s` : ""}</dd>
                </>
              )}
            </dl>
            {error && <div className="rounded-ctl border border-warning-border bg-warning-fill px-2.5 py-2 text-caption text-warning">{error}</div>}
            {live && schedule && (
              <div className="flex flex-col gap-1.5" data-auto-refresh="">
                <span className="text-[11px] font-semibold uppercase tracking-caps text-muted">Auto-refresh</span>
                <div role="radiogroup" aria-label="Auto-refresh" className="flex max-h-[260px] flex-col overflow-y-auto rounded-ctl border border-border">
                  {AUTO_OPTIONS.map((o) => {
                    const on = schedule.interval === o.value;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        disabled={!schedule.canEdit || schedule.saving}
                        onClick={() => schedule.onChange?.(o.value)}
                        data-auto-option={o.value}
                        className={cn("ui-focus-inset flex items-center gap-2.5 border-b border-border px-2.5 py-2 text-left last:border-b-0 disabled:cursor-default", on ? "bg-tint" : "hover:bg-subtle")}
                      >
                        <span aria-hidden="true" className={cn("grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border", on ? "border-brand-ink" : "border-border-strong")}>
                          {on && <span className="h-1.5 w-1.5 rounded-full bg-brand-ink" />}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className={cn("text-caption", on ? "font-semibold text-text" : "text-text")}>{o.label}</span>
                          {o.hint && <span className="text-[11px] text-muted">{o.hint}</span>}
                        </span>
                        {o.perDay ? <span className="shrink-0 font-mono text-[10.5px] text-faint">{o.perDay}/day</span> : null}
                      </button>
                    );
                  })}
                </div>
                {opt && opt.perDay && schedule.bytesPerRefresh ? (
                  <p className="m-0 text-[11.5px] leading-relaxed text-muted" data-auto-cost="">
                    {opt.label} is about {opt.perDay} refresh{opt.perDay === 1 ? "" : "es"} a day{schedule.queriesPerRefresh ? ` (${schedule.queriesPerRefresh} queries each)` : ""}, ~{bytesText(schedule.bytesPerRefresh * opt.perDay)} scanned a day. It pauses on its own when nobody has opened the dashboard for 7 days.
                  </p>
                ) : opt && opt.value !== "off" ? (
                  <p className="m-0 text-[11.5px] leading-relaxed text-muted">{opt.value === "realtime" ? "Nothing runs while nobody has it open." : "It pauses on its own when nobody has opened the dashboard for 7 days."}</p>
                ) : null}
                {!schedule.canEdit && <p className="m-0 text-[11px] text-faint">Only people who can edit this dashboard can change it.</p>}
              </div>
            )}
            <p className="m-0 text-caption leading-relaxed text-muted">
              {mode === "file"
                ? "An uploaded file is a fixed copy - these numbers change only when a new version is uploaded."
                : mode === "mixed"
                ? "Refresh recomputes the live part. The uploaded file stays as it is until a new version is uploaded."
                : fromSnapshot
                ? "Opened on the last saved numbers so the page is instant; anything older than 15 minutes updates on its own."
                : "Recomputed from the source. Refresh to pull the very latest."}
            </p>
            {mode === "file" && (
              <Link to="/data" className="ui-focus w-fit rounded text-caption font-medium text-brand-ink hover:underline">Upload a new version on Data →</Link>
            )}
            {live && !canRefresh && refreshNote && <p className="m-0 text-caption text-faint">{refreshNote}</p>}
          </div>
        )}
      </Popover>
      {canRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={working}
          data-freshness-refresh=""
          title={mode === "mixed" ? "Refresh the live data (the uploaded file stays as it is)" : "Refresh the data now"}
          className={cn("ui-focus inline-flex items-center gap-1.5 border-l border-border font-medium text-text hover:bg-subtle disabled:cursor-default disabled:text-faint", sm ? "px-2.5 text-caption" : "px-3 text-ui")}
        >
          <RefreshIcon size={sm ? 12 : 14} className={working ? "animate-spin motion-reduce:animate-none" : undefined} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      )}
    </div>
  );
}

// 2026-10-09 (round 15): small pieces the Data page's panels share - the
// dialog/sheet shell (Escape, focus, backdrop), chip and pill styles, the
// freshness line for a source, and the "N selected · add to" bar.
import { ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { DataSourceSummary } from "../api/client";
import type { Space } from "../api/spaces";
import { dataSourceCategory } from "../components/DataSourceForm";
import { timeAgo } from "../project/format";

export function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  if (typeof d === "string" && d.trim()) return d;
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg);
  if (e?.code === "ECONNABORTED") return "That took too long to answer. Please try again.";
  if (e && !e.response) return "Couldn't reach GD360. Check your connection and try again.";
  return fallback;
}

export function chipClass(on: boolean, extra = ""): string {
  return `ui-focus inline-flex items-center gap-2 h-8 px-3 rounded-full border text-[13px] transition-colors ${
    on ? "border-primary/50 bg-primary/10 text-text" : "border-border bg-surface text-secondary hover:text-text hover:border-border-strong"
  } ${extra}`;
}

export function CloseGlyph({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function CloseButton({ onClick, label = "Close" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="ui-focus shrink-0 w-10 h-10 rounded-[10px] border border-border text-secondary hover:text-text hover:bg-surface2 grid place-items-center"
    >
      <CloseGlyph />
    </button>
  );
}

/** A dialog shell: a right-hand sheet or a centred modal, portalled to the
 *  body, closed by Escape or a click on the backdrop, focus moved in on open
 *  and handed back on close. */
export function Overlay({
  label,
  onClose,
  children,
  side = "center",
  z = "z-[60]",
  maxWidth = "max-w-[620px]",
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  side?: "right" | "center";
  z?: string;
  maxWidth?: string;
}) {
  const panel = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      try {
        before?.focus?.();
      } catch {
        /* element gone */
      }
    };
  }, []);
  const onBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };
  if (side === "right") {
    return createPortal(
      <div className={`fixed inset-0 ${z} flex justify-end bg-black/60`} onMouseDown={onBackdrop}>
        <section
          ref={panel}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          className={`w-full ${maxWidth} h-full overflow-y-auto overscroll-contain bg-base border-l border-border shadow-pop outline-none`}
        >
          {children}
        </section>
      </div>,
      document.body
    );
  }
  return createPortal(
    <div className={`fixed inset-0 ${z} flex items-start justify-center bg-black/60 px-4 py-6 sm:py-16 overflow-y-auto`} onMouseDown={onBackdrop}>
      <section
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`w-full ${maxWidth} rounded-[20px] border border-border bg-base shadow-pop outline-none`}
      >
        {children}
      </section>
    </div>,
    document.body
  );
}

export function ErrorNote({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div role="alert" className={`rounded-ctl border border-danger-border bg-danger-fill px-3.5 py-2.5 text-ui text-text ${className}`}>
      {children}
    </div>
  );
}

export type Freshness = { text: string; tone: "good" | "warning" | "muted" | "info" };

export function sourceFreshness(ds: DataSourceSummary): Freshness {
  const cat = dataSourceCategory(ds.kind);
  if (cat === "Apps") {
    if (ds.sync_error) return { text: "Last sync failed", tone: "warning" };
    if (ds.last_synced_at) return { text: `Synced ${timeAgo(ds.last_synced_at)}`, tone: "good" };
    return { text: "Not synced yet", tone: "info" };
  }
  if (cat === "Databases" || cat === "Warehouses") return { text: "Live", tone: "good" };
  if (ds.kind === "google_sheets" || ds.kind === "microsoft_excel") return { text: "Live", tone: "good" };
  if (ds.kind === "streaming") {
    return ds.last_event_at ? { text: `Last event ${timeAgo(ds.last_event_at)}`, tone: "good" } : { text: "Waiting for the first event", tone: "muted" };
  }
  if (ds.kind === "api") {
    return ds.api_last_refreshed_at ? { text: `Refreshed ${timeAgo(ds.api_last_refreshed_at)}`, tone: "good" } : { text: "Never refreshed", tone: "muted" };
  }
  return { text: `Uploaded ${timeAgo(ds.created_at)}`, tone: "muted" };
}

export function toneColor(tone: Freshness["tone"]): string {
  if (tone === "good") return "rgb(var(--color-good))";
  if (tone === "warning") return "rgb(var(--color-warning))";
  if (tone === "info") return "rgb(var(--auto-tell, 157 180 255))";
  return "rgb(var(--color-muted))";
}

export function FreshDot({ f, className = "" }: { f: Freshness; className?: string }) {
  const c = toneColor(f.tone);
  return (
    <span className={`inline-flex items-center gap-2 text-[13px] ${className}`} style={{ color: c }}>
      <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: c }} aria-hidden="true" />
      {f.text}
    </span>
  );
}

export function SpaceTag({ space }: { space: Pick<Space, "name" | "color"> }) {
  return (
    <span className="inline-flex items-center gap-1.5 h-6 px-2 rounded-[7px] bg-surface2 text-secondary text-[12px] whitespace-nowrap">
      <span className="w-[7px] h-[7px] rounded-[3px] shrink-0" style={{ background: space.color }} aria-hidden="true" />
      {space.name}
    </span>
  );
}

export function spacesBySource(spaces: Space[] | null): Map<string, Space[]> {
  const m = new Map<string, Space[]>();
  for (const s of spaces || []) {
    for (const id of s.source_ids || []) {
      const list = m.get(id) || [];
      list.push(s);
      m.set(id, list);
    }
  }
  return m;
}

/** "N selected · add to [Space] [Space]" - shown while sources are ticked. */
export function BulkAddBar({
  count,
  spaces,
  busy,
  onAdd,
  onClear,
}: {
  count: number;
  spaces: Space[];
  busy: boolean;
  onAdd: (space: Space) => void;
  onClear: () => void;
}) {
  const editable = spaces.filter((s) => s.can_edit);
  return (
    <div
      role="region"
      aria-label="Add the selected sources to a Space"
      className="flex gap-2 items-center flex-wrap py-1.5 pl-3.5 pr-1.5 rounded-[12px] bg-primary/10 border border-primary/30"
    >
      <span className="text-[13px] text-text">
        {count} selected · {editable.length ? "add to" : "no Space you can add to yet"}
      </span>
      {editable.map((s) => (
        <button key={s.id} type="button" disabled={busy} onClick={() => onAdd(s)} className={chipClass(false, "disabled:opacity-50")}>
          <span className="w-2 h-2 rounded-[3px]" style={{ background: s.color }} aria-hidden="true" />
          {s.name}
        </button>
      ))}
      <button type="button" onClick={onClear} className="ui-focus h-8 px-2.5 rounded-full text-[13px] text-muted hover:text-text">
        Clear
      </button>
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <span className={`block rounded-[10px] bg-surface2 animate-pulse ${className}`} aria-hidden="true" />;
}

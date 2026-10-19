// 2026-10-19 (R56, the Studio core pattern): every piece of work opens on one canvas - a header with the
// conversation's artifact tabs, a status line and ONE green button, a tools bar for that kind of work, then the body.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Ic } from "./icons";
import "./studio.css";

export type FrameTab = { key: string; icon: string; label: string; badge?: string | null; on: boolean; onClick: () => void };

/** A button that opens a small menu; closes on outside click or Escape. */
export function MenuButton({ label, icon, className = "sd-tool", children, align = "left", caret = true, title, data, shrink = false }: {
  label?: ReactNode; icon?: string; className?: string; children: (close: () => void) => ReactNode; align?: "left" | "right"; caret?: boolean; title?: string; data?: string;
  /** the button may shrink (a long title ellipsised) */
  shrink?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", off);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <span ref={ref} style={{ position: "relative", display: "inline-flex", flex: shrink ? "0 1 auto" : "0 0 auto", minWidth: shrink ? 0 : undefined }}>
      <button type="button" className={`${className}${open ? " on" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" title={title} data-sd-menu={data}>
        {icon && <Ic n={icon} />}{label}{caret && label ? <Ic n="down" className="cv" /> : null}
      </button>
      {open && (
        <div className="sd-menu" role="menu" style={{ top: "calc(100% + 6px)", [align]: 0 } as any}>
          {children(() => setOpen(false))}
        </div>
      )}
    </span>
  );
}

export function StudioFrame({ kind, tabs, addMenu, status, actions, tools, children, onClose, bodyClass, bodyStyle }: {
  kind: string; tabs: FrameTab[]; addMenu?: (close: () => void) => ReactNode; status?: ReactNode; actions?: ReactNode; tools?: ReactNode;
  children: ReactNode; onClose?: () => void; bodyClass?: string; bodyStyle?: React.CSSProperties;
}) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const onKey = tabs.find((t) => t.on)?.key;
  useEffect(() => {
    const el = tabsRef.current?.querySelector<HTMLElement>(".sd-at.on");
    const box = tabsRef.current;
    if (el && box) box.scrollLeft = Math.max(0, el.offsetLeft - box.clientWidth + el.offsetWidth + 8 > box.scrollLeft ? el.offsetLeft - box.clientWidth + el.offsetWidth + 8 : Math.min(box.scrollLeft, el.offsetLeft - 8));
  }, [onKey, tabs.length]);
  return (
    <aside className="sd sd-canvas" aria-label="Canvas" data-c2-canvas={kind} data-sd-canvas={kind}>
      <div className="sd-ch">
        <div className="sd-tabs" role="tablist" data-sd-tabs="" ref={tabsRef}>
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={t.on} className={`sd-at${t.on ? " on" : ""}`} onClick={t.onClick} title={t.label} data-sd-tab={t.key}>
              <Ic n={t.icon} /><span className="t">{t.label}</span>{t.badge ? <small>{t.badge}</small> : null}
            </button>
          ))}
        </div>
        {addMenu && <MenuButton className="sd-addt" icon="plus" caret={false} title="New on this canvas" data="add">{addMenu}</MenuButton>}
        <span className="sd-sp" />
        {status && <span className="sd-stat" data-sd-status="">{status}</span>}
        {actions}
        {onClose && <button type="button" className="sd-close" onClick={onClose} aria-label="Close canvas" title="Close"><Ic n="x" s={14} /></button>}
      </div>
      {tools && <div className="sd-tb" role="toolbar" data-sd-tools="">{tools}</div>}
      <div className={`sd-cb${bodyClass ? ` ${bodyClass}` : ""}`} style={bodyStyle} data-sd-body="">{children}</div>
    </aside>
  );
}

/** Relative time for status lines: "just now", "4 min ago", "09:12", "12 Oct". */
export function ago(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  const s = (Date.now() - d.getTime()) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 2) return "yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

export function saveBlob(name: string, text: string, type = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function toCsv(cols: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map(esc).join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

export const safeName = (s: string) => (s || "file").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "file";

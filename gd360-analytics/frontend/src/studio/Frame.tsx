// 2026-10-19 (R56, the Studio core pattern): every piece of work opens on one canvas - a header with the
// conversation's artifact tabs, a status line and ONE green button, a tools bar for that kind of work, then the body.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Ic } from "./icons";
import "./studio.css";

export type FrameTab = { key: string; icon: string; label: string; badge?: string | null; on: boolean; onClick: () => void };

/** A button that opens a small menu; closes on outside click or Escape.
 *  R67: the menu is drawn on document.body (a portal, fixed to the button) - inside the tools bar, which scrolls
 *  sideways on narrow canvases, an absolutely-placed menu was clipped to 46px and every menu looked dead. */
export function MenuButton({ label, icon, className = "sd-tool", children, align = "left", caret = true, title, data, shrink = false, width }: {
  label?: ReactNode; icon?: string; className?: string; children: (close: () => void) => ReactNode; align?: "left" | "right"; caret?: boolean; title?: string; data?: string;
  /** the button may shrink (a long title ellipsised) */
  shrink?: boolean;
  /** a wider panel (a form rather than a list) */
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number; maxH: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const place = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth;
    const top = r.bottom + 6;
    const maxH = Math.max(160, window.innerHeight - top - 12);
    if (align === "right") setPos({ top, right: Math.max(8, vw - r.right), maxH });
    else setPos({ top, left: Math.min(r.left, vw - (width || 240) - 8), maxH });
  };
  useLayoutEffect(() => { if (open) place(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menu.current?.contains(t)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const move = () => place();
    document.addEventListener("mousedown", off);
    document.addEventListener("keydown", esc);
    window.addEventListener("resize", move);
    window.addEventListener("scroll", move, true);
    return () => {
      document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc);
      window.removeEventListener("resize", move); window.removeEventListener("scroll", move, true);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span ref={ref} style={{ position: "relative", display: "inline-flex", flex: shrink ? "0 1 auto" : "0 0 auto", minWidth: shrink ? 0 : undefined }}>
      <button type="button" className={`${className}${open ? " on" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" title={title} data-sd-menu={data}>
        {icon && <Ic n={icon} />}{label}{caret && label ? <Ic n="down" className="cv" /> : null}
      </button>
      {open && pos && createPortal(
        <div ref={menu} className="sd sd-menu sd-menu-fixed" role="menu" data-sd-menu-panel={data}
          style={{ position: "fixed", top: pos.top, left: pos.left, right: pos.right, maxHeight: pos.maxH, overflowY: "auto", minWidth: width || undefined, width: width || undefined, zIndex: 1000 }}>
          {children(() => setOpen(false))}
        </div>, document.body)}
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

// 2026-10-19 (R56, list and admin boards: Workspace, Data, Pipelines, Models, Dashboard, Initiatives, Settings):
// one page frame - the rail, a quiet breadcrumb bar with the page's own actions, the main column and an optional
// panel on the right (the selected source, the decisions waiting for you).
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { useAuth } from "../api/AuthContext";
import { ThemeButton } from "../chat/Shell";
import "./studio.css";

export type Crumb = { label: string; to?: string };

export function ListPage({ crumbs, actions, side, children, narrow = false, data, mainClass }: {
  crumbs: Crumb[]; actions?: ReactNode; side?: ReactNode; children: ReactNode; narrow?: boolean; data?: string; mainClass?: string;
}) {
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const { user } = useAuth();
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const first = (user?.full_name || "").trim().split(" ")[0];
  const wsName = ws ? (ws.is_personal ? (first ? `${first}'s workspace` : "Personal workspace") : ws.name) : "Workspace";
  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="sdp" data-sd-page={data}>
        <header className="sdp-top" data-gx-top="">
          <button type="button" className="crumb sdp-ws" data-gx-menu-trigger="" data-gx-ws-crumb="" title="Switch or manage workspace"
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); window.dispatchEvent(new CustomEvent("gx:open-workspace-menu", { detail: { x: r.left, y: r.bottom + 8 } })); }}>
            {wsName}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span className="sl">/</span>
              {c.to && i < crumbs.length - 1 ? <Link className="crumb" to={c.to}>{c.label}</Link> : <span className={i === crumbs.length - 1 ? "cur" : "crumb"} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.label}</span>}
            </span>
          ))}
          <span className="sd-sp" />
          {actions}
          <ThemeButton />
        </header>
        <div className="sdp-body">
          <main className={`sdp-main${narrow ? " narrow" : ""}${mainClass ? ` ${mainClass}` : ""}`}>{children}</main>
          {side && <aside className="sdp-side">{side}</aside>}
        </div>
      </div>
    </div>
  );
}

export function PageHead({ title, sub, actions, chips }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; chips?: ReactNode }) {
  return (
    <div className="sdp-hd">
      <div style={{ minWidth: 0 }}>
        <h1>{title}{chips}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {actions && <div className="act">{actions}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; n?: number | null }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="sdp-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} className={`sdp-tab${value === t.id ? " on" : ""}`} onClick={() => onChange(t.id)} data-sdp-tab={t.id}>
          {t.label}{t.n != null && <small>{t.n.toLocaleString()}</small>}
        </button>
      ))}
    </div>
  );
}

export function Kpi({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: "bad" | "warn" | "good" }) {
  return (
    <div className="sd-kpi">
      <span className="sd-lbl">{label}</span>
      <span className="v" style={tone ? { color: `rgb(var(--sd-${tone}))` } : undefined}>{value}</span>
      {note && <span className="n">{note}</span>}
    </div>
  );
}

export function Proof({ text, tone }: { text: string; tone?: string }) {
  const dot = tone === "bad" ? "bad" : tone === "warn" ? "warn" : tone === "violet" ? "violet" : tone === "blue" ? "blue" : tone === "muted" ? "muted" : "good";
  return <span className="sd-chip"><span className={`sd-dot ${dot}`} />{text}</span>;
}

export function Status({ text, tone }: { text: string; tone?: string }) {
  if (tone === "muted" || !tone) return <span className="sd-chip">{text}</span>;
  const dot = tone === "bad" ? "bad" : tone === "warn" ? "warn" : tone === "blue" ? "blue" : "good";
  return <span className={`sd-chip ${tone === "bad" ? "bad" : tone === "warn" ? "warn" : tone === "good" ? "good" : ""}`} style={tone === "blue" ? { color: "rgb(var(--sd-c1))" } : undefined}><span className={`sd-dot ${dot}`} />{text}</span>;
}

export const fmtWhen = (iso?: string | null): string => {
  if (!iso) return "–";
  const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  const s = (Date.now() - d.getTime()) / 1000;
  if (!Number.isFinite(s)) return "–";
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 2) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
};

export const compact = (n?: number | null): string => {
  if (n == null) return "–";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)} B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e8 ? 0 : 1)} M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(0)} K`;
  return n.toLocaleString();
};

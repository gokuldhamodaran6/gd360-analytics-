// 2026-10-10 (Clarity Blueprint, Option 1 - one product, three intents):
// the three kinds of work in GD360 and how each one looks and is named,
// everywhere it appears. People never have to learn which engine made
// something - only these three words:
//
//   Answer    - a question asked on Home, answered across any sources
//               (pages/ProjectWorkspace.tsx, /p/:id). Brand green.
//   Analysis  - hands-on work on one table in Studio: chat, data, charts,
//               SQL (pages/Workspace.tsx, /workspace/:id). Blue.
//   Dashboard - the one kind of dashboard: filters, cross-filter, canvas,
//               publish (pages/DashboardBuilderView.tsx). Amber.
//
// Answers and analyses live in Library; dashboards live in Dashboards.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export type Kind = "answer" | "analysis" | "dashboard";

export const KIND_LABEL: Record<Kind, string> = { answer: "Answer", analysis: "Analysis", dashboard: "Dashboard" };

// Full class strings (never assembled) so Tailwind's scanner keeps them.
const PILL: Record<Kind, string> = {
  answer: "bg-kind-answer-fill text-kind-answer border-kind-answer-border",
  analysis: "bg-kind-analysis-fill text-kind-analysis border-kind-analysis-border",
  dashboard: "bg-kind-dashboard-fill text-kind-dashboard border-kind-dashboard-border",
};
const TEXT: Record<Kind, string> = { answer: "text-kind-answer", analysis: "text-kind-analysis", dashboard: "text-kind-dashboard" };

export function kindClasses(kind: Kind): string {
  return PILL[kind];
}

export function kindText(kind: Kind): string {
  return TEXT[kind];
}

/** A conversation row (GET /conversations) is an Answer or an Analysis. */
export function conversationKind(c: { kind?: string | null }): Kind {
  return c.kind === "project" ? "answer" : "analysis";
}

/** Where a Library item opens. */
export function conversationHref(c: { id: string; kind?: string | null; datasource_id?: string | null }): string | null {
  if (c.kind === "project") return `/p/${c.id}`;
  return c.datasource_id ? `/workspace/${c.datasource_id}?conversation=${c.id}` : null;
}

/** Where a dashboard opens, whatever its storage generation. */
export function dashboardHref(d: { id: string; layout_version?: number | null }): string {
  if (d.layout_version === 2) return `/dashboard-builder/${d.id}`;
  if (d.layout_version === 3) return `/project-dashboards/${d.id}`;
  return `/dashboards/${d.id}`;
}

/** Where a dashboard's "Made from ..." link opens. */
export function sourceHref(kind: string | null | undefined, id: string | null | undefined, datasourceId?: string | null): string | null {
  if (!id) return null;
  if (kind === "answer") return `/p/${id}`;
  if (kind === "analysis" && datasourceId) return `/workspace/${datasourceId}?conversation=${id}`;
  return null;
}

export function KindIcon({ kind, size = 16, className = "" }: { kind: Kind; size?: number; className?: string }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className,
  };
  if (kind === "answer") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
        <path d="M12 17h.01" />
      </svg>
    );
  }
  if (kind === "analysis") {
    return (
      <svg {...common}>
        <path d="M4 20h16" />
        <path d="M6 16l4-6 4 3 4-7" />
      </svg>
    );
  }
  return (
    <svg {...common} strokeWidth={1.9}>
      <rect x="3" y="3" width="7" height="9" rx="1.2" />
      <rect x="14" y="3" width="7" height="5" rx="1.2" />
      <rect x="14" y="12" width="7" height="9" rx="1.2" />
      <rect x="3" y="16" width="7" height="5" rx="1.2" />
    </svg>
  );
}

/** The small label every row and page header carries: "Answer", "Analysis", "Dashboard". */
export function KindPill({ kind, children, className = "" }: { kind: Kind; children?: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 h-[22px] px-2 rounded-full border text-[11.5px] font-semibold whitespace-nowrap ${PILL[kind]} ${className}`}
    >
      <KindIcon kind={kind} size={12} />
      {children ?? KIND_LABEL[kind]}
    </span>
  );
}

/** The square icon tile at the start of a list row. */
export function KindTile({ kind, size = 36 }: { kind: Kind; size?: number }) {
  return (
    <span
      className={`grid place-items-center shrink-0 rounded-[10px] border ${PILL[kind]}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <KindIcon kind={kind} size={Math.round(size * 0.46)} />
    </span>
  );
}

/** "Made from answer “…”" - the provenance link on every dashboard. */
export function MadeFromLink({
  kind, title, href, newTab = false,
}: { kind: "answer" | "analysis"; title: string; href: string; newTab?: boolean }) {
  return (
    <Link
      to={href}
      target={newTab ? "_blank" : undefined}
      rel={newTab ? "noopener noreferrer" : undefined}
      data-made-from=""
      className="ui-focus inline-flex max-w-full items-center gap-1.5 h-[26px] pl-1 pr-2.5 rounded-full border border-border bg-surface text-ui text-secondary hover:text-text hover:border-border-strong"
      title={`Open the ${KIND_LABEL[kind].toLowerCase()} this dashboard was made from`}
    >
      <KindPill kind={kind} className="h-[18px] px-1.5 text-[10.5px]">Made from {KIND_LABEL[kind].toLowerCase()}</KindPill>
      <span className="truncate">{title}</span>
    </Link>
  );
}

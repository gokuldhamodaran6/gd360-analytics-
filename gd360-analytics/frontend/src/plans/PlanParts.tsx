// 2026-10-17 (R52): the plans, drawn once - the public /pricing page and the in-app Plan & usage page use these parts,
// fed by the same catalog the app meters (GET /v2/plans, services/agent/plans.py). One catalog, so the two pages can
// never disagree. Styles in plans.css use --pl-* tokens: the app's own tokens in the app, the dark set on /pricing.
import type { ReactNode } from "react";
import type { PlanSummary } from "../api/v2";
import "./plans.css";

export type Catalog = PlanSummary["plans"];
export const PLAN_ORDER = ["free", "pro", "team", "enterprise"] as const;
export const PLAN_COPY: Record<string, { for: string; items: string[]; cta: string; href: string }> = {
  free: { for: "Individuals, students, anyone trying it.", items: ["Chat, charts, models, documents, voice", "Dashboards and alerts", "Answers with proof"], cta: "Start free", href: "/start?plan=free" },
  pro: { for: "Professionals and freelancers.", items: ["The strongest models", "Bigger files and more sources", "Publish under your own logo"], cta: "Start with Pro", href: "/start?plan=pro" },
  team: { for: "Teams, small business to mid-market.", items: ["Spaces, roles, shared library", "Column and row rules per team", "Warehouses and a custom domain"], cta: "Start a team", href: "/start?plan=team" },
  enterprise: { for: "Enterprises, public sector, regulated.", items: ["SSO, audit export, retention policy", "Our cloud, your cloud or your warehouse", "Roll-out by GD360, with an SLA"], cta: "Talk to us", href: "/pricing#enterprise" },
};

export function priceOf(p: { price: Record<string, any> }): { big: string; small: string } {
  const pr = p.price || {};
  if (pr.usd_month === 0) return { big: "$0", small: "forever" };
  if (typeof pr.usd_month === "number") return { big: `$${pr.usd_month}`, small: `a month${pr.inr_month ? ` · ₹${Number(pr.inr_month).toLocaleString("en-IN")} in India` : ""}` };
  if (typeof pr.usd_seat_month === "number") return { big: `$${pr.usd_seat_month}`, small: `a person a month · ${pr.min_seats || 3} people or more` };
  return { big: "Custom", small: "platform fee and people, yearly" };
}

const LIMIT_ROWS: [string, string][] = [
  ["seats", "People"], ["questions_per_day", "Questions a day"], ["sources", "Data sources"], ["rows_per_source", "Rows per source"],
  ["file_mb", "File size"], ["models_per_month", "Models a month"], ["dashboards", "Dashboards"], ["automations", "Alerts and automations"], ["spaces", "Spaces"],
];
export function limitText(key: string, v: number | null | undefined): string {
  if (v == null) return key === "questions_per_day" || key === "models_per_month" ? "Fair use" : "Unlimited";
  if (key === "file_mb") return v >= 1000 ? `${(v / 1000).toLocaleString("en-US")} GB` : `${v} MB`;
  if (key === "rows_per_source") return v >= 1_000_000 ? `${(v / 1_000_000).toLocaleString("en-US")} million` : `${(v / 1000).toLocaleString("en-US")} thousand`;
  return v.toLocaleString("en-US");
}

export function PlanCards({ plans, current, enforced, action }: {
  plans: Catalog; current?: string | null; enforced: boolean; action?: (key: string) => ReactNode;
}) {
  return (
    <div className="pl-cards" data-pl-cards="">
      {PLAN_ORDER.map((k) => {
        const p = plans[k];
        if (!p) return null;
        const c = PLAN_COPY[k];
        const pr = priceOf(p);
        const on = current === k;
        const hot = !current && k === "team";
        return (
          <div key={k} className={`pl-card${on ? " on" : ""}${hot ? " hot" : ""}`} data-pl-plan={k}>
            <div className="pl-card-top">
              <span className="pl-eb">{p.who}</span>
              {on && <span className="pl-badge" data-pl-current="">Your plan</span>}
              {hot && <span className="pl-badge">Most teams</span>}
            </div>
            <span className="pl-name">{p.label}</span>
            <span className="pl-price"><b>{pr.big}</b><span>{pr.small}</span></span>
            <span className="pl-for">{c.for}</span>
            <ul className="pl-items">{c.items.map((it) => <li key={it}>{it}</li>)}</ul>
            <span className="pl-limits">{limitText("questions_per_day", p.limits.questions_per_day)}{p.limits.questions_per_day ? " questions a day" : " questions"} · {p.limits.seats ? `${p.limits.seats} ${p.limits.seats === 1 ? "person" : "people"}` : "any number of people"}</span>
            {action && <div className="pl-act">{action(k)}</div>}
          </div>
        );
      })}
      {!enforced && <p className="pl-note" data-pl-early="">Early access: every account has the full product, free, and no limit is enforced. Prices apply at launch, and you hear first.</p>}
    </div>
  );
}

export function CompareTable({ plans, current }: { plans: Catalog; current?: string | null }) {
  const keys = PLAN_ORDER.filter((k) => plans[k]);
  return (
    <div className="pl-tablewrap" data-pl-compare="">
      <table className="pl-table">
        <thead>
          <tr><th scope="col"><span className="pl-sr">Limit</span></th>{keys.map((k) => <th key={k} scope="col" className={current === k ? "on" : undefined}>{plans[k].label}</th>)}</tr>
        </thead>
        <tbody>
          {LIMIT_ROWS.map(([key, label]) => (
            <tr key={key}><th scope="row">{label}</th>{keys.map((k) => <td key={k} className={current === k ? "on" : undefined}>{limitText(key, plans[k].limits[key])}</td>)}</tr>
          ))}
          <tr><th scope="row">Every feature</th>{keys.map((k) => <td key={k} className={current === k ? "on" : undefined}>✓</td>)}</tr>
        </tbody>
      </table>
    </div>
  );
}

export function Meters({ plan }: { plan: PlanSummary }) {
  return (
    <div className="pl-meters" data-pl-meters="">
      {plan.meters.map((m) => {
        const pct = m.limit ? Math.min(100, (100 * m.used) / m.limit) : 0;
        return (
          <div key={m.key} className={`pl-meter${m.over ? " over" : m.near ? " near" : ""}`} data-pl-meter={m.key}>
            <span className="k">{m.label.charAt(0).toUpperCase() + m.label.slice(1)}</span>
            <span className="v">{m.used.toLocaleString("en-US")}<span>{m.limit ? ` of ${m.limit.toLocaleString("en-US")}` : " · no limit"}</span></span>
            <span className="bar" aria-hidden="true"><i style={{ width: m.limit ? `${pct}%` : "0%" }} /></span>
          </div>
        );
      })}
    </div>
  );
}

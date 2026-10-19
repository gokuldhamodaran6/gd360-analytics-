// 2026-10-19 (R56, website board "Pricing"): the plans read from the server (/v2/plans), the same table the app's
// meters use, so the page never says something the product does not do. While early access lasts every feature is
// open on every plan and limits are not enforced - the page says so instead of hiding it.
import { useEffect, useState } from "react";
import { v2Api } from "../../api/v2";
import { A, useMarketingPage } from "../shared";
import { SITE } from "../site";
import { Site } from "./chrome";

type Plans = Awaited<ReturnType<typeof v2Api.publicPlans>>;
const ORDER = ["free", "pro", "team", "enterprise"] as const;
const LIMITS: [string, string, (v: number) => string][] = [
  ["seats", "People", (v) => v.toLocaleString()],
  ["sources", "Sources", (v) => v.toLocaleString()],
  ["rows_per_source", "Rows per source", (v) => (v >= 1e6 ? `${v / 1e6}M` : `${v / 1e3}k`)],
  ["file_mb", "File size", (v) => (v >= 1000 ? `${v / 1000} GB` : `${v} MB`)],
  ["questions_per_day", "Questions a day", (v) => v.toLocaleString()],
  ["models_per_month", "Models a month", (v) => v.toLocaleString()],
  ["dashboards", "Dashboards", (v) => v.toLocaleString()],
  ["automations", "Pipelines and alerts", (v) => v.toLocaleString()],
];

function price(id: string, p: Plans["plans"][string], cur: "usd" | "inr", seats: number) {
  const pr = p.price || {};
  if (id === "enterprise") return { big: "Custom", per: "A yearly platform fee, set with you" };
  if (id === "team") {
    const n = Math.max(seats, pr.min_seats || 3);
    return { big: `$${pr.usd_seat_month}`, per: `per person a month, at least ${pr.min_seats || 3} · ${n} people = $${(n * pr.usd_seat_month).toLocaleString()} a month` };
  }
  const v = cur === "inr" ? pr.inr_month : pr.usd_month;
  if (!v) return { big: cur === "inr" ? "₹0" : "$0", per: "Free, for good" };
  return { big: cur === "inr" ? `₹${Number(v).toLocaleString("en-IN")}` : `$${v}`, per: "a month, one person" };
}

const FEATURES: Record<string, string[]> = {
  free: ["Answers with every step shown", "Dashboards, reports and predictions", "Standard AI model", "Community help"],
  pro: ["Everything in Free", "No limit on questions, models or dashboards", "Bigger sources and files", "Strongest AI model", "Email help within a day"],
  team: ["Everything in Pro", "Shared spaces, roles and access rules", "Audit log and required two-step sign-in", "Chat help within 4 hours"],
  enterprise: ["Everything in Team", "Use your own AI keys", "Help setting up and a success manager", "Agreed service levels"],
};

export default function Pricing2() {
  useMarketingPage("GD360 — pricing");
  const [plans, setPlans] = useState<Plans | null>(null);
  const [err, setErr] = useState(false);
  const [cur, setCur] = useState<"usd" | "inr">("usd");
  const [seats, setSeats] = useState(5);
  useEffect(() => { v2Api.publicPlans().then(setPlans).catch(() => setErr(true)); }, []);
  const mail = SITE.helloEmail;
  return (
    <Site data="pricing">
      <section className="mk2-wrap mk2-hero" style={{ paddingBottom: 0 }}>
        <span className="mk2-badge"><i />Early access</span>
        <h1 style={{ fontSize: "clamp(36px, 5vw, 56px)" }}>Simple plans. Every feature, on every plan.</h1>
        <p>{plans?.all_features
          ? "While GD360 is in early access every feature is open on every plan and the limits below are not enforced yet. We will tell you well before that changes."
          : "Pick the plan that fits how many people and how much data you have."}</p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", alignItems: "center", marginTop: 26, flexWrap: "wrap" }}>
          <div className="mk2-seg" role="group" aria-label="Currency">
            <button type="button" className={cur === "usd" ? "on" : ""} onClick={() => setCur("usd")}>US dollars</button>
            <button type="button" className={cur === "inr" ? "on" : ""} onClick={() => setCur("inr")}>Indian rupees</button>
          </div>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13.5, color: "var(--ink2)" }}>
            Team size
            <input type="number" min={1} max={500} value={seats} onChange={(e) => setSeats(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
              style={{ width: 70, height: 34, borderRadius: 9, border: "1px solid var(--line2)", padding: "0 10px", font: "inherit" }} data-mk2-seats="" />
          </label>
        </div>
        {err && <div className="mk2-err" style={{ maxWidth: 520, margin: "20px auto 0" }}>Couldn't load the plans just now. Refresh the page to try again.</div>}
        <div className="mk2-plans" data-mk2-plans="">
          {ORDER.map((id) => {
            const p = plans?.plans[id];
            if (!plans) return <div key={id} className="mk2-plan" style={{ minHeight: 380, background: "var(--panel)" }} />;
            if (!p) return null;
            const pr = price(id, p, cur, seats);
            const inrTeam = id === "team" && cur === "inr";
            return (
              <div key={id} className={`mk2-plan${id === "team" ? " pop" : ""}`} data-mk2-plan={id}>
                <span className="who">{p.who}</span>
                <h3>{p.label}</h3>
                <div className="price">{pr.big}</div>
                <div className="per">{pr.per}{inrTeam ? " (billed in US dollars)" : ""}</div>
                {id === "enterprise"
                  ? (mail ? <a className="mk2-btn sec" href={`mailto:${mail}?subject=GD360%20Enterprise`}>Talk to us</a> : <A className="mk2-btn sec" href="/about">Talk to us</A>)
                  : <A className={`mk2-btn ${id === "team" ? "pri" : "sec"}`} href={`/start?plan=${id}${id === "team" ? `&users=${Math.max(seats, 3)}` : ""}`}>{SITE.billingEnabled && id !== "free" ? `Choose ${p.label}` : "Start free"}</A>}
                <ul>{(FEATURES[id] || []).map((f) => <li key={f}>{f}</li>)}</ul>
              </div>
            );
          })}
        </div>
        {!SITE.billingEnabled && <div className="mk2-fine">Card payments are not switched on yet: nothing is charged today, whichever plan you pick.</div>}
      </section>

      <section className="mk2-wrap mk2-sec">
        <h2 style={{ fontSize: 28 }}>The limits, side by side</h2>
        <div style={{ overflowX: "auto", marginTop: 18 }}>
          <table className="mk2-table" data-mk2-limits="">
            <thead><tr><th>Limit</th>{ORDER.map((id) => <th key={id}>{plans?.plans[id]?.label || id}</th>)}</tr></thead>
            <tbody>
              {LIMITS.map(([k, label, fmt]) => (
                <tr key={k}><td>{label}</td>{ORDER.map((id) => {
                  const v = plans?.plans[id]?.limits?.[k];
                  return <td key={id} className="mono">{!plans ? "…" : v == null ? "No limit" : fmt(v)}</td>;
                })}</tr>
              ))}
              <tr><td>AI model</td>{ORDER.map((id) => <td key={id}>{(plans?.plans[id] as any)?.model_tier || "…"}</td>)}</tr>
              <tr><td>Help</td>{ORDER.map((id) => <td key={id}>{(plans?.plans[id] as any)?.support || "…"}</td>)}</tr>
            </tbody>
          </table>
        </div>
        <div className="mk2-faq">
          <div><h4>Is it really free right now?</h4><p>Yes. During early access every feature is open and nothing is charged. When paid plans start you choose one first; nothing moves on its own.</p></div>
          <div><h4>Do you change anything in my systems?</h4><p>No. Connections are read-only. Databases are queried where they are, and app data syncs into your workspace on a schedule you set.</p></div>
          <div><h4>What does Team add?</h4><p>Shared spaces with roles, access rules on rows and columns, an audit log, and required two-step sign-in for everyone.</p></div>
          <div><h4>Single sign-on?</h4><p>SAML single sign-on and SCIM are on the way and not available yet. Until then people sign in with email and two-step sign-in.</p></div>
        </div>
      </section>
    </Site>
  );
}

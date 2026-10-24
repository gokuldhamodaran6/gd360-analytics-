// 2026-10-19 (R56, website board "Landing"): the public home page in brand v2. Honest by rule: the picture of the
// app is marked "Example", there are no customer logos, quotes or certificates we do not have, and what is not built
// yet (single sign-on, SCIM) is named as "on the way".
import { A, useMarketingPage } from "../shared";
import { Site } from "./chrome";

const BARS: [string, number, string][] = [["Jan", 62, "$398k"], ["Feb", 70, "$446k"], ["Mar", 52, "$331k"], ["Apr", 74, "$471k"]];

function ExampleShot() {
  return (
    <div className="mk2-shot" data-mk2-example="" aria-label="An example of Euliv: a question on the left, the steps of the answer on the right">
      <div className="bar"><i /><i /><i /><span style={{ marginLeft: 10 }}>Example · made-up shop data</span></div>
      <div className="body">
        <div className="th">
          <div className="u">Why did revenue drop in March?</div>
          <div style={{ lineHeight: 1.55, color: "var(--ink2)" }}>
            Revenue fell <b style={{ color: "var(--ink)" }}>26%</b> from February to March. Most of it is one thing: paid search orders stopped for 9 days after the budget ran out.
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span className="mk2-chip"><i style={{ background: "var(--brand)" }} />3 steps checked</span>
            <span className="mk2-chip">orders · 12,480 rows</span>
          </div>
          <div style={{ marginTop: "auto", border: "1px solid var(--line)", borderRadius: 12, padding: "10px 12px", color: "var(--ink3)" }}>Ask a follow-up…</div>
        </div>
        <div className="cv">
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <b>Revenue by month</b><span className="mk2-chip">Steps</span><span style={{ flex: 1 }} />
            <span className="mk2-btn pri" style={{ height: 28, fontSize: 12.5, padding: "0 12px" }}>Turn into ▾</span>
          </div>
          <div className="card">
            <span className="k">1 · Data</span>
            <span className="mono" style={{ fontSize: 12, color: "var(--ink2)" }}>SELECT month, SUM(total) FROM orders GROUP BY 1</span>
          </div>
          <div className="card">
            <span className="k">2 · Chart</span>
            <svg viewBox="0 0 320 120" role="img" aria-label="Example bars: March is the lowest month" style={{ width: "100%", maxWidth: 420, height: "auto", maxHeight: 150, alignSelf: "flex-start" }}>
              {BARS.map(([m, h, v], i) => (
                <g key={m}>
                  <rect x={20 + i * 76} y={100 - h} width={44} height={h} rx={4} fill={m === "Mar" ? "#C2362C" : "#2F6FE4"} />
                  <text x={42 + i * 76} y={114} textAnchor="middle" fontSize="10" fill="#6E7472">{m}</text>
                  <text x={42 + i * 76} y={95 - h} textAnchor="middle" fontSize="10" fill="#4A504E">{v}</text>
                </g>
              ))}
            </svg>
          </div>
          <div className="card">
            <span className="k">3 · Finding</span>
            <span style={{ fontSize: 13, color: "var(--ink2)" }}>Paid search orders: 0 between 4 and 12 March. Other channels were flat.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const DO: [string, string, string][] = [
  ["Answers", "Ask in plain words. You get the number, a chart and the reason, with the query and rows one click away.", "01"],
  ["Dashboards", "Turn any answer into a page of charts. Change a chart by asking, then publish it to your team.", "02"],
  ["Reports", "A written report from the same numbers. Every figure stays linked to where it came from.", "03"],
  ["Predictions", "Who will leave, what next month looks like. Each model is tested on rows it never saw, and says how well it did.", "04"],
];
const MORE: [string, string][] = [
  ["Pipelines", "Clean and join data on a schedule. Each run is checked before it replaces anything."],
  ["Alerts", "Hear when a number moves, with the reason attached, by email or in the app."],
  ["Initiatives", "Track a goal across teams. Euliv keeps the evidence and flags what needs a decision."],
];
const SOURCES = ["Shopify", "WooCommerce", "Stripe", "Google Ads", "Meta Ads", "Google Analytics 4", "Search Console", "HubSpot", "Klaviyo", "Instagram", "YouTube", "LinkedIn Pages", "WhatsApp Business", "PostgreSQL", "MySQL", "SQL Server", "Supabase", "BigQuery", "Snowflake", "Redshift", "CSV and Excel files"];

export default function Landing() {
  useMarketingPage("Euliv — ask your data, check every answer");
  return (
    <Site data="landing">
      <section className="mk2-wrap mk2-hero">
        <span className="mk2-badge"><i />Early access · every feature open on every plan</span>
        <h1>Ask your data. Check every answer.</h1>
        <p>Euliv connects to the tools your business already runs on and answers in plain words. Every answer shows its steps, the query, the rows and the sources, so you can trust a number before you share it.</p>
        <div className="mk2-cta">
          <A href="/start" className="mk2-btn pri lg" data-mk2-hero-start="">Start free</A>
          <A href="/#how" className="mk2-btn sec lg">See how it works</A>
        </div>
        <div className="mk2-fine">Free plan, no card. Read-only connections: nothing in your systems is changed.</div>
        <ExampleShot />
      </section>

      <section className="mk2-wrap mk2-sec" id="how">
        <span className="mk2-eb">How it works</span>
        <h2>One conversation, every kind of work.</h2>
        <p className="mk2-lead">Start with a question. The answer opens beside the chat as steps you can read and change. When it is right, turn it into whatever the team needs.</p>
        <div className="mk2-grid4">
          {DO.map(([t, d, n]) => (
            <div key={t} className="mk2-card"><span className="n">{n}</span><h3>{t}</h3><p>{d}</p></div>
          ))}
        </div>
        <div className="mk2-grid3">
          {MORE.map(([t, d]) => (
            <div key={t} className="mk2-card tint"><h3>{t}</h3><p>{d}</p></div>
          ))}
        </div>
      </section>

      <section className="mk2-wrap mk2-sec" id="proof">
        <div className="mk2-proof">
          <div>
            <span className="mk2-eb">Why trust it</span>
            <h2>Proof on every number.</h2>
            <p className="mk2-lead">An answer is only useful if you can check it. Euliv keeps the query, the rows it read and the time of the last sync with every figure, and says plainly when the data cannot answer the question.</p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="mk2-pr">Revenue, March <b>$331,240</b><span className="mk2-chip"><i style={{ background: "var(--brand)" }} />Checked</span></div>
            <div className="mk2-pr">New customers <b>1,284</b><span className="mk2-chip"><i style={{ background: "var(--blue)" }} />2 sources agree</span></div>
            <div className="mk2-pr">Refund rate <b>4.1%</b><span className="mk2-chip"><i style={{ background: "var(--amber)" }} />Synced 3 h ago</span></div>
            <span style={{ fontSize: 12.5, color: "var(--ink3)" }}>Example figures, to show how proof looks.</span>
          </div>
        </div>
      </section>

      <section className="mk2-wrap mk2-sec" id="sources">
        <span className="mk2-eb">Sources</span>
        <h2>Works with what you already have.</h2>
        <p className="mk2-lead">Connect an app in a couple of minutes, point at a database, or drop in a file. Databases are read where they are; apps sync on a schedule you pick.</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 26 }}>
          {SOURCES.map((s) => <span key={s} className="mk2-chip" style={{ height: 32, padding: "0 14px", fontSize: 13.5, background: "#fff", border: "1px solid var(--line)" }}>{s}</span>)}
        </div>
      </section>

      <section className="mk2-wrap mk2-sec" id="security">
        <span className="mk2-eb">Security and control</span>
        <h2>The owner decides who sees what.</h2>
        <div className="mk2-grid3">
          <div className="mk2-card"><h3>Roles and rules</h3><p>Admins, members and viewers. Rules limit which rows and columns a person can read, and columns with personal data are flagged.</p></div>
          <div className="mk2-card"><h3>A record of everything</h3><p>Sign-ins, shares and changes go to an audit log the owner can read and download. Two-step sign-in can be required for everyone.</p></div>
          <div className="mk2-card"><h3>Honest about what is next</h3><p>Single sign-on (SAML) and SCIM provisioning are on the way and not available yet. We do not hold a SOC 2 report today.</p><span className="tag">On the way</span></div>
        </div>
      </section>

      <section className="mk2-wrap">
        <div className="mk2-dark">
          <div style={{ flex: "1 1 420px" }}>
            <h2 style={{ fontSize: 32, letterSpacing: "-.02em", fontWeight: 600 }}>Ask your first question in five minutes.</h2>
            <p>Make an account, connect one source or a file, and ask. Free while we are in early access.</p>
          </div>
          <A href="/start" className="mk2-btn pri lg">Start free</A>
          <A href="/pricing" className="mk2-btn sec lg">See pricing</A>
        </div>
      </section>
    </Site>
  );
}

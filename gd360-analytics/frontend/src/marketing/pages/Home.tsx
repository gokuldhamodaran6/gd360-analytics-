// Generated from the approved "GD360 Website — Final" mockup (Main.dc.html).
// Markup, inline styles and motion are kept exactly as designed; the
// page's CSS (animations, hover states) lives in marketing.css, scoped
// under .mkt-home.
import { Fragment, useState } from "react";
import { A, useMarketingPage } from "../shared";
import "../marketing.css";

/* eslint-disable @typescript-eslint/no-explicit-any */
function vals(state: any, setState: (patch: any) => void): any {

    const place = (xs, offset) => xs.map(([n, m], i) => {
      const a = (i / xs.length) * Math.PI * 2 + offset;
      return { n, m, x: (50 + 50 * Math.cos(a)).toFixed(2), y: (50 + 50 * Math.sin(a)).toFixed(2) };
    });
    const A = [["Snowflake","Sf"],["BigQuery","BQ"],["PostgreSQL","Pg"],["MySQL","My"],["SQL Server","SS"],["MongoDB","Mg"],["Supabase","Sb"],["Google Sheets","GS"],["CSV / Excel","Fi"],["REST API","{}"],["Shopify","Sh"],["WooCommerce","Wc"]];
    const B = [["Google Ads","GA"],["Meta Ads","Ma"],["GA4","G4"],["Search Console","SC"],["Instagram","Ig"],["Facebook Pages","Fb"],["LinkedIn Pages","in"],["YouTube","Yt"],["Stripe","St"],["HubSpot","Hs"],["Klaviyo","Kl"],["Webhooks","Wh"]];
    const dbl = (xs) => [...xs, ...xs].map(([n, m]) => ({ n, m }));
    const R = {
      motionClass: true ? "" : "calm",
      outer: place([["Instagram","Ig"],["Shopify","Sh"],["LinkedIn","in"],["Stripe","St"],["YouTube","Yt"],["HubSpot","Hs"],["Facebook","Fb"],["Klaviyo","Kl"],["WooCommerce","Wc"],["Google Sheets","GS"]], 0.3),
      middle: place([["Google Ads","GA"],["GA4","G4"],["Meta Ads","Ma"],["Search Console","SC"],["MongoDB","Mg"],["MySQL","My"],["CSV / Excel","Fi"],["REST API","{}"]], 0.9),
      inner: place([["Snowflake","Sf"],["BigQuery","BQ"],["Postgres","Pg"],["SQL Server","SS"],["Supabase","Sb"]], 0.2),
      rowA: dbl(A), rowB: dbl(B),
      narr: [
        { cls: "n1", k: "01", t: "Understands the question", d: "Which metric, which window, which sources — assumptions shown, every one changeable." },
        { cls: "n2", k: "02", t: "Plans across every source", d: "A step-by-step plan where each step runs inside its source, in that source’s own SQL." },
        { cls: "n3", k: "03", t: "Splits the change into causes", d: "Traffic, conversion and basket separated; drivers ranked; the usual suspects ruled out." },
        { cls: "n4", k: "04", t: "Proves every figure", d: "14 numbers in the answer, 14 matched to their queries — before you ever see them." }
      ],
      bars: [40, 62, 54, 78, 70, 92, 84, 104, 88].map((h, i) => ({ h, c: i === 7 ? "#43E5A0" : "#24413A", d: (i * 0.09).toFixed(2) + "s" })),
      kinds: ["Churn", "Forecast many", "Segments", "Anomalies", "Key drivers", "Bought together", "Cohorts", "Uplift", "Price sensitivity", "Sentiment"],
      story: [
        { cls: "tl1", time: "09:02", t: "The alert", d: "Revenue is 12% below last month. An automation noticed first and posted to #revenue." },
        { cls: "tl2", time: "09:03", t: "The answer", d: "A plan across four sources. The budget cut explains 73% of the drop — with the proof." },
        { cls: "tl3", time: "09:10", t: "The fix", d: "Marketing restores the budget. GD360 builds a dashboard to watch the recovery." },
        { cls: "tl4", time: "Next Monday", t: "The confirmation", d: "Back on trend. The weekly summary says so — every number linked to its query." }
      ],
      teams: [
        { n: "Marketing", q: "Which posts and campaigns actually brought people to the store?", d: "Organic and paid reach, engagement, search and site visits side by side — tied back to revenue.", s: "Instagram · Google Ads · GA4 · Shopify" },
        { n: "Sales", q: "Which deals will close this quarter — and why?", d: "Pipeline from your CRM, scored by a model trained on the deals you’ve already won and lost.", s: "HubSpot · Postgres · ML Studio" },
        { n: "Finance", q: "Why is gross margin down, and will it keep falling?", d: "The change split into drivers, the rest ruled out, and a forecast with its honest range.", s: "Snowflake · Stripe · Forecast" },
        { n: "Product", q: "Did the new checkout help or hurt conversion on mobile?", d: "Before and after by device and release, with the effect measured — not guessed.", s: "Postgres · GA4 · Uplift" },
        { n: "Operations", q: "Which products will run out before the next delivery?", d: "A demand forecast for every SKU, compared against stock on hand and lead time.", s: "Inventory · Shopify · Forecast many" },
        { n: "Leadership", q: "Send me what changed this week — only if it matters.", d: "One automation per team: refresh, check and summarise, delivered to email or Slack.", s: "Automations · every Space" }
      ],
      spec: [
        { k: "CONNECTIONS", v: "Read-only. Every query is parsed before it runs; anything that writes is refused." },
        { k: "CREDENTIALS", v: "Encrypted at rest and never displayed again after saving." },
        { k: "ACCESS", v: "Row and column rules applied to every query, dashboard, model and alert." },
        { k: "DATA MOVEMENT", v: "Queries pushed down to the source; only small aggregates leave it." },
        { k: "COST CONTROL", v: "Warehouse queries estimated before they run and capped per day." },
        { k: "ANSWERS", v: "Written only from computed results; a number checker blocks any mismatch." },
        { k: "AUDIT", v: "Plan, SQL, results and answer stored together for every question." }
      ]
    };

    const __menu = !!(state && state.menu);
    R.menu = __menu;
    R.menuExpanded = __menu ? "true" : "false";
    R.openMenu = () => setState({ menu: true });
    R.closeMenu = () => setState({ menu: false });
    R.menuLinks = [{ t: "Product", href: "#see" }, { t: "Platform", href: "#platform" }, { t: "Solutions", href: "#teams" }, { t: "Security", href: "#security" }, { t: "Pricing", href: "/pricing" }, { t: "About", href: "/about" }].map((x, i) => ({ ...x, cls: "ml" + (i + 1) }));
    R.mSources = [["Snowflake", "Sf", "LIVE"], ["Google Ads", "GA", "SYNCED"], ["GA4", "G4", "SYNCED"], ["Shopify", "Sh", "SYNCED"]].map(([n, m, mode], i) => ({ n, m, mode, cls: "ms" + (i + 1), ink: mode === "LIVE" ? "#43E5A0" : "#7AA7FF" }));
    return R;
  
}

export default function MarketingHome() {
  useMarketingPage("GD360 — Every source. One answer. Proven.");
  const [state, setS] = useState<any>({ menu: false });
  const setState = (patch: any) => setS((prev: any) => ({ ...prev, ...patch }));
  const V = vals(state, setState);
  return (
    <div className="mkt-home" style={{ fontFamily: "Geist, 'Helvetica Neue', system-ui, sans-serif", color: "#E8EEEC", background: "#07090A", minHeight: "100vh", overflowX: "clip" }}>
      {" "}
      <header className="mk-site-head" style={{ position: "relative", zIndex: "5", borderBottom: "1px solid #141A1B", background: "rgba(7,9,10,.82)" }}>
        {" "}
        <nav className="mk-site-nav" aria-label="Main" style={{ maxWidth: "1280px", margin: "0 auto", padding: "16px 24px", display: "flex", alignItems: "center", gap: "30px", flexWrap: "wrap" }}>
          {" "}
          <A href="/" style={{ display: "flex", alignItems: "center", gap: "10px", color: "#E8EEEC" }}>
            {" "}
            <span style={{ width: "34px", height: "34px", borderRadius: "10px", background: "#43E5A0", color: "#04140D", display: "grid", placeItems: "center", fontWeight: "900", fontSize: "17px", boxShadow: "0 0 24px rgba(67,229,160,.35)" }}>
              {"G"}
            </span>
            {" "}
            <span style={{ fontWeight: "800", fontSize: "20px", letterSpacing: "-0.02em" }}>
              {"GD360"}
            </span>
            {" "}
          </A>
          {" "}
          <div className="mk-navlinks mk-d-only" style={{ display: "flex", gap: "26px", flexWrap: "wrap", fontSize: "15px", flex: "1 1 auto" }}>
            {" "}
            <A href="#see" style={{ color: "#A3B0AC" }}>
              {"Product"}
            </A>
            {" "}
            <A href="#platform" style={{ color: "#A3B0AC" }}>
              {"Platform"}
            </A>
            {" "}
            <A href="#teams" style={{ color: "#A3B0AC" }}>
              {"Solutions"}
            </A>
            {" "}
            <A href="#security" style={{ color: "#A3B0AC" }}>
              {"Security"}
            </A>
            {" "}
            <A href="/pricing" style={{ color: "#A3B0AC" }}>
              {"Pricing"}
            </A>
            {" "}
            <A href="/about" style={{ color: "#A3B0AC" }}>
              {"About"}
            </A>
            {" "}
          </div>
          {" "}
          <div className="mk-d-only" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            {" "}
            <A href="/login" style={{ color: "#E8EEEC", fontSize: "15px", padding: "10px 14px" }}>
              {"Sign in"}
            </A>
            {" "}
            <A href="/start" style={{ background: "#43E5A0", color: "#04140D", fontWeight: "700", fontSize: "15px", padding: "12px 20px", borderRadius: "999px", minHeight: "44px", boxSizing: "border-box", display: "inline-flex", alignItems: "center", gap: "8px" }}>
              {"Get started "}
              <span aria-hidden="true">
                {"→"}
              </span>
            </A>
            {" "}
          </div>
          {" "}
          <div className="mk-m-only" style={{ marginLeft: "auto" }}>
            {" "}
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {" "}
              <button type="button" aria-label="Open menu" aria-expanded={V.menuExpanded} onClick={V.openMenu} style={{ width: "44px", height: "44px", borderRadius: "12px", border: "1px solid #2A3436", background: "#0E1213", display: "grid", placeItems: "center", cursor: "pointer", padding: "0" }}>
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path d="M2.5 5h13M2.5 9h13M2.5 13h8" stroke="#E8EEEC" strokeWidth="1.7" strokeLinecap="round"></path>
                </svg>
              </button>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
        </nav>
        {" "}
      </header>
      {" "}
      {V.menu && (
        <>
          {" "}
          <div className="mk-m-only">
            {" "}
            <div className="mk-msheet" role="dialog" aria-modal="true" aria-label="Menu" style={{ position: "fixed", inset: "0", zIndex: "80", background: "rgba(5,7,7,.97)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", display: "flex", flexDirection: "column", padding: "10px 16px calc(20px + env(safe-area-inset-bottom, 0px))", overflowY: "auto" }}>
              {" "}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: "48px" }}>
                {" "}
                <A href="/" onClick={V.closeMenu} style={{ display: "flex", alignItems: "center", gap: "10px", color: "#E8EEEC" }}>
                  <span style={{ width: "34px", height: "34px", borderRadius: "10px", background: "#43E5A0", color: "#04140D", display: "grid", placeItems: "center", fontWeight: "900", fontSize: "17px" }}>
                    {"G"}
                  </span>
                  <span style={{ fontWeight: "800", fontSize: "20px", letterSpacing: "-0.02em" }}>
                    {"GD360"}
                  </span>
                </A>
                {" "}
                <button type="button" aria-label="Close menu" onClick={V.closeMenu} style={{ width: "44px", height: "44px", borderRadius: "12px", border: "1px solid #2A3436", background: "#0E1213", display: "grid", placeItems: "center", cursor: "pointer", padding: "0" }}>
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                    <path d="M4 4l10 10M14 4L4 14" stroke="#E8EEEC" strokeWidth="1.7" strokeLinecap="round"></path>
                  </svg>
                </button>
                {" "}
              </div>
              {" "}
              <nav aria-label="Menu" style={{ display: "flex", flexDirection: "column", marginTop: "26px" }}>
                {" "}
                {(V.menuLinks || []).map((l: any, i1: number) => (
                  <Fragment key={i1}>
                    {" "}
                    <A href={l.href} onClick={V.closeMenu} className={`mk-mlink ${l.cls ? "mk-" + l.cls : ""}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "15px 0", borderBottom: "1px solid #141A1B", color: "#E8EEEC", fontSize: "30px", fontWeight: "800", letterSpacing: "-0.035em" }}>
                      {l.t}
                      <span aria-hidden="true" style={{ color: "#43E5A0", fontSize: "20px" }}>
                        {"→"}
                      </span>
                    </A>
                    {" "}
                  </Fragment>
                ))}
                {" "}
              </nav>
              {" "}
              <div style={{ marginTop: "auto", paddingTop: "28px", display: "flex", flexDirection: "column", gap: "10px" }}>
                {" "}
                <A href="/start" onClick={V.closeMenu} style={{ height: "54px", borderRadius: "999px", background: "#43E5A0", color: "#04140D", display: "grid", placeItems: "center", fontWeight: "700", fontSize: "16.5px" }}>
                  {"Get started"}
                </A>
                {" "}
                <A href="/login" onClick={V.closeMenu} style={{ height: "54px", borderRadius: "999px", border: "1px solid #2A3436", color: "#E8EEEC", display: "grid", placeItems: "center", fontWeight: "600", fontSize: "16.5px" }}>
                  {"Sign in"}
                </A>
                {" "}
                <span className="mk-mono" style={{ textAlign: "center", fontSize: "11.5px", color: "#7F8C88", marginTop: "8px", letterSpacing: "0.06em" }}>
                  {"EVERY SOURCE. ONE ANSWER. PROVEN."}
                </span>
                {" "}
              </div>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
        </>
      )}
      {" "}
      <section className="mk-m-hero" id="top" style={{ position: "relative", padding: "84px 24px 24px", textAlign: "center" }}>
        {" "}
        <div className="mk-gridbg" style={{ position: "absolute", inset: "0", pointerEvents: "none" }}></div>
        {" "}
        <div className="mk-aur mk-aur1" style={{ left: "8%", top: "60px", width: "520px", height: "520px", background: "rgba(67,229,160,.16)" }}></div>
        {" "}
        <div className="mk-aur mk-aur2" style={{ right: "6%", top: "220px", width: "460px", height: "460px", background: "rgba(122,167,255,.10)" }}></div>
        {" "}
        <div style={{ position: "relative", maxWidth: "1100px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "28px", alignItems: "center" }}>
          {" "}
          <A href="/start" className="mk-w mk-d1" style={{ display: "inline-flex", alignItems: "center", gap: "10px", border: "1px solid #24413A", background: "rgba(19,35,32,.8)", color: "#BDF3DA", fontSize: "13.5px", padding: "7px 16px 7px 7px", borderRadius: "999px" }}>
            {" "}
            <span className="mk-mono" style={{ background: "#43E5A0", color: "#04140D", fontSize: "11px", fontWeight: "600", padding: "3px 10px", borderRadius: "999px" }}>
              {"EARLY ACCESS"}
            </span>
            {" The full product, at no cost while we launch "}
            <span aria-hidden="true">
              {"→"}
            </span>
            {" "}
          </A>
          {" "}
          <h1 className="mk-m-h1" style={{ margin: "0", fontWeight: "900", fontSize: "clamp(50px, 9vw, 136px)", lineHeight: "0.92", letterSpacing: "-0.055em" }}>
            {" "}
            <span className="mk-w mk-d2">
              {"Every source."}
            </span>
            <br />
            {" "}
            <span className="mk-w mk-d3">
              {"One answer."}
            </span>
            {" "}
            <span className="mk-w mk-d4">
              <span className="mk-sheen">
                {"Proven."}
              </span>
            </span>
            {" "}
          </h1>
          {" "}
          <p className="mk-w mk-d5" style={{ margin: "0", fontSize: "clamp(17px, 1.8vw, 21px)", lineHeight: "1.6", color: "#A3B0AC", maxWidth: "720px" }}>
            {"GD360 is the AI analyst for companies that run on data but don’t have a data team. Ask in plain words — it plans the analysis across your warehouse, databases and apps, runs it where your data lives, and proves every number it gives you."}
          </p>
          {" "}
          <div className="mk-m-cta mk-w mk-d6" style={{ display: "flex", gap: "12px", flexWrap: "wrap", justifyContent: "center" }}>
            {" "}
            <A href="/start" style={{ background: "#43E5A0", color: "#04140D", fontWeight: "700", fontSize: "16.5px", padding: "17px 30px", borderRadius: "999px", boxShadow: "0 18px 50px -18px rgba(67,229,160,.7)" }}>
              {"Get early access"}
            </A>
            {" "}
            <A href="#see" style={{ border: "1px solid #2A3436", color: "#E8EEEC", fontWeight: "500", fontSize: "16.5px", padding: "17px 28px", borderRadius: "999px", background: "rgba(14,18,19,.7)", display: "inline-flex", alignItems: "center", gap: "10px" }}>
              <span aria-hidden="true" style={{ width: "22px", height: "22px", borderRadius: "22px", background: "#132320", display: "grid", placeItems: "center", fontSize: "9px", color: "#43E5A0" }}>
                {"▶"}
              </span>
              {"Watch it think"}
            </A>
            {" "}
          </div>
          {" "}
          <div className="mk-halo mk-w mk-d6" style={{ marginTop: "20px", width: "100%", maxWidth: "900px", borderRadius: "22px", background: "rgba(11,15,16,.92)", border: "1px solid #24413A", padding: "clamp(16px, 2.2vw, 24px) clamp(16px, 2.2vw, 26px)", display: "flex", alignItems: "center", gap: "16px", textAlign: "left", boxSizing: "border-box" }}>
            {" "}
            <span aria-hidden="true" style={{ flex: "none", width: "40px", height: "40px", borderRadius: "12px", background: "#43E5A0", color: "#04140D", display: "grid", placeItems: "center", fontWeight: "800", fontSize: "18px" }}>
              {"✦"}
            </span>
            {" "}
            <span className="mk-cmd-text" style={{ flex: "1", minWidth: "0", fontSize: "clamp(17px, 2.2vw, 27px)", fontWeight: "500", letterSpacing: "-0.02em", overflow: "hidden" }}>
              {" "}
              <span className="mk-rot">
                <span className="mk-rot-in">
                  <span>
                    {"Why is our revenue lower this month?"}
                  </span>
                  <span>
                    {"Forecast demand for every product next quarter"}
                  </span>
                  <span>
                    {"Which customers are about to stop buying?"}
                  </span>
                  <span>
                    {"Which posts actually brought people to the store?"}
                  </span>
                  <span>
                    {"Tell #revenue the moment refunds spike"}
                  </span>
                  <span>
                    {"Why is our revenue lower this month?"}
                  </span>
                </span>
              </span>
              <span className="mk-caret"></span>
              {" "}
            </span>
            {" "}
            <span className="mk-mono mk-cmd-pill" style={{ flex: "none", fontSize: "12px", color: "#7F8C88", border: "1px solid #1F2729", padding: "6px 10px", borderRadius: "8px" }}>
              {"All sources ⏎"}
            </span>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
        <div className="mk-m-only">
          {" "}
          <div style={{ position: "relative", maxWidth: "440px", margin: "40px auto 0", textAlign: "left", display: "flex", flexDirection: "column", gap: "8px" }}>
            {" "}
            <span className="mk-mono" style={{ fontSize: "11px", letterSpacing: "0.14em", color: "#7F8C88", marginBottom: "4px" }}>
              {"YOUR SOURCES · SAMPLE COMPANY"}
            </span>
            {" "}
            {(V.mSources || []).map((c: any, i1: number) => (
              <Fragment key={i1}>
                {" "}
                <div className={`mk-msrc ${c.cls ? "mk-" + c.cls : ""}`} style={{ display: "flex", alignItems: "center", gap: "12px", border: "1px solid #1F2729", background: "#0B0F10", borderRadius: "14px", padding: "10px 12px" }}>
                  {" "}
                  <span className="mk-mono" style={{ flex: "none", width: "32px", height: "32px", borderRadius: "9px", display: "grid", placeItems: "center", fontSize: "11px", fontWeight: "600", background: "#132320", border: "1px solid #24413A", color: "#43E5A0" }}>
                    {c.m}
                  </span>
                  {" "}
                  <span style={{ flex: "1", minWidth: "0", fontSize: "15px", fontWeight: "600" }}>
                    {c.n}
                  </span>
                  {" "}
                  <span className="mk-mono" style={{ fontSize: "10.5px", color: c.ink }}>
                    {c.mode}
                  </span>
                  {" "}
                </div>
                {" "}
              </Fragment>
            ))}
            {" "}
            <div style={{ position: "relative", height: "56px", width: "2px", margin: "0 auto", background: "linear-gradient(#1F2729, #43E5A0)" }}>
              <span className="mk-mdrop"></span>
              <span className="mk-mdrop mk-md2"></span>
            </div>
            {" "}
            <div className="mk-mans" style={{ border: "1px solid #24413A", background: "radial-gradient(ellipse at 100% 0%, rgba(67,229,160,.18), rgba(7,9,10,0) 60%), #0E1A16", borderRadius: "18px", padding: "18px", display: "flex", flexDirection: "column", gap: "8px" }}>
              {" "}
              <span className="mk-mono" style={{ fontSize: "11px", letterSpacing: "0.12em", color: "#43E5A0" }}>
                {"ONE ANSWER"}
              </span>
              {" "}
              <span style={{ fontWeight: "800", fontSize: "21px", lineHeight: "1.2", letterSpacing: "-0.025em" }}>
                {"Revenue is down $58.5k (−12.4%)"}
              </span>
              {" "}
              <span style={{ color: "#A3B0AC", fontSize: "14.5px", lineHeight: "1.55" }}>
                {"Mostly the Brand – US budget cut on 30 Sep. Meta, prices, stock and refunds ruled out."}
              </span>
              {" "}
              <span className="mk-mono" style={{ alignSelf: "flex-start", marginTop: "4px", fontSize: "11px", color: "#43E5A0", border: "1px solid #24413A", background: "#132320", padding: "5px 9px", borderRadius: "6px" }}>
                {"✓ 14 of 14 figures proven"}
              </span>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
        <div className="mk-d-only" style={{ position: "relative", width: "min(720px, 80vw)", aspectRatio: "1", margin: "64px auto 0" }}>
          {" "}
          <div className="mk-ring" style={{ inset: "0" }}></div>
          {" "}
          <div className="mk-ring" style={{ inset: "16%" }}></div>
          {" "}
          <div className="mk-ring" style={{ inset: "32%" }}></div>
          {" "}
          <div className="mk-comet mk-fast" style={{ inset: "0" }}></div>
          {" "}
          <div className="mk-comet mk-fast2" style={{ inset: "16%" }}></div>
          {" "}
          <div className="mk-spin3" style={{ position: "absolute", inset: "0" }}>
            {" "}
            {(V.outer || []).map((c: any, i1: number) => (
              <Fragment key={i1}>
                {" "}
                <div style={{ position: "absolute", left: `${c.x}%`, top: `${c.y}%`, transform: "translate(-50%, -50%)" }}>
                  {" "}
                  <div className="mk-un3">
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", background: "#0B0F10", border: "1px solid #1F2729", borderRadius: "999px", padding: "6px 13px 6px 6px", fontSize: "13px", whiteSpace: "nowrap", color: "#E8EEEC" }}>
                      <span className="mk-mono" style={{ width: "24px", height: "24px", borderRadius: "24px", display: "grid", placeItems: "center", fontSize: "10px", fontWeight: "600", background: "#132320", border: "1px solid #24413A", color: "#43E5A0" }}>
                        {c.m}
                      </span>
                      <span className="mk-chip-label">
                        {c.n}
                      </span>
                    </span>
                  </div>
                  {" "}
                </div>
                {" "}
              </Fragment>
            ))}
            {" "}
          </div>
          {" "}
          <div className="mk-spin2" style={{ position: "absolute", inset: "16%" }}>
            {" "}
            {(V.middle || []).map((c: any, i1: number) => (
              <Fragment key={i1}>
                {" "}
                <div style={{ position: "absolute", left: `${c.x}%`, top: `${c.y}%`, transform: "translate(-50%, -50%)" }}>
                  {" "}
                  <div className="mk-un2">
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", background: "#0B0F10", border: "1px solid #1F2729", borderRadius: "999px", padding: "6px 13px 6px 6px", fontSize: "13px", whiteSpace: "nowrap", color: "#E8EEEC" }}>
                      <span className="mk-mono" style={{ width: "24px", height: "24px", borderRadius: "24px", display: "grid", placeItems: "center", fontSize: "10px", fontWeight: "600", background: "#132320", border: "1px solid #24413A", color: "#43E5A0" }}>
                        {c.m}
                      </span>
                      <span className="mk-chip-label">
                        {c.n}
                      </span>
                    </span>
                  </div>
                  {" "}
                </div>
                {" "}
              </Fragment>
            ))}
            {" "}
          </div>
          {" "}
          <div className="mk-spin" style={{ position: "absolute", inset: "32%" }}>
            {" "}
            {(V.inner || []).map((c: any, i1: number) => (
              <Fragment key={i1}>
                {" "}
                <div style={{ position: "absolute", left: `${c.x}%`, top: `${c.y}%`, transform: "translate(-50%, -50%)" }}>
                  {" "}
                  <div className="mk-un1">
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", background: "#132320", border: "1px solid #24413A", borderRadius: "999px", padding: "6px 13px 6px 6px", fontSize: "13px", whiteSpace: "nowrap", color: "#E8EEEC" }}>
                      <span className="mk-mono" style={{ width: "24px", height: "24px", borderRadius: "24px", display: "grid", placeItems: "center", fontSize: "10px", fontWeight: "700", background: "#43E5A0", color: "#04140D" }}>
                        {c.m}
                      </span>
                      <span className="mk-chip-label">
                        {c.n}
                      </span>
                    </span>
                  </div>
                  {" "}
                </div>
                {" "}
              </Fragment>
            ))}
            {" "}
          </div>
          {" "}
          <div style={{ position: "absolute", left: "50%", top: "50%", width: "22%", aspectRatio: "1", transform: "translate(-50%, -50%)" }}>
            {" "}
            <span className="mk-wave"></span>
            <span className="mk-wave mk-wv2"></span>
            <span className="mk-wave mk-wv3"></span>
            {" "}
            <div className="mk-core" style={{ position: "absolute", inset: "0", borderRadius: "50%", background: "radial-gradient(circle at 35% 30%, #1A4636, #0B0F10 70%)", border: "1px solid #2E5E4C", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "8px", padding: "12px", boxSizing: "border-box" }}>
              {" "}
              <span style={{ width: "clamp(30px, 4vw, 48px)", height: "clamp(30px, 4vw, 48px)", borderRadius: "14px", background: "#43E5A0", color: "#04140D", display: "grid", placeItems: "center", fontWeight: "900", fontSize: "clamp(15px, 2vw, 24px)" }}>
                {"G"}
              </span>
              {" "}
              <span className="mk-mono" style={{ fontSize: "clamp(9px, 1.1vw, 12px)", color: "#43E5A0" }}>
                {"one answer"}
              </span>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
      </section>
      {" "}
      <section aria-label="Connectors" style={{ padding: "56px 0 64px" }}>
        {" "}
        <p className="mk-mono" style={{ textAlign: "center", margin: "0 0 28px", fontSize: "12.5px", letterSpacing: "0.16em", color: "#7F8C88" }}>
          {"WORKS WITH THE STACK YOU ALREADY RUN"}
        </p>
        {" "}
        <div style={{ overflow: "hidden", display: "flex", flexDirection: "column", gap: "12px", WebkitMaskImage: "linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent)", maskImage: "linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent)" }}>
          {" "}
          <div className="mk-marquee">
            {(V.rowA || []).map((c: any, i1: number) => (
              <Fragment key={i1}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "10px", border: "1px solid #1A2224", background: "#0B0F10", borderRadius: "12px", padding: "10px 16px 10px 10px", fontSize: "15px", whiteSpace: "nowrap" }}>
                  <span className="mk-mono" style={{ width: "28px", height: "28px", borderRadius: "8px", display: "grid", placeItems: "center", fontSize: "11px", fontWeight: "600", background: "#132320", border: "1px solid #24413A", color: "#43E5A0" }}>
                    {c.m}
                  </span>
                  {c.n}
                </span>
              </Fragment>
            ))}
          </div>
          {" "}
          <div className="mk-marquee mk-rev">
            {(V.rowB || []).map((c: any, i1: number) => (
              <Fragment key={i1}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "10px", border: "1px solid #1A2224", background: "#0B0F10", borderRadius: "12px", padding: "10px 16px 10px 10px", fontSize: "15px", whiteSpace: "nowrap" }}>
                  <span className="mk-mono" style={{ width: "28px", height: "28px", borderRadius: "8px", display: "grid", placeItems: "center", fontSize: "11px", fontWeight: "600", background: "#132320", border: "1px solid #24413A", color: "#43E5A0" }}>
                    {c.m}
                  </span>
                  {c.n}
                </span>
              </Fragment>
            ))}
          </div>
          {" "}
        </div>
        {" "}
      </section>
      {" "}
      <section className="mk-m-sec" id="see" style={{ padding: "104px 24px", borderTop: "1px solid #141A1B" }}>
        {" "}
        <div style={{ maxWidth: "1280px", margin: "0 auto", display: "flex", flexWrap: "wrap", gap: "56px", alignItems: "center" }}>
          {" "}
          <div style={{ flex: "1 1 380px", minWidth: "0", display: "flex", flexDirection: "column", gap: "22px" }}>
            {" "}
            <span className="mk-mono" style={{ fontSize: "12.5px", letterSpacing: "0.16em", color: "#43E5A0" }}>
              {"WATCH IT THINK"}
            </span>
            {" "}
            <h2 style={{ margin: "0", fontWeight: "800", fontSize: "clamp(34px, 4.6vw, 62px)", lineHeight: "1", letterSpacing: "-0.045em", textWrap: "balance" }}>
              {"It thinks like your best analyst. In seconds."}
            </h2>
            {" "}
            <div className="mk-m-rail" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {" "}
              {(V.narr || []).map((n: any, i1: number) => (
                <Fragment key={i1}>
                  {" "}
                  <div className={`mk-narr ${n.cls ? "mk-" + n.cls : ""}`} style={{ border: "1px solid #1F2729", borderRadius: "16px", padding: "16px 18px", display: "grid", gridTemplateColumns: "36px minmax(0, 1fr)", gap: "12px" }}>
                    {" "}
                    <span className="mk-mono" style={{ fontSize: "13px", color: "#43E5A0", paddingTop: "2px" }}>
                      {n.k}
                    </span>
                    {" "}
                    <span style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                      <span style={{ fontWeight: "700", fontSize: "17px" }}>
                        {n.t}
                      </span>
                      <span style={{ color: "#A3B0AC", fontSize: "14.5px", lineHeight: "1.55" }}>
                        {n.d}
                      </span>
                    </span>
                    {" "}
                  </div>
                  {" "}
                </Fragment>
              ))}
              {" "}
            </div>
            {" "}
          </div>
          {" "}
          <div style={{ flex: "1 1 560px", minWidth: "0" }}>
            {" "}
            <div style={{ borderRadius: "24px", background: "#0B0F10", border: "1px solid #1F2729", overflow: "hidden", boxShadow: "0 0 0 1px rgba(67,229,160,.12), 0 50px 140px -50px rgba(67,229,160,.45)" }}>
              {" "}
              <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "13px 16px", borderBottom: "1px solid #141A1B" }}>
                {" "}
                <span style={{ width: "10px", height: "10px", borderRadius: "10px", background: "#2A3436" }}></span>
                <span style={{ width: "10px", height: "10px", borderRadius: "10px", background: "#2A3436" }}></span>
                <span style={{ width: "10px", height: "10px", borderRadius: "10px", background: "#2A3436" }}></span>
                {" "}
                <span className="mk-mono" style={{ marginLeft: "10px", fontSize: "11.5px", color: "#7F8C88" }}>
                  {"GD360 · Sample company, Lumen Home"}
                </span>
                {" "}
              </div>
              {" "}
              <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
                {" "}
                <div style={{ border: "1px solid #2A3436", background: "#0E1213", borderRadius: "14px", padding: "14px 16px", display: "flex", alignItems: "center", gap: "12px" }}>
                  {" "}
                  <span aria-hidden="true" style={{ color: "#43E5A0" }}>
                    {"✦"}
                  </span>
                  {" "}
                  <span style={{ fontSize: "16px", flex: "1", minWidth: "0" }}>
                    <span className="mk-typing">
                      {"Why is our revenue lower this month?"}
                    </span>
                    <span className="mk-caret" style={{ width: "2px" }}></span>
                  </span>
                  {" "}
                </div>
                {" "}
                <div className="mk-m-steps" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "8px" }}>
                  {" "}
                  <div className="mk-step mk-s1 mk-mono" style={{ border: "1px solid #1F2729", borderRadius: "10px", padding: "10px 12px", fontSize: "12px" }}>
                    {"01 Revenue, both windows"}
                    <br />
                    <span style={{ color: "#43E5A0" }}>
                      {"Snowflake · LIVE"}
                    </span>
                  </div>
                  {" "}
                  <div className="mk-step mk-s2 mk-mono" style={{ border: "1px solid #1F2729", borderRadius: "10px", padding: "10px 12px", fontSize: "12px" }}>
                    {"02 Visits by channel"}
                    <br />
                    <span style={{ color: "#7AA7FF" }}>
                      {"GA4 · SYNCED"}
                    </span>
                  </div>
                  {" "}
                  <div className="mk-step mk-s3 mk-mono" style={{ border: "1px solid #1F2729", borderRadius: "10px", padding: "10px 12px", fontSize: "12px" }}>
                    {"03 Spend by campaign"}
                    <br />
                    <span style={{ color: "#7AA7FF" }}>
                      {"Google Ads · SYNCED"}
                    </span>
                  </div>
                  {" "}
                  <div className="mk-step mk-s4 mk-mono" style={{ border: "1px solid #1F2729", borderRadius: "10px", padding: "10px 12px", fontSize: "12px" }}>
                    {"04 Checkout by device"}
                    <br />
                    <span style={{ color: "#43E5A0" }}>
                      {"Postgres · LIVE"}
                    </span>
                  </div>
                  {" "}
                  <div className="mk-step mk-s5 mk-mono" style={{ border: "1px solid #1F2729", borderRadius: "10px", padding: "10px 12px", fontSize: "12px" }}>
                    {"05 Price, stock, refunds"}
                    <br />
                    <span style={{ color: "#7AA7FF" }}>
                      {"Shopify · SYNCED"}
                    </span>
                  </div>
                  {" "}
                  <div className="mk-step mk-s6 mk-mono" style={{ border: "1px solid #1F2729", borderRadius: "10px", padding: "10px 12px", fontSize: "12px" }}>
                    {"06 Split the change"}
                    <br />
                    <span style={{ color: "#A3B0AC" }}>
                      {"Analysis engine"}
                    </span>
                  </div>
                  {" "}
                </div>
                {" "}
                <div style={{ border: "1px solid #1F2729", borderRadius: "14px", background: "#0E1213", padding: "18px", display: "flex", flexDirection: "column", gap: "14px" }}>
                  {" "}
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", alignItems: "baseline" }}>
                    <span style={{ fontSize: "19px", fontWeight: "700" }}>
                      {"Revenue is down $58.5k (−12.4%)"}
                    </span>
                    <span className="mk-mono" style={{ fontSize: "11.5px", color: "#7F8C88" }}>
                      {"$470.8k → $412.3k"}
                    </span>
                  </div>
                  {" "}
                  <div style={{ display: "flex", flexDirection: "column", gap: "9px", fontSize: "13px" }}>
                    {" "}
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 150px) minmax(0,1fr) 64px", gap: "10px", alignItems: "center" }}>
                      <span style={{ color: "#A3B0AC" }}>
                        {"Brand – US budget cut"}
                      </span>
                      <span style={{ height: "10px", background: "#141A1B", borderRadius: "4px" }}>
                        <span className="mk-grow mk-g1" style={{ display: "block", height: "10px", width: "73%", background: "#FF7A6B", borderRadius: "4px" }}></span>
                      </span>
                      <span className="mk-mono" style={{ textAlign: "right" }}>
                        {"−$43.0k"}
                      </span>
                    </div>
                    {" "}
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 150px) minmax(0,1fr) 64px", gap: "10px", alignItems: "center" }}>
                      <span style={{ color: "#A3B0AC" }}>
                        {"Mobile checkout, 3.4"}
                      </span>
                      <span style={{ height: "10px", background: "#141A1B", borderRadius: "4px" }}>
                        <span className="mk-grow mk-g2" style={{ display: "block", height: "10px", width: "37%", background: "#FF7A6B", borderRadius: "4px" }}></span>
                      </span>
                      <span className="mk-mono" style={{ textAlign: "right" }}>
                        {"−$21.7k"}
                      </span>
                    </div>
                    {" "}
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 150px) minmax(0,1fr) 64px", gap: "10px", alignItems: "center" }}>
                      <span style={{ color: "#A3B0AC" }}>
                        {"Bundles lifted basket"}
                      </span>
                      <span style={{ height: "10px", background: "#141A1B", borderRadius: "4px" }}>
                        <span className="mk-grow mk-g3" style={{ display: "block", height: "10px", width: "25%", background: "#43E5A0", borderRadius: "4px" }}></span>
                      </span>
                      <span className="mk-mono" style={{ textAlign: "right" }}>
                        {"+$14.9k"}
                      </span>
                    </div>
                    {" "}
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 150px) minmax(0,1fr) 64px", gap: "10px", alignItems: "center" }}>
                      <span style={{ color: "#A3B0AC" }}>
                        {"Everything else"}
                      </span>
                      <span style={{ height: "10px", background: "#141A1B", borderRadius: "4px" }}>
                        <span className="mk-grow mk-g4" style={{ display: "block", height: "10px", width: "15%", background: "#6F7C78", borderRadius: "4px" }}></span>
                      </span>
                      <span className="mk-mono" style={{ textAlign: "right" }}>
                        {"−$8.7k"}
                      </span>
                    </div>
                    {" "}
                  </div>
                  {" "}
                  <div className="mk-mono" style={{ display: "flex", gap: "8px", flexWrap: "wrap", fontSize: "11px" }}>
                    <span style={{ border: "1px solid #1F2729", color: "#A3B0AC", padding: "4px 8px", borderRadius: "6px" }}>
                      {"Ruled out: Meta, prices, stock, refunds"}
                    </span>
                    <span style={{ border: "1px solid #24413A", background: "#132320", color: "#43E5A0", padding: "4px 8px", borderRadius: "6px" }}>
                      {"✓ 14 of 14 figures checked"}
                    </span>
                  </div>
                  {" "}
                </div>
                {" "}
              </div>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
      </section>
      {" "}
      <section className="mk-m-sec" id="proof" style={{ padding: "104px 24px", background: "#0B0F10", borderTop: "1px solid #141A1B", borderBottom: "1px solid #141A1B" }}>
        {" "}
        <div style={{ maxWidth: "1280px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "44px" }}>
          {" "}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "28px", justifyContent: "space-between", alignItems: "flex-end" }}>
            {" "}
            <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "760px" }}>
              {" "}
              <span className="mk-mono" style={{ fontSize: "12.5px", letterSpacing: "0.16em", color: "#43E5A0" }}>
                {"PROOF, NOT PROMISES"}
              </span>
              {" "}
              <h2 style={{ margin: "0", fontWeight: "800", fontSize: "clamp(34px, 4.6vw, 62px)", lineHeight: "1", letterSpacing: "-0.045em", textWrap: "balance" }}>
                {"Every number comes with its receipt."}
              </h2>
              {" "}
            </div>
            {" "}
            <p style={{ margin: "0", maxWidth: "420px", color: "#A3B0AC", fontSize: "16.5px", lineHeight: "1.6" }}>
              {"AI that invents numbers is worse than no AI. GD360 writes only from computed results — and a checker blocks any figure that doesn’t match its query."}
            </p>
            {" "}
          </div>
          {" "}
          <div style={{ display: "flex", flexWrap: "wrap", border: "1px solid #2A3436", background: "#07090A", borderRadius: "22px", overflow: "hidden" }}>
            {" "}
            <div style={{ flex: "1 1 620px", minWidth: "0", padding: "clamp(24px, 4vw, 52px)", display: "flex", flexDirection: "column", gap: "22px", borderRight: "1px solid #1F2729", position: "relative" }}>
              {" "}
              <div className="mk-scanline"></div>
              {" "}
              <div className="mk-mono" style={{ display: "flex", gap: "12px", flexWrap: "wrap", fontSize: "12px", color: "#7F8C88" }}>
                <span>
                  {"ANSWER"}
                </span>
                <span style={{ marginLeft: "auto" }}>
                  {"Sample company · Lumen Home"}
                </span>
              </div>
              {" "}
              <p style={{ margin: "0", fontWeight: "400", fontSize: "clamp(24px, 2.8vw, 38px)", lineHeight: "1.3", letterSpacing: "-0.02em" }}>
                {"Revenue fell "}
                <span className="mk-hl mk-h1d">
                  {"$58.5k (−12.4%)"}
                </span>
                <span className="mk-mark">
                  {"1"}
                </span>
                {", mostly because the "}
                <span className="mk-hl mk-h2d">
                  {"Brand – US budget was cut from $1,200 to $500 a day"}
                </span>
                <span className="mk-mark">
                  {"2"}
                </span>
                {" on 30 September. A slower mobile checkout after "}
                <span className="mk-hl mk-h3d">
                  {"app 3.4 cost a further $21.7k"}
                </span>
                <span className="mk-mark">
                  {"3"}
                </span>
                {"."}
              </p>
              {" "}
              <p style={{ margin: "0", color: "#A3B0AC", fontSize: "16px", lineHeight: "1.65", maxWidth: "640px" }}>
                {"Ruled out with evidence: Meta campaigns, price changes, stock-outs, refunds and seasonality."}
              </p>
              {" "}
            </div>
            {" "}
            <div style={{ flex: "1 1 380px", minWidth: "0", background: "#090C0D", padding: "clamp(20px, 3vw, 34px)", display: "flex", flexDirection: "column", gap: "14px" }}>
              {" "}
              <span className="mk-mono" style={{ fontSize: "11.5px", letterSpacing: "0.12em", color: "#7F8C88" }}>
                {"EVIDENCE"}
              </span>
              {" "}
              <div className="mk-note mk-o1" style={{ border: "1px solid #1F2729", background: "#0E1213", borderRadius: "12px", padding: "14px", display: "flex", flexDirection: "column", gap: "8px" }}>
                <span className="mk-mono" style={{ fontSize: "11.5px", color: "#43E5A0" }}>
                  {"[1] Snowflake · orders · LIVE"}
                </span>
                <code className="mk-mono" style={{ fontSize: "12px", lineHeight: "1.6", color: "#D5DEDB", whiteSpace: "pre-wrap" }}>
                  {"SELECT SUM(net_amount) FROM orders\nWHERE status = 'paid' AND order_date …"}
                </code>
              </div>
              {" "}
              <div className="mk-note mk-o2" style={{ border: "1px solid #1F2729", background: "#0E1213", borderRadius: "12px", padding: "14px", display: "flex", flexDirection: "column", gap: "8px" }}>
                <span className="mk-mono" style={{ fontSize: "11.5px", color: "#7AA7FF" }}>
                  {"[2] Google Ads · campaigns · SYNCED"}
                </span>
                <code className="mk-mono" style={{ fontSize: "12px", lineHeight: "1.6", color: "#D5DEDB", whiteSpace: "pre-wrap" }}>
                  {"Brand – US daily budget\n29 Sep  $1,200   →   30 Sep  $500"}
                </code>
              </div>
              {" "}
              <div className="mk-note mk-o3" style={{ border: "1px solid #1F2729", background: "#0E1213", borderRadius: "12px", padding: "14px", display: "flex", flexDirection: "column", gap: "8px" }}>
                <span className="mk-mono" style={{ fontSize: "11.5px", color: "#43E5A0" }}>
                  {"[3] Postgres · checkout_events · LIVE"}
                </span>
                <code className="mk-mono" style={{ fontSize: "12px", lineHeight: "1.6", color: "#D5DEDB", whiteSpace: "pre-wrap" }}>
                  {"mobile conversion 3.1% → 2.4%\nafter release 3.4"}
                </code>
              </div>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
      </section>
      {" "}
      <section className="mk-m-sec" id="platform" style={{ padding: "112px 24px" }}>
        {" "}
        <div style={{ maxWidth: "1280px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "44px" }}>
          {" "}
          <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "820px" }}>
            {" "}
            <span className="mk-mono" style={{ fontSize: "12.5px", letterSpacing: "0.16em", color: "#43E5A0" }}>
              {"THE PLATFORM"}
            </span>
            {" "}
            <h2 style={{ margin: "0", fontWeight: "800", fontSize: "clamp(34px, 4.6vw, 62px)", lineHeight: "1", letterSpacing: "-0.045em", textWrap: "balance" }}>
              {"One workspace. The work of a whole data team."}
            </h2>
            {" "}
            <p style={{ margin: "0", color: "#A3B0AC", fontSize: "17px", lineHeight: "1.6" }}>
              {"The engineer who connects and governs the data. The scientist who builds the models. The analyst who explains what happened. All in one calm screen anyone can use."}
            </p>
            {" "}
          </div>
          {" "}
          <div className="mk-m-rail" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "16px" }}>
            {" "}
            <div className="mk-lift" style={{ border: "1px solid #1F2729", background: "#0B0F10", borderRadius: "24px", padding: "28px", display: "flex", flexDirection: "column", gap: "14px" }}>
              {" "}
              <span className="mk-mono" style={{ fontSize: "12px", color: "#43E5A0" }}>
                {"FORECAST"}
              </span>
              {" "}
              <h3 style={{ margin: "0", fontWeight: "800", fontSize: "24px", letterSpacing: "-0.03em" }}>
                {"See next quarter coming."}
              </h3>
              {" "}
              <svg viewBox="0 0 320 120" role="img" aria-label="A forecast continuing past today with a widening range" style={{ width: "100%", height: "auto" }}>
                <path d="M0 92 L40 84 L80 88 L120 70 L160 66 L200 52" fill="none" stroke="#A3B0AC" strokeWidth="2"></path>
                <path d="M200 52 L240 44 L280 36 L320 26 L320 50 L280 54 L240 58 L200 52 Z" fill="rgba(67,229,160,.14)"></path>
                <path className="mk-draw" d="M200 52 L240 46 L280 41 L320 38" fill="none" stroke="#43E5A0" strokeWidth="2.5"></path>
                <line x1="200" y1="10" x2="200" y2="112" stroke="#2A3436" strokeWidth="1"></line>
                <text x="204" y="20" fill="#7F8C88" fontSize="11" fontFamily="Geist Mono, monospace">
                  {"today"}
                </text>
              </svg>
              {" "}
              <p style={{ margin: "0", color: "#A3B0AC", lineHeight: "1.6", fontSize: "15px" }}>
                {"One series or thousands, always with the range of likely outcomes — and tested on weeks the model never saw."}
              </p>
              {" "}
            </div>
            {" "}
            <div className="mk-lift" style={{ border: "1px solid #1F2729", background: "#0B0F10", borderRadius: "24px", padding: "28px", display: "flex", flexDirection: "column", gap: "14px" }}>
              {" "}
              <span className="mk-mono" style={{ fontSize: "12px", color: "#43E5A0" }}>
                {"SPACES"}
              </span>
              {" "}
              <h3 style={{ margin: "0", fontWeight: "800", fontSize: "24px", letterSpacing: "-0.03em" }}>
                {"A room for every team."}
              </h3>
              {" "}
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {" "}
                <div style={{ display: "flex", alignItems: "center", gap: "10px", border: "1px solid #1F2729", borderRadius: "12px", padding: "11px 12px" }}>
                  <span style={{ width: "10px", height: "10px", borderRadius: "3px", background: "#43E5A0" }}></span>
                  <span style={{ fontWeight: "600" }}>
                    {"Marketing & Brand"}
                  </span>
                  <span className="mk-mono" style={{ marginLeft: "auto", fontSize: "11px", color: "#7F8C88" }}>
                    {"8 sources"}
                  </span>
                </div>
                {" "}
                <div style={{ display: "flex", alignItems: "center", gap: "10px", border: "1px solid #1F2729", borderRadius: "12px", padding: "11px 12px" }}>
                  <span style={{ width: "10px", height: "10px", borderRadius: "3px", background: "#7AA7FF" }}></span>
                  <span style={{ fontWeight: "600" }}>
                    {"Sales"}
                  </span>
                  <span className="mk-mono" style={{ marginLeft: "auto", fontSize: "11px", color: "#7F8C88" }}>
                    {"4 sources"}
                  </span>
                </div>
                {" "}
                <div style={{ display: "flex", alignItems: "center", gap: "10px", border: "1px solid #1F2729", borderRadius: "12px", padding: "11px 12px" }}>
                  <span style={{ width: "10px", height: "10px", borderRadius: "3px", background: "#A3B0AC" }}></span>
                  <span style={{ fontWeight: "600" }}>
                    {"Finance"}
                  </span>
                  <span className="mk-mono" style={{ marginLeft: "auto", fontSize: "11px", color: "#7F8C88" }}>
                    {"private"}
                  </span>
                </div>
                {" "}
              </div>
              {" "}
              <p style={{ margin: "0", color: "#A3B0AC", lineHeight: "1.6", fontSize: "15px" }}>
                {"Group sources by team and ask a Space. Access always follows the data — a Space never shows what someone couldn’t already see."}
              </p>
              {" "}
            </div>
            {" "}
            <div className="mk-lift" style={{ border: "1px solid #1F2729", background: "#0B0F10", borderRadius: "24px", padding: "28px", display: "flex", flexDirection: "column", gap: "14px" }}>
              {" "}
              <span className="mk-mono" style={{ fontSize: "12px", color: "#43E5A0" }}>
                {"DASHBOARDS"}
              </span>
              {" "}
              <h3 style={{ margin: "0", fontWeight: "800", fontSize: "24px", letterSpacing: "-0.03em" }}>
                {"From answer to board in one click."}
              </h3>
              {" "}
              <div style={{ height: "112px", display: "flex", alignItems: "flex-end", gap: "8px", borderBottom: "1px solid #1F2729" }}>
                {" "}
                {(V.bars || []).map((b: any, i1: number) => (
                  <Fragment key={i1}>
                    <div className="mk-rise" style={{ flex: "1", height: `${b.h}px`, background: b.c, borderRadius: "4px 4px 0 0", animationDelay: b.d }}></div>
                  </Fragment>
                ))}
                {" "}
              </div>
              {" "}
              <p style={{ margin: "0", color: "#A3B0AC", lineHeight: "1.6", fontSize: "15px" }}>
                {"Live tiles, cross-filters and freshness for every source — shared by link or on your own domain."}
              </p>
              {" "}
            </div>
            {" "}
            <div style={{ gridColumn: "1 / -1", minWidth: "0", border: "1px solid #1F2729", background: "linear-gradient(160deg, #102019, #0B0F10 60%)", borderRadius: "24px", padding: "clamp(24px, 3.4vw, 36px)", display: "flex", flexWrap: "wrap", gap: "32px", alignItems: "center" }}>
              {" "}
              <div style={{ flex: "1 1 340px", display: "flex", flexDirection: "column", gap: "12px" }}>
                {" "}
                <span className="mk-mono" style={{ fontSize: "12px", color: "#43E5A0" }}>
                  {"ML STUDIO · 21 KINDS OF MODEL"}
                </span>
                {" "}
                <h3 style={{ margin: "0", fontWeight: "800", fontSize: "clamp(26px, 3vw, 36px)", letterSpacing: "-0.035em", lineHeight: "1.05" }}>
                  {"Predictions from a sentence."}
                </h3>
                {" "}
                <p style={{ margin: "0", color: "#A3B0AC", lineHeight: "1.65", fontSize: "16px" }}>
                  {"Say “which customers will stop buying?” GD360 builds the label from order history, the features at the right point in time and a fair test; checks for leaks; trains several models against a baseline — and explains every score. Learn from one source, several joined on a shared key, or a whole Space. Never a silent sample."}
                </p>
                {" "}
              </div>
              {" "}
              <div style={{ flex: "1 1 420px", minWidth: "0", display: "flex", flexDirection: "column", gap: "10px" }}>
                {" "}
                <span className="mk-mono" style={{ fontSize: "11.5px", color: "#7F8C88" }}>
                  {"Illustrative leaderboard · tested on the most recent 20%"}
                </span>
                {" "}
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 150px) minmax(0,1fr) 48px", gap: "12px", alignItems: "center", fontSize: "14px" }}>
                  <span>
                    {"Gradient boosting"}
                  </span>
                  <span style={{ height: "10px", background: "#141A1B", borderRadius: "4px" }}>
                    <span className="mk-grow mk-g1" style={{ display: "block", height: "10px", width: "88%", background: "#43E5A0", borderRadius: "4px" }}></span>
                  </span>
                  <span className="mk-mono">
                    {"0.88"}
                  </span>
                </div>
                {" "}
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 150px) minmax(0,1fr) 48px", gap: "12px", alignItems: "center", fontSize: "14px" }}>
                  <span>
                    {"Random forest"}
                  </span>
                  <span style={{ height: "10px", background: "#141A1B", borderRadius: "4px" }}>
                    <span className="mk-grow mk-g2" style={{ display: "block", height: "10px", width: "84%", background: "#2C9C6F", borderRadius: "4px" }}></span>
                  </span>
                  <span className="mk-mono">
                    {"0.84"}
                  </span>
                </div>
                {" "}
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 150px) minmax(0,1fr) 48px", gap: "12px", alignItems: "center", fontSize: "14px" }}>
                  <span>
                    {"Linear model"}
                  </span>
                  <span style={{ height: "10px", background: "#141A1B", borderRadius: "4px" }}>
                    <span className="mk-grow mk-g3" style={{ display: "block", height: "10px", width: "78%", background: "#2C9C6F", borderRadius: "4px" }}></span>
                  </span>
                  <span className="mk-mono">
                    {"0.78"}
                  </span>
                </div>
                {" "}
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 150px) minmax(0,1fr) 48px", gap: "12px", alignItems: "center", fontSize: "14px" }}>
                  <span style={{ color: "#7F8C88" }}>
                    {"Baseline to beat"}
                  </span>
                  <span style={{ height: "10px", background: "#141A1B", borderRadius: "4px" }}>
                    <span className="mk-grow mk-g4" style={{ display: "block", height: "10px", width: "61%", background: "#2A3436", borderRadius: "4px" }}></span>
                  </span>
                  <span className="mk-mono" style={{ color: "#7F8C88" }}>
                    {"0.61"}
                  </span>
                </div>
                {" "}
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "8px" }}>
                  {" "}
                  {(V.kinds || []).map((k: any, i1: number) => (
                    <Fragment key={i1}>
                      <span style={{ border: "1px solid #1F2729", background: "#0E1213", borderRadius: "999px", padding: "6px 11px", fontSize: "13px", color: "#D5DEDB" }}>
                        {k}
                      </span>
                    </Fragment>
                  ))}
                  {" "}
                </div>
                {" "}
              </div>
              {" "}
            </div>
            {" "}
            <div style={{ gridColumn: "1 / -1", minWidth: "0", border: "1px solid #1F2729", background: "#0B0F10", borderRadius: "24px", padding: "clamp(24px, 3.4vw, 36px)", display: "flex", flexDirection: "column", gap: "18px" }}>
              {" "}
              <span className="mk-mono" style={{ fontSize: "12px", color: "#43E5A0" }}>
                {"AUTOMATIONS"}
              </span>
              {" "}
              <p style={{ margin: "0", fontWeight: "700", fontSize: "clamp(22px, 2.8vw, 36px)", lineHeight: "1.28", letterSpacing: "-0.025em", textWrap: "balance" }}>
                <span style={{ color: "#7AA7FF" }}>
                  {"When"}
                </span>
                {" weekly revenue drops more than 10%, "}
                <span style={{ color: "#43E5A0" }}>
                  {"run"}
                </span>
                {" a full analysis — then "}
                <span style={{ color: "#F2B84B" }}>
                  {"tell"}
                </span>
                {" the leadership channel, only if something changed."}
              </p>
              {" "}
              <div style={{ position: "relative", height: "44px", borderRadius: "999px", border: "1px solid #1F2729", overflow: "hidden" }}>
                {" "}
                <div className="mk-beam"></div>
                {" "}
                <div className="mk-mono" style={{ position: "relative", display: "flex", justifyContent: "space-between", gap: "10px", height: "100%", alignItems: "center", padding: "0 18px", fontSize: "clamp(10px, 1vw, 12px)", color: "#A3B0AC" }}>
                  <span>
                    {"WHEN · schedule, new data, threshold"}
                  </span>
                  <span>
                    {"DO · refresh, check, re-score"}
                  </span>
                  <span>
                    {"TELL · email, Slack, Teams"}
                  </span>
                </div>
                {" "}
              </div>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
      </section>
      {" "}
      <section className="mk-m-sec" id="pulse" style={{ padding: "104px 24px", background: "#0B0F10", borderTop: "1px solid #141A1B", borderBottom: "1px solid #141A1B" }}>
        {" "}
        <div style={{ maxWidth: "1280px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "40px" }}>
          {" "}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "28px", justifyContent: "space-between", alignItems: "flex-end" }}>
            {" "}
            <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "760px" }}>
              {" "}
              <span className="mk-mono" style={{ fontSize: "12.5px", letterSpacing: "0.16em", color: "#43E5A0" }}>
                {"ALWAYS WATCHING"}
              </span>
              {" "}
              <h2 style={{ margin: "0", fontWeight: "800", fontSize: "clamp(34px, 4.6vw, 62px)", lineHeight: "1", letterSpacing: "-0.045em", textWrap: "balance" }}>
                {"It notices before you do."}
              </h2>
              {" "}
            </div>
            {" "}
            <p style={{ margin: "0", maxWidth: "420px", color: "#A3B0AC", fontSize: "16.5px", lineHeight: "1.6" }}>
              {"From “something’s off” to “fixed” before lunch — the alert, the cause and the proof arrive together."}
            </p>
            {" "}
          </div>
          {" "}
          <div style={{ border: "1px solid #1F2729", background: "#07090A", borderRadius: "24px", padding: "clamp(16px, 2.4vw, 28px)", display: "flex", flexDirection: "column", gap: "14px" }}>
            {" "}
            <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", alignItems: "baseline" }}>
              {" "}
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <span style={{ fontSize: "14px", color: "#A3B0AC" }}>
                  {"Daily revenue"}
                </span>
                <span style={{ fontWeight: "800", fontSize: "clamp(26px, 3vw, 38px)", letterSpacing: "-0.04em" }}>
                  {"$412.3k "}
                  <span className="mk-mono" style={{ fontSize: "15px", fontWeight: "500", color: "#FF7A6B" }}>
                    {"−12.4% vs last month"}
                  </span>
                </span>
              </div>
              {" "}
              <span className="mk-mono" style={{ fontSize: "11.5px", color: "#7F8C88" }}>
                {"Sample data · Snowflake + Google Ads + Postgres"}
              </span>
              {" "}
            </div>
            {" "}
            <div style={{ position: "relative", width: "100%", aspectRatio: "1200 / 380" }}>
              {" "}
              <svg viewBox="0 0 1200 380" role="img" aria-label="Daily revenue rises, drops sharply on 30 September, then recovers after the budget is restored" style={{ position: "absolute", inset: "0", width: "100%", height: "100%" }}>
                <defs>
                  <linearGradient id="homeFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#43E5A0" stopOpacity=".28"></stop>
                    <stop offset="1" stopColor="#43E5A0" stopOpacity="0"></stop>
                  </linearGradient>
                </defs>
                <line x1="0" y1="95" x2="1200" y2="95" stroke="#141A1B"></line>
                <line x1="0" y1="190" x2="1200" y2="190" stroke="#141A1B"></line>
                <line x1="0" y1="285" x2="1200" y2="285" stroke="#141A1B"></line>
                <rect className="mk-zone" x="770" y="20" width="230" height="330" fill="rgba(255,122,107,.07)"></rect>
                <path className="mk-area" d="M0 250 L60 240 L120 245 L180 225 L240 230 L300 210 L360 215 L420 195 L480 200 L540 185 L600 190 L660 175 L720 180 L770 176 L800 252 L850 264 L900 258 L950 266 L1000 256 L1040 226 L1100 206 L1160 196 L1200 190 L1200 350 L0 350 Z" fill="url(#homeFill)"></path>
                <path className="mk-line" d="M0 250 L60 240 L120 245 L180 225 L240 230 L300 210 L360 215 L420 195 L480 200 L540 185 L600 190 L660 175 L720 180 L770 176 L800 252 L850 264 L900 258 L950 266 L1000 256 L1040 226 L1100 206 L1160 196 L1200 190" fill="none" stroke="#43E5A0" strokeWidth="3" strokeLinejoin="round"></path>
                <circle cx="800" cy="252" r="7" fill="#FF7A6B"></circle>
                <circle className="mk-pin" cx="800" cy="252" r="7" fill="none" stroke="#FF7A6B" strokeWidth="2"></circle>
                <circle cx="1040" cy="226" r="7" fill="#43E5A0"></circle>
                <circle className="mk-pin" cx="1040" cy="226" r="7" fill="none" stroke="#43E5A0" strokeWidth="2"></circle>
                <text x="0" y="372" fill="#6F7C78" fontSize="13" fontFamily="Geist Mono, monospace">
                  {"1 Sep"}
                </text>
                <text x="560" y="372" fill="#6F7C78" fontSize="13" fontFamily="Geist Mono, monospace">
                  {"15 Sep"}
                </text>
                <text x="1130" y="372" fill="#6F7C78" fontSize="13" fontFamily="Geist Mono, monospace">
                  {"14 Oct"}
                </text>
              </svg>
              {" "}
              <div className="mk-call mk-d-only" style={{ position: "absolute", left: "49%", top: "76%", maxWidth: "46%", border: "1px solid #5C2A24", background: "rgba(46,21,19,.94)", borderRadius: "12px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "4px" }}>
                <span className="mk-mono" style={{ fontSize: "11px", color: "#FF7A6B" }}>
                  {"30 SEP · CAUSE FOUND"}
                </span>
                <span style={{ fontSize: "clamp(11px, 1.2vw, 14px)", lineHeight: "1.4" }}>
                  {"Brand – US budget cut $1,200 → $500 a day: "}
                  <b>
                    {"−$43.0k"}
                  </b>
                </span>
              </div>
              {" "}
              <div className="mk-call mk-cl2 mk-d-only" style={{ position: "absolute", right: "2%", top: "14%", maxWidth: "40%", border: "1px solid #24413A", background: "rgba(19,35,32,.95)", borderRadius: "12px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "4px" }}>
                <span className="mk-mono" style={{ fontSize: "11px", color: "#43E5A0" }}>
                  {"7 OCT · BUDGET RESTORED"}
                </span>
                <span style={{ fontSize: "clamp(11px, 1.2vw, 14px)", lineHeight: "1.4" }}>
                  {"Revenue recovering — #revenue notified"}
                </span>
              </div>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
          <div className="mk-m-rail" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px" }}>
            {" "}
            {(V.story || []).map((s: any, i1: number) => (
              <Fragment key={i1}>
                {" "}
                <div className={`mk-tl ${s.cls ? "mk-" + s.cls : ""}`} style={{ border: "1px solid #1F2729", background: "#0B0F10", borderRadius: "18px", padding: "22px", display: "flex", flexDirection: "column", gap: "10px" }}>
                  {" "}
                  <span className="mk-mono" style={{ fontSize: "13px", color: "#43E5A0" }}>
                    {s.time}
                  </span>
                  {" "}
                  <span style={{ fontWeight: "700", fontSize: "19px" }}>
                    {s.t}
                  </span>
                  {" "}
                  <span style={{ color: "#A3B0AC", fontSize: "14.5px", lineHeight: "1.6" }}>
                    {s.d}
                  </span>
                  {" "}
                </div>
                {" "}
              </Fragment>
            ))}
            {" "}
          </div>
          {" "}
        </div>
        {" "}
      </section>
      {" "}
      <section className="mk-m-sec" id="teams" style={{ padding: "112px 24px" }}>
        {" "}
        <div style={{ maxWidth: "1280px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "40px" }}>
          {" "}
          <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "820px" }}>
            {" "}
            <span className="mk-mono" style={{ fontSize: "12.5px", letterSpacing: "0.16em", color: "#43E5A0" }}>
              {"SOLUTIONS"}
            </span>
            {" "}
            <h2 style={{ margin: "0", fontWeight: "800", fontSize: "clamp(34px, 4.6vw, 62px)", lineHeight: "1", letterSpacing: "-0.045em", textWrap: "balance" }}>
              {"Built for the questions every team actually asks."}
            </h2>
            {" "}
          </div>
          {" "}
          <div className="mk-m-rail" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px" }}>
            {" "}
            {(V.teams || []).map((t: any, i1: number) => (
              <Fragment key={i1}>
                {" "}
                <div className="mk-lift" style={{ border: "1px solid #1F2729", background: "#0B0F10", borderRadius: "22px", padding: "26px", display: "flex", flexDirection: "column", gap: "12px" }}>
                  {" "}
                  <span style={{ fontWeight: "700", fontSize: "18px", color: "#43E5A0" }}>
                    {t.n}
                  </span>
                  {" "}
                  <p style={{ margin: "0", fontSize: "18px", lineHeight: "1.45", color: "#E8EEEC", fontWeight: "500" }}>
                    {"“"}{t.q}{"”"}
                  </p>
                  {" "}
                  <p style={{ margin: "0", fontSize: "14.5px", lineHeight: "1.6", color: "#A3B0AC" }}>
                    {t.d}
                  </p>
                  {" "}
                  <span className="mk-mono" style={{ fontSize: "11.5px", color: "#7F8C88", borderTop: "1px solid #1F2729", paddingTop: "12px", marginTop: "auto" }}>
                    {t.s}
                  </span>
                  {" "}
                </div>
                {" "}
              </Fragment>
            ))}
            {" "}
          </div>
          {" "}
        </div>
        {" "}
      </section>
      {" "}
      <section className="mk-m-sec" id="security" style={{ padding: "104px 24px", background: "#0B0F10", borderTop: "1px solid #141A1B", borderBottom: "1px solid #141A1B" }}>
        {" "}
        <div style={{ maxWidth: "1280px", margin: "0 auto", display: "flex", flexWrap: "wrap", gap: "56px" }}>
          {" "}
          <div style={{ flex: "1 1 360px", display: "flex", flexDirection: "column", gap: "18px" }}>
            {" "}
            <span className="mk-mono" style={{ fontSize: "12.5px", letterSpacing: "0.16em", color: "#43E5A0" }}>
              {"ENTERPRISE-GRADE"}
            </span>
            {" "}
            <h2 style={{ margin: "0", fontWeight: "800", fontSize: "clamp(34px, 4.4vw, 58px)", lineHeight: "1", letterSpacing: "-0.045em", textWrap: "balance" }}>
              {"Secure by design, not by add-on."}
            </h2>
            {" "}
            <p style={{ margin: "0", color: "#A3B0AC", fontSize: "16.5px", lineHeight: "1.65" }}>
              {"GD360 never writes to your systems and never moves raw rows. Every question keeps its plan, SQL, results and answer together — so any number can be traced months later, by you, your auditor or your board."}
            </p>
            {" "}
            <A href="/pricing#enterprise" style={{ fontWeight: "600", fontSize: "15.5px" }}>
              {"Enterprise plans and security review →"}
            </A>
            {" "}
          </div>
          {" "}
          <dl style={{ flex: "1 1 620px", margin: "0", borderTop: "1px solid #2A3436" }}>
            {" "}
            {(V.spec || []).map((s: any, i1: number) => (
              <Fragment key={i1}>
                {" "}
                <div className="mk-m-spec" style={{ display: "grid", gridTemplateColumns: "minmax(130px, 210px) minmax(0, 1fr)", gap: "20px", padding: "18px 0", borderBottom: "1px solid #1F2729" }}>
                  <dt className="mk-mono" style={{ fontSize: "12.5px", color: "#43E5A0" }}>
                    {s.k}
                  </dt>
                  <dd style={{ margin: "0", fontSize: "16px", lineHeight: "1.55" }}>
                    {s.v}
                  </dd>
                </div>
                {" "}
              </Fragment>
            ))}
            {" "}
          </dl>
          {" "}
        </div>
        {" "}
      </section>
      {" "}
      <section style={{ padding: "104px 24px 0" }}>
        {" "}
        <div className="mk-m-num" style={{ maxWidth: "1280px", margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1px", background: "#1F2729", border: "1px solid #1F2729", borderRadius: "26px", overflow: "hidden" }}>
          {" "}
          <div className="mk-m-numcell" style={{ background: "#07090A", padding: "34px", display: "flex", flexDirection: "column", gap: "8px" }}>
            <span className="mk-m-numbig" style={{ fontWeight: "900", fontSize: "64px", color: "#43E5A0", letterSpacing: "-0.05em" }}>
              {"71"}
            </span>
            <span style={{ color: "#A3B0AC", fontSize: "15.5px", lineHeight: "1.5" }}>
              {"sources in the catalog, from warehouses to social pages"}
            </span>
          </div>
          {" "}
          <div className="mk-m-numcell" style={{ background: "#07090A", padding: "34px", display: "flex", flexDirection: "column", gap: "8px" }}>
            <span className="mk-m-numbig" style={{ fontWeight: "900", fontSize: "64px", letterSpacing: "-0.05em" }}>
              {"21"}
            </span>
            <span style={{ color: "#A3B0AC", fontSize: "15.5px", lineHeight: "1.5" }}>
              {"kinds of model, from churn to price sensitivity"}
            </span>
          </div>
          {" "}
          <div className="mk-m-numcell" style={{ background: "#07090A", padding: "34px", display: "flex", flexDirection: "column", gap: "8px" }}>
            <span className="mk-m-numbig" style={{ fontWeight: "900", fontSize: "64px", letterSpacing: "-0.05em" }}>
              {"5"}
            </span>
            <span style={{ color: "#A3B0AC", fontSize: "15.5px", lineHeight: "1.5" }}>
              {"checked layers between your question and its proof"}
            </span>
          </div>
          {" "}
          <div className="mk-m-numcell" style={{ background: "#07090A", padding: "34px", display: "flex", flexDirection: "column", gap: "8px" }}>
            <span className="mk-m-numbig" style={{ fontWeight: "900", fontSize: "64px", color: "#43E5A0", letterSpacing: "-0.05em" }}>
              {"0"}
            </span>
            <span style={{ color: "#A3B0AC", fontSize: "15.5px", lineHeight: "1.5" }}>
              {"raw rows moved — only small aggregates leave your systems"}
            </span>
          </div>
          {" "}
        </div>
        {" "}
      </section>
      {" "}
      <section id="early-access" style={{ padding: "104px 24px" }}>
        <div style={{ maxWidth: "1280px", margin: "0 auto" }}>
          <div className="gd-ea gd-ea-xl">
            <div className="gd-ea-copy">
              <span className="gd-ea-eyebrow"><span className="gd-ea-dot"></span>{"EARLY ACCESS · OPEN NOW"}</span>
              <h2 className="gd-ea-title">{"Every feature. "}<span className="mk-sheen">{"No cost while we launch."}</span></h2>
              <p className="gd-ea-text">{"GD360 is in early access. Create a workspace and use the whole product — 71 connectors, Spaces, ML Studio, dashboards and automations. Everything you build stays yours when plans go live."}</p>
              <div className="gd-ea-points">
                <span>{"✓ No card needed"}</span>
                <span>{"✓ The full product"}</span>
                <span>{"✓ Keep all your work"}</span>
              </div>
              <div><A href="/start" className="gd-ea-go">{"Get early access →"}</A></div>
            </div>
            <div className="gd-ea-side">
              <span className="gd-soon-chip gd-soon-chip-lg"><span className="gd-ea-dot gd-ea-dot-amber"></span>{"PRICING · COMING SOON"}</span>
              <p className="gd-ea-side-text">{"Per-user plans for individuals, teams and whole companies are on their way. Early-access workspaces hear first."}</p>
              <ul className="gd-ea-list">
                <li><span>{"Plus"}</span><em>{"For individuals"}</em></li>
                <li><span>{"Team"}</span><em>{"For teams on many tools"}</em></li>
                <li><span>{"Business"}</span><em>{"For several teams"}</em></li>
                <li><span>{"Enterprise"}</span><em>{"Company-wide roll-outs"}</em></li>
              </ul>
            </div>
          </div>
        </div>
      </section>
      {" "}
      <section style={{ position: "relative", padding: "128px 24px 140px", textAlign: "center", borderTop: "1px solid #141A1B", overflow: "hidden" }}>
        {" "}
        <div className="mk-gridbg" style={{ position: "absolute", inset: "0", pointerEvents: "none" }}></div>
        {" "}
        <div className="mk-aur mk-aur1" style={{ left: "50%", top: "-120px", marginLeft: "-380px", width: "760px", height: "520px", background: "rgba(67,229,160,.15)" }}></div>
        {" "}
        <div style={{ position: "relative", maxWidth: "940px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "26px", alignItems: "center" }}>
          {" "}
          <div style={{ position: "relative", width: "92px", height: "92px" }}>
            {" "}
            <span className="mk-wave"></span>
            <span className="mk-wave mk-wv2"></span>
            {" "}
            <div className="mk-core" style={{ position: "absolute", inset: "0", borderRadius: "26px", background: "#43E5A0", color: "#04140D", display: "grid", placeItems: "center", fontWeight: "900", fontSize: "40px" }}>
              {"G"}
            </div>
            {" "}
          </div>
          {" "}
          <h2 style={{ margin: "0", fontWeight: "900", fontSize: "clamp(42px, 7vw, 104px)", lineHeight: "0.94", letterSpacing: "-0.055em", textWrap: "balance" }}>
            {"Ask the question you’ve been "}
            <span className="mk-sheen">
              {"putting off."}
            </span>
          </h2>
          {" "}
          <p style={{ margin: "0", color: "#A3B0AC", fontSize: "19px", lineHeight: "1.55", maxWidth: "620px" }}>
            {"Connect your first source in minutes. Your first answer — with its proof — arrives in seconds."}
          </p>
          {" "}
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", justifyContent: "center" }}>
            {" "}
            <A href="/start" style={{ background: "#43E5A0", color: "#04140D", fontWeight: "700", fontSize: "17px", padding: "18px 32px", borderRadius: "999px", boxShadow: "0 18px 50px -18px rgba(67,229,160,.7)" }}>
              {"Get early access"}
            </A>
            {" "}
            <A href="#see" style={{ border: "1px solid #2A3436", color: "#E8EEEC", fontWeight: "500", fontSize: "17px", padding: "18px 30px", borderRadius: "999px" }}>
              {"See it work"}
            </A>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
      </section>
      {" "}
      <footer style={{ borderTop: "1px solid #141A1B", padding: "72px 24px 36px", background: "#050707" }}>
        {" "}
        <div style={{ maxWidth: "1280px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "52px" }}>
          {" "}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "48px", justifyContent: "space-between" }}>
            {" "}
            <div style={{ flex: "1 1 300px", display: "flex", flexDirection: "column", gap: "16px", maxWidth: "380px" }}>
              {" "}
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <span style={{ width: "32px", height: "32px", borderRadius: "9px", background: "#43E5A0", color: "#04140D", display: "grid", placeItems: "center", fontWeight: "900", fontSize: "16px" }}>
                  {"G"}
                </span>
                <span style={{ fontWeight: "800", fontSize: "19px" }}>
                  {"GD360"}
                </span>
              </div>
              {" "}
              <p style={{ margin: "0", color: "#A3B0AC", fontSize: "15px", lineHeight: "1.6" }}>
                {"The AI analyst that shows its work. Every source, one answer — proven."}
              </p>
              {" "}
            </div>
            {" "}
            <div className="mk-m-foot" style={{ display: "flex", flexWrap: "wrap", gap: "60px" }}>
              {" "}
              <div style={{ display: "flex", flexDirection: "column", gap: "11px", fontSize: "14.5px" }}>
                <span className="mk-mono" style={{ fontSize: "11.5px", letterSpacing: "0.12em", color: "#7F8C88" }}>
                  {"PRODUCT"}
                </span>
                <A href="#see" style={{ color: "#A3B0AC" }}>
                  {"How it works"}
                </A>
                <A href="#platform" style={{ color: "#A3B0AC" }}>
                  {"Platform"}
                </A>
                <A href="#platform" style={{ color: "#A3B0AC" }}>
                  {"ML Studio"}
                </A>
                <A href="#platform" style={{ color: "#A3B0AC" }}>
                  {"Automations"}
                </A>
                <A href="/pricing" style={{ color: "#A3B0AC" }}>
                  {"Pricing"}
                </A>
              </div>
              {" "}
              <div style={{ display: "flex", flexDirection: "column", gap: "11px", fontSize: "14.5px" }}>
                <span className="mk-mono" style={{ fontSize: "11.5px", letterSpacing: "0.12em", color: "#7F8C88" }}>
                  {"COMPANY"}
                </span>
                <A href="/about" style={{ color: "#A3B0AC" }}>
                  {"About us"}
                </A>
                <A href="/about" style={{ color: "#A3B0AC" }}>
                  {"Investors"}
                </A>
                <A href="/about" style={{ color: "#A3B0AC" }}>
                  {"Careers"}
                </A>
                <A href="/about" style={{ color: "#A3B0AC" }}>
                  {"Contact"}
                </A>
              </div>
              {" "}
              <div style={{ display: "flex", flexDirection: "column", gap: "11px", fontSize: "14.5px" }}>
                <span className="mk-mono" style={{ fontSize: "11.5px", letterSpacing: "0.12em", color: "#7F8C88" }}>
                  {"TRUST"}
                </span>
                <A href="#security" style={{ color: "#A3B0AC" }}>
                  {"Security"}
                </A>
                <A href="/privacy" style={{ color: "#A3B0AC" }}>
                  {"Privacy policy"}
                </A>
                <A href="/privacy" style={{ color: "#A3B0AC" }}>
                  {"Terms of service"}
                </A>
                <A href="/privacy" style={{ color: "#A3B0AC" }}>
                  {"Data processing"}
                </A>
              </div>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", justifyContent: "space-between", borderTop: "1px solid #141A1B", paddingTop: "24px", fontSize: "13.5px", color: "#7F8C88" }}>
            {" "}
            <span>
              {"© 2026 GD360. All rights reserved."}
            </span>
            {" "}
            <span>
              {"GD360 and the GD360 logo are trademarks of GD360. Other names are trademarks of their respective owners."}
            </span>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
      </footer>
      {" "}
      <div className="mk-m-only" style={{ height: "84px" }}></div>
      {" "}
      <div className="mk-m-only">
        {" "}
        <div style={{ position: "fixed", left: "0", right: "0", bottom: "0", zIndex: "40", padding: "10px 16px calc(10px + env(safe-area-inset-bottom, 0px))", background: "rgba(7,9,10,.9)", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", borderTop: "1px solid #1F2729", display: "flex", alignItems: "center", gap: "10px" }}>
          {" "}
          <A href="#see" style={{ flex: "1", height: "50px", border: "1px solid #2A3436", borderRadius: "999px", display: "grid", placeItems: "center", color: "#E8EEEC", fontWeight: "600", fontSize: "15px" }}>
            {"See it work"}
          </A>
          {" "}
          <A href="/start" style={{ flex: "1.5", height: "50px", borderRadius: "999px", background: "#43E5A0", color: "#04140D", display: "grid", placeItems: "center", fontWeight: "700", fontSize: "15.5px", boxShadow: "0 12px 34px -14px rgba(67,229,160,.8)" }}>
            {"Get early access"}
          </A>
          {" "}
        </div>
        {" "}
      </div>
      {" "}
    </div>
  );
}

// Generated from the approved "GD360 Website — Final" mockup (About.dc.html).
// Markup, inline styles and motion are kept exactly as designed; the
// page's CSS (animations, hover states) lives in marketing.css, scoped
// under .mkt-about.
import { Fragment, useState } from "react";
import { A, useMarketingPage } from "../shared";
import "../marketing.css";
import { DEFAULT_FOUNDER_BIO, SITE } from "../site";

/* eslint-disable @typescript-eslint/no-explicit-any */
function vals(state: any, setState: (patch: any) => void): any {

    const R = {
      principles: [
        { n: "01", t: "Show the work", d: "Every number links to the query and source behind it. If we can’t prove it, we don’t say it." },
        { n: "02", t: "Data stays where it lives", d: "We query your systems in place, read-only, and bring back only what the answer needs." },
        { n: "03", t: "Plain words over jargon", d: "A founder and a data engineer should both find the answer clear on first read." },
        { n: "04", t: "Never a silent shortcut", d: "No hidden sampling, no invented columns. If something was left out, we say what and why." },
        { n: "05", t: "Access follows the data", d: "Nobody sees a row or column through GD360 they couldn’t see at the source." }
      ],
      log: [
        { when: "SEP 2026", delay: "0s", t: "The analyst engine", x: "Questions to SQL across databases and files, dashboards from any answer, and a leak guardrail for machine learning." },
        { when: "SEP 2026", delay: "0.5s", t: "Warehouses, natively", x: "BigQuery and Snowflake queried in place, with cost estimates and daily caps." },
        { when: "OCT 2026", delay: "1s", t: "Lineage and live dashboards", x: "A map of where every number flows; cross-filtering dashboards with freshness per source." },
        { when: "OCT 2026", delay: "1.5s", t: "One question, every source", x: "A reviewed plan, pushed-down queries and answers that pass a number check." },
        { when: "OCT 2026", delay: "2s", t: "Automations", x: "When something happens, do the work and tell the right people — by email or Slack." },
        { when: "OCT 2026", delay: "2.5s", t: "ML Studio", x: "21 kinds of model from a sentence, tested on rows they never saw and explained per row." },
        { when: "OCT 2026", delay: "3s", t: "Spaces and a 71-source catalog", x: "Team Spaces, social and marketing connectors, and models that learn from joined sources." }
      ]
    };

    const __menu = !!(state && state.menu);
    R.menu = __menu;
    R.menuExpanded = __menu ? "true" : "false";
    R.openMenu = () => setState({ menu: true });
    R.closeMenu = () => setState({ menu: false });
    R.menuLinks = [{ t: "Product", href: "/#see" }, { t: "Platform", href: "/#platform" }, { t: "Solutions", href: "/#teams" }, { t: "Security", href: "/#security" }, { t: "Pricing", href: "/pricing" }, { t: "About", href: "/about" }].map((x, i) => ({ ...x, cls: "ml" + (i + 1) }));
    return R;
  
}

export default function MarketingAbout() {
  useMarketingPage("GD360 — About us");
  const [state, setS] = useState<any>({ menu: false });
  const setState = (patch: any) => setS((prev: any) => ({ ...prev, ...patch }));
  const V = vals(state, setState);
  return (
    <div className="mkt-about" style={{ fontFamily: "Geist, 'Helvetica Neue', system-ui, sans-serif", color: "#E8EEEC", background: "#07090A", minHeight: "100vh", overflowX: "clip" }}>
      {" "}
      <header className="mk-site-head" style={{ position: "relative", zIndex: "5", borderBottom: "1px solid #141A1B", background: "rgba(7,9,10,.82)" }}>
        {" "}
        <nav className="mk-site-nav" aria-label="Main" style={{ maxWidth: "1280px", margin: "0 auto", padding: "16px 24px", display: "flex", alignItems: "center", gap: "30px", flexWrap: "wrap" }}>
          {" "}
          <A href="/" style={{ display: "flex", alignItems: "center", gap: "10px", color: "#E8EEEC" }}>
            <span style={{ width: "34px", height: "34px", borderRadius: "10px", background: "#43E5A0", color: "#04140D", display: "grid", placeItems: "center", fontWeight: "900", fontSize: "17px", boxShadow: "0 0 24px rgba(67,229,160,.35)" }}>
              {"G"}
            </span>
            <span style={{ fontWeight: "800", fontSize: "20px", letterSpacing: "-0.02em" }}>
              {"GD360"}
            </span>
          </A>
          {" "}
          <div className="mk-navlinks mk-d-only" style={{ display: "flex", gap: "26px", flexWrap: "wrap", fontSize: "15px", flex: "1 1 auto" }}>
            <A href="/#see" style={{ color: "#A3B0AC" }}>
              {"Product"}
            </A>
            <A href="/#platform" style={{ color: "#A3B0AC" }}>
              {"Platform"}
            </A>
            <A href="/#teams" style={{ color: "#A3B0AC" }}>
              {"Solutions"}
            </A>
            <A href="/#security" style={{ color: "#A3B0AC" }}>
              {"Security"}
            </A>
            <A href="/pricing" style={{ color: "#A3B0AC" }}>
              {"Pricing"}
            </A>
            <A href="/about" style={{ color: "#E8EEEC", fontWeight: "600" }}>
              {"About"}
            </A>
          </div>
          {" "}
          <div className="mk-d-only" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <A href="/login" style={{ color: "#E8EEEC", fontSize: "15px", padding: "10px 14px" }}>
              {"Sign in"}
            </A>
            <A href="/start" style={{ background: "#43E5A0", color: "#04140D", fontWeight: "700", fontSize: "15px", padding: "12px 20px", borderRadius: "999px", minHeight: "44px", boxSizing: "border-box", display: "inline-flex", alignItems: "center", gap: "8px" }}>
              {"Get started "}
              <span aria-hidden="true">
                {"→"}
              </span>
            </A>
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
      <section className="mk-m-hero" style={{ position: "relative", padding: "104px 24px 96px" }}>
        {" "}
        <div className="mk-gridbg" style={{ position: "absolute", inset: "0", pointerEvents: "none" }}></div>
        {" "}
        <div className="mk-aur" style={{ right: "-120px", top: "-80px", width: "700px", height: "700px", background: "rgba(67,229,160,.15)" }}></div>
        {" "}
        <div style={{ position: "relative", maxWidth: "1280px", margin: "0 auto", display: "flex", flexWrap: "wrap", gap: "56px", alignItems: "center" }}>
          {" "}
          <div style={{ flex: "1 1 640px", minWidth: "0", display: "flex", flexDirection: "column", gap: "28px" }}>
            {" "}
            <span className="mk-mono mk-w mk-d1" style={{ fontSize: "12.5px", letterSpacing: "0.16em", color: "#43E5A0" }}>
              {"ABOUT GD360"}
            </span>
            {" "}
            <h1 className="mk-m-h1" style={{ margin: "0", fontWeight: "900", fontSize: "clamp(46px, 7.4vw, 112px)", lineHeight: "0.93", letterSpacing: "-0.055em", textWrap: "balance" }}>
              <span className="mk-w mk-d2">
                {"The analyst every company"}
              </span>
              {" "}
              <span className="mk-w mk-d3">
                <span className="mk-sheen">
                  {"deserves."}
                </span>
              </span>
            </h1>
            {" "}
            <p className="mk-w mk-d4" style={{ margin: "0", fontSize: "clamp(18px, 1.8vw, 22px)", lineHeight: "1.6", color: "#A3B0AC", maxWidth: "680px" }}>
              {"The best-run companies have data teams that turn every question into a clear, defensible answer. Most companies never will. GD360 exists to close that gap — for every team, in plain words, with the proof attached."}
            </p>
            {" "}
          </div>
          {" "}
          <div className="mk-d-only" style={{ flex: "1 1 360px", display: "grid", placeItems: "center" }}>
            {" "}
            <div style={{ position: "relative", width: "min(380px, 80vw)", aspectRatio: "1" }}>
              {" "}
              <div className="mk-ring" style={{ inset: "0" }}></div>
              <div className="mk-ring" style={{ inset: "18%" }}></div>
              <div className="mk-ring" style={{ inset: "36%" }}></div>
              {" "}
              <div className="mk-comet" style={{ inset: "0" }}></div>
              <div className="mk-comet" style={{ inset: "18%", animationDuration: "15s", animationDirection: "reverse" }}></div>
              {" "}
              <div style={{ position: "absolute", inset: "38%", borderRadius: "30%", background: "#43E5A0", color: "#04140D", display: "grid", placeItems: "center", fontWeight: "900", fontSize: "clamp(28px, 4vw, 44px)", boxShadow: "0 0 120px 20px rgba(67,229,160,.3)" }}>
                {"G"}
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
      <section style={{ padding: "104px 24px", borderTop: "1px solid #141A1B", borderBottom: "1px solid #141A1B", background: "#0B0F10" }}>
        {" "}
        <div style={{ maxWidth: "1120px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "24px" }}>
          {" "}
          <span className="mk-mono" style={{ fontSize: "12.5px", letterSpacing: "0.16em", color: "#43E5A0" }}>
            {"OUR MISSION"}
          </span>
          {" "}
          <p className="mk-reveal" style={{ margin: "0", fontWeight: "800", fontSize: "clamp(32px, 4.8vw, 66px)", lineHeight: "1.08", letterSpacing: "-0.04em", textWrap: "balance" }}>
            {"Make every company as smart about its own data as the best-run companies in the world — without hiring a data team."}
          </p>
          {" "}
        </div>
        {" "}
      </section>
      {" "}
      <section style={{ padding: "120px 24px" }}>
        {" "}
        <div style={{ maxWidth: "1280px", margin: "0 auto", display: "flex", flexWrap: "wrap", gap: "64px" }}>
          {" "}
          <div style={{ flex: "1 1 360px", display: "flex", flexDirection: "column", gap: "16px" }}>
            {" "}
            <span className="mk-mono" style={{ fontSize: "12.5px", letterSpacing: "0.16em", color: "#43E5A0" }}>
              {"WHY WE BUILT IT"}
            </span>
            {" "}
            <h2 style={{ margin: "0", fontWeight: "800", fontSize: "clamp(34px, 4.6vw, 60px)", lineHeight: "1", letterSpacing: "-0.045em", textWrap: "balance" }}>
              {"Answers were trapped in a dozen tools."}
            </h2>
            {" "}
          </div>
          {" "}
          <div style={{ flex: "1 1 640px", display: "flex", flexDirection: "column", gap: "22px", fontSize: "19px", lineHeight: "1.75", color: "#C9D3D0" }}>
            {" "}
            <p style={{ margin: "0" }}>
              {"Every growing company runs on data it can’t easily use. Orders sit in a warehouse, spend in ad platforms, traffic in analytics, deals in a CRM, audience on social pages. The people who need answers — founders, marketers, finance leads — wait days for a report, or give up and guess."}
            </p>
            {" "}
            <p style={{ margin: "0" }}>
              {"AI promised to fix this. Chatbots that invent numbers made it worse. A figure nobody can trace is a figure nobody can act on."}
            </p>
            {" "}
            <p style={{ margin: "0", color: "#E8EEEC", fontWeight: "500" }}>
              {"So we built GD360 the way a great analyst works: understand the business first, plan before running anything, query each source where it lives, and show the work behind every number. Fast enough for a founder. Rigorous enough for a CFO."}
            </p>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
      </section>
      {" "}
      <section style={{ padding: "0 24px 120px" }}>
        {" "}
        <div style={{ maxWidth: "1280px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "40px" }}>
          {" "}
          <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "780px" }}>
            <span className="mk-mono" style={{ fontSize: "12.5px", letterSpacing: "0.16em", color: "#43E5A0" }}>
              {"WHAT WE BELIEVE"}
            </span>
            <h2 style={{ margin: "0", fontWeight: "800", fontSize: "clamp(34px, 4.6vw, 60px)", lineHeight: "1", letterSpacing: "-0.045em" }}>
              {"Five principles behind every screen."}
            </h2>
          </div>
          {" "}
          <div className="mk-m-rail" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "14px" }}>
            {" "}
            {(V.principles || []).map((p: any, i1: number) => (
              <Fragment key={i1}>
                {" "}
                <div className="mk-lift" style={{ border: "1px solid #1F2729", background: "#0B0F10", borderRadius: "22px", padding: "26px", display: "flex", flexDirection: "column", gap: "12px" }}>
                  {" "}
                  <span className="mk-mono" style={{ fontSize: "38px", fontWeight: "600", color: "#24413A" }}>
                    {p.n}
                  </span>
                  {" "}
                  <h3 style={{ margin: "0", fontSize: "20px", fontWeight: "800", letterSpacing: "-0.02em" }}>
                    {p.t}
                  </h3>
                  {" "}
                  <p style={{ margin: "0", color: "#A3B0AC", lineHeight: "1.6", fontSize: "15px" }}>
                    {p.d}
                  </p>
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
      <section style={{ padding: "0 24px 120px" }}>
        {" "}
        <div style={{ maxWidth: "1280px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "40px" }}>
          {" "}
          <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "760px" }}>
            <span className="mk-mono" style={{ fontSize: "12.5px", letterSpacing: "0.16em", color: "#43E5A0" }}>
              {"THE TEAM"}
            </span>
            <h2 style={{ margin: "0", fontWeight: "800", fontSize: "clamp(34px, 4.6vw, 60px)", lineHeight: "1", letterSpacing: "-0.045em" }}>
              {"Founder-led. Held to one standard."}
            </h2>
          </div>
          {" "}
          <div className="mk-m-rail" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px" }}>
            {" "}
            <div style={{ border: "1px solid #24413A", background: "linear-gradient(160deg, #102019, #0B0F10 70%)", borderRadius: "26px", padding: "30px", display: "flex", flexDirection: "column", gap: "18px" }}>
              {" "}
              <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                {" "}
                <span style={{ width: "76px", height: "76px", borderRadius: "22px", background: "#132320", border: "1px solid #24413A", display: "grid", placeItems: "center", fontWeight: "900", fontSize: "26px", color: "#43E5A0" }}>
                  {"GD"}
                </span>
                {" "}
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <span style={{ fontWeight: "800", fontSize: "21px" }}>
                    {SITE.founderName}
                  </span>
                  <span style={{ color: "#43E5A0", fontSize: "15px" }}>
                    {SITE.founderRole}
                  </span>
                </div>
                {" "}
              </div>
              {" "}
              <p style={{ margin: "0", color: "#A3B0AC", fontSize: "15.5px", lineHeight: "1.65" }}>
                {SITE.founderBio || DEFAULT_FOUNDER_BIO}
              </p>
              {" "}
              {(SITE.founderLinkedIn || SITE.founderEmail) && (
                <span className="mk-mono" style={{ fontSize: "12px", color: "#7F8C88", display: "flex", gap: "10px" }}>
                  {SITE.founderLinkedIn && <A href={SITE.founderLinkedIn} target="_blank" rel="noreferrer" style={{ color: "#A3B0AC" }}>LinkedIn</A>}
                  {SITE.founderLinkedIn && SITE.founderEmail && <span>·</span>}
                  {SITE.founderEmail && <A href={"mailto:" + SITE.founderEmail} style={{ color: "#A3B0AC" }}>{SITE.founderEmail}</A>}
                </span>
              )}
              {" "}
            </div>
            {" "}
            <div className="mk-lift" style={{ border: "1px solid #1F2729", background: "#0B0F10", borderRadius: "26px", padding: "30px", display: "flex", flexDirection: "column", gap: "14px", justifyContent: "center" }}>
              {" "}
              <span style={{ fontWeight: "800", fontSize: "21px" }}>
                {"Join us"}
              </span>
              {" "}
              <p style={{ margin: "0", color: "#A3B0AC", fontSize: "15.5px", lineHeight: "1.65" }}>
                {"We’re looking for people who care about craft, data and honesty in equal measure — engineers, designers and data scientists."}
              </p>
              {" "}
              <A href={SITE.careersEmail ? "mailto:" + SITE.careersEmail : "/pricing#enterprise"} style={{ fontWeight: "600", fontSize: "15.5px" }}>
                {"See open roles →"}
              </A>
              {" "}
            </div>
            {" "}
            <div className="mk-lift" style={{ border: "1px solid #1F2729", background: "#0B0F10", borderRadius: "26px", padding: "30px", display: "flex", flexDirection: "column", gap: "14px", justifyContent: "center" }}>
              {" "}
              <span style={{ fontWeight: "800", fontSize: "21px" }}>
                {"Design partners"}
              </span>
              {" "}
              <p style={{ margin: "0", color: "#A3B0AC", fontSize: "15.5px", lineHeight: "1.65" }}>
                {"We build alongside the teams who use GD360 every day. Join early, shape the roadmap and lock in a founding rate."}
              </p>
              {" "}
              <A href={SITE.helloEmail ? "mailto:" + SITE.helloEmail : "/pricing#enterprise"} style={{ fontWeight: "600", fontSize: "15.5px" }}>
                {"Become a design partner →"}
              </A>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
      </section>
      {" "}
      <section style={{ padding: "0 24px 120px" }}>
        {" "}
        <div style={{ maxWidth: "1280px", margin: "0 auto", border: "1px solid #24413A", borderRadius: "30px", padding: "clamp(28px, 5vw, 64px)", background: "radial-gradient(ellipse at 90% 0%, rgba(67,229,160,.17), rgba(7,9,10,0) 55%), #0B0F10", display: "flex", flexDirection: "column", gap: "40px" }}>
          {" "}
          <h2 style={{ margin: "0", fontWeight: "900", fontSize: "clamp(36px, 5vw, 72px)", lineHeight: "0.98", letterSpacing: "-0.05em" }}>
            {"Let’s talk."}
          </h2>
          {" "}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "28px" }}>
            {" "}
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid #24413A", paddingTop: "20px" }}>
              <span style={{ fontWeight: "800", fontSize: "19px" }}>
                {"Enterprise"}
              </span>
              <span style={{ color: "#A3B0AC", fontSize: "15px", lineHeight: "1.6" }}>
                {"Company-wide roll-out, security review and a live demo on your data."}
              </span>
              <A href="/pricing#enterprise" style={{ fontWeight: "600" }}>
                {"Book an enterprise demo →"}
              </A>
            </div>
            {" "}
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid #24413A", paddingTop: "20px" }}>
              <span style={{ fontWeight: "800", fontSize: "19px" }}>
                {"Investors"}
              </span>
              <span style={{ color: "#A3B0AC", fontSize: "15px", lineHeight: "1.6" }}>
                {"The investor brief and a product walkthrough."}
              </span>
              <A href={SITE.investorsEmail ? "mailto:" + SITE.investorsEmail : "/pricing#enterprise"} style={{ fontWeight: "600" }}>
                {"Request the investor brief →"}
              </A>
            </div>
            {" "}
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid #24413A", paddingTop: "20px" }}>
              <span style={{ fontWeight: "800", fontSize: "19px" }}>
                {"Press and partners"}
              </span>
              <span style={{ color: "#A3B0AC", fontSize: "15px", lineHeight: "1.6" }}>
                {"Integrations, partnerships and media."}
              </span>
              <A href={SITE.helloEmail ? "mailto:" + SITE.helloEmail : "/pricing#enterprise"} style={{ fontWeight: "600" }}>
                {"Get in touch →"}
              </A>
            </div>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
      </section>
      {" "}
      <footer style={{ borderTop: "1px solid #141A1B", padding: "56px 24px 36px", background: "#050707" }}>
        {" "}
        <div style={{ maxWidth: "1280px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "40px" }}>
          {" "}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "40px", justifyContent: "space-between", alignItems: "center" }}>
            {" "}
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ width: "32px", height: "32px", borderRadius: "9px", background: "#43E5A0", color: "#04140D", display: "grid", placeItems: "center", fontWeight: "900", fontSize: "16px" }}>
                {"G"}
              </span>
              <span style={{ fontWeight: "800", fontSize: "19px" }}>
                {"GD360"}
              </span>
              <span style={{ color: "#7F8C88", fontSize: "14.5px", marginLeft: "8px" }}>
                {"Every source. One answer. Proven."}
              </span>
            </div>
            {" "}
            <div style={{ display: "flex", gap: "22px", flexWrap: "wrap", fontSize: "14.5px" }}>
              <A href="/#see" style={{ color: "#A3B0AC" }}>
                {"Product"}
              </A>
              <A href="/pricing" style={{ color: "#A3B0AC" }}>
                {"Pricing"}
              </A>
              <A href="/about" style={{ color: "#A3B0AC" }}>
                {"About us"}
              </A>
              <A href="/#security" style={{ color: "#A3B0AC" }}>
                {"Security"}
              </A>
              <A href="/privacy" style={{ color: "#A3B0AC" }}>
                {"Privacy"}
              </A>
              <A href="/privacy" style={{ color: "#A3B0AC" }}>
                {"Terms"}
              </A>
            </div>
            {" "}
          </div>
          {" "}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", justifyContent: "space-between", borderTop: "1px solid #141A1B", paddingTop: "24px", fontSize: "13.5px", color: "#7F8C88" }}>
            <span>
              {"© 2026 GD360. All rights reserved."}
            </span>
            {SITE.legalLine && (
              <span>
                {SITE.legalLine}
              </span>
            )}
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
          <A href="/pricing" style={{ flex: "1", height: "50px", border: "1px solid #2A3436", borderRadius: "999px", display: "grid", placeItems: "center", color: "#E8EEEC", fontWeight: "600", fontSize: "15px" }}>
            {"See pricing"}
          </A>
          {" "}
          <A href="/start" style={{ flex: "1.5", height: "50px", borderRadius: "999px", background: "#43E5A0", color: "#04140D", display: "grid", placeItems: "center", fontWeight: "700", fontSize: "15.5px", boxShadow: "0 12px 34px -14px rgba(67,229,160,.8)" }}>
            {"Get started"}
          </A>
          {" "}
        </div>
        {" "}
      </div>
      {" "}
    </div>
  );
}

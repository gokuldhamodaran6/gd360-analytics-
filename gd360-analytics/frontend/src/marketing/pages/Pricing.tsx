// Generated from the approved "GD360 Website — Final" mockup (Pricing.dc.html).
// Markup, inline styles and motion are kept exactly as designed; the
// page's CSS (animations, hover states) lives in marketing.css, scoped
// under .mkt-pricing.
import { EulivMark, Wordmark } from "../../components/Brand";
import { FormEvent, Fragment, useEffect, useState } from "react";
import { api } from "../../api/client";
import { v2Api } from "../../api/v2";
import { CompareTable, PlanCards, type Catalog } from "../../plans/PlanParts";
import { errorText } from "../shared";
import { A, useMarketingPage } from "../shared";
import "../marketing.css";

/* eslint-disable @typescript-eslint/no-explicit-any */
function vals(state: any, setState: (patch: any) => void): any {
    const R: any = {
      entItems: ["A live demo on your own sources", "Custom limits and terms", "Security review, governance and access design", "Guided roll-out for every team", "A named contact and custom terms"],
    };
    const __menu = !!(state && state.menu);
    R.menu = __menu;
    R.menuExpanded = __menu ? "true" : "false";
    R.openMenu = () => setState({ menu: true });
    R.closeMenu = () => setState({ menu: false });
    R.menuLinks = [{ t: "Product", href: "/#see" }, { t: "Platform", href: "/#platform" }, { t: "Solutions", href: "/#teams" }, { t: "Security", href: "/#security" }, { t: "Pricing", href: "/pricing" }, { t: "About", href: "/about" }].map((x, i) => ({ ...x, cls: "ml" + (i + 1) }));
    return R;
  
}

// 2026-10-17 (R52): the plans in the one design system (src/plans), from the catalog the app meters - the same cards
// and table the in-app Plan & usage page shows, so the two can never disagree. The early-access promise is said once.
function PlansPublic() {
  const [plans, setPlans] = useState<Catalog | null>(null);
  const [enforced, setEnforced] = useState(false);
  const [seats, setSeats] = useState(5);
  useEffect(() => { v2Api.publicPlans().then((d) => { setPlans(d.plans); setEnforced(d.enforced); }).catch(() => setPlans(null)); }, []);
  const team = plans?.team?.price || {};
  const per = typeof team.usd_seat_month === "number" ? team.usd_seat_month : null;
  const min = team.min_seats || 3;
  const n = Math.max(min, seats);
  return (
    <div className="pl pl-dark" data-pl-public="">
      <div className="pl-pub">
        <section className="pl-hero" aria-labelledby="pl-h1">
          <span className="pl-eb">Pricing</span>
          <h1 id="pl-h1">Every feature on every plan.</h1>
          <p>Plans differ by people, data, governance and where it runs, never by hiding a capability. {enforced ? "" : "During early access every account has the whole product free; these prices apply at launch, and you hear first."}</p>
          <div className="pl-row">
            <A href="/start" className="pl-btn p">Start free</A>
            <A href="#enterprise" className="pl-btn">Talk to us</A>
          </div>
        </section>
        {plans && (
          <section aria-label="Plans" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <PlanCards plans={plans} enforced={enforced} action={(k) => <A href={k === "enterprise" ? "#enterprise" : `/start?plan=${k}`} className={`pl-btn${k === "team" ? " p" : ""}`}>{k === "free" ? "Start free" : k === "enterprise" ? "Talk to us" : `Start with ${plans[k].label}`}</A>} />
          </section>
        )}
        {plans && (
          <section aria-labelledby="pl-cmp" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <h2 id="pl-cmp" style={{ fontSize: "clamp(24px, 3vw, 34px)", fontWeight: 800 }}>Limits side by side</h2>
            <CompareTable plans={plans} />
          </section>
        )}
        {per != null && (
          <section aria-labelledby="pl-calc" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <h2 id="pl-calc" style={{ fontSize: "clamp(24px, 3vw, 34px)", fontWeight: 800 }}>What Team costs</h2>
            <div className="pl-calc" data-pl-calc="">
              <label style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <span style={{ fontSize: 15 }}><b>{n}</b> people <span style={{ color: "var(--pl-ink3)" }}>· {min} or more</span></span>
                <input type="range" min={min} max={200} value={n} onChange={(e) => setSeats(Number(e.target.value))} aria-label="People on the Team plan" />
              </label>
              <div className="tot" data-pl-total="">${(per * n).toLocaleString("en-US")}<span>a month at launch · ${per} a person</span></div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function PlansFaq() {
  const faq = [
    ["Is early access really free?", "Yes. Every feature, no card, no trial clock."],
    ["When do these prices apply?", "At launch. Early-access users hear first, with notice, before anything about their account changes."],
    ["Are the limits enforced now?", "No. Your Plan & usage page shows what you use against the plan, so nothing surprises you later."],
    ["What happens to my work at launch?", "Nothing moves. Sources, dashboards, documents and models stay where they are."],
    ["Who should talk to us?", "Teams rolling Euliv out company-wide, and anyone who needs it in their own cloud or warehouse."],
  ];
  return (
    <div className="pl pl-dark">
      <div className="pl-pub" style={{ paddingTop: 0, paddingBottom: 96 }}>
        <section aria-labelledby="pl-faq" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <span className="pl-eb">Questions</span>
          <h2 id="pl-faq" style={{ fontSize: "clamp(28px, 3.6vw, 44px)", fontWeight: 800 }}>Short answers.</h2>
          <div className="pl-faq">{faq.map(([q, a]) => <div key={q}><b>{q}</b><span>{a}</span></div>)}</div>
        </section>
      </div>
    </div>
  );
}

export default function MarketingPricing() {
  useMarketingPage("Euliv — Pricing");
  const [state, setS] = useState<any>({ menu: false, mplan: "team", annual: false, calc: "team", users: 5 });
  const setState = (patch: any) => setS((prev: any) => ({ ...prev, ...patch }));
  const V = vals(state, setState);
  // 2026-10-09: the Enterprise demo request is saved for the team (POST /site/demo-request).
  const [demo, setDemo] = useState({ name: "", email: "", company: "", team_size: "50–200 people", question: "" });
  const [demoState, setDemoState] = useState<"" | "sending" | "sent">("");
  const [demoError, setDemoError] = useState("");
  const field = (k: string) => (e: any) => setDemo((d) => ({ ...d, [k]: e.target.value }));
  const onDemo = async (e: FormEvent) => {
    e.preventDefault();
    setDemoError("");
    if (!demo.name.trim() || !/^\S+@\S+\.\S+$/.test(demo.email.trim())) {
      setDemoError("Please add your name and a work email.");
      return;
    }
    setDemoState("sending");
    try {
      await api.post("/site/demo-request", demo);
      setDemoState("sent");
    } catch (err: any) {
      setDemoState("");
      setDemoError(errorText(err, "Couldn't send that - please try again in a moment."));
    }
  };
  return (
    <div className="mkt-pricing" style={{ fontFamily: "Geist, 'Helvetica Neue', system-ui, sans-serif", color: "#E8EEEC", background: "#07090A", minHeight: "100vh", overflowX: "clip" }}>
      {" "}
      <header className="mk-site-head" style={{ position: "relative", zIndex: "5", borderBottom: "1px solid #141A1B", background: "rgba(7,9,10,.82)" }}>
        {" "}
        <nav className="mk-site-nav" aria-label="Main" style={{ maxWidth: "1280px", margin: "0 auto", padding: "16px 24px", display: "flex", alignItems: "center", gap: "30px", flexWrap: "wrap" }}>
          {" "}
          <A href="/" style={{ display: "flex", alignItems: "center", gap: "10px", color: "#E8EEEC" }}>
            <EulivMark size={34} tone="bright" /> <Wordmark size={22} tone="bright" />
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
            <A href="/pricing" style={{ color: "#E8EEEC", fontWeight: "600" }}>
              {"Pricing"}
            </A>
            <A href="/about" style={{ color: "#A3B0AC" }}>
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
                  <EulivMark size={34} tone="bright" /> <Wordmark size={22} tone="bright" />
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
      <PlansPublic />
      {" "}
      <section id="enterprise" style={{ padding: "0 24px 104px" }}>
        {" "}
        <div style={{ maxWidth: "1280px", margin: "0 auto", border: "1px solid #24413A", borderRadius: "30px", background: "radial-gradient(ellipse at 90% 0%, rgba(67,229,160,.17), rgba(7,9,10,0) 55%), #0B0F10", padding: "clamp(28px, 5vw, 64px)", display: "flex", flexWrap: "wrap", gap: "48px", alignItems: "flex-start" }}>
          {" "}
          <div style={{ flex: "1 1 460px", display: "flex", flexDirection: "column", gap: "20px" }}>
            {" "}
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              {" "}
              <div style={{ position: "relative", width: "52px", height: "52px" }}>
                <span className="mk-wave"></span>
                <span className="mk-wave mk-wv2"></span>
                <div style={{ position: "absolute", inset: "0", borderRadius: "16px", background: "#0E1513", color: "#04140D", display: "grid", placeItems: "center", fontWeight: "900", fontSize: "22px" }}>
<EulivMark size={30} tone="bright" />
</div>
              </div>
              {" "}
              <span className="mk-mono" style={{ fontSize: "12.5px", letterSpacing: "0.16em", color: "#43E5A0" }}>
                {"ENTERPRISE"}
              </span>
              {" "}
            </div>
            {" "}
            <h2 style={{ margin: "0", fontWeight: "900", fontSize: "clamp(34px, 4.6vw, 64px)", lineHeight: "0.98", letterSpacing: "-0.05em", textWrap: "balance" }}>
              {"Rolling Euliv out across the company?"}
            </h2>
            {" "}
            <p style={{ margin: "0", color: "#A3B0AC", fontSize: "17px", lineHeight: "1.65", maxWidth: "560px" }}>
              {"See Euliv answer your hardest question on your own sources, live. We’ll walk your team through security, governance and roll-out — and shape a plan around how you work."}
            </p>
            {" "}
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {" "}
              {(V.entItems || []).map((e: any, i1: number) => (
                <Fragment key={i1}>
                  <div style={{ display: "flex", gap: "12px", alignItems: "flex-start", fontSize: "15.5px", lineHeight: "1.5", color: "#D5DEDB" }}>
                    <span aria-hidden="true" style={{ flex: "none", width: "24px", height: "24px", borderRadius: "24px", border: "1px solid #24413A", background: "#132320", color: "#43E5A0", display: "grid", placeItems: "center", fontSize: "11px" }}>
                      {"✓"}
                    </span>
                    <span>
                      {e}
                    </span>
                  </div>
                </Fragment>
              ))}
              {" "}
            </div>
            {" "}
          </div>
          {" "}
          <form onSubmit={onDemo} noValidate style={{ flex: "1 1 420px", border: "1px solid #2A3436", background: "#07090A", borderRadius: "24px", padding: "30px", display: "flex", flexDirection: "column", gap: "16px" }}>
            {" "}
            <span style={{ fontWeight: "800", fontSize: "22px", letterSpacing: "-0.02em" }}>
              {"Book an enterprise demo"}
            </span>
            {" "}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "12px" }}>
              {" "}
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13.5px", color: "#A3B0AC" }}>
                {"Full name"}
                <input type="text" required autoComplete="name" value={demo.name} onChange={field("name")} placeholder="Your name" style={{ height: "48px", border: "1px solid #2A3436", borderRadius: "12px", padding: "0 14px", fontSize: "16px", fontFamily: "inherit", background: "#0B0F10", color: "#E8EEEC" }} />
              </label>
              {" "}
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13.5px", color: "#A3B0AC" }}>
                {"Work email"}
                <input type="email" required autoComplete="email" value={demo.email} onChange={field("email")} placeholder="you@company.com" style={{ height: "48px", border: "1px solid #2A3436", borderRadius: "12px", padding: "0 14px", fontSize: "16px", fontFamily: "inherit", background: "#0B0F10", color: "#E8EEEC" }} />
              </label>
              {" "}
            </div>
            {" "}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "12px" }}>
              {" "}
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13.5px", color: "#A3B0AC" }}>
                {"Company"}
                <input type="text" autoComplete="organization" value={demo.company} onChange={field("company")} placeholder="Company name" style={{ height: "48px", border: "1px solid #2A3436", borderRadius: "12px", padding: "0 14px", fontSize: "16px", fontFamily: "inherit", background: "#0B0F10", color: "#E8EEEC" }} />
              </label>
              {" "}
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13.5px", color: "#A3B0AC" }}>
                {"Team size"}
                <select value={demo.team_size} onChange={field("team_size")} style={{ height: "48px", border: "1px solid #2A3436", borderRadius: "12px", padding: "0 12px", fontSize: "16px", fontFamily: "inherit", background: "#0B0F10", color: "#E8EEEC" }}>
                  <option>
                    {"50–200 people"}
                  </option>
                  <option>
                    {"200–1,000 people"}
                  </option>
                  <option>
                    {"1,000–5,000 people"}
                  </option>
                  <option>
                    {"5,000+ people"}
                  </option>
                </select>
              </label>
              {" "}
            </div>
            {" "}
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13.5px", color: "#A3B0AC" }}>
              {"The question you want answered"}
              <textarea rows={3} value={demo.question} onChange={field("question")} placeholder="e.g. Which campaigns bring customers who come back?" style={{ border: "1px solid #2A3436", borderRadius: "12px", padding: "12px 14px", fontSize: "16px", fontFamily: "inherit", resize: "vertical", background: "#0B0F10", color: "#E8EEEC" }}></textarea>
            </label>
            {" "}
            {demoError && (
              <span role="alert" style={{ fontSize: "14px", color: "#FF7A6B" }}>{demoError}</span>
            )}
            <button type="submit" disabled={demoState !== ""} style={{ height: "54px", border: "0", borderRadius: "999px", background: "#43E5A0", color: "#04140D", fontSize: "16.5px", fontWeight: "700", fontFamily: "inherit", cursor: demoState ? "default" : "pointer", opacity: demoState === "sending" ? 0.75 : 1, boxShadow: "0 18px 50px -18px rgba(67,229,160,.7)" }}>
              {demoState === "sent" ? "Request received ✓" : demoState === "sending" ? "Sending…" : "Book a demo"}
            </button>
            {" "}
            <span className="mk-mono" style={{ fontSize: "11.5px", color: "#7F8C88" }}>
              {demoState === "sent" ? "Thank you — a product specialist will reply to confirm a time." : "A product specialist will reply to confirm a time."}
            </span>
            {" "}
          </form>
          {" "}
        </div>
        {" "}
      </section>
      {" "}
      <PlansFaq />
      {" "}
      <footer style={{ borderTop: "1px solid #141A1B", padding: "56px 24px 36px", background: "#050707" }}>
        {" "}
        <div style={{ maxWidth: "1280px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "40px" }}>
          {" "}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "40px", justifyContent: "space-between", alignItems: "center" }}>
            {" "}
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <EulivMark size={32} tone="bright" /> <Wordmark size={21} tone="bright" />
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
              {"© 2026 Euliv. All rights reserved."}
            </span>
            <span>
              {"Prices in USD per user, excluding applicable taxes."}
            </span>
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
        <div style={{ position: "fixed", left: "0", right: "0", bottom: "0", zIndex: "40", padding: "10px 16px calc(10px + env(safe-area-inset-bottom, 0px))", background: "rgba(7,9,10,.9)", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", borderTop: "1px solid #1F2729", display: "flex", alignItems: "center", gap: "12px" }}>
          {" "}
          <div style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column", gap: "2px" }}>
            {" "}
            <span style={{ fontWeight: "800", fontSize: "16px", letterSpacing: "-0.01em" }}>
              {"Early access"}
            </span>
            {" "}
            <span className="mk-mono" style={{ fontSize: "11px", color: "#7F8C88", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {"Every feature · free while we launch"}
            </span>
            {" "}
          </div>
          {" "}
          <A href="/start" style={{ flex: "none", height: "50px", padding: "0 22px", borderRadius: "999px", background: "#43E5A0", color: "#04140D", display: "grid", placeItems: "center", fontWeight: "700", fontSize: "15.5px", boxShadow: "0 12px 34px -14px rgba(67,229,160,.8)" }}>
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

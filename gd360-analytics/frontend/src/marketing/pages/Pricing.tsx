// Generated from the approved "GD360 Website — Final" mockup (Pricing.dc.html).
// Markup, inline styles and motion are kept exactly as designed; the
// page's CSS (animations, hover states) lives in marketing.css, scoped
// under .mkt-pricing.
import { FormEvent, Fragment, useState } from "react";
import { api } from "../../api/client";
import { errorText } from "../shared";
import { A, useMarketingPage } from "../shared";
import "../marketing.css";

/* eslint-disable @typescript-eslint/no-explicit-any */
function vals(state: any, setState: (patch: any) => void): any {

    const s = state || {};
    const annual = !!s.annual;
    const money = (n) => "$" + (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    const T = [
      { id: "plus", name: "Plus", m: null, for: "For individuals who want answers every day.", lead: "INCLUDES", min: 1, chats: 200, src: 5,
        limits: [{ k: "AI chats / month", v: "200", pct: 20 }, { k: "Data sources", v: "5", pct: 20 }, { k: "Users", v: "1", pct: 6 }],
        items: ["Every database, files and Google Sheets", "5 dashboards with daily refresh", "ML Studio — 5 trainings a month", "2 automations", "Answers with proof, password-protected links"], cta: "Coming soon", href: "/start" },
      { id: "team", name: "Team", m: null, popular: true, for: "For teams that run on many tools and work together.", lead: "EVERYTHING IN PLUS, AND", min: 3, chats: 500, src: 25,
        limits: [{ k: "AI chats / user / month", v: "500", pct: 50 }, { k: "Data sources", v: "25", pct: 60 }, { k: "Users", v: "3 or more", pct: 40 }],
        items: ["Snowflake, BigQuery and synced apps — ads, store, CRM, social", "Spaces for every team", "ML Studio — all 21 kinds, 50 trainings", "20 automations, hourly refresh", "Row and column access rules"], cta: "Coming soon", href: "/start" },
      { id: "business", name: "Business", m: null, for: "For companies with several teams and higher volumes.", lead: "EVERYTHING IN TEAM, AND", min: 10, chats: 2000, src: 0,
        limits: [{ k: "AI chats / user / month", v: "2,000", pct: 85 }, { k: "Data sources", v: "Unlimited", pct: 100 }, { k: "Users", v: "10 or more", pct: 70 }],
        items: ["Unlimited dashboards, Spaces and automations", "Higher daily warehouse budget", "Custom domain for shared dashboards", "Refresh every 15 minutes", "Priority support"], cta: "Coming soon", href: "/start" },
      { id: "enterprise", name: "Enterprise", m: null, for: "For company-wide roll-outs with security review.", lead: "EVERYTHING IN BUSINESS, AND", min: 0,
        limits: [{ k: "AI chats", v: "Custom", pct: 100 }, { k: "Data sources", v: "Unlimited", pct: 100 }, { k: "Users", v: "Unlimited", pct: 100 }],
        items: ["Custom limits and terms", "Security review and governance support", "Guided onboarding for every team", "Named contact and custom terms"], cta: "Book a demo", href: "#enterprise" }
    ];
    const unit = (t) => annual ? Math.round((t.m * 10 / 12) * 100) / 100 : t.m;
    const plans = T.map((t) => {
      const custom = t.m == null;
      return {
        ...t, popular: !!t.popular, href: t.href === "/start" ? "/start?plan=" + t.id + (annual ? "&billing=annual" : "") : t.href,
        price: custom ? "Custom" : money(unit(t)),
        per: custom ? "" : "/ user / month",
        note: custom ? "Annual agreement, invoiced" : (annual ? money(t.m * 10) + " per user, billed yearly" : "Billed monthly, cancel any time") + (t.min > 1 ? " · minimum " + t.min + " users" : ""),
        wrap: t.popular ? "shine" : "",
        border: t.popular ? "transparent" : "#1F2729", bg: t.popular ? "#0E1A16" : "#0B0F10",
        ctaBg: t.popular ? "#43E5A0" : "transparent", ctaInk: t.popular ? "#04140D" : "#E8EEEC", ctaBorder: t.popular ? "#43E5A0" : "#2A3436"
      };
    });
    const pick = T.find((t) => t.id === (s.calc || "team")) || T[1];
    const users = Math.max(pick.min, s.users || 1);
    const perUser = unit(pick);
    const total = Math.round(perUser * users * 100) / 100;
    const Y = "✓", N = "—";
    const cell = (t, i) => ({ t, c: t === N ? "#4B5A57" : (t === Y ? "#43E5A0" : "#E8EEEC"), bg: i === 1 ? "#0F1A16" : "transparent" });
    const row = (f, v) => ({ f, v: v.map(cell) });
    const R = {
      isMonthly: annual ? "false" : "true", isAnnual: annual ? "true" : "false",
      setMonthly: () => setState({ annual: false }), setAnnual: () => setState({ annual: true }),
      mBg: annual ? "transparent" : "#43E5A0", mInk: annual ? "#A3B0AC" : "#04140D",
      aBg: annual ? "#43E5A0" : "transparent", aInk: annual ? "#04140D" : "#A3B0AC",
      plans,
      calcHref: "/start?plan=" + pick.id + "&users=" + users + (annual ? "&billing=annual" : ""),
      calcPlans: T.filter((t) => t.m != null).map((t) => {
        const on = t.id === pick.id;
        return { name: t.name, unit: money(unit(t)), on: on ? "true" : "false",
          pick: () => setState({ calc: t.id, users: Math.max(t.min, (state && state.users) || 1) }),
          border: on ? "#43E5A0" : "#2A3436", bg: on ? "#132320" : "#0E1213", ink: on ? "#43E5A0" : "#E8EEEC" };
      }),
      users,
      less: () => setState({ users: Math.max(pick.min, users - 1) }),
      more: () => setState({ users: Math.min(500, users + 1) }),
      minNote: pick.min > 1 ? "minimum " + pick.min : "",
      calcLabel: pick.name + " · " + users + (users === 1 ? " user" : " users") + (annual ? " · billed yearly" : " · billed monthly"),
      total: money(total),
      totalNote: annual ? money(Math.round(total * 12)) + " a year — you save " + money(Math.round(pick.m * users * 2)) : "Pay yearly and save " + money(Math.round(pick.m * users * 2)) + " a year",
      chatsTotal: (pick.chats * users).toLocaleString("en-US") + " AI chats a month for your workspace",
      sourcesTotal: pick.src ? pick.src + " data sources" : "Unlimited data sources",
      groups: [
        { g: "USAGE", rows: [
          row("Price per user / month", ["TBA", "TBA", "TBA", "TBA"]),
          row("Users", ["1", "3 or more", "10 or more", "Unlimited"]),
          row("AI chats per month", ["200", "500 per user", "2,000 per user", "Custom"]),
          row("Data sources", ["5", "25", "Unlimited", "Unlimited"]),
          row("ML Studio trainings per month", ["5", "50", "250", "Custom"]),
          row("Dashboards", ["5", "50", "Unlimited", "Unlimited"]),
          row("Automations", ["2", "20", "Unlimited", "Unlimited"])
        ]},
        { g: "SOURCES", rows: [
          row("Files, CSV, Excel and Google Sheets", [Y, Y, Y, Y]),
          row("Databases: Postgres, MySQL, SQL Server, MongoDB, Supabase", [Y, Y, Y, Y]),
          row("Warehouses: Snowflake and BigQuery", [N, Y, Y, Y]),
          row("Synced apps: ads, GA4, store, CRM, social pages", [N, Y, Y, Y]),
          row("REST API connector", [N, Y, Y, Y]),
          row("Warehouse cost budget per day", [N, "Standard", "High", "Custom"])
        ]},
        { g: "WORK TOGETHER", rows: [
          row("Spaces for each team", [N, Y, Y, Y]),
          row("Row and column access rules", [N, Y, Y, Y]),
          row("Scheduled refresh", ["Daily", "Hourly", "Every 15 min", "Every 15 min"]),
          row("Password-protected links", [Y, Y, Y, Y]),
          row("Custom domain for shared dashboards", [N, N, Y, Y]),
          row("Dashboard viewers at no extra cost", [N, Y, Y, Y])
        ]},
        { g: "TRUST AND SUPPORT", rows: [
          row("Answers with linked queries and number check", [Y, Y, Y, Y]),
          row("Read-only connections, encrypted credentials", [Y, Y, Y, Y]),
          row("Support", ["Email", "Email", "Priority", "Named contact"]),
          row("Security review and guided onboarding", [N, N, N, Y])
        ]}
      ],
      entItems: ["A live demo on your own sources", "Custom limits and terms", "Security review, governance and access design", "Guided roll-out for every team", "A named contact and custom terms"],
      faq: [
        { q: "Is early access really free?", a: "Yes. Every feature, no card." },
        { q: "When is pricing announced?", a: "Soon. Early-access users hear first." },
        { q: "What happens to my work at launch?", a: "Nothing moves. Sources, dashboards and models stay." },
        { q: "Any usage limits?", a: "Fair use only. We'll reach out before anything changes." },
        { q: "Who should book a demo?", a: "Teams rolling GD360 out company-wide." }
      ]
    };

    const __menu = !!(state && state.menu);
    R.menu = __menu;
    R.menuExpanded = __menu ? "true" : "false";
    R.openMenu = () => setState({ menu: true });
    R.closeMenu = () => setState({ menu: false });
    R.menuLinks = [{ t: "Product", href: "/#see" }, { t: "Platform", href: "/#platform" }, { t: "Solutions", href: "/#teams" }, { t: "Security", href: "/#security" }, { t: "Pricing", href: "/pricing" }, { t: "About", href: "/about" }].map((x, i) => ({ ...x, cls: "ml" + (i + 1) }));
    const __ids = ["plus", "team", "business", "enterprise"];
    const __mi = Math.max(0, __ids.indexOf((state && state.mplan) || "team"));
    R.mTabs = R.plans.map((p, i) => ({ name: p.name, on: i === __mi ? "true" : "false", pick: () => setState({ mplan: __ids[i] }), bg: i === __mi ? "#43E5A0" : "transparent", ink: i === __mi ? "#04140D" : "#A3B0AC" }));
    R.mPlans = [R.plans[__mi]];
    R.mGroups = R.groups.map((g) => ({ g: g.g, rows: g.rows.map((r) => ({ f: r.f, t: r.v[__mi].t, c: r.v[__mi].c })) }));
    const __p = R.plans[__mi];
    R.mBar = { name: __p.name, price: __p.price === "Custom" ? "Custom" : __p.price + " / user", note: __p.note, href: __p.href, cta: __p.cta };
    return R;
  
}

export default function MarketingPricing() {
  useMarketingPage("GD360 — Pricing");
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
      <section className="mk-m-hero" style={{ position: "relative", padding: "104px 24px 64px", textAlign: "center", overflow: "hidden" }}>
        <div className="gd-tba-glow" aria-hidden="true"></div>
        <div style={{ position: "relative", maxWidth: "980px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "26px", alignItems: "center" }}>
          <span className="gd-soon-chip gd-soon-chip-lg mk-w mk-d1" style={{ alignSelf: "center" }}><span className="gd-ea-dot gd-ea-dot-amber"></span>{"PRICING · TO BE ANNOUNCED"}</span>
          <h1 className="mk-m-h1" style={{ margin: "0", fontWeight: "900", fontSize: "clamp(48px, 8vw, 120px)", lineHeight: "0.92", letterSpacing: "-0.055em", textWrap: "balance" }}>
            <span className="mk-w mk-d2">{"Pricing soon."}</span>
            <br />
            <span className="mk-w mk-d3"><span className="mk-sheen">{"Access now."}</span></span>
          </h1>
          <p className="mk-w mk-d4" style={{ margin: "0", fontSize: "clamp(17px, 1.8vw, 21px)", lineHeight: "1.55", color: "#A3B0AC", maxWidth: "560px" }}>
            {"Plans are on the way. Until then, every feature is free."}
          </p>
          <div className="mk-m-cta mk-w mk-d5" style={{ display: "flex", gap: "12px", flexWrap: "wrap", justifyContent: "center" }}>
            <A href="/start" className="gd-ea-go">{"Start early access →"}</A>
            <A href="#enterprise" className="gd-ghost">{"Enterprise? Talk to us"}</A>
          </div>
        </div>
      </section>
      {" "}
      <section style={{ padding: "0 24px 96px" }}>
        <div style={{ maxWidth: "1280px", margin: "0 auto" }}>
          <div className="gd-ea gd-ea-xl" style={{ flexDirection: "column", flexWrap: "nowrap", alignItems: "stretch" }}>
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: "24px" }}>
              <div className="gd-ea-copy" style={{ flex: "1 1 460px" }}>
                <span className="gd-ea-eyebrow"><span className="gd-ea-dot"></span>{"EARLY ACCESS · INCLUDED TODAY"}</span>
                <h2 className="gd-ea-title">{"Everything. "}<span className="mk-sheen">{"Free."}</span></h2>
                <p className="gd-ea-text">{"No card. No trial clock. Nothing locked."}</p>
              </div>
            </div>
            <div className="gd-feat">
              <div className="gd-feat-item"><span className="gd-feat-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z" /></svg></span><span className="gd-feat-t">{"Ask anything"}</span><span className="gd-feat-d">{"Plain-English questions. Proven answers."}</span></div>
              <div className="gd-feat-item"><span className="gd-feat-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5" /></svg></span><span className="gd-feat-t">{"71 connectors"}</span><span className="gd-feat-d">{"Warehouses, databases, files and apps."}</span></div>
              <div className="gd-feat-item"><span className="gd-feat-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z" /></svg></span><span className="gd-feat-t">{"Dashboards"}</span><span className="gd-feat-d">{"Build, share, refresh."}</span></div>
              <div className="gd-feat-item"><span className="gd-feat-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg></span><span className="gd-feat-t">{"Spaces"}</span><span className="gd-feat-d">{"A home for every team."}</span></div>
              <div className="gd-feat-item"><span className="gd-feat-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /></svg></span><span className="gd-feat-t">{"ML Studio"}</span><span className="gd-feat-d">{"21 model types from one sentence."}</span></div>
              <div className="gd-feat-item"><span className="gd-feat-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9z" /></svg></span><span className="gd-feat-t">{"Automations"}</span><span className="gd-feat-d">{"Alerts and reports on schedule."}</span></div>
              <div className="gd-feat-item"><span className="gd-feat-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" /></svg></span><span className="gd-feat-t">{"Data quality"}</span><span className="gd-feat-d">{"Checks, rules and access control."}</span></div>
              <div className="gd-feat-item"><span className="gd-feat-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4" /></svg></span><span className="gd-feat-t">{"Secure by default"}</span><span className="gd-feat-d">{"Read-only. Encrypted. Audited."}</span></div>
            </div>
          </div>
        </div>
      </section>
      {" "}
      <section style={{ padding: "0 24px 104px" }}>
        <div style={{ maxWidth: "1280px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "28px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <span className="mk-mono" style={{ fontSize: "12.5px", letterSpacing: "0.16em", color: "#43E5A0" }}>{"WHAT'S NEXT"}</span>
            <h2 style={{ margin: "0", fontWeight: "800", fontSize: "clamp(32px, 4.4vw, 58px)", lineHeight: "1", letterSpacing: "-0.045em" }}>{"No surprises."}</h2>
          </div>
            <ol className="gd-steps">
              <li><span className="gd-step-n">{"01 · TODAY"}</span><span className="gd-step-t">{"Use everything"}</span><span className="gd-step-d">{"The full product, free."}</span></li>
              <li><span className="gd-step-n">{"02 · BEFORE LAUNCH"}</span><span className="gd-step-t">{"Hear first"}</span><span className="gd-step-d">{"Early users get plans first, with notice."}</span></li>
              <li><span className="gd-step-n">{"03 · AT LAUNCH"}</span><span className="gd-step-t">{"Keep it all"}</span><span className="gd-step-d">{"Pick a plan. Your work stays put."}</span></li>
            </ol>
        </div>
      </section>
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
                <div style={{ position: "absolute", inset: "0", borderRadius: "16px", background: "#43E5A0", color: "#04140D", display: "grid", placeItems: "center", fontWeight: "900", fontSize: "22px" }}>
                  {"G"}
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
              {"Rolling GD360 out across the company?"}
            </h2>
            {" "}
            <p style={{ margin: "0", color: "#A3B0AC", fontSize: "17px", lineHeight: "1.65", maxWidth: "560px" }}>
              {"See GD360 answer your hardest question on your own sources, live. We’ll walk your team through security, governance and roll-out — and shape a plan around how you work."}
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
      <section style={{ padding: "0 24px 112px" }}>
        {" "}
        <div style={{ maxWidth: "1280px", margin: "0 auto", display: "flex", flexWrap: "wrap", gap: "48px" }}>
          {" "}
          <div style={{ flex: "1 1 320px", display: "flex", flexDirection: "column", gap: "16px" }}>
            <span className="mk-mono" style={{ fontSize: "12.5px", letterSpacing: "0.16em", color: "#43E5A0" }}>
              {"QUESTIONS"}
            </span>
            <h2 style={{ margin: "0", fontWeight: "800", fontSize: "clamp(32px, 4vw, 52px)", lineHeight: "1", letterSpacing: "-0.045em" }}>
              {"Short answers."}
            </h2>
          </div>
          {" "}
          <div style={{ flex: "1 1 640px", display: "flex", flexDirection: "column", borderTop: "1px solid #1F2729" }}>
            {" "}
            {(V.faq || []).map((f: any, i1: number) => (
              <Fragment key={i1}>
                {" "}
                <div style={{ padding: "22px 0", borderBottom: "1px solid #1F2729", display: "flex", flexDirection: "column", gap: "8px" }}>
                  <span style={{ fontWeight: "700", fontSize: "17.5px" }}>
                    {f.q}
                  </span>
                  <span style={{ color: "#A3B0AC", fontSize: "15.5px", lineHeight: "1.65" }}>
                    {f.a}
                  </span>
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

// Generated from the approved "GD360 Website — Final" mockup (Start.dc.html).
// Markup, inline styles and motion are kept exactly as designed; the
// page's CSS (animations, hover states) lives in marketing.css, scoped
// under .mkt-start.
import { FormEvent, Fragment, useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../api/AuthContext";
import { errorText } from "../shared";
import { SITE } from "../site";
import { A, useMarketingPage } from "../shared";
import "../marketing.css";

/* eslint-disable @typescript-eslint/no-explicit-any */
function vals(state: any, setState: (patch: any) => void): any {

    const s = state || {};
    const step = s.step || 1;
    const annual = !!s.annual;
    const money = (n) => "$" + (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    const P = [
      { id: "early", name: "Early access", m: 0, min: 1, max: 1, blurb: "Every feature · no card · while we launch" },
      { id: "plus", name: "Plus", m: 0, min: 1, max: 1, blurb: "One person · 200 chats · 5 sources" },
      { id: "team", name: "Team", m: 0, min: 3, max: 500, blurb: "Warehouses, apps, Spaces, ML, automations" },
      { id: "business", name: "Business", m: 0, min: 10, max: 500, blurb: "Unlimited sources and dashboards" }
    ];
    const unit = (p) => annual ? Math.round((p.m * 10 / 12) * 100) / 100 : p.m;
    const pick = P.find((p) => p.id === s.plan) || P[1];
    const users = Math.min(pick.max, Math.max(pick.min, s.users || 1));
    const monthly = Math.round(unit(pick) * users * 100) / 100;
    const due = annual ? pick.m * 10 * users : monthly;
    const SRC = [
      ["snowflake", "Snowflake", "Sf", "LIVE"], ["bigquery", "BigQuery", "BQ", "LIVE"], ["postgres", "PostgreSQL", "Pg", "LIVE"], ["mysql", "MySQL", "My", "LIVE"],
      ["sheets", "Google Sheets", "GS", "SYNCED"], ["files", "CSV / Excel", "Fi", "UPLOAD"], ["shopify", "Shopify", "Sh", "SYNCED"], ["gads", "Google Ads", "GA", "SYNCED"],
      ["ga4", "GA4", "G4", "SYNCED"], ["hubspot", "HubSpot", "Hs", "SYNCED"], ["stripe", "Stripe", "St", "SYNCED"], ["instagram", "Instagram", "Ig", "SYNCED"]
    ];
    const chosen = SRC.find((x) => x[0] === s.source);
    const sourceName = chosen ? chosen[1] : "your source";
    const Q = ["Why did revenue change last month?", "Which customers buy again within 90 days?", "What are our top products by margin?", "Where do our best customers come from?"];
    const qi = s.q || 0;
    const stepDefs = [["1", "Plan & account"], ["2", "Connect"], ["3", "First question"]];
    const R = {
      isStep1: step === 1, isStep2: step === 2, isStep3: step === 3,
      steps: stepDefs.map(([n, label], i) => {
        const k = i + 1, done = k < step, cur = k === step;
        return { label, mark: done ? "✓" : n,
          border: cur ? "#43E5A0" : (done ? "#24413A" : "#1F2729"), bg: cur ? "#132320" : "transparent", ink: cur || done ? "#E8EEEC" : "#7F8C88",
          dotBg: cur || done ? "#43E5A0" : "#1F2729", dotInk: cur || done ? "#04140D" : "#A3B0AC" };
      }),
      isMonthly: annual ? "false" : "true", isAnnual: annual ? "true" : "false",
      setMonthly: () => setState({ annual: false }), setAnnual: () => setState({ annual: true }),
      mBg: annual ? "transparent" : "#43E5A0", mInk: annual ? "#A3B0AC" : "#04140D",
      aBg: annual ? "#43E5A0" : "transparent", aInk: annual ? "#04140D" : "#A3B0AC",
      plans: P.map((p) => {
        const on = p.id === pick.id;
        return { id: p.id, soon: p.m > 0, name: p.name, blurb: p.blurb, price: money(unit(p)), on: on ? "true" : "false",
          pick: () => setState({ plan: p.id, users: Math.min(p.max, Math.max(p.min, (state && state.users) || 1)) }),
          border: on ? "#43E5A0" : "#1F2729", bg: on ? "#0F1A16" : "#0B0F10", dot: on ? "#43E5A0" : "#2A3436", fill: on ? "#43E5A0" : "transparent" };
      }),
      planName: pick.name, users, userWord: users === 1 ? "user" : "users",
      unitLabel: money(unit(pick)) + " / user / mo",
      less: () => setState({ users: Math.max(pick.min, users - 1) }),
      more: () => setState({ users: Math.min(pick.max, users + 1) }),
      minNote: pick.max === 1 ? "single user" : (pick.min > 1 ? "minimum " + pick.min : ""),
      dueLabel: annual ? "Due today (yearly)" : "Due today (monthly)",
      due: money(due),
      dueNote: annual ? "Renews yearly · you save " + money(Math.round(pick.m * users * 2)) + " vs monthly" : "Renews monthly · cancel any time",
      toStep2: () => setState({ step: 2 }),
      back1: () => setState({ step: 1 }),
      sources: SRC.map(([id, n, m, mode]) => {
        const on = id === s.source;
        return { n, m, mode, on: on ? "true" : "false", pick: () => setState({ source: id }),
          border: on ? "#43E5A0" : "#1F2729", bg: on ? "#0F1A16" : "#0B0F10", modeInk: mode === "LIVE" ? "#43E5A0" : "#7AA7FF" };
      }),
      hasSource: !!chosen, sourceName,
      toStep3: () => setState({ step: 3, asked: false }),
      back2: () => setState({ step: 2 }),
      question: Q[qi],
      suggestions: Q.map((q, i) => ({ q, pick: () => setState({ q: i, asked: false }),
        border: i === qi ? "#43E5A0" : "#1F2729", bg: i === qi ? "#132320" : "#0B0F10", ink: i === qi ? "#43E5A0" : "#D5DEDB" })),
      ask: () => setState({ asked: true }),
      asked: !!s.asked
    };
    const __st = (state && state.step) || 1;
    R.stepNum = String(__st);
    R.stepName = ["Plan & account", "Connect a source", "First question"][__st - 1];
    R.stepPct = String(Math.round((__st / 3) * 100));
    return R;
  
}

export default function MarketingStart() {
  useMarketingPage("GD360 — Get started");
  // 2026-10-09: plan, users and billing can arrive from /pricing
  // (?plan=team&users=8&billing=annual); a signed-in visitor starts at step 2.
  const { user, register, getCaptcha } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // a workspace invite (or any deep link) that sent a new person here
  const returnTo = (location.state as { from?: string } | null)?.from || "";
  const [params] = useSearchParams();
  const [state, setS] = useState<any>({
    step: 1,
    annual: params.get("billing") === "annual",
    plan: "early",
    users: Math.max(1, Math.min(500, Number(params.get("users")) || 5)),
    source: "", q: 0, asked: false,
  });
  const setState = (patch: any) => setS((prev: any) => ({ ...prev, ...patch }));
  const V = vals(state, setState);
  const [form, setForm] = useState({ name: "", email: "", company: "", password: "", captcha: "" });
  const [captcha, setCaptcha] = useState({ id: "", question: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // already signed in: nothing to set up here, go to the app
  useEffect(() => {
    if (user && !busy) navigate(returnTo || "/", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);
  const field = (k: string) => (e: any) => setForm((f) => ({ ...f, [k]: k === "captcha" ? e.target.value.replace(/[^0-9-]/g, "") : e.target.value }));
  const loadCaptcha = () =>
    getCaptcha()
      .then((c) => setCaptcha({ id: c.captcha_id, question: c.question }))
      .catch(() => setCaptcha({ id: "", question: "" }));
  useEffect(() => {
    if (!user) loadCaptcha();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const createWorkspace = async (e?: FormEvent) => {
    e?.preventDefault();
    setErr("");
    if (!form.email.trim() || form.password.length < 8) {
      setErr("Add your work email and a password of at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      await register(form.email.trim(), form.password, captcha.id, form.captcha, form.name.trim() || undefined, form.company.trim() || undefined);
      try {
        localStorage.setItem("gd360_chosen_plan", JSON.stringify({ plan: state.plan, users: V.users, billing: state.annual ? "annual" : "monthly" }));
      } catch {
        /* storage may be blocked */
      }
      if (returnTo) {
        navigate(returnTo, { replace: true });
        return;
      }
      navigate("/", { replace: true });
    } catch (ex: any) {
      setErr(errorText(ex, "Couldn't create your workspace."));
      setForm((f) => ({ ...f, captcha: "" }));
      loadCaptcha();
    } finally {
      setBusy(false);
    }
  };
  V.toStep2 = createWorkspace;
  if (!SITE.billingEnabled) {
    V.dueLabel = state.annual ? "Your plan, per year" : "Your plan, per month";
    V.dueNote = "Nothing is charged today. We confirm your plan with you before billing starts.";
  }
  const isEarly = state.plan === "early";
  V.isEarly = isEarly;
  V.summaryLine = isEarly ? "Early access · every feature" : V.planName + " · " + V.users + " " + V.userWord;
  if (isEarly) {
    V.unitLabel = "all features";
    V.summaryLine = "Early access";
    V.dueLabel = "Due today";
    V.due = "Free";
    V.dueNote = "No card. Pricing announced soon — you'll hear first.";
  }
  const APP_KINDS: Record<string, string> = { shopify: "shopify", gads: "google_ads", ga4: "ga4", hubspot: "hubspot", stripe: "stripe", instagram: "instagram" };
  const openGD360 = () => {
    try {
      sessionStorage.setItem("gd360_first_question", V.question);
    } catch {
      /* ignore */
    }
    const kind = APP_KINDS[state.source];
    navigate(state.source ? "/data?tab=catalog" + (kind ? "&connect=" + kind : "") : "/");
  };
  return (
    <div className="mkt-start" style={{ fontFamily: "Geist, 'Helvetica Neue', system-ui, sans-serif", color: "#E8EEEC", background: "#07090A", minHeight: "100vh", display: "flex", flexWrap: "wrap" }}>
      {" "}
      <aside className="mk-m-aside mk-gridbg" style={{ flex: "1 1 420px", minWidth: "0", position: "relative", overflow: "hidden", backgroundColor: "#0B0F10", borderRight: "1px solid #141A1B", padding: "32px clamp(20px, 4vw, 56px)", display: "flex", flexDirection: "column", gap: "40px", justifyContent: "space-between" }}>
        {" "}
        <A href="/" style={{ display: "flex", alignItems: "center", gap: "10px", color: "#E8EEEC", position: "relative" }}>
          <span style={{ width: "34px", height: "34px", borderRadius: "10px", background: "#43E5A0", color: "#04140D", display: "grid", placeItems: "center", fontWeight: "900", fontSize: "17px" }}>
            {"G"}
          </span>
          <span style={{ fontWeight: "800", fontSize: "20px", letterSpacing: "-0.02em" }}>
            {"GD360"}
          </span>
        </A>
        {" "}
        <div className="mk-start-orbit" style={{ position: "relative", display: "grid", placeItems: "center" }}>
          {" "}
          <div style={{ position: "relative", width: "min(340px, 70vw)", aspectRatio: "1" }}>
            {" "}
            <div className="mk-ring" style={{ inset: "0" }}></div>
            <div className="mk-ring" style={{ inset: "18%" }}></div>
            <div className="mk-ring" style={{ inset: "36%" }}></div>
            {" "}
            <div className="mk-comet" style={{ inset: "0" }}></div>
            <div className="mk-comet" style={{ inset: "18%", animationDuration: "15s", animationDirection: "reverse" }}></div>
            {" "}
            <div style={{ position: "absolute", inset: "38%" }}>
              {" "}
              <span className="mk-wave"></span>
              <span className="mk-wave mk-wv2"></span>
              <span className="mk-wave mk-wv3"></span>
              {" "}
              <div style={{ position: "absolute", inset: "0", borderRadius: "30%", background: "#43E5A0", color: "#04140D", display: "grid", placeItems: "center", fontWeight: "900", fontSize: "34px", boxShadow: "0 0 100px 16px rgba(67,229,160,.3)" }}>
                {"G"}
              </div>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
        <div className="mk-d-only" style={{ position: "relative", display: "flex", flexDirection: "column", gap: "14px" }}>
          {" "}
          <p style={{ margin: "0", fontWeight: "800", fontSize: "clamp(26px, 2.6vw, 36px)", lineHeight: "1.12", letterSpacing: "-0.035em" }}>
            {"Three minutes from now, you’ll have your first proven answer."}
          </p>
          {" "}
          <div className="mk-mono" style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "13px", color: "#A3B0AC" }}>
            {" "}
            <span>
              {"✓ Read-only connections"}
            </span>
            <span>
              {"✓ Credentials encrypted at rest"}
            </span>
            <span>
              {"✓ Every number linked to its query"}
            </span>
            {" "}
          </div>
          {" "}
        </div>
        {" "}
      </aside>
      {" "}
      <main className="mk-m-main" style={{ flex: "999 1 560px", minWidth: "0", padding: "32px clamp(20px, 4vw, 64px) 56px", display: "flex", flexDirection: "column", gap: "32px" }}>
        {" "}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
          {" "}
          <div className="mk-m-only" style={{ width: "100%" }}>
            {" "}
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {" "}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "10px" }}>
                <span className="mk-mono" style={{ fontSize: "11.5px", letterSpacing: "0.12em", color: "#43E5A0" }}>
                  {"EARLY ACCESS"}
                </span>
                <span style={{ fontSize: "13.5px", color: "#A3B0AC" }}>
                  {"Create your account"}
                </span>
              </div>
              {" "}
              <div style={{ height: "4px", background: "#1A2224", borderRadius: "4px", overflow: "hidden" }}>
                <div style={{ height: "4px", width: "100%", background: "#43E5A0", borderRadius: "4px", transition: "width .4s ease" }}></div>
              </div>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
          <span className="mk-d-only gd-ea-pill"><span className="gd-ea-dot"></span>{"Early access · free"}</span>
          {" "}
          <span style={{ fontSize: "14px", color: "#A3B0AC" }}>
            {"Already have an account? "}
            <A href="/login">
              {"Sign in"}
            </A>
          </span>
          {" "}
        </div>
        {" "}
        {V.isStep1 && (
          <>
            {" "}
            <div className="mk-enter" style={{ display: "flex", flexDirection: "column", gap: "26px" }}>
              {" "}
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {" "}
                <h1 style={{ margin: "0", fontWeight: "900", fontSize: "clamp(34px, 4vw, 54px)", lineHeight: "1", letterSpacing: "-0.05em" }}>
                  {"Your workspace. Free."}
                </h1>
                {" "}
                <p style={{ margin: "0", color: "#A3B0AC", fontSize: "16.5px", lineHeight: "1.6" }}>
                  {"Every feature during early access. Company-wide roll-out? "}
                  <A href="/pricing#enterprise">
                    {"Talk to us"}
                  </A>
                  {"."}
                </p>
                {" "}
              </div>
              {" "}
              <div className="gd-inc" aria-label="Included in early access">
                <span>{"71 connectors"}</span><span>{"Ask anything"}</span><span>{"Dashboards"}</span><span>{"Spaces"}</span><span>{"ML Studio"}</span><span>{"Automations"}</span>
              </div>
              {" "}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "20px" }}>
                {" "}
                <form onSubmit={createWorkspace} noValidate style={{ flex: "1 1 380px", display: "flex", flexDirection: "column", gap: "14px" }}>
                  {" "}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "12px" }}>
                    {" "}
                    <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13.5px", color: "#A3B0AC" }}>
                      {"Full name"}
                      <input className="mk-input" type="text" autoComplete="name" value={form.name} onChange={field("name")} placeholder="Your name" />
                    </label>
                    {" "}
                    <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13.5px", color: "#A3B0AC" }}>
                      {"Work email"}
                      <input className="mk-input" type="email" required autoComplete="email" value={form.email} onChange={field("email")} placeholder="you@company.com" />
                    </label>
                    {" "}
                  </div>
                  {" "}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "12px" }}>
                    {" "}
                    <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13.5px", color: "#A3B0AC" }}>
                      {"Company"}
                      <input className="mk-input" type="text" autoComplete="organization" value={form.company} onChange={field("company")} placeholder="Company name" />
                    </label>
                    {" "}
                    <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13.5px", color: "#A3B0AC" }}>
                      {"Password"}
                      <input className="mk-input" type="password" required minLength={8} autoComplete="new-password" value={form.password} onChange={field("password")} placeholder="At least 8 characters" />
                    </label>
                    {" "}
                  </div>
                  {" "}
                  <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13.5px", color: "#A3B0AC" }}>
                    {captcha.question ? `Quick check: ${captcha.question}` : "Quick check"}
                    <input className="mk-input" type="text" inputMode="numeric" required value={form.captcha} onChange={field("captcha")} placeholder="Your answer" />
                  </label>
                  {SITE.billingEnabled && (
                    <>
                  <span className="mk-mono" style={{ fontSize: "11.5px", letterSpacing: "0.1em", color: "#7F8C88", marginTop: "6px" }}>
                    {"PAYMENT"}
                  </span>
                  {" "}
                  <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13.5px", color: "#A3B0AC" }}>
                    {"Card number"}
                    <input className="mk-input" type="text" inputMode="numeric" placeholder="1234 1234 1234 1234" />
                  </label>
                  {" "}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "12px" }}>
                    {" "}
                    <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13.5px", color: "#A3B0AC" }}>
                      {"Expiry"}
                      <input className="mk-input" type="text" placeholder="MM / YY" />
                    </label>
                    {" "}
                    <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13.5px", color: "#A3B0AC" }}>
                      {"CVC"}
                      <input className="mk-input" type="text" inputMode="numeric" placeholder="123" />
                    </label>
                    {" "}
                  </div>
                  {" "}
                    </>
                  )}
                  <button type="submit" hidden aria-hidden="true" tabIndex={-1}></button>
                </form>
                {" "}
                <div style={{ flex: "1 1 280px", border: "1px solid #24413A", background: "radial-gradient(ellipse at 100% 0%, rgba(67,229,160,.14), rgba(7,9,10,0) 60%), #0B0F10", borderRadius: "20px", padding: "22px", display: "flex", flexDirection: "column", gap: "14px", alignSelf: "flex-start" }}>
                  {" "}
                  <span className="mk-mono" style={{ fontSize: "11.5px", letterSpacing: "0.12em", color: "#43E5A0" }}>
                    {"ORDER SUMMARY"}
                  </span>
                  {" "}
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "15px" }}>
                    <span>
                      {V.summaryLine}
                    </span>
                    <span className="mk-mono">
                      {V.unitLabel}
                    </span>
                  </div>
                  {" "}
                  {!V.isEarly && (
                  <>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    {" "}
                    <button type="button" aria-label="One user fewer" onClick={V.less} style={{ width: "44px", height: "44px", borderRadius: "12px", border: "1px solid #2A3436", background: "#0E1213", color: "#E8EEEC", fontSize: "20px", cursor: "pointer", fontFamily: "inherit" }}>
                      {"−"}
                    </button>
                    {" "}
                    <span className="mk-mono" style={{ minWidth: "40px", textAlign: "center", fontSize: "22px", fontWeight: "600" }}>
                      {V.users}
                    </span>
                    {" "}
                    <button type="button" aria-label="One user more" onClick={V.more} style={{ width: "44px", height: "44px", borderRadius: "12px", border: "1px solid #2A3436", background: "#0E1213", color: "#E8EEEC", fontSize: "20px", cursor: "pointer", fontFamily: "inherit" }}>
                      {"+"}
                    </button>
                    {" "}
                    <span className="mk-mono" style={{ fontSize: "11.5px", color: "#7F8C88" }}>
                      {V.minNote}
                    </span>
                    {" "}
                  </div>
                  {" "}
                  </>
                  )}
                  <div style={{ borderTop: "1px solid #1F2729", paddingTop: "14px", display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "10px" }}>
                    <span style={{ color: "#A3B0AC" }}>
                      {V.dueLabel}
                    </span>
                    <span style={{ fontWeight: "900", fontSize: "34px", letterSpacing: "-0.04em", color: "#43E5A0" }}>
                      {V.due}
                    </span>
                  </div>
                  {" "}
                  <span className="mk-mono" style={{ fontSize: "11.5px", color: "#7F8C88", lineHeight: "1.5" }}>
                    {V.dueNote}
                  </span>
                  {" "}
                  <button type="button" className="mk-d-only" onClick={() => createWorkspace()} disabled={busy} style={{ height: "52px", border: "0", borderRadius: "999px", background: "#43E5A0", color: "#04140D", fontSize: "16px", fontWeight: "700", fontFamily: "inherit", cursor: "pointer", boxShadow: "0 18px 50px -18px rgba(67,229,160,.7)" }}>
                    {busy ? "Creating your workspace…" : "Create workspace →"}
                  </button>
                  {err && (
                    <span role="alert" style={{ fontSize: "13.5px", color: "#FF7A6B", lineHeight: "1.5" }}>{err}</span>
                  )}
                  {" "}
                  <span style={{ fontSize: "12px", color: "#7F8C88", lineHeight: "1.5" }}>
                    {"By continuing you agree to the "}
                    <A href="/privacy">
                      {"Terms"}
                    </A>
                    {" and "}
                    <A href="/privacy">
                      {"Privacy policy"}
                    </A>
                    {"."}
                  </span>
                  {" "}
                </div>
                {" "}
              </div>
              {" "}
            </div>
            {" "}
            <div className="mk-m-only" style={{ height: "80px" }}></div>
            {" "}
            <div className="mk-m-only">
              {" "}
              <div style={{ position: "fixed", left: "0", right: "0", bottom: "0", zIndex: "40", padding: "10px 16px calc(10px + env(safe-area-inset-bottom, 0px))", background: "rgba(7,9,10,.92)", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", borderTop: "1px solid #1F2729", display: "flex", alignItems: "center", gap: "12px" }}>
                {" "}
                <div style={{ flex: "1", minWidth: "0", display: "flex", flexDirection: "column", gap: "1px" }}>
                  {" "}
                  <span className="mk-mono" style={{ fontSize: "11px", color: "#7F8C88", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {V.summaryLine}
                  </span>
                  {" "}
                  <span style={{ fontWeight: "900", fontSize: "22px", letterSpacing: "-0.03em", color: "#43E5A0" }}>
                    {V.due}
                  </span>
                  {" "}
                </div>
                {" "}
                <button type="button" onClick={V.toStep2} style={{ flex: "none", height: "50px", padding: "0 20px", border: "0", borderRadius: "999px", background: "#43E5A0", color: "#04140D", fontSize: "15.5px", fontWeight: "700", fontFamily: "inherit", cursor: "pointer", boxShadow: "0 12px 34px -14px rgba(67,229,160,.8)" }}>
                  {"Create workspace →"}
                </button>
                {" "}
              </div>
              {" "}
            </div>
            {" "}
          </>
        )}
        {" "}
        {V.isStep2 && (
          <>
            {" "}
            <div className="mk-enter" style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
              {" "}
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {" "}
                <h1 style={{ margin: "0", fontWeight: "900", fontSize: "clamp(34px, 4vw, 54px)", lineHeight: "1", letterSpacing: "-0.05em" }}>
                  {"Connect your first source."}
                </h1>
                {" "}
                <p style={{ margin: "0", color: "#A3B0AC", fontSize: "16.5px", lineHeight: "1.6" }}>
                  {"Read-only, encrypted, and you can add more any time. Databases and warehouses are queried in place; apps sync on a schedule."}
                </p>
                {" "}
              </div>
              {" "}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "10px" }}>
                {" "}
                {(V.sources || []).map((c: any, i1: number) => (
                  <Fragment key={i1}>
                    {" "}
                    <button type="button" aria-pressed={c.on} onClick={c.pick} style={{ textAlign: "left", cursor: "pointer", fontFamily: "inherit", color: "#E8EEEC", border: `1px solid ${c.border}`, background: c.bg, borderRadius: "16px", padding: "14px", display: "flex", alignItems: "center", gap: "12px", minHeight: "64px" }}>
                      {" "}
                      <span className="mk-mono" style={{ flex: "none", width: "36px", height: "36px", borderRadius: "10px", display: "grid", placeItems: "center", fontSize: "12px", fontWeight: "600", background: "#132320", border: "1px solid #24413A", color: "#43E5A0" }}>
                        {c.m}
                      </span>
                      {" "}
                      <span style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" }}>
                        <span style={{ fontWeight: "700", fontSize: "15px" }}>
                          {c.n}
                        </span>
                        <span className="mk-mono" style={{ fontSize: "10.5px", color: c.modeInk }}>
                          {c.mode}
                        </span>
                      </span>
                      {" "}
                    </button>
                    {" "}
                  </Fragment>
                ))}
                {" "}
              </div>
              {" "}
              {V.hasSource && (
                <>
                  {" "}
                  <div className="mk-enter" style={{ border: "1px solid #24413A", background: "#0F1A16", borderRadius: "18px", padding: "18px 20px", display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "center", justifyContent: "space-between" }}>
                    {" "}
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px", minWidth: "0" }}>
                      {" "}
                      <span style={{ fontWeight: "700", fontSize: "16px" }}>
                        {V.sourceName}{" selected · read-only"}
                      </span>
                      {" "}
                      <span className="mk-mono" style={{ fontSize: "12px", color: "#A3B0AC" }}>
                        {"You’ll sign in to it next — GD360 only ever reads."}
                      </span>
                      {" "}
                      <div style={{ height: "4px", width: "min(320px, 70vw)", background: "#1A2224", borderRadius: "4px", overflow: "hidden" }}>
                        <div className="mk-grow" style={{ height: "4px", width: "100%", background: "#43E5A0" }}></div>
                      </div>
                      {" "}
                    </div>
                    {" "}
                    <button type="button" onClick={V.toStep3} style={{ height: "50px", padding: "0 24px", border: "0", borderRadius: "999px", background: "#43E5A0", color: "#04140D", fontSize: "15.5px", fontWeight: "700", fontFamily: "inherit", cursor: "pointer" }}>
                      {"Continue →"}
                    </button>
                    {" "}
                  </div>
                  {" "}
                </>
              )}
              {" "}
              <button type="button" onClick={V.back1} style={{ alignSelf: "flex-start", background: "none", border: "0", color: "#A3B0AC", fontFamily: "inherit", fontSize: "14.5px", cursor: "pointer", padding: "10px 0", minHeight: "44px" }}>
                {"← Back to plan"}
              </button>
              {" "}
            </div>
            {" "}
          </>
        )}
        {" "}
        {V.isStep3 && (
          <>
            {" "}
            <div className="mk-enter" style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
              {" "}
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {" "}
                <h1 style={{ margin: "0", fontWeight: "900", fontSize: "clamp(34px, 4vw, 54px)", lineHeight: "1", letterSpacing: "-0.05em" }}>
                  {"Ask your first question."}
                </h1>
                {" "}
                <p style={{ margin: "0", color: "#A3B0AC", fontSize: "16.5px", lineHeight: "1.6" }}>
                  {"In plain words, the way you’d ask your best analyst. Try one of these, or write your own in the app."}
                </p>
                {" "}
              </div>
              {" "}
              <div style={{ border: "1px solid #24413A", background: "#0B0F10", borderRadius: "20px", padding: "18px 20px", display: "flex", alignItems: "center", gap: "14px", boxShadow: "0 0 0 1px rgba(67,229,160,.2), 0 30px 90px -40px rgba(67,229,160,.5)" }}>
                {" "}
                <span aria-hidden="true" style={{ flex: "none", width: "38px", height: "38px", borderRadius: "11px", background: "#43E5A0", color: "#04140D", display: "grid", placeItems: "center", fontWeight: "800" }}>
                  {"✦"}
                </span>
                {" "}
                <span style={{ flex: "1", minWidth: "0", fontSize: "clamp(16px, 1.8vw, 21px)", fontWeight: "500" }}>
                  {V.question}
                </span>
                {" "}
                <button type="button" onClick={V.ask} style={{ flex: "none", height: "46px", padding: "0 20px", border: "0", borderRadius: "999px", background: "#43E5A0", color: "#04140D", fontSize: "15px", fontWeight: "700", fontFamily: "inherit", cursor: "pointer" }}>
                  {"Ask"}
                </button>
                {" "}
              </div>
              {" "}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {" "}
                {(V.suggestions || []).map((g: any, i1: number) => (
                  <Fragment key={i1}>
                    {" "}
                    <button type="button" onClick={g.pick} style={{ cursor: "pointer", fontFamily: "inherit", fontSize: "14px", color: g.ink, border: `1px solid ${g.border}`, background: g.bg, borderRadius: "999px", padding: "10px 14px", minHeight: "44px" }}>
                      {g.q}
                    </button>
                    {" "}
                  </Fragment>
                ))}
                {" "}
              </div>
              {" "}
              {V.asked && (
                <>
                  {" "}
                  <div className="mk-enter" style={{ border: "1px solid #1F2729", background: "#0B0F10", borderRadius: "20px", padding: "20px", display: "flex", flexDirection: "column", gap: "14px" }}>
                    {" "}
                    <span className="mk-mono" style={{ fontSize: "11.5px", letterSpacing: "0.12em", color: "#43E5A0" }}>
                      {"GD360’S PLAN · "}{V.sourceName}
                    </span>
                    {" "}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "8px" }}>
                      {" "}
                      <div className="mk-stepOn mk-so1 mk-mono" style={{ border: "1px solid #1F2729", borderRadius: "10px", padding: "10px 12px", fontSize: "12px" }}>
                        {"01 Understand the question"}
                      </div>
                      {" "}
                      <div className="mk-stepOn mk-so2 mk-mono" style={{ border: "1px solid #1F2729", borderRadius: "10px", padding: "10px 12px", fontSize: "12px" }}>
                        {"02 Query "}{V.sourceName}
                      </div>
                      {" "}
                      <div className="mk-stepOn mk-so3 mk-mono" style={{ border: "1px solid #1F2729", borderRadius: "10px", padding: "10px 12px", fontSize: "12px" }}>
                        {"03 Check every number"}
                      </div>
                      {" "}
                    </div>
                    {" "}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "14px", alignItems: "center", justifyContent: "space-between", borderTop: "1px solid #1F2729", paddingTop: "14px" }}>
                      {" "}
                      <span style={{ fontSize: "15.5px", color: "#D5DEDB" }}>
                        {"Your workspace is ready. Connect " + V.sourceName + " and your question will be waiting on Home."}
                      </span>
                      {" "}
                      <button type="button" onClick={openGD360} style={{ background: "#43E5A0", color: "#04140D", fontWeight: "700", fontSize: "15.5px", padding: "14px 22px", borderRadius: "999px", border: "0", fontFamily: "inherit", cursor: "pointer" }}>
                        {"Open GD360 →"}
                      </button>
                      {" "}
                    </div>
                    {" "}
                  </div>
                  {" "}
                </>
              )}
              {" "}
              <button type="button" onClick={V.back2} style={{ alignSelf: "flex-start", background: "none", border: "0", color: "#A3B0AC", fontFamily: "inherit", fontSize: "14.5px", cursor: "pointer", padding: "10px 0", minHeight: "44px" }}>
                {"← Back to sources"}
              </button>
              {" "}
            </div>
            {" "}
          </>
        )}
        {" "}
        <footer style={{ marginTop: "auto", paddingTop: "24px", borderTop: "1px solid #141A1B", display: "flex", justifyContent: "space-between", gap: "16px", flexWrap: "wrap", fontSize: "13px", color: "#7F8C88" }}>
          <span>
            {"© 2026 GD360. All rights reserved."}
          </span>
          <span>
            <A href="/pricing" style={{ color: "#A3B0AC" }}>
              {"Pricing"}
            </A>
            {" · "}
            <A href="/about" style={{ color: "#A3B0AC" }}>
              {"About"}
            </A>
            {" · "}
            <A href="/privacy" style={{ color: "#A3B0AC" }}>
              {"Privacy"}
            </A>
          </span>
        </footer>
        {" "}
      </main>
      {" "}
    </div>
  );
}

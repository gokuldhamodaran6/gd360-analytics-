// 2026-10-19 (R56, website board "Sign up & onboarding"): four steps on one page - who it is for and the account,
// a first source, a first question, the team. The account is real from step 1 (register + the quick check), and the
// person stays here after it is made instead of being thrown into the app half set up. Every later step can be
// skipped. A signed-in visitor starts at step 2; a visitor sent here by an invite link goes straight back to it.
import { Wordmark } from "../../components/Brand";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../api/AuthContext";
import { workspaceApi, type WorkspaceSummary } from "../../api/client";
import { ACTIVE_WORKSPACE_KEY } from "../../lib/useWorkspaceNav";
import { A, errorText, useMarketingPage } from "../shared";
import { Mark } from "./chrome";

const WHO: [string, string, string][] = [
  ["me", "Just me", "My own business or my own work"],
  ["team", "My team", "A few people who share the same numbers"],
  ["company", "My company", "Several teams, with owners and rules"],
  ["agency", "My clients", "An agency or consultant with many accounts"],
];
const CONNECT: [string, string, string][] = [
  ["shopify", "Shopify", "Orders, products, customers"],
  ["google_ads", "Google Ads", "Spend, clicks, conversions"],
  ["ga4", "Google Analytics 4", "Visits, pages, events"],
  ["stripe", "Stripe", "Payments, refunds, plans"],
  ["hubspot", "HubSpot", "Contacts, deals, pipeline"],
  ["meta_ads", "Meta Ads", "Facebook and Instagram ads"],
  ["db", "A database", "PostgreSQL, MySQL, BigQuery, Snowflake…"],
  ["file", "A file", "CSV or Excel"],
];
const QUESTIONS: Record<string, string[]> = {
  shopify: ["Which products sold best last month?", "How many customers came back for a second order?", "Why did revenue change this week?"],
  google_ads: ["Which campaigns cost the most per conversion?", "Where should I move budget next month?", "Why did clicks drop last week?"],
  ga4: ["Which pages bring the most sign-ups?", "Where do visitors leave?", "How did traffic change this month?"],
  stripe: ["What is my monthly recurring revenue?", "Which customers churned last month?", "How much did refunds cost this quarter?"],
  hubspot: ["Which deals are stuck the longest?", "How fast do leads become customers?", "Which source brings the best leads?"],
  meta_ads: ["Which ads have the lowest cost per purchase?", "How did spend change week by week?", "Which audiences are getting tired?"],
  "": ["What changed in my numbers this week?", "What are my best customers like?", "Which customers might leave next month?"],
};
const STEPS: [string, string][] = [["Your account", "Who it is for, and how you sign in"], ["Connect data", "One source or a file to start"], ["First question", "What you want to know first"], ["Your team", "Invite people, or later"]];

export default function Start2() {
  useMarketingPage("Get Early Access to Euliv: Connect Your Data in Minutes", {
    path: "/start",
    description: "Create your Euliv workspace, connect a warehouse, database or app, and ask your first question in plain English. Every feature is free in early access.",
  });
  const { user, register, getCaptcha } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const returnTo = (location.state as { from?: string } | null)?.from || "";
  const signedInAtStart = useRef(!!user);
  const [step, setStep] = useState(user ? 2 : 1);
  const [who, setWho] = useState(params.get("plan") === "team" ? "team" : "me");
  const [form, setForm] = useState({ name: "", email: "", company: "", password: "", captcha: "" });
  const [captcha, setCaptcha] = useState({ id: "", question: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [source, setSource] = useState("");
  const [question, setQuestion] = useState("");
  const [ws, setWs] = useState<WorkspaceSummary | null>(null);
  const [copied, setCopied] = useState(false);

  const loadCaptcha = () => getCaptcha().then((c) => setCaptcha({ id: c.captcha_id, question: c.question })).catch(() => setCaptcha({ id: "", question: "" }));
  useEffect(() => { if (!user) void loadCaptcha(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  // signed in on arrival (not by this form): skip the account step; an invite link goes back to the invite
  useEffect(() => { if (user && signedInAtStart.current && returnTo) navigate(returnTo, { replace: true }); }, [user, returnTo, navigate]);
  useEffect(() => {
    if (step !== 4 || !user) return;
    workspaceApi.list().then((list) => {
      let saved = ""; try { saved = localStorage.getItem(ACTIVE_WORKSPACE_KEY) || ""; } catch { /* blocked */ }
      setWs(list.find((w) => w.id === saved) || list.find((w) => !w.is_personal && w.role === "owner") || list[0] || null);
    }).catch(() => setWs(null));
  }, [step, user]);

  const field = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: k === "captcha" ? e.target.value.replace(/[^0-9-]/g, "") : e.target.value }));

  const createAccount = async (e?: FormEvent) => {
    e?.preventDefault();
    setErr("");
    if (!form.email.trim() || form.password.length < 8) { setErr("Add your work email and a password of at least 8 characters."); return; }
    if (!form.captcha) { setErr("Answer the quick check, so we know you are a person."); return; }
    setBusy(true);
    try {
      await register(form.email.trim(), form.password, captcha.id, form.captcha, form.name.trim() || undefined, form.company.trim() || undefined);
      try { localStorage.setItem("gd360_chosen_plan", JSON.stringify({ plan: params.get("plan") || "free", users: Number(params.get("users")) || 1, who })); } catch { /* blocked */ }
      if (returnTo) { navigate(returnTo, { replace: true }); return; }
      setStep(2);
    } catch (ex: any) {
      setErr(errorText(ex, "Couldn't create your account."));
      setForm((f) => ({ ...f, captcha: "" }));
      void loadCaptcha();
    } finally { setBusy(false); }
  };

  const [teamName, setTeamName] = useState("");
  const [making, setMaking] = useState(false);
  const [teamErr, setTeamErr] = useState("");
  useEffect(() => { if (step === 4 && !teamName) { const nm = form.name.trim() || user?.full_name || ""; setTeamName(form.company.trim() || user?.company || (nm ? `${nm.split(" ")[0]}'s team` : "My team")); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [step]);
  const makeTeam = async () => {
    setMaking(true); setTeamErr("");
    try {
      const w = await workspaceApi.create(teamName.trim());
      try { localStorage.setItem(ACTIVE_WORKSPACE_KEY, w.id); } catch { /* blocked */ }
      setWs(w);
    } catch (ex: any) { setTeamErr(errorText(ex, "Couldn't make the team space.")); }
    finally { setMaking(false); }
  };
  const inviteUrl = ws?.invite_token && !ws.is_personal ? `${window.location.origin}/invite/${ws.invite_token}` : "";
  const finish = () => {
    try { if (question.trim()) sessionStorage.setItem("gd360_first_question", question.trim()); } catch { /* blocked */ }
    if (source === "file" || source === "db") navigate("/data?tab=catalog");
    else if (source) navigate(`/data?tab=catalog&connect=${source}`);
    else navigate(question.trim() ? `/?ask=${encodeURIComponent(question.trim())}` : "/");
  };
  const qs = QUESTIONS[source] || QUESTIONS[""];

  return (
    <div className="mk2" data-mk2="start">
      <div className="mk2-on">
        <aside>
          <A href="/" className="mk2-logo"><Mark /><Wordmark size={18} tone="deep" /></A>
          <div className="mk2-steps" data-mk2-steps="">
            {STEPS.map(([t, d], i) => {
              const n = i + 1;
              return (
                <div key={t} className={`mk2-step${n === step ? " on" : n < step ? " done" : ""}`} data-mk2-step={n}>
                  <span className="d">{n < step ? "✓" : n}</span>
                  <div><b>{t}</b><span>{d}</span></div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: "auto", fontSize: 13, color: "var(--ink3)", lineHeight: 1.6 }}>
            Free while we are in early access, with every feature open. No card.<br />
            {!user && <>Already have an account? <A href="/login" style={{ color: "var(--brand)", fontWeight: 500 }}>Sign in</A></>}
          </div>
        </aside>
        <main>
          {step === 1 && (
            <>
              <span className="mk2-eb">Step 1 of 4</span>
              <h1>Who is Euliv for?</h1>
              <p className="lead">This sets up your first space. You can change it at any time.</p>
              <div className="mk2-tiles" role="radiogroup" aria-label="Who it is for">
                {WHO.map(([id, t, d]) => (
                  <button key={id} type="button" role="radio" aria-checked={who === id} className={`mk2-tile${who === id ? " on" : ""}`} onClick={() => setWho(id)} data-mk2-who={id}><b>{t}</b><span>{d}</span></button>
                ))}
              </div>
              <form className="mk2-form" onSubmit={createAccount} noValidate data-mk2-signup="">
                <label>Your name<input autoComplete="name" value={form.name} onChange={field("name")} placeholder="Asha Rao" /></label>
                <label>Company<input autoComplete="organization" value={form.company} onChange={field("company")} placeholder="Optional" /></label>
                <label>Work email<input type="email" autoComplete="email" required value={form.email} onChange={field("email")} placeholder="you@company.com" /></label>
                <label>Password<input type="password" autoComplete="new-password" required value={form.password} onChange={field("password")} placeholder="At least 8 characters" /></label>
                <label>{captcha.question ? `Quick check: ${captcha.question}` : "Quick check"}<input inputMode="numeric" value={form.captcha} onChange={field("captcha")} placeholder="Your answer" data-mk2-captcha="" /></label>
                <div style={{ display: "flex", alignItems: "flex-end" }}>
                  <button type="submit" className="mk2-btn pri lg" style={{ width: "100%" }} disabled={busy} data-mk2-create="">{busy ? "Creating your account…" : "Create account"}</button>
                </div>
                {err && <div className="mk2-err" style={{ gridColumn: "1 / -1" }} role="alert">{err}</div>}
              </form>
            </>
          )}
          {step === 2 && (
            <>
              <span className="mk2-eb">Step 2 of 4</span>
              <h1>{(form.name.trim() || user?.full_name) ? `Welcome, ${(form.name.trim() || user?.full_name || "").split(" ")[0]}. ` : ""}Where is your data?</h1>
              <p className="lead">Pick one to start. Connections are read-only, and you sign in to the app on the next screen, never here.</p>
              <div className="mk2-tiles" role="radiogroup" aria-label="First source">
                {CONNECT.map(([id, t, d]) => (
                  <button key={id} type="button" role="radio" aria-checked={source === id} className={`mk2-tile${source === id ? " on" : ""}`} onClick={() => setSource(source === id ? "" : id)} data-mk2-source={id}><b>{t}</b><span>{d}</span></button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" className="mk2-btn pri lg" onClick={() => setStep(3)} data-mk2-next="">{source ? "Continue" : "Skip for now"}</button>
              </div>
            </>
          )}
          {step === 3 && (
            <>
              <span className="mk2-eb">Step 3 of 4</span>
              <h1>What do you want to know first?</h1>
              <p className="lead">{source && source !== "db" && source !== "file" ? "A few people ask these first. Pick one or write your own; it waits in the box once your data is in." : "Pick one or write your own. It waits in the box when you open Euliv."}</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {qs.map((q) => (
                  <button key={q} type="button" className={`mk2-tile${question === q ? " on" : ""}`} onClick={() => setQuestion(q)} data-mk2-q=""><b style={{ fontWeight: 500 }}>{q}</b></button>
                ))}
              </div>
              <div className="mk2-form" style={{ gridTemplateColumns: "1fr" }}>
                <label>Or ask in your own words<input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Which customers spent the most this year?" data-mk2-question="" /></label>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" className="mk2-btn sec lg" onClick={() => setStep(2)}>Back</button>
                <button type="button" className="mk2-btn pri lg" onClick={() => setStep(4)} data-mk2-next="">Continue</button>
              </div>
            </>
          )}
          {step === 4 && (
            <>
              <span className="mk2-eb">Step 4 of 4</span>
              <h1>Bring your team in</h1>
              <p className="lead">Anyone who opens the link and signs in joins as a member. You can change their role in Settings › Members.</p>
              {inviteUrl ? (
                <div className="mk2-form" style={{ gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "end" }} data-mk2-invite="">
                  <label>Invite link for {ws?.name}<input readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} /></label>
                  <button type="button" className="mk2-btn sec lg" onClick={() => { void navigator.clipboard?.writeText(inviteUrl).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? "Copied" : "Copy link"}</button>
                </div>
              ) : (
                <div className="mk2-card" data-mk2-invite="none">
                  <p>{ws ? "Your personal space is only for you. Make a team space to get a link to share; you can do this later from the workspace menu too." : "Reading your workspace…"}</p>
                  {ws && (
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 6 }}>
                      <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13.5, fontWeight: 500, flex: "1 1 240px" }}>Team space name
                        <input value={teamName} onChange={(e) => setTeamName(e.target.value)} style={{ height: 42, borderRadius: 10, border: "1px solid var(--line2)", padding: "0 12px", font: "inherit", fontSize: 15 }} data-mk2-team-name="" />
                      </label>
                      <button type="button" className="mk2-btn sec lg" disabled={making || !teamName.trim()} onClick={makeTeam} data-mk2-make-team="">{making ? "Making it…" : "Make a team space"}</button>
                    </div>
                  )}
                  {teamErr && <div className="mk2-err">{teamErr}</div>}
                </div>
              )}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" className="mk2-btn sec lg" onClick={() => setStep(3)}>Back</button>
                <button type="button" className="mk2-btn pri lg" onClick={finish} data-mk2-finish="">{source && source !== "db" && source !== "file" ? `Connect ${CONNECT.find((c) => c[0] === source)?.[1]}` : source ? "Add my data" : "Open Euliv"}</button>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

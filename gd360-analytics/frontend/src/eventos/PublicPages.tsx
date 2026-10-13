// Round 42: the no-login pages of Event OS.
//   /t/:code      a person's ticket with its QR for the door
//   /sp/:token    a sponsor's live report (and their renewal answer)
//   /f/:token     the two-question survey (NPS + one line, ?t= ticket)
//   /x/:token     the shared, read-only Event 360
//   /sign/:token  a goal owner signs their expectation
import { ReactNode, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { API_URL } from "../api/client";
import { errText, Overview, publicEvent } from "../api/eventos";
import Overview360 from "./Overview360";
import { SponsorReportView } from "./SponsorReportView";
import { Ring } from "./charts";
import { fmtv, localWhen, PhaseStepper } from "./kit";

function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen bg-base text-text relative overflow-hidden">
      <div className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 w-[900px] h-[420px]" style={{ background: "radial-gradient(closest-side, rgb(var(--color-primary) / 0.12), transparent)" }} />
      <div className={`relative mx-auto px-4 py-8 sm:py-12 flex flex-col gap-5 ${wide ? "max-w-[1240px]" : "max-w-[480px]"}`}>
        {children}
        <div className="text-center text-caption text-muted pt-6">Powered by GD360 Event OS</div>
      </div>
    </div>
  );
}
const Panel = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <div className={`rounded-card border border-border bg-surface p-5 sm:p-6 flex flex-col gap-4 shadow-card ${className}`}>{children}</div>
);
function Missing({ text }: { text: string }) {
  return <Shell><Panel><div className="text-section font-semibold">This page isn't available</div><p className="m-0 text-ui text-secondary">{text}</p></Panel></Shell>;
}
const Loading = ({ h = 360 }: { h?: number }) => <Shell><div className="rounded-card bg-surface2 animate-pulse" style={{ height: h }} /></Shell>;

// ------------------------------------------------------------------ ticket --
export function TicketPage() {
  const { code = "" } = useParams();
  const [t, setT] = useState<any>(null);
  const [miss, setMiss] = useState("");
  useEffect(() => { publicEvent.ticket(code).then(setT).catch((e) => setMiss(errText(e, "We couldn't find that ticket."))); }, [code]);
  useEffect(() => { if (t) document.title = `Ticket · ${t.event.title}`; }, [t]);
  if (miss) return <Missing text={miss} />;
  if (!t) return <Loading />;
  const came = t.status === "checked_in";
  return (
    <Shell>
      <div className="rounded-[22px] overflow-hidden border border-border bg-surface shadow-card" data-ticket-page="">
        <div className="px-6 pt-6 pb-5 flex flex-col gap-1.5" style={{ background: "linear-gradient(135deg, rgb(var(--color-primary) / 0.22), rgb(var(--color-primary) / 0.04))" }}>
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-brand-ink">{t.tier === "free" ? "Admission" : t.tier} ticket</span>
          <h1 className="m-0 text-[24px] font-semibold tracking-tight leading-tight text-balance">{t.event.title}</h1>
          <span className="text-ui text-secondary">{[localWhen(t.event.start_local), t.event.location].filter((x) => x && x !== "–").join(" · ")}</span>
        </div>
        <div className="relative h-0 border-t border-dashed border-border mx-5">
          <span className="absolute -left-8 -top-3 w-6 h-6 rounded-full bg-base border border-border" /><span className="absolute -right-8 -top-3 w-6 h-6 rounded-full bg-base border border-border" />
        </div>
        <div className="px-6 py-6 flex flex-col items-center gap-4">
          <div className="rounded-[14px] bg-white p-3 w-[220px] h-[220px] [&>svg]:w-full [&>svg]:h-full" aria-label={`QR code for ticket ${t.code}`} role="img"
            dangerouslySetInnerHTML={{ __html: t.qr_svg }} />
          <span className="font-mono text-[26px] tracking-[0.2em] text-text">{t.code}</span>
          <div className="text-center"><div className="text-ui text-text font-medium">{t.name || "Guest"}</div><div className="text-caption text-muted">{t.company || ""}</div></div>
          <span className={`h-7 px-3 rounded-full inline-flex items-center text-caption border ${came ? "border-good-border bg-good-fill text-good" : "border-border text-secondary"}`}>
            {came ? "Checked in - enjoy the event" : t.confirmed ? "Confirmed · show this at the door" : "Show this at the door"}</span>
          {t.event.join_url && <a className="btn-primary w-full justify-center !h-11" href={t.event.join_url} target="_blank" rel="noreferrer">Join online</a>}
          {!t.confirmed && !came && <a className="text-caption text-brand-ink underline" href={`${API_URL}/public/eventos/c/${t.code}`}>Confirm I'm coming</a>}
        </div>
      </div>
      <p className="m-0 text-caption text-muted text-center">Screenshot this page - it works without signal.</p>
    </Shell>
  );
}

// ----------------------------------------------------------------- sponsor --
export function SponsorPublic() {
  const { token = "" } = useParams();
  const [r, setR] = useState<any>(null);
  const [miss, setMiss] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = () => publicEvent.sponsor(token).then(setR).catch((e) => setMiss(errText(e, "This report link isn't valid.")));
  useEffect(() => { load(); const t = window.setInterval(load, 60000); return () => window.clearInterval(t); }, [token]);
  useEffect(() => { if (r) document.title = `${r.sponsor.name} · ${r.event.title}`; }, [r]);
  if (miss) return <Missing text={miss} />;
  if (!r) return <Loading h={480} />;
  const renew = async (decision: string) => {
    setBusy(true); setErr("");
    try { await publicEvent.renew(token, decision, name || undefined); await load(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <Shell wide>
      <div className="flex flex-wrap items-end justify-between gap-4" data-sponsor-page="">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-brand-ink">Sponsor report · live{r.event.sample ? " · sample data" : ""}</span>
          <h1 className="m-0 text-[26px] sm:text-[30px] font-semibold tracking-tight">{r.sponsor.name}</h1>
          <span className="text-ui text-secondary">{r.event.title}{r.sponsor.booth ? ` · booth ${r.sponsor.booth}` : ""}{r.sponsor.tier ? ` · ${r.sponsor.tier}` : ""}</span>
        </div>
        <span className="text-caption text-muted">Updates every minute</span>
      </div>
      <SponsorReportView r={r} currency={r.event.currency || "INR"} />
      <Panel>
        <div className="flex flex-col gap-1"><div className="text-section font-semibold">Next year?</div>
          <div className="text-caption text-muted">One tap tells the organiser. {r.sponsor.renewal !== "none" && r.sponsor.renewal ? `Your answer: ${r.sponsor.renewal === "signed" ? "we're in" : r.sponsor.renewal === "verbal" ? "likely" : "not this time"}.` : ""}</div></div>
        <div className="flex gap-2 flex-wrap items-center">
          <input className="input !w-[220px]" placeholder="Your name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Your name" />
          <button type="button" className="btn-primary text-sm" disabled={busy} onClick={() => renew("signed")}>We're in for next year</button>
          <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => renew("verbal")}>Likely - let's talk</button>
          <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => renew("declined")}>Not this time</button>
        </div>
        {err && <div className="text-caption text-danger">{err}</div>}
      </Panel>
    </Shell>
  );
}

// ------------------------------------------------------------------ survey --
export function SurveyPage() {
  const { token = "" } = useParams();
  const [params] = useSearchParams();
  const t = params.get("t");
  const [s, setS] = useState<any>(null);
  const [miss, setMiss] = useState("");
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { publicEvent.survey(token, t).then(setS).catch((e) => setMiss(errText(e, "This survey link isn't valid."))); }, [token, t]);
  if (miss) return <Missing text={miss} />;
  if (!s) return <Loading />;
  const send = async () => {
    if (score === null) return;
    setBusy(true); setErr("");
    try { await publicEvent.answer(token, { t: t || undefined, score, comment: comment || undefined, ratings }); setDone(true); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  if (done) return <Shell><Panel><div className="text-[40px] leading-none text-good">✓</div><div className="text-section font-semibold">Thank you{s.name ? `, ${s.name}` : ""}</div>
    <p className="m-0 text-ui text-secondary">Your answer goes straight to the team behind {s.title}.</p></Panel></Shell>;
  const col = (n: number) => (n <= 6 ? "rgb(var(--color-danger))" : n <= 8 ? "rgb(var(--color-warning))" : "rgb(var(--color-good))");
  return (
    <Shell>
      <div className="flex flex-col gap-1"><span className="font-mono text-[11px] uppercase tracking-[0.14em] text-brand-ink">30 seconds</span>
        <h1 className="m-0 text-[24px] font-semibold tracking-tight text-balance">{s.name ? `${s.name}, how` : "How"} was {s.title}?</h1></div>
      <Panel>
        <div className="text-ui text-text">How likely are you to recommend it to a colleague?</div>
        <div className="grid grid-cols-11 gap-1" role="radiogroup" aria-label="Score from 0 to 10" data-nps="">
          {Array.from({ length: 11 }, (_, n) => (
            <button key={n} type="button" role="radio" aria-checked={score === n} onClick={() => setScore(n)}
              className="ui-focus h-11 rounded-[9px] border text-ui tabular-nums transition-colors"
              style={score === n ? { background: col(n), borderColor: col(n), color: "#06150F", fontWeight: 600 } : { borderColor: "rgb(var(--color-border))" }}>{n}</button>
          ))}
        </div>
        <div className="flex justify-between text-[11px] text-muted"><span>Not likely</span><span>Very likely</span></div>
        <label className="flex flex-col gap-1.5"><span className="text-ui text-text">What's the one thing we should keep or change?</span>
          <textarea className="input min-h-[96px]" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} /></label>
        {s.sessions?.length > 0 && (
          <details className="text-ui"><summary className="cursor-pointer text-secondary">Rate the sessions you saw (optional)</summary>
            <div className="flex flex-col gap-2 pt-3">
              {s.sessions.map((x: any) => (
                <div key={x.id} className="flex items-center gap-2 justify-between">
                  <span className="truncate text-caption text-text">{x.title}</span>
                  <span className="flex gap-0.5 shrink-0">{[1, 2, 3, 4, 5].map((v) => (
                    <button key={v} type="button" aria-label={`${v} stars`} onClick={() => setRatings({ ...ratings, [x.id]: v })}
                      className="text-[18px] leading-none px-0.5" style={{ color: (ratings[x.id] || 0) >= v ? "rgb(var(--color-warning))" : "rgb(var(--color-border-strong))" }}>★</button>))}</span>
                </div>
              ))}
            </div>
          </details>
        )}
        {err && <div className="text-caption text-danger">{err}</div>}
        <button type="button" className="btn-primary !h-12 text-[15px]" disabled={score === null || busy} onClick={send} data-send-survey="">{busy ? "Sending…" : "Send"}</button>
      </Panel>
    </Shell>
  );
}

// ------------------------------------------------------------------ shared --
export function SharedEvent() {
  const { token = "" } = useParams();
  const [ov, setOv] = useState<Overview | null>(null);
  const [miss, setMiss] = useState("");
  const load = () => publicEvent.shared(token).then(setOv).catch((e) => setMiss(errText(e, "This link isn't shared any more.")));
  useEffect(() => { load(); const t = window.setInterval(load, 120000); return () => window.clearInterval(t); }, [token]);
  useEffect(() => { if (ov) document.title = `${ov.event.title} · Event 360`; }, [ov]);
  if (miss) return <Missing text={miss} />;
  if (!ov) return <Loading h={520} />;
  const sc = ov.score;
  const val = sc.now.score ?? sc.predicted?.median ?? null;
  return (
    <Shell wide>
      <div className="flex flex-wrap items-center justify-between gap-5" data-shared-event="">
        <div className="flex flex-col gap-1.5 min-w-0">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-brand-ink">Event 360 · read-only · live{ov.event.sample ? " · sample data" : ""}</span>
          <h1 className="m-0 text-[26px] sm:text-[30px] font-semibold tracking-tight text-balance">{ov.event.title}</h1>
          <div className="flex items-center gap-4 flex-wrap text-ui text-secondary"><PhaseStepper now={ov.event.phase_now} />
            {ov.event.windows.start_local && <span>{localWhen(ov.event.windows.start_local)}</span>}</div>
        </div>
        <div className="flex items-center gap-3 rounded-card border border-border bg-surface px-3 py-2">
          <Ring value={val} size={64} stroke={6} />
          <span className="flex flex-col"><span className="text-caption text-muted">{sc.now.score !== null ? "Success score" : "Predicted success"}</span>
            <span className="text-ui">{sc.now.score !== null ? `${sc.now.confidence}% counted` : sc.predicted?.p10 !== undefined && sc.predicted?.p10 !== null ? `range ${sc.predicted.p10}–${sc.predicted.p90}` : "–"}</span></span>
        </div>
      </div>
      <Overview360 ov={ov} readOnly />
    </Shell>
  );
}

// -------------------------------------------------------------------- sign --
export function SignGoal() {
  const { token = "" } = useParams();
  const [g, setG] = useState<any>(null);
  const [miss, setMiss] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = () => publicEvent.goal(token).then((x) => { setG(x); if (!name) setName(x.owner_name || ""); }).catch((e) => setMiss(errText(e, "This sign link isn't valid.")));
  useEffect(() => { load(); }, [token]);
  if (miss) return <Missing text={miss} />;
  if (!g) return <Loading />;
  const sign = async () => {
    setBusy(true); setErr("");
    try { await publicEvent.sign(token, name.trim()); await load(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const f = (v: number | null) => fmtv(v, g.unit);
  return (
    <Shell>
      <div className="flex flex-col gap-1"><span className="font-mono text-[11px] uppercase tracking-[0.14em] text-brand-ink">Success contract · v{g.version}</span>
        <h1 className="m-0 text-[24px] font-semibold tracking-tight text-balance">{g.event}</h1></div>
      <Panel>
        <div className="flex flex-col gap-1"><span className="text-caption text-muted">{g.owner_name ? `${g.owner_name}'s expectation` : "Expectation"}</span>
          <div className="text-section font-semibold">{g.label}</div><span className="text-caption text-secondary">Measured as: {g.metric}</span></div>
        <div className="grid grid-cols-3 gap-2 text-center">
          {[["Disappointing", g.lower_is_better ? g.high : g.low, "rgb(var(--color-danger))"], ["Target", g.target, "rgb(var(--color-primary))"], ["Outstanding", g.lower_is_better ? g.low : g.high, "rgb(var(--color-good))"]].map(([l, v, c]) => (
            <div key={l as string} className="rounded-ctl border border-border px-2 py-3 flex flex-col gap-1"><span className="text-[11px] text-muted">{l as string}</span>
              <span className="text-[19px] font-semibold tabular-nums" style={{ color: c as string }}>{f(v as number)}</span></div>
          ))}
        </div>
        <p className="m-0 text-caption text-muted">{g.how} {g.lower_is_better ? "Lower is better." : ""}</p>
        {g.signed ? (
          <div className="rounded-ctl border border-good-border bg-good-fill text-good px-4 py-3 text-ui" data-signed="">Signed by {g.signed_by}. This is what the event will be judged on.</div>
        ) : (
          <div className="flex flex-col gap-2">
            <input className="input !h-11" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" aria-label="Your name" />
            {err && <div className="text-caption text-danger">{err}</div>}
            <button type="button" className="btn-primary !h-12 text-[15px]" disabled={busy || !name.trim()} onClick={sign} data-sign="">{busy ? "Signing…" : "I agree - sign"}</button>
          </div>
        )}
      </Panel>
    </Shell>
  );
}

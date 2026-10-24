// 2026-10-17 (R53): GD360 Events - Event OS as a product of its own. A public page at /events; the app is
// /events/app (the initiatives hub showing only events and webinars, under its own name).
import { Link } from "react-router-dom";
import ThemeToggle from "../components/ThemeToggle";

const PHASES: { k: string; t: string; d: string[] }[] = [
  { k: "Before", t: "Fill the room", d: ["A registration page with tickets and QR codes, live in a minute", "Registrations against a forecast with an 80% range", "Every post with the hashtag, the code or the banner in the picture - matched by itself", "Ad spend from campaigns named INIT-CODE, cost per registration, and where the next dollar does most"] },
  { k: "During", t: "Run the floor", d: ["A staff phone app: check-in, walk-ins in eight seconds, session doors - works offline", "Who came against who said they would, live", "Webinars: viewers minute by minute and the drop points", "Questions, polls and the hot list while it's happening"] },
  { k: "After", t: "Prove it", d: ["Webinar 360 complete ten minutes after the end", "A meetup report card at 9 am the next morning", "Pipeline from the companies that came, lift against what would have happened anyway", "The A–Z report and a board PDF - every number says how true it is"] },
];
const TYPES: [string, string][] = [
  ["In-person events", "Conferences, summits, launches, dinners - doors, sessions, sponsors and walk-ins."],
  ["Webinars", "Zoom or Teams. Attendance, minutes watched, hot / warm / cold, replay views."],
  ["Online events", "Several tracks at once, viewers per track, peaks and drops."],
  ["Meetups", "Small and solo-run. One phone, no setup, a report card the next morning."],
];
const TRUTH: [string, string, string][] = [
  ["Counted", "Scans, sign-ups, syncs - Euliv saw it happen.", "rgb(var(--color-good))"],
  ["Matched", "A post or a deal tied to the event by a rule you can read.", "rgb(var(--color-kind-analysis))"],
  ["Typed", "A number someone entered. Shown in amber, never mixed in quietly.", "rgb(var(--color-warning))"],
  ["Modelled", "A forecast or a lift, always with its range.", "rgb(var(--color-kind-alert))"],
];

export default function EventsLanding() {
  return (
    <div className="min-h-screen bg-base text-text" data-events-landing="">
      <header className="px-4 sm:px-8 py-4 flex items-center justify-between gap-3 max-w-[1120px] mx-auto">
        <Link to="/events" className="inline-flex items-center gap-2.5 text-text">
          <span className="w-8 h-8 rounded-[10px] grid place-items-center bg-primary text-on-primary" aria-hidden>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M8 3v4M16 3v4M3.5 10h17" /></svg>
          </span>
          <span className="font-semibold tracking-tight">Euliv Events</span>
        </Link>
        <nav className="flex items-center gap-2">
          <ThemeToggle />
          <Link to="/events/app" className="btn-secondary text-sm">Sign in</Link>
          <Link to="/start?product=events" className="btn-primary text-sm" data-events-start="">Start free</Link>
        </nav>
      </header>

      <main className="px-4 sm:px-8 max-w-[1120px] mx-auto flex flex-col gap-16 pb-20">
        <section className="pt-10 sm:pt-16 grid gap-10 lg:grid-cols-[1.1fr_1fr] items-center">
          <div className="flex flex-col gap-5">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-brand-ink">Event OS · from the first sign-up to the last post</span>
            <h1 className="m-0 text-[34px] sm:text-[46px] leading-[1.05] font-semibold tracking-tight text-balance">Know if your event worked - the morning after, not the month after.</h1>
            <p className="m-0 text-[17px] leading-relaxed text-secondary max-w-[560px]">Registration, check-in, buzz, the live floor and the report in one place. Posts, ad spend and pipeline find the event by themselves, and every number says whether it was counted, matched, typed or modelled.</p>
            <div className="flex gap-2 flex-wrap">
              <Link to="/start?product=events" className="btn-primary">Plan your next event</Link>
              <Link to="/events/app" className="btn-secondary">Open the app</Link>
            </div>
          </div>
          <div className="rounded-card border border-border bg-surface p-5 flex flex-col gap-4 shadow-card" aria-label="Example: an event's morning-after card">
            <div className="flex items-center justify-between"><span className="text-caption text-muted">Customer summit · the morning after</span><span className="text-caption text-good">● Report ready 9:00</span></div>
            <div className="grid grid-cols-3 gap-4">
              {[["412", "came", "of 455 expected"], ["38", "walk-ins", "counted at the door"], ["$1.2M", "pipeline", "matched, 14 deals"]].map(([v, l, h]) => (
                <div key={l} className="flex flex-col"><span className="text-[26px] font-semibold tabular-nums leading-none">{v}</span><span className="text-caption text-muted mt-1">{l}</span><span className="text-[11px] text-faint">{h}</span></div>
              ))}
            </div>
            <div className="h-2 rounded-full bg-surface2 overflow-hidden"><div className="h-full rounded-full bg-primary" style={{ width: "90%" }} /></div>
            <ul className="m-0 pl-4 text-caption text-secondary flex flex-col gap-1">
              <li>91% of registrations showed up; the 70-90% band came in at 84%.</li>
              <li>63 posts matched by hashtag, code or the banner in the picture.</li>
              <li>The thank-you email and the photo post are drafted for you.</li>
            </ul>
            <span className="text-[11px] text-faint">Example numbers.</span>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          {PHASES.map((p) => (
            <div key={p.k} className="rounded-card border border-border bg-surface p-5 flex flex-col gap-3">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">{p.k}</span>
              <h2 className="m-0 text-[20px] font-semibold tracking-tight">{p.t}</h2>
              <ul className="m-0 p-0 list-none flex flex-col gap-2">{p.d.map((x) => <li key={x} className="flex gap-2 text-ui text-secondary"><span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-primary shrink-0" />{x}</li>)}</ul>
            </div>
          ))}
        </section>

        <section className="flex flex-col gap-5">
          <h2 className="m-0 text-[24px] font-semibold tracking-tight">Every kind of event</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {TYPES.map(([t, d]) => <div key={t} className="rounded-card border border-border p-4"><div className="text-ui font-semibold">{t}</div><p className="m-0 mt-1 text-caption text-muted leading-relaxed">{d}</p></div>)}
          </div>
        </section>

        <section className="grid gap-8 lg:grid-cols-[1fr_1.2fr] items-start">
          <div className="flex flex-col gap-3">
            <h2 className="m-0 text-[24px] font-semibold tracking-tight">Numbers that say how true they are</h2>
            <p className="m-0 text-ui text-secondary leading-relaxed">Event reports mix what was counted with what someone typed into a spreadsheet. Euliv Events keeps them apart, so the board sees which numbers to trust.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {TRUTH.map(([t, d, c]) => (
              <div key={t} className="rounded-ctl border border-border p-3.5 flex flex-col gap-1">
                <span className="inline-flex items-center gap-2 text-ui font-medium" style={{ color: c }}><span className="w-2 h-2 rounded-full" style={{ background: c }} />{t}</span>
                <span className="text-caption text-muted">{d}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-card border border-tint-border bg-tint/50 p-6 sm:p-8 flex flex-wrap items-center justify-between gap-5">
          <div className="max-w-[620px]"><h2 className="m-0 text-[22px] font-semibold tracking-tight">Works with what you already use</h2>
            <p className="m-0 mt-1.5 text-ui text-secondary">Instagram, LinkedIn, Facebook and YouTube posts; Meta and Google Ads; GA4; HubSpot; Zoom and Microsoft Teams; Luma. Registrations go back to the ad platforms as conversions.</p></div>
          <Link to="/start?product=events" className="btn-primary">Start free</Link>
        </section>
      </main>
      <footer className="px-4 sm:px-8 py-8 border-t border-border text-caption text-muted text-center">Euliv Events is part of Euliv. <Link to="/" className="hover:text-text underline">gd360</Link> · <Link to="/privacy" className="hover:text-text underline">Privacy</Link></footer>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { errorText, gtmApi, Initiative, initiativesApi, PlanRow, Profile, TrackedLink } from "../api/initiatives";
import { askHref } from "./OverviewTab";
import { Banner, CopyField, Field, fmt, fmtDate, Section, Sheet } from "./ui";

type Props = { i: Initiative; reload: () => void; onError: (s: string) => void };

const STATE: Record<PlanRow["state"], [string, string]> = {
  live: ["Counted", "text-good bg-good-fill border-good-border"],
  connected: ["Connected data", "text-primary bg-tint border-tint-border"],
  setup: ["Needs setup", "text-warning bg-warning-fill border-warning-border"],
  manual: ["Logged by hand", "text-secondary bg-surface2 border-border"],
  waiting: ["Waiting", "text-muted bg-surface2 border-border"],
};
const KIND_LABEL: Record<string, string> = { landing_page: "Landing page", social_post: "Social post", ad: "Ad", email: "Email link", other: "Link" };

export default function TrackingTab({ i, reload, onError }: Props) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => { gtmApi.profile(i.workspace_id).then(setProfile).catch(() => undefined); }, [i.workspace_id]);

  const pages = i.tracked.filter((l) => l.kind === "landing_page");
  const posts = i.tracked.filter((l) => l.kind !== "landing_page");

  return (
    <div className="flex flex-col gap-5">
      <Section title="How every number is tracked" sub="For each target: counted automatically, already in your connected data, needs a one-time setup, or logged by hand.">
        <ul className="m-0 p-0 list-none flex flex-col divide-y divide-border" data-tracking-plan="">
          {i.tracking_plan.map((r) => (
            <li key={r.key} className="py-3 flex gap-3 items-start flex-wrap sm:flex-nowrap" data-plan-row={r.state}>
              <span className={`shrink-0 inline-flex items-center h-[24px] px-2.5 rounded-full border text-[11.5px] font-medium w-[118px] justify-center ${STATE[r.state][1]}`}>{STATE[r.state][0]}</span>
              <div className="min-w-0 flex-1">
                <div className="text-ui text-text font-medium">{r.label}</div>
                <div className="text-caption text-secondary leading-relaxed">{r.how}</div>
              </div>
              {r.action?.startsWith("ask:") && r.question && <Link to={askHref(r.action.slice(4), r.question)} className="btn-secondary text-sm !py-1.5 shrink-0">Ask it</Link>}
              {r.action === "tracking" && r.state === "setup" && <a href="#snippet" className="btn-secondary text-sm !py-1.5 shrink-0">Set up</a>}
              {r.action === "accounts" && r.state === "setup" && <Link to="/accounts?tab=sources" className="btn-secondary text-sm !py-1.5 shrink-0">Open sources</Link>}
            </li>
          ))}
        </ul>
      </Section>

      {i.ab && (
        <Banner kind={i.ab.state === "winner" ? "good" : "info"}>
          <b className="font-medium">A/B · {i.ab.a} vs {i.ab.b}:</b> {i.ab.text}
        </Banner>
      )}

      <Section title="Landing pages" sub="Built anywhere (Webflow, WordPress, your own site). Each page shows whether the snippet is reporting, its visitors and conversions. Mark two as A and B to compare."
        actions={i.can_edit ? <button type="button" className="btn-primary text-sm" onClick={() => setAdding("landing_page")} data-add-page="">Add landing page</button> : undefined}>
        {pages.length === 0 ? <p className="m-0 text-ui text-muted">No landing pages yet.</p> : <LinkTable i={i} rows={pages} reload={reload} onError={onError} pages />}
      </Section>

      <Section title="Posts, ads and links" sub="Use the GD360 link instead of the raw one: clicks are counted, visits are tagged to this initiative, and only this initiative's posts count - not everything the company publishes."
        actions={i.can_edit ? <button type="button" className="btn-primary text-sm" onClick={() => setAdding("social_post")} data-add-post="">Add post or ad</button> : undefined}>
        {posts.length === 0 ? <p className="m-0 text-ui text-muted">Nothing tracked yet. Add each LinkedIn post, ad or link you share for this initiative.</p> : <LinkTable i={i} rows={posts} reload={reload} onError={onError} />}
        <p className="m-0 text-caption text-muted">Reach and impressions live inside LinkedIn, Instagram and ad managers. Log them in one line on “Today & updates” and pick the post - or connect LinkedIn Pages, Meta Ads or Google Ads under Data sources and ask them directly.</p>
      </Section>

      {i.breakdown.length > 0 && (
        <Section title="By channel, organic vs paid" sub="Only this initiative's own posts, ads and pages.">
          <div className="overflow-x-auto -mx-5 px-5">
            <table className="w-full min-w-[720px] text-ui" data-breakdown="">
              <thead><tr className="text-left text-caption text-muted border-b border-border">
                <th className="py-2 font-medium">Channel</th><th className="font-medium">Type</th><th className="font-medium">Region</th>
                {["Reach", "Clicks", "Visits", "Conversions", "Spend", "Cost / conversion"].map((h) => <th key={h} className="font-medium text-right px-2">{h}</th>)}
              </tr></thead>
              <tbody>{i.breakdown.map((b, k) => (
                <tr key={k} className="border-b border-border last:border-0">
                  <td className="py-2 capitalize">{b.channel.replace("_", " ")}</td>
                  <td><span className={`text-caption px-2 py-0.5 rounded-full ${b.mode === "Paid" ? "bg-warning-fill text-warning" : "bg-good-fill text-good"}`}>{b.mode}</span></td>
                  <td className="text-secondary">{b.region || "—"}</td>
                  <td className="text-right px-2 tabular-nums">{b.reach ? fmt(b.reach) : "—"}</td>
                  <td className="text-right px-2 tabular-nums">{fmt(b.clicks)}</td>
                  <td className="text-right px-2 tabular-nums">{fmt(b.visits)}</td>
                  <td className="text-right px-2 tabular-nums">{fmt(b.conversions)}</td>
                  <td className="text-right px-2 tabular-nums">{b.spend ? fmt(b.spend, "money") : "—"}</td>
                  <td className="text-right px-2 tabular-nums">{b.cost_per_conversion ? fmt(b.cost_per_conversion, "money") : "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Section>
      )}

      <Section id="snippet" title="Website snippet" sub="One line in the <head> of your site and landing pages. No cookies; a random visitor id only. Named companies appear when people click your emails, register, or when IPinfo is connected.">
        {profile ? (
          <>
            <CopyField value={profile.snippet} testId="snippet" label="Tracking snippet" />
            <div className={`text-caption ${profile.tracking.live ? "text-good" : "text-warning"}`}>
              {profile.tracking.live ? `Reporting - last visit ${fmtDate(profile.tracking.last_visit_at)}` : "No visits seen yet. Add the snippet, publish, then open the page once."}
            </div>
            <details className="text-caption text-secondary">
              <summary className="cursor-pointer text-text">Forms and conversions on your pages (optional)</summary>
              <pre className="mt-2 p-3 rounded-ctl bg-base border border-border overflow-x-auto text-[12px] leading-relaxed">{`// after your own form submits:
gd360.identify(email, name, company);   // names the visitor and their company
gd360.subscribe(email, name);           // newsletter sign-up (with consent)
gd360.conversion("demo_request");       // counts a conversion on this page`}</pre>
            </details>
          </>
        ) : <div className="h-10 rounded-ctl bg-surface2 animate-pulse" />}
      </Section>

      {adding && <AddLink i={i} kind={adding} onClose={() => setAdding(null)} onDone={() => { setAdding(null); reload(); }} onError={onError} />}
    </div>
  );
}

function LinkTable({ i, rows, reload, onError, pages = false }: { i: Initiative; rows: TrackedLink[]; reload: () => void; onError: (s: string) => void; pages?: boolean }) {
  const [open, setOpen] = useState<TrackedLink | null>(null);
  return (
    <>
      <div className="overflow-x-auto -mx-5 px-5">
        <table className="w-full min-w-[820px] text-ui" data-links={pages ? "pages" : "posts"}>
          <thead><tr className="text-left text-caption text-muted border-b border-border">
            <th className="py-2 font-medium">{pages ? "Page" : "Post / ad"}</th><th className="font-medium">Type</th>
            {(pages ? ["Visitors", "Visits", "Accounts", "Conversions", "Rate"] : ["Clicks", "Visits", "Reach (logged)", "Conversions"]).map((h) => <th key={h} className="font-medium text-right px-2">{h}</th>)}
            <th className="font-medium">{pages ? "Tracking" : "Last click"}</th><th />
          </tr></thead>
          <tbody>{rows.map((l) => (
            <tr key={l.id} className="border-b border-border last:border-0" data-link-row={l.label}>
              <td className="py-2.5 pr-2"><div className="flex items-center gap-2">{l.variant && <span className="inline-grid place-items-center w-6 h-6 rounded-[7px] bg-surface2 text-caption font-semibold text-text">{l.variant}</span>}
                <div className="min-w-0"><div className="text-text truncate max-w-[260px]">{l.label}</div><a href={l.url} target="_blank" rel="noreferrer" className="text-caption text-muted hover:underline truncate block max-w-[260px]">{l.url.replace(/^https?:\/\//, "")}</a></div></div></td>
              <td className="text-caption text-secondary whitespace-nowrap">{pages ? "" : `${l.channel ? `${l.channel} · ` : ""}`}<span className={l.paid ? "text-warning" : "text-good"}>{l.paid ? "Paid" : "Organic"}</span>{l.region ? ` · ${l.region}` : ""}</td>
              {pages ? <>
                <td className="text-right px-2 tabular-nums">{fmt(l.visitors)}</td><td className="text-right px-2 tabular-nums">{fmt(l.visits)}</td>
                <td className="text-right px-2 tabular-nums">{fmt(l.accounts)}</td><td className="text-right px-2 tabular-nums">{fmt(l.conversions)}</td>
                <td className="text-right px-2 tabular-nums">{l.conversion_rate !== null ? `${l.conversion_rate}%` : "—"}</td>
                <td className="text-caption whitespace-nowrap">{l.tracking?.state === "live" ? <span className="text-good">Live</span> : l.tracking?.state === "stale" ? <span className="text-warning">Quiet 14+ days</span> : <span className="text-warning">Not reporting</span>}</td>
              </> : <>
                <td className="text-right px-2 tabular-nums">{fmt(l.clicks)}</td><td className="text-right px-2 tabular-nums">{fmt(l.visits)}</td>
                <td className="text-right px-2 tabular-nums">{l.logged?.reach ? fmt(l.logged.reach) : "—"}</td><td className="text-right px-2 tabular-nums">{fmt(l.conversions)}</td>
                <td className="text-caption text-muted">{l.last_click_at ? fmtDate(l.last_click_at) : "—"}</td>
              </>}
              <td className="text-right"><button type="button" className="text-caption text-primary hover:underline" onClick={() => setOpen(l)}>{pages ? "Details" : "Link"}</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {open && (
        <Sheet open onClose={() => setOpen(null)} title={open.label}
          footer={i.can_edit ? <button type="button" className="btn-secondary text-sm !text-danger" onClick={async () => { try { await initiativesApi.deleteLink(i.id, open.id); setOpen(null); reload(); } catch (e) { onError(errorText(e)); } }}>Stop tracking</button> : undefined}>
          <Field label="Share this link instead of the original" hint="Counts the click, tags the visit to this initiative, then goes to the page."><CopyField value={open.tracked_url} testId="tracked-url" /></Field>
          <Field label="Goes to"><span className="text-ui text-secondary break-all">{open.url}</span></Field>
          {i.can_edit && <EditLink i={i} l={open} onDone={() => { setOpen(null); reload(); }} onError={onError} />}
        </Sheet>
      )}
    </>
  );
}

function EditLink({ i, l, onDone, onError }: { i: Initiative; l: TrackedLink; onDone: () => void; onError: (s: string) => void }) {
  const [f, setF] = useState({ label: l.label, variant: l.variant || "", paid: l.paid, region: l.region || "", channel: l.channel || "" });
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><input className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
        <Field label="Channel"><input className="input" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} /></Field>
        <Field label="Region"><input className="input" value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} /></Field>
        <Field label="A/B variant"><select className="input" value={f.variant} onChange={(e) => setF({ ...f, variant: e.target.value })}><option value="">None</option><option value="A">A</option><option value="B">B</option></select></Field>
      </div>
      <label className="flex items-center gap-2 text-ui"><input type="checkbox" checked={f.paid} onChange={(e) => setF({ ...f, paid: e.target.checked })} /> Paid promotion</label>
      <div><button type="button" className="btn-primary text-sm" onClick={async () => { try { await initiativesApi.patchLink(i.id, l.id, f); onDone(); } catch (e) { onError(errorText(e)); } }}>Save</button></div>
    </div>
  );
}

function AddLink({ i, kind, onClose, onDone, onError }: { i: Initiative; kind: string; onClose: () => void; onDone: () => void; onError: (s: string) => void }) {
  const region0 = i.scope.regions?.[0] || "";
  const [f, setF] = useState({ kind, label: "", url: "", channel: kind === "landing_page" ? "" : "linkedin", paid: false, region: region0, variant: "" });
  const [made, setMade] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title={kind === "landing_page" ? "Add a landing page" : "Add a post, ad or link"}
      footer={made ? <button type="button" className="btn-primary text-sm" onClick={onDone}>Done</button> : <button type="button" className="btn-primary text-sm" disabled={busy || !f.url.trim()} onClick={async () => {
        setBusy(true);
        try { const r = await initiativesApi.addLink(i.id, f); setMade(r.tracked_url); } catch (e) { onError(errorText(e)); } finally { setBusy(false); }
      }} data-save-link="">Track it</button>}>
      {made ? (
        <>
          <Banner kind="good">Tracking. {f.kind === "landing_page" ? "Make sure the snippet is on this page - the Tracking tab shows when it starts reporting." : "Use this link in the post or ad:"}</Banner>
          <CopyField value={made} testId="new-tracked-url" />
        </>
      ) : (
        <>
          <Field label="Type"><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label={f.kind === "landing_page" ? "Page address" : "Where it should go (the page or the post)"}><input className="input" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://" data-link-url="" /></Field>
          <Field label="Name"><input className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder={f.kind === "landing_page" ? "Page A - short form" : "LinkedIn US promo #1"} /></Field>
          <div className="grid gap-3 sm:grid-cols-3">
            {f.kind !== "landing_page" && <Field label="Channel"><select className="input" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
              {["linkedin", "instagram", "facebook", "x", "youtube", "google_ads", "newsletter", "partner", "other"].map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}</select></Field>}
            <Field label="Region"><input className="input" value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} placeholder="e.g. US" /></Field>
            {f.kind === "landing_page" && <Field label="A/B variant"><select className="input" value={f.variant} onChange={(e) => setF({ ...f, variant: e.target.value })}><option value="">None</option><option value="A">A</option><option value="B">B</option></select></Field>}
          </div>
          <label className="flex items-center gap-2 text-ui"><input type="checkbox" checked={f.paid} onChange={(e) => setF({ ...f, paid: e.target.checked })} /> Paid promotion (boosted post or ad)</label>
        </>
      )}
    </Sheet>
  );
}

// 2026-10-17 (R53): Evidence - the tracking contract, every post, ad, UTM session, deal, email and page the Tracker
// matched to this initiative, the review queue for matches under the policy's bar, and the extra sources
// (picture check, Teams attendance, LinkedIn @mentions). Numbers here are what the targets count.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { errorText, Initiative } from "../api/initiatives";
import { ApOne, autopilotApi, Ev } from "../api/autopilot";
import { Banner, Empty, fmt, fmtDate, Section, Stat } from "../initiatives/ui";
import { Seg } from "../eventos/kit";
import { compact } from "../eventos/charts";
import { ContractCard, EvKindIcon, ReviewRow } from "./kit";

const KINDS: { id: string; label: string }[] = [
  { id: "all", label: "All" }, { id: "post", label: "Posts" }, { id: "ad", label: "Ads" }, { id: "web", label: "Web" },
  { id: "deal", label: "Deals" }, { id: "email", label: "Emails" }, { id: "page", label: "Pages" },
];
const VALUE_LABEL: [string, string, string][] = [
  ["social_reach", "Social reach", "count"], ["ad_spend", "Ad spend", "money"], ["ad_conversions", "Ad results", "count"], ["utm_sessions", "UTM sessions", "count"],
  ["pipeline_value", "Pipeline sourced", "money"], ["revenue", "Revenue won", "money"], ["posts_matched", "Posts matched", "count"],
];

export default function EvidenceTab({ i, reload }: { i: Initiative; reload: () => void }) {
  const [ap, setAp] = useState<ApOne | null>(null);
  const [rows, setRows] = useState<Ev[] | null>(null);
  const [values, setValues] = useState<Record<string, number>>({});
  const [kind, setKind] = useState("all");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(() => {
    autopilotApi.one(i.id).then(setAp).catch((e) => setErr(errorText(e, "Couldn't load the evidence.")));
    autopilotApi.evidence(i.id).then((r) => { setRows(r.evidence); setValues(r.values || {}); }).catch((e) => setErr(errorText(e)));
  }, [i.id]);
  useEffect(load, [load]);
  const changed = () => { load(); reload(); };

  const run = async (label: string, f: () => Promise<any>, msg: (r: any) => string) => {
    setBusy(label); setErr(""); setNote("");
    try { const r = await f(); if (r && r.ok === false) setErr(r.why || "That didn't work."); else setNote(msg(r)); changed(); } catch (e) { setErr(errorText(e)); } finally { setBusy(""); }
  };
  const scan = () => run("scan", () => autopilotApi.run(i.id), (r) =>
    `Scanned. ${r.evidence?.new ?? 0} new, ${r.evidence?.review ?? 0} to review${r.closed?.length ? `, ${r.closed.length} task${r.closed.length > 1 ? "s" : ""} closed` : ""}.`);

  const review = useMemo(() => (rows || []).filter((e) => e.state === "review"), [rows]);
  const shown = useMemo(() => (rows || []).filter((e) => e.state !== "review" && (kind === "all" || e.kind === kind)), [rows, kind]);
  const vals = VALUE_LABEL.filter(([k]) => values[k] !== undefined && values[k] !== null);

  return (
    <div className="flex flex-col gap-5" data-evidence-tab="">
      {err && <Banner kind="error" onClose={() => setErr("")}>{err}</Banner>}
      {note && <Banner kind="good" onClose={() => setNote("")}>{note}</Banner>}

      <Section title="Tracking contract" sub="How every number finds this initiative. Use these and nothing has to be typed."
        actions={i.can_edit ? <button type="button" className="btn-primary text-sm" onClick={scan} disabled={!!busy} data-scan="">{busy === "scan" ? "Scanning…" : "Scan now"}</button> : undefined}>
        {!ap ? <div className="h-28 rounded-ctl bg-surface2 animate-pulse" /> : (
          <ContractCard c={ap.contract} canEdit={i.can_edit}
            onPatch={async (b) => { try { await autopilotApi.contract(i.id, b); changed(); } catch (e) { setErr(errorText(e)); } }} />
        )}
        {ap && (
          <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-caption text-muted" data-sources="">
            <span>Last scan {ap.last_scan ? new Date(ap.last_scan).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "not yet"}</span>
            {ap.sources.length ? ap.sources.map((s, k) => <span key={k} className="text-secondary">{s.name}</span>)
              : <span>No synced sources yet - <Link to="/data" className="text-brand-ink hover:underline">connect Instagram, LinkedIn, Meta / Google Ads, GA4 or HubSpot</Link>.</span>}
          </div>
        )}
      </Section>

      {vals.length > 0 && (
        <Section title="What the evidence adds up to" sub="Counted from accepted evidence only. Rejected matches never count.">
          <div className="grid gap-5 grid-cols-[repeat(auto-fill,minmax(140px,1fr))]">
            {vals.map(([k, l, u]) => <Stat key={k} label={l} value={fmt(values[k], u)} />)}
          </div>
        </Section>
      )}

      {review.length > 0 && (
        <Section title={`To review · ${review.length}`} sub={`Matches under ${Math.round(100 * (ap?.policy.auto_attach_at || 0.9))}% sure. Confirm adds their numbers; reject keeps them out for good.`}>
          <div className="flex flex-col" data-review-queue="">
            {review.map((e) => <ReviewRow key={e.id} e={e} initiativeId={i.id} canEdit={i.can_edit} onChanged={changed} />)}
          </div>
        </Section>
      )}

      <Section title="Evidence" sub="Everything attached, newest first." >
        <div className="overflow-x-auto -mx-1 px-1 [scrollbar-width:none]">
          <Seg items={KINDS.map((k) => ({ ...k, badge: k.id === "all" ? null : (rows || []).filter((e) => e.kind === k.id && e.state !== "review").length || null }))} value={kind} onChange={setKind} label="Evidence kind" />
        </div>
        {!rows ? <div className="h-24 rounded-ctl bg-surface2 animate-pulse" /> : shown.length === 0 ? (
          <Empty title="Nothing attached yet" body={`Name ad campaigns ${ap?.contract.ad_rule || "INIT-CODE"}, tag posts ${ap?.contract.hashtag || "with the hashtag"}, and use the UTM campaign on links. Then Scan now.`} />
        ) : (
          <ul className="m-0 p-0 list-none flex flex-col divide-y divide-border" data-evidence-list="">
            {shown.slice(0, 120).map((e) => (
              <li key={e.id} className="py-2.5 flex gap-3 items-start min-w-0" data-ev={e.kind} data-ev-state={e.state}>
                <EvKindIcon kind={e.kind} />
                <div className="min-w-0 flex-1">
                  <div className="text-ui text-text truncate">{e.url ? <a href={e.url} target="_blank" rel="noreferrer" className="hover:underline block truncate">{e.title || e.text}</a> : (e.title || e.text)}</div>
                  <div className="text-caption text-muted">{e.source}{e.occurred_at ? ` · ${fmtDate(e.occurred_at)}` : ""} · {e.state === "rejected" ? "rejected" : e.state === "confirmed" ? `confirmed${e.decided_by ? ` by ${e.decided_by}` : ""}` : `matched by ${e.matched_by}`}{e.why ? ` · ${e.why}` : ""}</div>
                </div>
                <div className="text-caption tabular-nums text-secondary text-right shrink-0">
                  {Object.entries(e.numbers || {}).filter(([, v]) => v !== null && v !== undefined).slice(0, 2).map(([k, v]) => (
                    <div key={k}>{k === "spend" || k === "amount" ? fmt(Number(v), "money") : compact(Number(v))} <span className="text-muted">{k.replace(/_/g, " ")}</span></div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {i.can_edit && <MoreSources i={i} busy={busy} run={run} />}
    </div>
  );
}

function MoreSources({ i, busy, run }: { i: Initiative; busy: string; run: (label: string, f: () => Promise<any>, msg: (r: any) => string) => Promise<void> }) {
  const [mapKind, setMapKind] = useState<"ad" | "post">("ad");
  const [mapVal, setMapVal] = useState("");
  const [org, setOrg] = useState("");
  const [meeting, setMeeting] = useState("");
  return (
    <Section title="Add a source by hand" sub="For the things a naming rule can't catch.">
      <div className="grid gap-5 md:grid-cols-2">
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (mapVal.trim()) run("map", () => autopilotApi.map(i.id, mapKind, mapVal.trim()), (r) => `Mapped. ${r.found?.found ?? 0} items found on the rescan.`).then(() => setMapVal("")); }} data-map-form="">
          <span className="text-ui text-text font-medium">Map an ad campaign or a post</span>
          <span className="text-caption text-muted">Paste the campaign name or ID, or the post's link or ID. It counts at 100%.</span>
          <div className="flex gap-2 flex-wrap">
            <select className="input !w-auto !py-2 text-caption" value={mapKind} onChange={(e) => setMapKind(e.target.value as "ad" | "post")} aria-label="Kind"><option value="ad">Ad campaign</option><option value="post">Post</option></select>
            <input className="input !py-2 text-caption flex-1 min-w-[160px]" value={mapVal} onChange={(e) => setMapVal(e.target.value)} placeholder={mapKind === "ad" ? "Spring launch - prospecting" : "https://www.instagram.com/p/…"} aria-label="Campaign or post" />
            <button type="submit" className="btn-secondary text-caption !py-2" disabled={!!busy || mapVal.trim().length < 2}>{busy === "map" ? "Mapping…" : "Map"}</button>
          </div>
        </form>
        <div className="flex flex-col gap-2">
          <span className="text-ui text-text font-medium">Picture check</span>
          <span className="text-caption text-muted">Upload the banner or logo. Posts that show it in the picture are matched even without the hashtag.</span>
          <label className="btn-secondary text-caption !py-2 w-fit cursor-pointer">
            {busy === "banner" ? "Uploading…" : "Upload an image"}
            <input type="file" accept="image/*" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) run("banner", () => autopilotApi.banner(i.id, f), () => "Saved. The next scan checks pictures for it."); e.target.value = ""; }} data-banner-file="" />
          </label>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-ui text-text font-medium">LinkedIn @mentions</span>
          <span className="text-caption text-muted">Posts by other people that mention your company page. Needs the LinkedIn token in <Link to="/initiatives/autopilot" className="text-brand-ink hover:underline">Autopilot setup</Link> and LinkedIn's Community Management approval.</span>
          <button type="button" className="btn-secondary text-caption !py-2 w-fit" disabled={!!busy} onClick={() => run("mentions", () => autopilotApi.mentions(i.id), (r) => `${r.found ?? 0} mention${r.found === 1 ? "" : "s"} found.`)} data-mentions="">
            {busy === "mentions" ? "Checking…" : "Check mentions now"}</button>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-ui text-text font-medium">Microsoft Teams attendance</span>
          <span className="text-caption text-muted">Upload the attendance report (CSV) from the meeting, or pull it with the Graph app from setup.</span>
          <div className="flex gap-2 flex-wrap items-center">
            <label className="btn-secondary text-caption !py-2 cursor-pointer">
              {busy === "teams" ? "Importing…" : "Upload CSV"}
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) run("teams", () => autopilotApi.teamsImport(i.id, f), (r) => `${r.attended ?? 0} attendees imported from ${r.rows ?? 0} rows.`); e.target.value = ""; }} data-teams-file="" />
            </label>
          </div>
          <form className="flex gap-2 flex-wrap" onSubmit={(e) => { e.preventDefault(); run("pull", () => autopilotApi.teamsPull(i.id, org.trim(), meeting.trim()), (r) => `${r.attended ?? 0} attendees pulled from Teams.`); }}>
            <input className="input !py-2 text-caption flex-1 min-w-[140px]" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Organizer email" aria-label="Organizer email" />
            <input className="input !py-2 text-caption flex-1 min-w-[140px]" value={meeting} onChange={(e) => setMeeting(e.target.value)} placeholder="Online meeting ID" aria-label="Meeting ID" />
            <button type="submit" className="btn-secondary text-caption !py-2" disabled={!!busy || org.trim().length < 3 || meeting.trim().length < 3}>{busy === "pull" ? "Pulling…" : "Pull"}</button>
          </form>
        </div>
      </div>
    </Section>
  );
}

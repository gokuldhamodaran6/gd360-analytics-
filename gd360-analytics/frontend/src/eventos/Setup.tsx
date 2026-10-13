// Setup: everything that lets the numbers fill themselves - when and
// where, the tracking identity (code, hashtags, words, handles), brand
// images for the picture check, ads, the agenda, the floor, money, the
// online platform, and the links.
import { useEffect, useRef, useState } from "react";
import { Initiative, initiativesApi } from "../api/initiatives";
import { API_URL } from "../api/client";
import { assetUrl, ConfigData, eventApi, errText, SessionRow } from "../api/eventos";
import { Banner, CopyField, Field } from "../initiatives/ui";
import { Card, Eyebrow, money, Skel } from "./kit";

const TZ = ["Asia/Kolkata", "Asia/Singapore", "Asia/Dubai", "Asia/Tokyo", "Asia/Jakarta", "Europe/London", "Europe/Berlin", "Europe/Paris", "America/New_York",
  "America/Chicago", "America/Los_Angeles", "Australia/Sydney", "Africa/Lagos", "Africa/Nairobi", "UTC"];
const list = (s: string) => s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
const local = (iso: string | null) => (iso ? iso.slice(0, 16) : "");

export default function SetupTab({ i, onChanged, onDeleted }: { i: Initiative; onChanged: () => void; onDeleted: () => void }) {
  const [d, setD] = useState<ConfigData | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [f, setF] = useState<any>(null);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const [assetKind, setAssetKind] = useState("banner");
  const [ns, setNs] = useState({ title: "", speaker: "", room: "", starts_at: "", ends_at: "", capacity: "", online: false });
  const [csvSession, setCsvSession] = useState("");
  const load = () => {
    eventApi.config(i.id).then((x) => {
      setD(x);
      const c = x.config;
      setF({ ...c, starts_at: local(c.starts_at), ends_at: local(c.ends_at), hashtags: c.hashtags.join(", "), keywords: c.keywords.join(", "),
        promo_codes: c.promo_codes.join(", "), speakers: (c.handles.speakers || []).join("\n"), sponsors: (c.handles.sponsors || []).join("\n"),
        press: (c.handles.press || []).join("\n"), creators: (c.handles.creators || []).join("\n"), ad_campaigns: c.ad_campaigns.join("\n"),
        zones: c.zones.length ? c.zones : [], costs: c.costs, vip: c.prices.vip ?? "", paid: c.prices.paid ?? "", zoom_secret: "" });
    }).catch((e) => setErr(errText(e)));
    eventApi.sessions(i.id).then((x) => setSessions(x.sessions)).catch(() => undefined);
  };
  useEffect(load, [i.id]);
  if (!d || !f) return <div className="grid gap-4"><Skel h={260} /><Skel h={260} /></div>;
  const can = d.can_edit;
  const save = async (key: string, body: any) => {
    setBusy(key); setErr(""); setOk("");
    try { await eventApi.patchConfig(i.id, body); setOk("Saved."); load(); onChanged(); } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  };
  const token = d.links.registration.split("/e/")[1] || "";
  const staffKey = (d.links.staff.split("?k=")[1] || "").split("&")[0];
  const SaveBtn = ({ k, body }: { k: string; body: () => any }) => can ? (
    <button type="button" className="btn-primary text-sm self-start" disabled={busy === k} onClick={() => save(k, body())}>{busy === k ? "Saving…" : "Save"}</button>) : null;
  const upload = async (file: File) => {
    setBusy("asset"); setErr("");
    try { await eventApi.addAsset(i.id, file, assetKind); load(); onChanged(); } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  };
  const importCsv = async (file: File) => {
    setBusy("csv"); setErr(""); setOk("");
    try { const r: any = await eventApi.importAttendance(i.id, file, csvSession || undefined); setOk(`Attendance report read: ${r.people} people, ${r.joined} newly joined, ${r.new} who hadn't registered.`); onChanged(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  };
  const addSession = async () => {
    setErr("");
    try {
      await eventApi.addSession(i.id, { ...ns, capacity: ns.capacity ? Number(ns.capacity) : null, starts_at: ns.starts_at || null, ends_at: ns.ends_at || null });
      setNs({ title: "", speaker: "", room: "", starts_at: "", ends_at: "", capacity: "", online: false }); load();
    } catch (e) { setErr(errText(e)); }
  };
  return (
    <div className="flex flex-col gap-5" data-screen="setup">
      {err && <Banner kind="error" onClose={() => setErr("")}>{err}</Banner>}
      {ok && <Banner kind="good" onClose={() => setOk("")}>{ok}</Banner>}
      <div className="flex flex-col gap-1"><Eyebrow>Setup · tracking readiness {Math.round((100 * d.checks.filter((c) => c.ok).length) / Math.max(d.checks.length, 1))}%</Eyebrow>
        <h2 className="m-0 text-[20px] font-semibold text-text">Set it once - every number fills itself in</h2></div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {d.checks.map((c) => (
          <div key={c.key} className={`rounded-ctl border px-3 py-2 text-caption flex items-center gap-2 ${c.ok ? "border-good-border bg-good-fill text-good" : "border-warning-border bg-warning-fill text-warning"}`}>
            <span>{c.ok ? "✓" : "•"}</span><span className="text-text">{c.label}</span>{!c.ok && <span className="ml-auto truncate">{c.fix}</span>}
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="When and where" sub="Times are the venue's local time">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Format"><select className="input" value={f.format} disabled={!can} onChange={(e) => setF({ ...f, format: e.target.value })}>
              {[["offline", "In person"], ["hybrid", "In person + online"], ["online", "Online live event"], ["webinar", "Webinar"], ["meetup", "Meetup"], ["booth", "Booth at a show"],
                ["roadshow", "Roadshow"], ["launch", "Product launch"], ["workshop", "Workshop"], ["festival", "Festival"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Size"><select className="input" value={f.mode} disabled={!can} onChange={(e) => setF({ ...f, mode: e.target.value })}>
              <option value="solo">Solo - a phone is enough</option><option value="team">Team</option><option value="pro">Pro</option><option value="mega">Mega</option></select></Field>
            <Field label="Starts"><input type="datetime-local" className="input" value={f.starts_at} disabled={!can} onChange={(e) => setF({ ...f, starts_at: e.target.value })} /></Field>
            <Field label="Ends"><input type="datetime-local" className="input" value={f.ends_at} disabled={!can} onChange={(e) => setF({ ...f, ends_at: e.target.value })} /></Field>
            <Field label="Time zone"><select className="input" value={f.timezone || "Asia/Kolkata"} disabled={!can} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
              {TZ.map((t) => <option key={t} value={t}>{t}</option>)}</select></Field>
            <Field label="City"><input className="input" value={f.city || ""} disabled={!can} onChange={(e) => setF({ ...f, city: e.target.value })} placeholder="Bengaluru" /></Field>
            <Field label="Capacity"><input className="input" inputMode="numeric" value={f.capacity ?? ""} disabled={!can} onChange={(e) => setF({ ...f, capacity: e.target.value })} /></Field>
            <Field label="Fire limit"><input className="input" inputMode="numeric" value={f.fire_limit ?? ""} disabled={!can} onChange={(e) => setF({ ...f, fire_limit: e.target.value })} /></Field>
            <Field label="Keep watching after (days)" hint="Posts, replays and pipeline keep counting"><input className="input" inputMode="numeric" value={f.post_window_days} disabled={!can} onChange={(e) => setF({ ...f, post_window_days: e.target.value })} /></Field>
          </div>
          <SaveBtn k="when" body={() => ({ format: f.format, mode: f.mode, starts_at: f.starts_at || null, ends_at: f.ends_at || null, timezone: f.timezone, city: f.city,
            capacity: f.capacity === "" ? null : Number(f.capacity), fire_limit: f.fire_limit === "" ? null : Number(f.fire_limit), post_window_days: Number(f.post_window_days) || 30 })} />
        </Card>

        <Card title="Tracking identity" sub="How posts, links, ads and codes are recognised as this event">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Event code" hint={`Ads named ${f.code ? `INIT-${String(f.code).toUpperCase()}-…` : "INIT-CODE-…"} count automatically`}>
              <input className="input font-mono" value={f.code || ""} disabled={!can} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
            <Field label="Hashtags"><input className="input" value={f.hashtags} disabled={!can} onChange={(e) => setF({ ...f, hashtags: e.target.value })} placeholder="#EulivAISummit, #AIS26" /></Field>
          </div>
          <Field label="Words that mean this event" hint="Two or more in a post sends it for a quick check"><input className="input" value={f.keywords} disabled={!can} onChange={(e) => setF({ ...f, keywords: e.target.value })} /></Field>
          <Field label="Promo and creator codes"><input className="input font-mono" value={f.promo_codes} disabled={!can} onChange={(e) => setF({ ...f, promo_codes: e.target.value })} placeholder="PODCAST26, YT-ANKIT" /></Field>
          <div className="grid grid-cols-2 gap-3">
            {[["speakers", "Speakers (names or handles)"], ["sponsors", "Sponsors"], ["press", "Press outlets"], ["creators", "Creators"]].map(([k, l]) => (
              <Field key={k} label={l}><textarea className="input min-h-[74px]" value={f[k]} disabled={!can} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
            ))}
          </div>
          <SaveBtn k="identity" body={() => ({ code: f.code, hashtags: list(f.hashtags), keywords: list(f.keywords), promo_codes: list(f.promo_codes),
            handles: { speakers: list(f.speakers), sponsors: list(f.sponsors), press: list(f.press), creators: list(f.creators) } })} />
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Brand images" sub="Banner, stage backdrop, badge, logo - the picture check looks for these in posts (brand marks only, never faces)">
          <div className="flex gap-3 flex-wrap">
            {d.assets.map((a) => (
              <figure key={a.id} className="m-0 w-[140px] rounded-ctl border border-border overflow-hidden bg-surface2">
                <img src={assetUrl(a.url)} alt={a.label || a.kind} className="w-full h-[86px] object-cover" />
                <figcaption className="px-2 py-1.5 flex items-center justify-between text-[11.5px] text-muted"><span>{a.kind}</span>
                  {can && <button type="button" className="hover:text-danger" onClick={async () => { await eventApi.deleteAsset(i.id, a.id); load(); }}>Remove</button>}</figcaption>
              </figure>
            ))}
            {!d.assets.length && d.config.sample && [["2", "backdrop"], ["3", "badge"], ["1", "stage screen"]].map(([n, k]) => (
              <figure key={n} className="m-0 w-[140px] rounded-ctl border border-border overflow-hidden bg-surface2">
                <img src={`/eventos-sample/${n}.svg`} alt={k} className="w-full h-[86px] object-cover" />
                <figcaption className="px-2 py-1.5 text-[11.5px] text-muted">{k} · sample</figcaption>
              </figure>
            ))}
            {!d.assets.length && !d.config.sample && <div className="text-caption text-muted">No images yet - upload the banner and backdrop so posts without a hashtag are still found.</div>}
          </div>
          {can && (
            <div className="flex gap-2 items-center flex-wrap">
              <select className="input !w-auto" value={assetKind} onChange={(e) => setAssetKind(e.target.value)} aria-label="Image kind">
                <option value="banner">Banner</option><option value="backdrop">Stage backdrop</option><option value="badge">Badge / lanyard</option><option value="logo">Logo</option></select>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => { const x = e.target.files?.[0]; if (x) upload(x); e.target.value = ""; }} />
              <button type="button" className="btn-secondary text-sm" disabled={busy === "asset"} onClick={() => fileRef.current?.click()}>{busy === "asset" ? "Uploading…" : "Upload an image"}</button>
              <span className="text-caption text-muted">JPG, PNG or WEBP, up to 3 MB</span>
            </div>
          )}
          {d.scan && <div className="text-caption text-muted">Picture check: {d.scan.vision}. X search: {d.scan.x ? "on" : "off (set X_BEARER_TOKEN)"}. YouTube search: {d.scan.youtube ? "on" : "off (set YOUTUBE_API_KEY)"}.</div>}
        </Card>

        <Card title="Ads" sub={`Spend is read from your synced Meta Ads and Google Ads. Campaigns named ${d.config.naming_rule}… count automatically.`}>
          {d.ads.campaigns.length > 0 && <div className="text-caption text-secondary">{d.ads.campaigns.length} campaigns counted · {money(d.ads.total, d.config.currency)} spent</div>}
          {d.ads.unmatched.length > 0 && (
            <div className="flex flex-col">
              <div className="text-caption text-muted mb-1">Recent campaigns that don't follow the rule - add the ones that belong to this event:</div>
              {d.ads.unmatched.map((c: any) => (
                <div key={c.platform + c.campaign} className="flex items-center gap-2 py-1.5 border-t border-border text-ui">
                  <span className="truncate flex-1 font-mono text-[12.5px]">{c.campaign}</span><span className="text-caption text-muted">{c.platform} · {money(c.spend, d.config.currency)}</span>
                  {can && <button type="button" className="btn-secondary !py-1 !px-2 text-[11.5px]" onClick={() => save("ads", { ad_campaigns: [...d.config.ad_campaigns, c.id || c.campaign] })}>Count it</button>}
                </div>
              ))}
            </div>
          )}
          <Field label="Campaigns mapped by hand (one per line, id or exact name)"><textarea className="input min-h-[70px] font-mono text-[12.5px]" value={f.ad_campaigns} disabled={!can} onChange={(e) => setF({ ...f, ad_campaigns: e.target.value })} /></Field>
          <SaveBtn k="ads" body={() => ({ ad_campaigns: list(f.ad_campaigns) })} />
          {!d.ads.sources.length && <div className="text-caption text-muted">No ad accounts connected - connect Meta Ads or Google Ads from Data sources.</div>}
        </Card>
      </div>

      <Card title="Agenda" sub="Each session gets a door scan in the staff app, a rating after, and its own stream curve">
        <div className="flex flex-col">
          {sessions.map((s) => (
            <div key={s.id} className="grid grid-cols-[110px_minmax(0,1fr)_120px_70px_auto] gap-3 items-center py-2 border-t border-border first:border-t-0 text-ui">
              <span className="font-mono text-caption text-muted">{s.starts_at ? new Date(s.starts_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "–"}</span>
              <span className="truncate text-text">{s.title}<span className="text-muted">{s.speaker ? ` · ${s.speaker}` : ""}</span></span>
              <span className="text-caption text-muted truncate">{s.room}{s.online ? " · streamed" : ""}</span>
              <span className="text-caption tabular-nums text-muted">{s.capacity ?? "–"}</span>
              {can ? <button type="button" className="text-caption text-muted hover:text-danger" onClick={async () => { await eventApi.deleteSession(i.id, s.id); load(); }}>Remove</button> : <span />}
            </div>
          ))}
        </div>
        {can && (
          <div className="grid gap-2 grid-cols-2 md:grid-cols-[1.5fr_1fr_0.8fr_1fr_1fr_0.6fr_auto_auto] items-end">
            <Field label="Session"><input className="input" value={ns.title} onChange={(e) => setNs({ ...ns, title: e.target.value })} /></Field>
            <Field label="Speaker"><input className="input" value={ns.speaker} onChange={(e) => setNs({ ...ns, speaker: e.target.value })} /></Field>
            <Field label="Room"><input className="input" value={ns.room} onChange={(e) => setNs({ ...ns, room: e.target.value })} /></Field>
            <Field label="Starts"><input type="datetime-local" className="input" value={ns.starts_at} onChange={(e) => setNs({ ...ns, starts_at: e.target.value })} /></Field>
            <Field label="Ends"><input type="datetime-local" className="input" value={ns.ends_at} onChange={(e) => setNs({ ...ns, ends_at: e.target.value })} /></Field>
            <Field label="Seats"><input className="input" inputMode="numeric" value={ns.capacity} onChange={(e) => setNs({ ...ns, capacity: e.target.value })} /></Field>
            <label className="flex items-center gap-1.5 text-caption pb-2.5"><input type="checkbox" checked={ns.online} onChange={(e) => setNs({ ...ns, online: e.target.checked })} />Streamed</label>
            <button type="button" className="btn-secondary text-sm" disabled={!ns.title.trim()} onClick={addSession}>Add</button>
          </div>
        )}
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="The floor" sub="Rooms and areas with their capacity, and the gates (outside). Counters post their count to the hook below.">
          <div className="flex flex-col gap-2">
            {f.zones.map((z: any, k: number) => (
              <div key={k} className="grid grid-cols-[minmax(0,1fr)_100px_auto_auto] gap-2 items-center">
                <input className="input !py-1.5" value={z.name} disabled={!can} onChange={(e) => setF({ ...f, zones: f.zones.map((x: any, j: number) => (j === k ? { ...x, name: e.target.value } : x)) })} aria-label="Zone name" />
                <input className="input !py-1.5" inputMode="numeric" value={z.capacity ?? ""} placeholder="capacity" disabled={!can || z.outside} onChange={(e) => setF({ ...f, zones: f.zones.map((x: any, j: number) => (j === k ? { ...x, capacity: e.target.value } : x)) })} aria-label="Capacity" />
                <label className="flex items-center gap-1 text-caption"><input type="checkbox" checked={!!z.outside} disabled={!can} onChange={(e) => setF({ ...f, zones: f.zones.map((x: any, j: number) => (j === k ? { ...x, outside: e.target.checked } : x)) })} />gate</label>
                {can && <button type="button" className="text-caption text-muted hover:text-danger" onClick={() => setF({ ...f, zones: f.zones.filter((_: any, j: number) => j !== k) })}>×</button>}
              </div>
            ))}
            {can && <button type="button" className="text-caption text-brand-ink self-start" onClick={() => setF({ ...f, zones: [...f.zones, { name: "", capacity: "" }] })}>+ Add an area</button>}
          </div>
          <SaveBtn k="zones" body={() => ({ zones: f.zones.filter((z: any) => z.name).map((z: any) => ({ ...z, capacity: z.capacity === "" || z.capacity === null ? null : Number(z.capacity) })) })} />
          <div className="text-caption text-muted">People-counter hook (POST zone + count; no images ever):</div>
          <CopyField value={`${API_URL}/public/eventos/hook/${token}/occupancy?k=${staffKey}`} label="Occupancy hook" testId="hook-occ" />
        </Card>

        <Card title="Money" sub="Costs (marketing lines with a channel count towards cost per ICP person), ticket prices, the win rate for expected revenue">
          <div className="flex flex-col gap-2">
            {f.costs.map((c: any, k: number) => (
              <div key={k} className="grid grid-cols-[minmax(0,1fr)_120px_130px_auto] gap-2 items-center">
                <input className="input !py-1.5" value={c.label} disabled={!can} onChange={(e) => setF({ ...f, costs: f.costs.map((x: any, j: number) => (j === k ? { ...x, label: e.target.value } : x)) })} aria-label="Cost" />
                <input className="input !py-1.5" inputMode="decimal" value={c.amount} disabled={!can} onChange={(e) => setF({ ...f, costs: f.costs.map((x: any, j: number) => (j === k ? { ...x, amount: e.target.value } : x)) })} aria-label="Amount" />
                <input className="input !py-1.5" value={c.channel || ""} placeholder="channel (optional)" disabled={!can} onChange={(e) => setF({ ...f, costs: f.costs.map((x: any, j: number) => (j === k ? { ...x, channel: e.target.value } : x)) })} aria-label="Channel" />
                {can && <button type="button" className="text-caption text-muted hover:text-danger" onClick={() => setF({ ...f, costs: f.costs.filter((_: any, j: number) => j !== k) })}>×</button>}
              </div>
            ))}
            {can && <button type="button" className="text-caption text-brand-ink self-start" onClick={() => setF({ ...f, costs: [...f.costs, { label: "", amount: "", channel: "" }] })}>+ Add a cost line</button>}
          </div>
          <div className="grid grid-cols-4 gap-3">
            <Field label="Currency"><select className="input" value={f.currency} disabled={!can} onChange={(e) => setF({ ...f, currency: e.target.value })}>
              {["INR", "USD", "EUR", "GBP", "SGD", "AED", "AUD"].map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="VIP price"><input className="input" inputMode="decimal" value={f.vip} disabled={!can} onChange={(e) => setF({ ...f, vip: e.target.value })} /></Field>
            <Field label="Paid price"><input className="input" inputMode="decimal" value={f.paid} disabled={!can} onChange={(e) => setF({ ...f, paid: e.target.value })} /></Field>
            <Field label="Win rate"><input className="input" inputMode="decimal" value={f.win_rate} disabled={!can} onChange={(e) => setF({ ...f, win_rate: e.target.value })} /></Field>
          </div>
          <SaveBtn k="money" body={() => ({ costs: f.costs.filter((c: any) => c.label).map((c: any) => ({ label: c.label, amount: Number(c.amount) || 0, channel: c.channel || null })),
            currency: f.currency, prices: { vip: f.vip === "" ? null : Number(f.vip), paid: f.paid === "" ? null : Number(f.paid) }, win_rate: Number(f.win_rate) || 0.22 })} />
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Online and webinar" sub="Zoom, Teams, Webex, YouTube Live - joins, minutes, questions">
          <Field label="Join link (sent with every ticket)"><input className="input" value={f.join_url || ""} disabled={!can} onChange={(e) => setF({ ...f, join_url: e.target.value })} placeholder="https://zoom.us/j/…" /></Field>
          <Field label={`Zoom secret token${d.config.zoom_secret_set ? " (set)" : ""}`} hint="From your Zoom app's Feature → Event subscriptions; joins and leaves then arrive live">
            <input className="input font-mono" value={f.zoom_secret} disabled={!can} onChange={(e) => setF({ ...f, zoom_secret: e.target.value })} placeholder={d.config.zoom_secret_set ? "••••••••" : ""} /></Field>
          <SaveBtn k="online" body={() => ({ join_url: f.join_url || null, ...(f.zoom_secret ? { zoom_secret: f.zoom_secret } : {}) })} />
          <div className="text-caption text-muted">Zoom webhook URL (participant joined / left):</div>
          <CopyField value={`${API_URL}/public/eventos/hook/${token}/zoom`} label="Zoom webhook" testId="hook-zoom" />
          {can && (
            <div className="flex flex-col gap-2 border-t border-border pt-3">
              <div className="text-ui text-text">No app? Drop the attendee report</div>
              <div className="text-caption text-muted">The CSV from Zoom, Teams or Webex (email, join and leave time). Everyone gets their watch minutes and is marked as joined; the viewers-per-minute curve draws itself.</div>
              <div className="flex gap-2 flex-wrap items-center">
                <select className="input !w-auto text-caption" value={csvSession} onChange={(e) => setCsvSession(e.target.value)} aria-label="Session">
                  <option value="">The whole event</option>{sessions.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select>
                <input ref={csvRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const x = e.target.files?.[0]; if (x) importCsv(x); e.target.value = ""; }} />
                <button type="button" className="btn-secondary text-sm" disabled={busy === "csv"} onClick={() => csvRef.current?.click()}>{busy === "csv" ? "Reading…" : "Upload the report"}</button>
              </div>
            </div>
          )}
        </Card>

        <Card title="Links" sub="Copy, print as QR from Share, or replace if one leaks">
          {[["Registration page", d.links.registration], ["Staff phone app", d.links.staff], ["Survey", d.links.survey], ["Walk-in page (classic)", d.links.walk_in]].map(([l, u]) => (
            <div key={l} className="flex flex-col gap-1"><span className="text-caption text-muted">{l}</span><CopyField value={u} label={l} testId={l} /></div>
          ))}
          {can && <button type="button" className="btn-secondary text-sm self-start" onClick={async () => { await eventApi.newLinks(i.id, "staff"); setOk("New staff link - the old one stopped working."); load(); onChanged(); }}>Replace the staff link</button>}
        </Card>
      </div>

      {can && (
        <Card title="Delete this event" tone="warning" sub="Removes the event, its tickets, posts, sponsors, leads and numbers for everyone. People and companies stay in your accounts.">
          {!confirmDel ? <button type="button" className="btn-secondary text-sm !text-danger self-start" onClick={() => setConfirmDel(true)}>Delete event</button> : (
            <div className="flex gap-2 items-center text-caption"><span className="text-danger">Delete for everyone?</span>
              <button type="button" className="btn-secondary text-sm !text-danger" onClick={async () => { try { await initiativesApi.remove(i.id); onDeleted(); } catch (e) { setErr(errText(e)); } }}>Delete</button>
              <button type="button" className="text-muted underline" onClick={() => setConfirmDel(false)}>Keep</button></div>
          )}
        </Card>
      )}
    </div>
  );
}

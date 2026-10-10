import { useCallback, useEffect, useRef, useState } from "react";
import { Audience, CampaignRow, downloadBlob, errorText, gtmApi, Initiative } from "../api/initiatives";
import { Banner, Empty, Field, fmtDate, Section, Sheet } from "./ui";

type Props = { workspaceId: string; initiative?: Initiative; onChanged?: () => void; onError: (s: string) => void };

const TAGS = ["first_name", "company", "title", "registration_link", "booking_link", "event_name", "event_date", "location", "sender"];
const STATUS_CLS: Record<string, string> = { draft: "text-muted", scheduled: "text-primary", queued: "text-primary", sending: "text-primary", paused: "text-warning", sent: "text-good", failed: "text-danger" };

export default function CampaignsPanel({ workspaceId, initiative, onChanged, onError }: Props) {
  const [rows, setRows] = useState<CampaignRow[] | null>(null);
  const [open, setOpen] = useState<string | "new" | null>(null);
  const [emailReady, setEmailReady] = useState<boolean | null>(initiative ? initiative.email_ready : null);
  const load = useCallback(() => {
    gtmApi.campaigns(workspaceId, initiative?.id).then(setRows).catch((e) => onError(errorText(e)));
  }, [workspaceId, initiative?.id, onError]);
  useEffect(load, [load]);
  useEffect(() => { if (emailReady === null) gtmApi.profile(workspaceId).then((p) => setEmailReady(p.email.configured)).catch(() => undefined); }, [workspaceId, emailReady]);
  const canEdit = initiative ? initiative.can_edit : true;
  const busy = (rows || []).some((r) => ["queued", "sending"].includes(r.status));
  useEffect(() => { if (!busy) return; const t = window.setInterval(load, 4000); return () => window.clearInterval(t); }, [busy, load]);

  return (
    <div className="flex flex-col gap-5">
      {emailReady === false && (
        <Banner kind="warning">Email sending isn't switched on for this GD360 server yet (an admin adds RESEND_API_KEY or SMTP settings plus EMAIL_FROM). You can still write campaigns and export them - every message personalised - for HubSpot, Mailchimp, Outlook or any tool.</Banner>
      )}
      <Section title="Email campaigns" sub="Personalised per person, sent to the right ICP tier or list, with opens, clicks and unsubscribes tracked back to each account."
        actions={canEdit ? <button type="button" className="btn-primary text-sm" onClick={() => setOpen("new")} data-new-campaign="">New campaign</button> : undefined}>
        {!rows ? <div className="h-24 rounded-ctl bg-surface2 animate-pulse" /> : rows.length === 0 ? (
          <Empty title="No campaigns yet" body="Invites, reminders, thank-yous and nurture emails - each one goes to exactly the audience you pick and reports back by account." />
        ) : (
          <div className="overflow-x-auto -mx-5 px-5">
            <table className="w-full min-w-[720px] text-ui" data-campaigns="">
              <thead><tr className="text-left text-caption text-muted border-b border-border">
                <th className="py-2 font-medium">Campaign</th><th className="font-medium">Audience</th><th className="font-medium">Status</th>
                {["Sent", "Opened", "Clicked"].map((h) => <th key={h} className="font-medium text-right px-2">{h}</th>)}<th />
              </tr></thead>
              <tbody>{rows.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className="py-2.5 pr-2"><div className="text-text">{c.name}</div><div className="text-caption text-muted truncate max-w-[280px]">{c.subject}</div></td>
                  <td className="text-caption text-secondary">{c.audience_text}</td>
                  <td className={`text-caption ${STATUS_CLS[c.status] || ""}`}>{c.status === "scheduled" ? `Scheduled ${fmtDate(c.scheduled_at)}` : c.status[0].toUpperCase() + c.status.slice(1)}{c.status === "sending" && c.queued ? ` · ${c.queued} left` : ""}</td>
                  <td className="text-right px-2 tabular-nums">{c.sent}</td>
                  <td className="text-right px-2 tabular-nums">{c.opened}{c.open_rate !== null ? <span className="text-muted"> · {c.open_rate}%</span> : null}</td>
                  <td className="text-right px-2 tabular-nums">{c.clicked}{c.click_rate !== null ? <span className="text-muted"> · {c.click_rate}%</span> : null}</td>
                  <td className="text-right"><button type="button" className="text-caption text-primary hover:underline" onClick={() => setOpen(c.id)}>Open</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Section>
      {open && <Composer id={open === "new" ? null : open} workspaceId={workspaceId} initiative={initiative} emailReady={!!emailReady} canEdit={canEdit}
        onClose={() => setOpen(null)} onSaved={() => { load(); onChanged?.(); }} onError={onError} />}
    </div>
  );
}

function Composer({ id, workspaceId, initiative, emailReady, canEdit, onClose, onSaved, onError }: {
  id: string | null; workspaceId: string; initiative?: Initiative; emailReady: boolean; canEdit: boolean; onClose: () => void; onSaved: () => void; onError: (s: string) => void;
}) {
  const [cid, setCid] = useState<string | null>(id);
  const [f, setF] = useState({ name: "", subject: "", body: "" });
  const [aud, setAud] = useState<Audience>(initiative?.audience || { tiers: ["A", "B"] });
  const [mode, setMode] = useState<"accounts" | "people" | "subscribers">("accounts");
  const [count, setCount] = useState<{ people: number; accounts: number; sample: any[] } | null>(null);
  const [preview, setPreview] = useState<{ subject: string; text: string; to: string | null } | null>(null);
  const [status, setStatus] = useState("draft");
  const [stats, setStats] = useState<CampaignRow | null>(null);
  const [when, setWhen] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLTextAreaElement>(null);
  const locked = ["sending", "sent", "queued"].includes(status) || !canEdit;

  useEffect(() => {
    if (!id) {
      const reg = initiative?.links_public.registration;
      setF({
        name: initiative ? `${initiative.title} - invite` : "New campaign",
        subject: initiative ? `You're invited: ${initiative.title}` : "",
        body: initiative ? `Hi {{first_name}},\n\nWe'd love to see {{company}} at ${initiative.title}${initiative.key_date ? " on {{event_date}}" : ""}${initiative.location ? " in {{location}}" : ""}.\n\nSave your place: {{registration_link}}\n\n{{sender}}` : "Hi {{first_name}},\n\n",
      });
      void reg;
      return;
    }
    gtmApi.campaign(id).then((c) => {
      setF({ name: c.name, subject: c.subject, body: c.body });
      const a = c.audience || {};
      setAud(a);
      setMode(a.subscribers ? "subscribers" : a.people ? "people" : "accounts");
      setCount(c.count); setPreview(c.preview); setStatus(c.status); setStats(c);
    }).catch((e) => onError(errorText(e)));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const audience: Audience = mode === "subscribers" ? { subscribers: true } : mode === "people" && initiative ? { initiative_id: initiative.id, people: aud.people || "registered" } : { tiers: aud.tiers, countries: aud.countries, titles: aud.titles, segments: aud.segments, lists: aud.lists };
  useEffect(() => {
    const t = window.setTimeout(() => { gtmApi.count(workspaceId, audience).then(setCount).catch(() => undefined); }, 350);
    return () => window.clearTimeout(t);
  }, [JSON.stringify(audience), workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (): Promise<string | null> => {
    try {
      if (cid) { await gtmApi.patchCampaign(cid, { ...f, audience }); onSaved(); return cid; }
      const c = await gtmApi.createCampaign({ ...f, audience, workspace_id: workspaceId, initiative_id: initiative?.id });
      setCid(c.id); onSaved(); return c.id;
    } catch (e) { onError(errorText(e)); return null; }
  };
  const act = async (fn: (id: string) => Promise<any>, ok?: string) => {
    setBusy(true); setMsg("");
    try { const id2 = await save(); if (id2) { await fn(id2); if (ok) setMsg(ok); const c = await gtmApi.campaign(id2); setPreview(c.preview); setStatus(c.status); setStats(c); onSaved(); } }
    catch (e) { onError(errorText(e)); } finally { setBusy(false); }
  };
  const insert = (tag: string) => {
    const el = body.current;
    const t = `{{${tag}}}`;
    if (!el) { setF({ ...f, body: f.body + t }); return; }
    const s = el.selectionStart, e = el.selectionEnd;
    setF({ ...f, body: f.body.slice(0, s) + t + f.body.slice(e) });
    window.setTimeout(() => { el.focus(); el.selectionStart = el.selectionEnd = s + t.length; }, 0);
  };
  const csv = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

  return (
    <Sheet open onClose={onClose} title={cid ? f.name || "Campaign" : "New campaign"} wide
      footer={<>
        {cid && <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => act(async (x) => downloadBlob(await gtmApi.exportCampaign(x), `${f.name || "campaign"}.csv`))}>Export CSV</button>}
        {!locked && <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => act(async () => undefined, "Saved.")}>Save draft</button>}
        {!locked && emailReady && <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => act(async (x) => { const r = await gtmApi.test(x); setMsg(`Test sent to ${r.to}.`); })}>Send me a test</button>}
        {!locked && emailReady && <button type="button" className="btn-primary text-sm" disabled={busy || !count?.people || !f.subject.trim() || !f.body.trim()} data-send-campaign=""
          onClick={() => act((x) => gtmApi.send(x, { scheduled_at: when || undefined, confirm_count: count?.people }), when ? `Scheduled for ${new Date(when).toLocaleString()}.` : "Sending - results appear as people open and click.")}>
          {when ? "Schedule" : `Send to ${count?.people ?? 0}`}</button>}
      </>}>
      {msg && <Banner kind="good" onClose={() => setMsg("")}>{msg}</Banner>}
      {stats && stats.sent > 0 && (
        <div className="grid grid-cols-4 gap-3 rounded-ctl border border-border p-3 text-center">
          {[["Sent", stats.sent], ["Opened", `${stats.opened}${stats.open_rate !== null ? ` · ${stats.open_rate}%` : ""}`], ["Clicked", `${stats.clicked}${stats.click_rate !== null ? ` · ${stats.click_rate}%` : ""}`], ["Unsubscribed", stats.unsubscribed]].map(([l, v]) => (
            <div key={String(l)}><div className="text-section font-semibold tabular-nums text-text">{v}</div><div className="text-caption text-muted">{l}</div></div>
          ))}
        </div>
      )}
      {stats?.error && <Banner kind={status === "failed" ? "error" : "warning"}>{stats.error}</Banner>}
      <Field label="Internal name"><input className="input" value={f.name} disabled={locked} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>

      <div className="flex flex-col gap-2">
        <span className="text-caption font-medium text-secondary">Who gets it</span>
        <div className="inline-flex p-[3px] rounded-full border border-border bg-base self-start flex-wrap">
          {([["accounts", "People at target accounts"], ...(initiative ? [["people", "This initiative's people"]] : []), ["subscribers", "Newsletter list"]] as [typeof mode, string][]).map(([k, l]) => (
            <button key={k} type="button" disabled={locked} onClick={() => setMode(k)} aria-pressed={mode === k}
              className={`ui-focus h-8 px-3 rounded-full text-caption ${mode === k ? "bg-surface2 text-text font-medium" : "text-muted hover:text-text"}`}>{l}</button>
          ))}
        </div>
        {mode === "accounts" && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Tiers"><div className="flex gap-1.5">{["A", "B", "C"].map((t) => {
              const on = (aud.tiers || []).includes(t);
              return <button key={t} type="button" disabled={locked} aria-pressed={on} onClick={() => setAud({ ...aud, tiers: on ? (aud.tiers || []).filter((x) => x !== t) : [...(aud.tiers || []), t] })}
                className={`ui-focus h-8 px-3 rounded-full border text-caption ${on ? "border-primary bg-tint text-text" : "border-border text-secondary"}`}>{t}</button>;
            })}</div></Field>
            <Field label="Countries / regions"><input className="input !py-1.5" disabled={locked} value={(aud.countries || []).join(", ")} onChange={(e) => setAud({ ...aud, countries: csv(e.target.value) })} placeholder="All" /></Field>
            <Field label="Job titles contain"><input className="input !py-1.5" disabled={locked} value={(aud.titles || []).join(", ")} onChange={(e) => setAud({ ...aud, titles: csv(e.target.value) })} placeholder="Any" /></Field>
          </div>
        )}
        {mode === "people" && (
          <select className="input !w-auto" disabled={locked} value={aud.people || "registered"} onChange={(e) => setAud({ ...aud, people: e.target.value as Audience["people"] })}>
            <option value="registered">Everyone who registered</option><option value="attended">Attendees</option><option value="no_shows">Registered but didn't come</option><option value="walk_ins">Walk-ins</option>
          </select>
        )}
        <span className="text-caption text-secondary" data-audience-count="">
          {count ? <><b className="text-text">{count.people.toLocaleString()}</b> people at {count.accounts.toLocaleString()} accounts · unsubscribed people are always left out{count.sample.length ? ` · e.g. ${count.sample.slice(0, 2).map((s) => s.name || s.email).join(", ")}` : ""}</> : "Counting…"}
        </span>
      </div>

      <Field label="Subject"><input className="input" value={f.subject} disabled={locked} onChange={(e) => setF({ ...f, subject: e.target.value })} data-campaign-subject="" /></Field>
      <Field label="Message" hint="Plain text. Links are tracked automatically; an unsubscribe link and your postal address (Accounts → ICP & sender) are added at the bottom.">
        <textarea ref={body} className="input min-h-[200px] font-[inherit] leading-relaxed" value={f.body} disabled={locked} onChange={(e) => setF({ ...f, body: e.target.value })} />
      </Field>
      {!locked && <div className="flex gap-1.5 flex-wrap">{TAGS.map((t) => <button key={t} type="button" className="text-[11.5px] h-6 px-2 rounded-full bg-surface2 text-secondary hover:text-text font-mono" onClick={() => insert(t)}>{`{{${t}}}`}</button>)}</div>}
      {!locked && emailReady && <Field label="Send later (optional)"><input type="datetime-local" className="input !w-auto" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>}

      {preview && (
        <div className="rounded-ctl border border-border bg-base p-4 flex flex-col gap-2">
          <span className="text-caption text-muted">Preview{preview.to ? ` for ${preview.to}` : ""}</span>
          <div className="text-ui font-semibold text-text">{preview.subject}</div>
          <pre className="m-0 whitespace-pre-wrap text-ui text-secondary font-[inherit] leading-relaxed">{preview.text}</pre>
        </div>
      )}
      {!preview && cid === null && <button type="button" className="btn-secondary text-sm self-start" disabled={busy || locked} onClick={() => act(async () => undefined)}>Save and preview</button>}
    </Sheet>
  );
}

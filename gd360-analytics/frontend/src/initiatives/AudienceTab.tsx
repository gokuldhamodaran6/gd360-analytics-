import { useCallback, useEffect, useMemo, useState } from "react";
import { downloadBlob, errorText, Initiative, initiativesApi, Person } from "../api/initiatives";
import { Banner, CopyField, Field, fmtDate, Section, Sheet, Stat, Tier } from "./ui";

type Props = { i: Initiative; reload: () => void; onError: (s: string) => void };

export default function AudienceTab({ i, reload, onError }: Props) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [q, setQ] = useState("");
  const [show, setShow] = useState<"all" | "attended" | "no_show" | "walk_in" | "meeting">("all");
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [details, setDetails] = useState(false);
  const load = useCallback(() => { initiativesApi.people(i.id).then(setPeople).catch((e) => onError(errorText(e))); }, [i.id, onError]);
  useEffect(load, [load]);

  const rows = useMemo(() => (people || []).filter((p) => {
    if (q && !`${p.name} ${p.email} ${p.company}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (show === "attended") return p.attended;
    if (show === "no_show") return !!p.registered_at && !p.attended;
    if (show === "walk_in") return p.walk_in;
    if (show === "meeting") return p.wants_meeting;
    return true;
  }), [people, q, show]);
  const reg = (people || []).filter((p) => p.registered_at).length;
  const att = (people || []).filter((p) => p.attended).length;
  const walk = (people || []).filter((p) => p.walk_in).length;
  const meet = (people || []).filter((p) => p.wants_meeting).length;

  const toggleAttended = async (p: Person) => {
    if (!p.contact_id) return;
    try { await initiativesApi.setAttended(i.id, p.contact_id, !p.attended); load(); reload(); } catch (e) { onError(errorText(e)); }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex gap-5 flex-wrap items-start">
        <Section title="Registration" className="flex-[1_1_380px]" sub={i.registration_open ? "Open - anyone with the link can register." : "Closed - the page says registration is closed."}
          actions={i.can_edit ? <>
            <button type="button" className="btn-secondary text-sm" onClick={() => setDetails(true)}>Page details</button>
            <button type="button" className="btn-secondary text-sm" onClick={async () => { try { await initiativesApi.patch(i.id, { registration_open: !i.registration_open }); reload(); } catch (e) { onError(errorText(e)); } }}>
              {i.registration_open ? "Close registration" : "Open registration"}</button>
          </> : undefined}>
          <CopyField value={i.links_public.registration} testId="registration" />
          <p className="m-0 text-caption text-muted">Every sign-up lands on your account list with its company matched. Marketing opt-in is never pre-ticked and is recorded with the time. Each team member also has a personal version of this link (Team tab) that credits them.</p>
        </Section>
        {i.kind !== "webinar" && (
          <Section title="Walk-in capture" className="flex-[1_1_320px]" sub="Your booth team opens this on their phones. Registered guests are checked in; new visitors become walk-ins.">
            <CopyField value={i.links_public.walk_in} testId="walkin" />
            <p className="m-0 text-caption text-muted">Anyone asking for a meeting becomes a follow-up task automatically.</p>
          </Section>
        )}
      </div>

      <Section title="People" sub="Registrants, attendees and walk-ins, with their accounts."
        actions={<>
          {i.can_edit && <button type="button" className="btn-secondary text-sm" onClick={() => setImporting(true)} data-import-people="">Import a list</button>}
          {i.can_edit && <button type="button" className="btn-secondary text-sm" onClick={() => setAdding(true)}>Add person</button>}
          <button type="button" className="btn-secondary text-sm" onClick={async () => { try { downloadBlob(await initiativesApi.peopleCsv(i.id), `${i.title}-people.csv`); } catch (e) { onError(errorText(e)); } }}>Export CSV</button>
        </>}>
        <div className="grid gap-5 grid-cols-[repeat(auto-fill,minmax(120px,1fr))]">
          <Stat label="Registered" value={reg} />
          <Stat label="Attended" value={att} hint={reg ? `${Math.round((100 * att) / Math.max(reg, 1))}% of registrants` : undefined} />
          <Stat label="Walk-ins" value={walk} />
          <Stat label="Want a meeting" value={meet} />
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <input className="input !py-2 text-ui flex-[1_1_220px]" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email or company" aria-label="Search people" />
          <div className="inline-flex p-[3px] rounded-full border border-border bg-base flex-wrap">
            {([["all", "All"], ["attended", "Attended"], ["no_show", "No-shows"], ["walk_in", "Walk-ins"], ["meeting", "Want a meeting"]] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setShow(k)} aria-pressed={show === k}
                className={`ui-focus h-8 px-3 rounded-full text-caption ${show === k ? "bg-surface2 text-text font-medium" : "text-muted hover:text-text"}`}>{l}</button>
            ))}
          </div>
        </div>
        {!people ? <div className="h-24 rounded-ctl bg-surface2 animate-pulse" /> : rows.length === 0 ? <p className="m-0 text-ui text-muted">No one here yet.</p> : (
          <div className="overflow-x-auto -mx-5 px-5">
            <table className="w-full min-w-[760px] text-ui" data-people-table="">
              <thead><tr className="text-left text-caption text-muted border-b border-border">
                <th className="py-2 font-medium">Person</th><th className="font-medium">Company</th><th className="font-medium">Registered</th><th className="font-medium">Attended</th><th className="font-medium">Notes</th><th className="font-medium">Emails OK</th>
              </tr></thead>
              <tbody>{rows.slice(0, 500).map((p, k) => (
                <tr key={p.contact_id || p.account_id || k} className="border-b border-border last:border-0">
                  <td className="py-2 pr-2"><div className="text-text">{p.name || p.email || "—"}</div><div className="text-caption text-muted">{[p.title, p.name ? p.email : null].filter(Boolean).join(" · ")}</div></td>
                  <td><span className="inline-flex items-center gap-2"><Tier tier={p.tier} /><span className="text-secondary">{p.company || "—"}</span></span></td>
                  <td className="text-secondary">{p.registered_at ? fmtDate(p.registered_at) : p.walk_in ? "Walk-in" : "—"}</td>
                  <td>{p.contact_id && i.can_edit ? (
                    <button type="button" onClick={() => toggleAttended(p)} aria-pressed={p.attended} className={`ui-focus h-7 px-2.5 rounded-full border text-caption ${p.attended ? "border-good-border bg-good-fill text-good" : "border-border text-muted"}`}>{p.attended ? "Attended" : "Mark attended"}</button>
                  ) : p.attended ? <span className="text-good text-caption">Attended</span> : <span className="text-muted">—</span>}</td>
                  <td className="text-caption text-secondary">{[p.wants_meeting ? "Wants a meeting" : null, p.interests?.length ? p.interests.join(", ") : null, p.note].filter(Boolean).join(" · ") || "—"}</td>
                  <td className="text-caption">{p.subscribed ? <span className="text-good">Yes</span> : <span className="text-muted">No</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Section>
      {importing && <ImportPeople i={i} onClose={() => setImporting(false)} onDone={() => { load(); reload(); }} />}
      {adding && <AddPerson i={i} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); reload(); }} onError={onError} />}
      {details && <PageDetails i={i} onClose={() => setDetails(false)} onDone={() => { setDetails(false); reload(); }} onError={onError} />}
    </div>
  );
}

function ImportPeople({ i, onClose, onDone }: { i: Initiative; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [signal, setSignal] = useState(i.kind === "webinar" ? "webinar_attended" : "attended");
  const [source, setSource] = useState("luma");
  const [preview, setPreview] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async (commit: boolean, f = file) => {
    if (!f) return;
    setBusy(true); setErr("");
    try {
      const r = await initiativesApi.importPeople(i.id, f, signal, source, commit);
      if (commit) { setResult(r); onDone(); } else setPreview(r);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title="Import a list" wide footer={<>{preview && !result && <button type="button" className="btn-primary text-sm" disabled={busy} onClick={() => go(true)}>Import {preview.rows} rows</button>}{result && <button type="button" className="btn-primary text-sm" onClick={onClose}>Done</button>}</>}>
      <p className="m-0 text-ui text-secondary">Guest lists from Luma or Eventbrite, attendance reports from Zoom or Teams, a LinkedIn event export, or any spreadsheet. People are matched by email; companies by email domain or name.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What is this list?"><select className="input" value={signal} onChange={(e) => setSignal(e.target.value)}>
          <option value="registered">Registrations</option><option value={i.kind === "webinar" ? "webinar_attended" : "attended"}>Attendees (no-shows detected from a check-in column)</option>
          <option value="walk_in">Walk-ins</option><option value="newsletter_signup">Newsletter sign-ups</option><option value="social">Social engagement</option></select></Field>
        <Field label="From"><select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
          {["luma", "eventbrite", "zoom", "teams", "linkedin", "hubspot", "salesforce", "spreadsheet"].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</select></Field>
      </div>
      <input type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0] || null; setFile(f); setPreview(null); setResult(null); if (f) go(false, f); }} aria-label="CSV file" />
      {err && <Banner kind="error">{err}</Banner>}
      {preview && !result && <div className="text-ui text-text">{preview.rows} rows · matched: {Object.entries(preview.mapping).map(([k, v]) => `${k} ← ${v}`).join(", ")}</div>}
      {result && <Banner kind="good">Imported {result.signals || 0} people{result.no_shows ? ` (${result.no_shows} no-shows recorded as registered)` : ""}{result.accounts_created ? `, ${result.accounts_created} new accounts` : ""}.</Banner>}
    </Sheet>
  );
}

function AddPerson({ i, onClose, onDone, onError }: { i: Initiative; onClose: () => void; onDone: () => void; onError: (s: string) => void }) {
  const [f, setF] = useState({ name: "", email: "", company: "", title: "", kind: "registered" });
  return (
    <Sheet open onClose={onClose} title="Add a person" footer={<button type="button" className="btn-primary text-sm" disabled={!f.name.trim() && !f.email.trim()} onClick={async () => {
      try { await initiativesApi.addPerson(i.id, f); onDone(); } catch (e) { onError(errorText(e)); }
    }}>Add</button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email"><input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Company"><input className="input" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} /></Field>
        <Field label="Title"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      </div>
      <Field label="As"><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="registered">Registered</option><option value="attended">Attended</option><option value="walk_in">Walk-in</option></select></Field>
    </Sheet>
  );
}

function PageDetails({ i, onClose, onDone, onError }: { i: Initiative; onClose: () => void; onDone: () => void; onError: (s: string) => void }) {
  const d = i.details || {};
  const [f, setF] = useState({ public_description: d.public_description || i.summary || "", time: d.time || "", join_url: d.join_url || "",
    interests: Array.isArray(d.interests) ? d.interests.join(", ") : d.interests || "", location: i.location || "", key_date: i.key_date || "" });
  return (
    <Sheet open onClose={onClose} title="Registration page" wide footer={<button type="button" className="btn-primary text-sm" onClick={async () => {
      try {
        await initiativesApi.patch(i.id, { location: f.location, key_date: f.key_date || null, details: { public_description: f.public_description, time: f.time, join_url: f.join_url, interests: f.interests } });
        onDone();
      } catch (e) { onError(errorText(e)); }
    }}>Save</button>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Date"><input type="date" className="input" value={f.key_date} onChange={(e) => setF({ ...f, key_date: e.target.value })} /></Field>
        <Field label="Time"><input className="input" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} placeholder="2:00 – 6:00 PM CT" /></Field>
        <Field label="Where"><input className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
      </div>
      <Field label="What guests read"><textarea className="input min-h-[120px]" value={f.public_description} onChange={(e) => setF({ ...f, public_description: e.target.value })} /></Field>
      {i.kind === "webinar" && <Field label="Join link" hint="Shown after registering and in the confirmation email."><input className="input" value={f.join_url} onChange={(e) => setF({ ...f, join_url: e.target.value })} /></Field>}
      {i.kind !== "webinar" && <Field label="Walk-in interests" hint="Comma-separated; the booth team taps them on the phone page."><input className="input" value={f.interests} onChange={(e) => setF({ ...f, interests: e.target.value })} placeholder="Wholesale, Lighting, Outdoor" /></Field>}
    </Sheet>
  );
}

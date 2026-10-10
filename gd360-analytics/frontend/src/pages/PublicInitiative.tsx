// 2026-10-10: the public, no-login pages of Initiatives:
//   /e/:token        event / webinar registration (with ?ref= for a rep's link)
//   /w/:token?k=     walk-in capture for the booth team's phones
//   /a/:token        approve a deliverable or request changes
//   /r/:token        a team member's "My invites" page - log outreach in two taps
import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { errorText, publicGtm } from "../api/initiatives";

function Frame({ children, narrow = true }: { children: ReactNode; narrow?: boolean }) {
  return (
    <div className="min-h-screen bg-base text-text px-4 py-8 sm:py-14 flex justify-center">
      <div className={`w-full ${narrow ? "max-w-[480px]" : "max-w-[760px]"} flex flex-col gap-5`}>{children}
        <div className="text-center text-caption text-muted pt-4">Powered by GD360</div>
      </div>
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-card border border-border bg-surface p-5 sm:p-7 flex flex-col gap-4 shadow-card">{children}</div>;
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const { label, ...rest } = props;
  return <label className="flex flex-col gap-1.5"><span className="text-caption font-medium text-secondary">{label}</span><input {...rest} className="input !h-12 text-[15px]" /></label>;
}

function longDate(iso?: string | null) {
  if (!iso) return "";
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function Missing({ text }: { text: string }) {
  return <Frame><Card><div className="text-section font-semibold">This page isn't available</div><p className="m-0 text-ui text-secondary">{text}</p></Card></Frame>;
}

// ------------------------------------------------------------ registration --
export function EventRegister() {
  const { token = "" } = useParams();
  const [params] = useSearchParams();
  const [ev, setEv] = useState<any>(null);
  const [missing, setMissing] = useState("");
  const [f, setF] = useState({ name: "", email: "", company: "", title: "", consent: false, hp: "" });
  const [done, setDone] = useState<any>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { publicGtm.event(token).then(setEv).catch((e) => setMissing(errorText(e, "The link may be wrong or the event has ended."))); }, [token]);
  if (missing) return <Missing text={missing} />;
  if (!ev) return <Frame><div className="h-80 rounded-card bg-surface2 animate-pulse" /></Frame>;
  const submit = async () => {
    setBusy(true); setErr("");
    let vid: string | undefined;
    try { vid = localStorage.getItem("gd360_vid") || undefined; } catch { /* none */ }
    try { setDone(await publicGtm.register(token, { ...f, ref: params.get("ref") || undefined, visitor_id: vid })); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Frame>
      <div className="flex flex-col gap-2">
        {ev.company && <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{ev.company}</span>}
        <span className="text-caption font-medium text-primary">{ev.kind_label}</span>
        <h1 className="m-0 text-[28px] sm:text-[32px] font-semibold tracking-tight leading-tight text-balance">{ev.title}</h1>
        <div className="text-ui text-secondary">{[longDate(ev.key_date), ev.time, ev.online ? "Online" : ev.location].filter(Boolean).join(" · ")}</div>
      </div>
      {ev.description && <p className="m-0 text-body text-secondary leading-relaxed whitespace-pre-wrap">{ev.description}</p>}
      <Card>
        {done ? (
          <div className="flex flex-col gap-2" data-registered="">
            <div className="text-section font-semibold">{done.already ? "You're already registered" : "You're registered"}</div>
            <p className="m-0 text-ui text-secondary">{done.join_url ? <>Join here when it starts: <a className="text-primary underline break-all" href={done.join_url}>{done.join_url}</a></> : "We'll see you there. A confirmation is on its way if email is set up for this event."}</p>
          </div>
        ) : !ev.open ? (
          <div className="text-ui text-secondary">Registration is closed.</div>
        ) : (
          <form className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <Input label="Full name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" />
            <Input label="Work email" required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" />
            <div className="grid gap-3.5 sm:grid-cols-2">
              <Input label="Company" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} autoComplete="organization" />
              <Input label="Job title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoComplete="organization-title" />
            </div>
            <input tabIndex={-1} autoComplete="off" aria-hidden className="hidden" value={f.hp} onChange={(e) => setF({ ...f, hp: e.target.value })} />
            <label className="flex items-start gap-2.5 text-ui text-secondary"><input type="checkbox" className="mt-1 w-4 h-4" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} />
              <span>Send me occasional updates and invitations by email. You can unsubscribe at any time.</span></label>
            {err && <div className="text-caption text-danger" role="alert">{err}</div>}
            <button type="submit" className="btn-primary !h-12 text-[15px]" disabled={busy || !f.name.trim() || !f.email.trim()} data-register="">{busy ? "Registering…" : "Register"}</button>
            <p className="m-0 text-caption text-muted">{ev.privacy_note}</p>
          </form>
        )}
      </Card>
    </Frame>
  );
}

// ---------------------------------------------------------------- walk-in --
export function WalkInCapture() {
  const { token = "" } = useParams();
  const [params] = useSearchParams();
  const k = params.get("k") || "";
  const [info, setInfo] = useState<any>(null);
  const [missing, setMissing] = useState("");
  const blank = { name: "", email: "", company: "", title: "", phone: "", interests: [] as string[], wants_meeting: false, consent: false, note: "" };
  const [f, setF] = useState(blank);
  const [by, setBy] = useState(() => { try { return localStorage.getItem("gd360_booth_name") || ""; } catch { return ""; } });
  const [last, setLast] = useState<any>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { publicGtm.walkin(token, k).then(setInfo).catch((e) => setMissing(errorText(e))); }, [token, k]);
  if (missing) return <Missing text={missing} />;
  if (!info) return <Frame><div className="h-96 rounded-card bg-surface2 animate-pulse" /></Frame>;
  const save = async () => {
    setBusy(true); setErr("");
    try {
      try { localStorage.setItem("gd360_booth_name", by); } catch { /* none */ }
      const r = await publicGtm.captureWalkin(token, { ...f, k, captured_by: by || undefined });
      setLast({ ...r, who: f.name || f.email || f.company });
      setInfo({ ...info, captured: r.captured });
      setF(blank);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Frame>
      <div className="flex items-center justify-between gap-3">
        <span className="text-ui text-secondary truncate">{info.title}</span>
        <span className="text-ui text-good font-medium tabular-nums" data-captured="">{info.captured} captured</span>
      </div>
      {last && <div className="rounded-card border border-good-border bg-good-fill px-4 py-3 text-ui text-good" role="status">{last.checked_in ? `Checked in: ${last.who} (registered)` : `Saved: ${last.who}`}{" "}· next visitor</div>}
      <Card>
        <h1 className="m-0 text-[24px] font-semibold tracking-tight">New visitor</h1>
        <form className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <Input label="Company" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} />
          <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Input label="Email" type="email" inputMode="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <div className="grid gap-3.5 grid-cols-2">
            <Input label="Role" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
            <Input label="Phone" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </div>
          {info.interests?.length > 0 && (
            <div className="flex flex-col gap-2"><span className="text-caption font-medium text-secondary">Interested in</span>
              <div className="flex gap-2 flex-wrap">{info.interests.map((x: string) => {
                const on = f.interests.includes(x);
                return <button key={x} type="button" aria-pressed={on} onClick={() => setF({ ...f, interests: on ? f.interests.filter((y) => y !== x) : [...f.interests, x] })}
                  className={`h-10 px-4 rounded-full border text-ui ${on ? "border-primary bg-tint text-text" : "border-border text-secondary"}`}>{x}</button>;
              })}</div></div>
          )}
          <label className="flex items-center gap-3 text-[15px]"><input type="checkbox" className="w-5 h-5" checked={f.wants_meeting} onChange={(e) => setF({ ...f, wants_meeting: e.target.checked })} /> Wants a meeting</label>
          <label className="flex items-center gap-3 text-ui text-secondary"><input type="checkbox" className="w-5 h-5" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} /> Agreed to receive follow-up emails</label>
          <label className="flex flex-col gap-1.5"><span className="text-caption font-medium text-secondary">Note</span><textarea className="input min-h-[70px]" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
          <Input label="Captured by" value={by} onChange={(e) => setBy(e.target.value)} placeholder="Your name" />
          {err && <div className="text-caption text-danger" role="alert">{err}</div>}
          <button type="submit" className="btn-primary !h-14 text-[16px]" disabled={busy || !(f.name || f.email || f.company)} data-save-visitor="">{busy ? "Saving…" : "Save visitor"}</button>
        </form>
      </Card>
    </Frame>
  );
}

// --------------------------------------------------------------- approval --
export function ApprovePage() {
  const { token = "" } = useParams();
  const [a, setA] = useState<any>(null);
  const [missing, setMissing] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => publicGtm.approval(token).then((x) => { setA(x); if (!name) setName(x.approver || ""); }).catch((e) => setMissing(errorText(e))), [token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  if (missing) return <Missing text={missing} />;
  if (!a) return <Frame><div className="h-80 rounded-card bg-surface2 animate-pulse" /></Frame>;
  const decide = async (decision: "approve" | "changes") => {
    setBusy(true); setErr("");
    try { await publicGtm.decide(token, { decision, name, note }); await load(); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Frame>
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{a.initiative}</span>
        <h1 className="m-0 text-[26px] font-semibold tracking-tight leading-tight">{a.task}</h1>
        <span className="text-ui text-secondary">{a.requested_by} asked {a.approver || "you"} to review{a.version ? ` version ${a.version}` : ""}.</span>
      </div>
      {a.note && <div className="rounded-card border border-border bg-surface px-4 py-3 text-ui">“{a.note}”</div>}
      <Card>
        <span className="text-ui font-semibold">What to review</span>
        {a.evidence.length === 0 ? <p className="m-0 text-ui text-muted">No files were attached.</p> : (
          <ul className="m-0 p-0 list-none flex flex-col gap-2">
            {a.evidence.map((e: any, k: number) => (
              <li key={k} className="rounded-ctl border border-border px-3 py-2.5 flex items-center justify-between gap-3">
                <span className="min-w-0"><span className="block text-ui truncate">{e.label}</span><span className="text-caption text-muted">{e.kind}{e.version ? ` · v${e.version}` : ""}</span></span>
                {e.url && <a href={e.url} target="_blank" rel="noreferrer" className="btn-secondary text-sm !py-1.5 shrink-0">Open ↗</a>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        {a.state === "submitted" ? (
          <div className="flex flex-col gap-3.5" data-approve-form="">
            <Input label="Your name" value={name} onChange={(e) => setName(e.target.value)} />
            <label className="flex flex-col gap-1.5"><span className="text-caption font-medium text-secondary">Comments (required if changes are needed)</span><textarea className="input min-h-[90px]" value={note} onChange={(e) => setNote(e.target.value)} /></label>
            {err && <div className="text-caption text-danger" role="alert">{err}</div>}
            <div className="grid grid-cols-2 gap-3">
              <button type="button" className="btn-secondary !h-12" disabled={busy || !name.trim()} onClick={() => decide("changes")}>Request changes</button>
              <button type="button" className="btn-primary !h-12" disabled={busy || !name.trim()} onClick={() => decide("approve")} data-approve="">Approve</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1" data-decided={a.state}>
            <div className={`text-section font-semibold ${a.state === "approved" ? "text-good" : "text-danger"}`}>{a.state === "approved" ? "Approved" : "Changes requested"}</div>
            <span className="text-ui text-secondary">by {a.decided_by}{a.decided_at ? ` on ${new Date(a.decided_at).toLocaleDateString()}` : ""}{a.decision_note ? ` - “${a.decision_note}”` : ""}</span>
          </div>
        )}
      </Card>
    </Frame>
  );
}

// ------------------------------------------------------------- my invites --
const QUICK = [
  { status: "invited", label: "Invited" }, { status: "replied", label: "Replied" }, { status: "interested", label: "Interested" },
  { status: "registered", label: "Registered" }, { status: "meeting", label: "Meeting booked" }, { status: "declined", label: "Declined" }, { status: "not_now", label: "Not now" },
];

export function RepPage() {
  const { token = "" } = useParams();
  const [d, setD] = useState<any>(null);
  const [missing, setMissing] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ status: "", channel: "", note: "", next_step_on: "" });
  const [filter, setFilter] = useState<"todo" | "all" | "replied">("todo");
  const [adding, setAdding] = useState(false);
  const [np, setNp] = useState({ name: "", email: "", company: "", title: "", segment: "target", channel: "linkedin" });
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => publicGtm.rep(token).then(setD).catch((e) => setMissing(errorText(e))), [token]);
  useEffect(() => { load(); }, [load]);
  const rows = useMemo(() => (d?.rows || []).filter((r: any) => filter === "all" ? true : filter === "replied" ? ["replied", "interested"].includes(r.status) : ["not_contacted", "invited"].includes(r.status) || r.overdue), [d, filter]);
  if (missing) return <Missing text={missing} />;
  if (!d) return <Frame narrow={false}><div className="h-96 rounded-card bg-surface2 animate-pulse" /></Frame>;
  const st = d.stats || {};
  const tg = d.member.targets || {};
  const save = async (id: string) => {
    setBusy(true);
    try {
      await publicGtm.repLog(token, { outreach_id: id, status: form.status || undefined, channel: form.channel || undefined, note: form.note || undefined, next_step_on: form.next_step_on || undefined });
      setOpen(null); setForm({ status: "", channel: "", note: "", next_step_on: "" }); setFlash("Saved."); await load();
    } catch (e) { setFlash(errorText(e)); } finally { setBusy(false); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(d.invite_link); setFlash("Invite link copied."); } catch { setFlash(d.invite_link); } };
  return (
    <Frame narrow={false}>
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">My invites · {d.initiative.title}</span>
        <h1 className="m-0 text-[26px] font-semibold tracking-tight">Hi {d.member.name.split(" ")[0]}</h1>
        <span className="text-ui text-secondary">{[d.member.role, d.member.team, d.initiative.key_date ? longDate(d.initiative.key_date) : null].filter(Boolean).join(" · ")}</span>
      </div>
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        {[["Invited", st.invited, tg.invites], ["Replied", st.replied, null], ["Registered", st.registered, tg.registrations], ["Meetings", st.meetings, tg.meetings]].map(([l, v, t]) => (
          <div key={String(l)} className="rounded-card border border-border bg-surface px-4 py-3">
            <div className="text-[24px] font-semibold tabular-nums leading-tight">{v || 0}{t ? <span className="text-ui text-muted font-normal"> / {t}</span> : null}</div>
            <div className="text-caption text-muted">{l}</div>
          </div>
        ))}
      </div>
      <div className="rounded-card border border-tint-border bg-tint px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-ui text-text">Your personal invite link - registrations through it count for you automatically.</span>
        <button type="button" className="btn-primary text-sm" onClick={copy} data-copy-invite="">Copy link</button>
      </div>
      {flash && <div className="text-caption text-good" role="status">{flash}</div>}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex p-[3px] rounded-full border border-border bg-surface">
          {([["todo", "To do"], ["replied", "Replied"], ["all", "All"]] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}
            className={`h-9 px-4 rounded-full text-caption ${filter === k ? "bg-surface2 text-text font-medium" : "text-muted"}`}>{l}</button>)}
        </div>
        <button type="button" className="btn-secondary text-sm" onClick={() => setAdding(!adding)}>Add someone I invited</button>
      </div>
      {adding && (
        <Card>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Name" value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} />
            <Input label="Email" value={np.email} onChange={(e) => setNp({ ...np, email: e.target.value })} />
            <Input label="Company" value={np.company} onChange={(e) => setNp({ ...np, company: e.target.value })} />
            <Input label="Title" value={np.title} onChange={(e) => setNp({ ...np, title: e.target.value })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5"><span className="text-caption font-medium text-secondary">They are</span><select className="input !h-12" value={np.segment} onChange={(e) => setNp({ ...np, segment: e.target.value })}><option value="target">A target account</option><option value="customer">An existing customer</option></select></label>
            <label className="flex flex-col gap-1.5"><span className="text-caption font-medium text-secondary">I invited them by</span><select className="input !h-12" value={np.channel} onChange={(e) => setNp({ ...np, channel: e.target.value })}>{d.channels.map((c: any) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
          </div>
          <button type="button" className="btn-primary !h-12" disabled={busy || !(np.name || np.email || np.company)} onClick={async () => {
            setBusy(true);
            try { await publicGtm.repLog(token, { ...np, status: "invited" }); setNp({ name: "", email: "", company: "", title: "", segment: "target", channel: np.channel }); setAdding(false); setFlash("Added."); await load(); } catch (e) { setFlash(errorText(e)); } finally { setBusy(false); }
          }}>Add as invited</button>
        </Card>
      )}
      <div className="flex flex-col gap-2.5" data-rep-rows="">
        {rows.length === 0 && <div className="text-ui text-muted text-center py-6">Nothing here.</div>}
        {rows.map((r: any) => (
          <div key={r.id} className={`rounded-card border bg-surface ${r.overdue ? "border-danger-border" : "border-border"}`}>
            <button type="button" className="w-full text-left px-4 py-3.5 flex items-center gap-3" onClick={() => { setOpen(open === r.id ? null : r.id); setForm({ status: "", channel: r.channel || "", note: "", next_step_on: "" }); }}>
              <span className={`w-7 h-7 rounded-[8px] grid place-items-center text-caption font-semibold shrink-0 ${r.tier === "A" ? "bg-good-fill text-good" : "bg-surface2 text-secondary"}`}>{r.tier || "·"}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-ui font-medium truncate">{r.person || r.account}</span>
                <span className="block text-caption text-muted truncate">{[r.person ? r.account : null, r.title, r.segment === "customer" ? "Customer" : null].filter(Boolean).join(" · ")}</span>
              </span>
              <span className="text-caption shrink-0 text-right"><span className="block text-text">{r.status_label}</span>{r.overdue ? <span className="text-danger">Follow-up due</span> : r.next_step_on ? <span className="text-muted">Next {new Date(`${r.next_step_on}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span> : null}</span>
            </button>
            {open === r.id && (
              <div className="px-4 pb-4 flex flex-col gap-3 border-t border-border pt-3">
                <div className="flex gap-2 flex-wrap">{QUICK.map((q) => <button key={q.status} type="button" aria-pressed={form.status === q.status} onClick={() => setForm({ ...form, status: q.status })}
                  className={`h-10 px-3.5 rounded-full border text-ui ${form.status === q.status ? "border-primary bg-tint text-text" : "border-border text-secondary"}`}>{q.label}</button>)}</div>
                <select className="input !h-11" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} aria-label="How">
                  <option value="">How? (LinkedIn, Sales Navigator, email…)</option>{d.channels.map((c: any) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
                <input className="input !h-11" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Note (optional)" />
                <label className="flex items-center gap-2 text-caption text-secondary">Follow up on <input type="date" className="input !h-10 !w-auto" value={form.next_step_on} onChange={(e) => setForm({ ...form, next_step_on: e.target.value })} /></label>
                <div className="flex gap-2 items-center flex-wrap">
                  <button type="button" className="btn-primary !h-11" disabled={busy || (!form.status && !form.channel && !form.note && !form.next_step_on)} onClick={() => save(r.id)} data-rep-save="">Save</button>
                  {r.linkedin_url && <a href={r.linkedin_url} target="_blank" rel="noreferrer" className="text-caption text-primary">LinkedIn profile ↗</a>}
                  {r.email && <span className="text-caption text-muted select-all">{r.email}</span>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </Frame>
  );
}

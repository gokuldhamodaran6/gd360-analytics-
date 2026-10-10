// One account: fit, heat, the people (and who to look for), every signal,
// the initiatives it's part of, and quick actions - log activity, remind me,
// find people with Apollo.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AccountDetail, errorText, gtmApi, initiativesApi, InitiativeSummary } from "../api/initiatives";
import { Field, fmt, fmtDate, Heat, Sheet, Tier } from "./ui";

const ACTIVITY = [["meeting", "Meeting"], ["call", "Call"], ["email_reply", "Email reply"], ["social", "Social engagement"], ["event", "Met at an event"], ["opportunity", "Opportunity opened"], ["note", "Note"]];

export default function AccountDrawer({ id, ws, onClose, onError }: { id: string; ws: string; onClose: () => void; onError: (s: string) => void }) {
  const [a, setA] = useState<AccountDetail | null>(null);
  const [inits, setInits] = useState<InitiativeSummary[]>([]);
  const [act, setAct] = useState({ kind: "meeting", text: "", initiative_id: "" });
  const [rem, setRem] = useState({ note: "", remind_at: "" });
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ segment: "", list_name: "", owner_name: "", notes: "", industry: "", country: "" });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    gtmApi.account(id).then((x) => { setA(x); setF({ segment: x.segment || "", list_name: x.list_name || "", owner_name: x.owner_name || "", notes: x.notes || "", industry: x.industry || "", country: x.country || "" }); }).catch((e) => { onError(errorText(e)); onClose(); });
  }, [id, onError, onClose]);
  useEffect(load, [load]);
  useEffect(() => { if (ws) initiativesApi.hub(ws).then((h) => setInits(h.initiatives.filter((x) => x.status !== "done"))).catch(() => undefined); }, [ws]);

  const run = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true); setMsg("");
    try { await fn(); setMsg(ok); load(); } catch (e) { onError(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <Sheet open onClose={onClose} title={a ? a.name : "Account"} wide>
      {!a ? <div className="h-48 rounded-ctl bg-surface2 animate-pulse" /> : (
        <div className="flex flex-col gap-5" data-account-drawer="">
          {msg && <div className="text-caption text-good">{msg}</div>}
          <div className="flex items-start gap-4 flex-wrap">
            <div className="flex flex-col gap-1 min-w-0 flex-1">
              <div className="text-caption text-muted">{[a.domain, a.industry, a.employees ? `${fmt(a.employees)} people` : null, [a.city, a.country].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}</div>
              <div className="flex gap-3 flex-wrap text-caption">
                {a.domain && <a href={`https://${a.domain}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">Website ↗</a>}
                {a.linkedin_url && <a href={a.linkedin_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">LinkedIn ↗</a>}
                <span className="text-muted">Source: {a.source || "—"}{a.list_name ? ` · ${a.list_name}` : ""}{a.owner_name ? ` · Owner ${a.owner_name}` : ""}</span>
              </div>
            </div>
            <div className="flex gap-5">
              <div className="flex flex-col items-center gap-1"><Tier tier={a.icp_tier} /><span className="text-caption text-muted">ICP {a.icp_score ?? "—"}</span></div>
              <div className="flex flex-col items-center gap-1"><Heat heat={a.heat} score={a.engagement_score} /><span className="text-caption text-muted">{fmt(a.engagement_score)} pts</span></div>
            </div>
          </div>
          {a.icp_reasons.length > 0 && <div className="flex gap-1.5 flex-wrap">{a.icp_reasons.map((r) => <span key={r} className="text-caption px-2 h-6 inline-flex items-center rounded-full bg-good-fill text-good">{r}</span>)}</div>}

          <div className="grid gap-2 grid-cols-3 sm:grid-cols-6 text-center">
            {[["visit", "Visits"], ["email_open", "Opens"], ["email_click", "Clicks"], ["registered", "Registered"], ["attended", "Attended"], ["meeting", "Meetings"]].map(([k, l]) => (
              <div key={k} className="rounded-ctl border border-border py-2"><div className="text-section font-semibold tabular-nums text-text">{a.counts[k] || 0}</div><div className="text-[11px] text-muted">{l}</div></div>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-ui font-semibold text-text">People</span>
              <button type="button" className="text-caption text-primary hover:underline disabled:opacity-50" disabled={busy}
                onClick={() => a.apollo ? run(async () => { const r = await gtmApi.findPeople(a.id); setMsg(`Apollo found ${r.found}; ${r.added} added.`); }, "") : setMsg("Connect Apollo under Accounts → Sources to find people automatically - or use the LinkedIn searches below.")}>
                Find people with Apollo</button>
            </div>
            {a.people.length === 0 ? <p className="m-0 text-caption text-muted">No one known here yet.</p> : (
              <ul className="m-0 p-0 list-none flex flex-col divide-y divide-border rounded-ctl border border-border" data-account-people="">
                {a.people.map((p) => (
                  <li key={p.id} className="px-3 py-2 flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-ui text-text truncate">{p.name || p.email}{p.persona_match && <span className="ml-2 text-[11px] text-good">Buyer persona</span>}</div>
                      <div className="text-caption text-muted truncate">{[p.title, p.email].filter(Boolean).join(" · ")}</div>
                    </div>
                    {p.signals > 0 && <span className="text-caption text-secondary tabular-nums">{p.signals} signals</span>}
                    {p.linkedin_url && <a href={p.linkedin_url} target="_blank" rel="noreferrer" className="text-caption text-primary">in ↗</a>}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-col gap-1">
              <span className="text-caption text-secondary">Who to look for</span>
              <div className="flex gap-1.5 flex-wrap">{a.personas.map((p) => (
                <a key={p.title} href={p.search} target="_blank" rel="noreferrer" className={`text-caption h-7 px-2.5 inline-flex items-center rounded-full border ${p.covered ? "border-good-border text-good" : "border-border text-secondary hover:text-text"}`}>
                  {p.covered ? "✓ " : ""}{p.title} ↗</a>
              ))}</div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <form className="rounded-ctl border border-border p-3 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); run(async () => { await gtmApi.activity(a.id, { ...act, initiative_id: act.initiative_id || null }); setAct({ ...act, text: "" }); }, "Logged."); }}>
              <span className="text-ui font-semibold text-text">Log activity</span>
              <select className="input !py-1.5 text-caption" value={act.kind} onChange={(e) => setAct({ ...act, kind: e.target.value })} aria-label="Activity">{ACTIVITY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <select className="input !py-1.5 text-caption" value={act.initiative_id} onChange={(e) => setAct({ ...act, initiative_id: e.target.value })} aria-label="Initiative"><option value="">No initiative</option>{inits.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select>
              <input className="input !py-1.5 text-caption" value={act.text} onChange={(e) => setAct({ ...act, text: e.target.value })} placeholder="What happened" aria-label="Details" />
              <button type="submit" className="btn-secondary text-sm !py-1.5 self-start" disabled={busy}>Log</button>
            </form>
            <form className="rounded-ctl border border-border p-3 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); run(async () => { await initiativesApi.addReminder({ ...rem, account_id: a.id }); setRem({ note: "", remind_at: "" }); }, "Reminder set."); }}>
              <span className="text-ui font-semibold text-text">Remind me</span>
              <input className="input !py-1.5 text-caption" value={rem.note} onChange={(e) => setRem({ ...rem, note: e.target.value })} placeholder="Follow up after the showcase" aria-label="Reminder" />
              <input type="datetime-local" className="input !py-1.5 text-caption" value={rem.remind_at} onChange={(e) => setRem({ ...rem, remind_at: e.target.value })} aria-label="When" />
              <button type="submit" className="btn-secondary text-sm !py-1.5 self-start" disabled={busy || !rem.note.trim() || !rem.remind_at}>Set reminder</button>
              {a.reminders.map((r) => <span key={r.id} className="text-caption text-secondary">· {r.note} - {fmtDate(r.remind_at)}</span>)}
            </form>
          </div>

          {(a.initiatives.length > 0 || a.boards.length > 0) && (
            <div className="flex flex-col gap-1.5">
              <span className="text-ui font-semibold text-text">In initiatives</span>
              <div className="flex gap-2 flex-wrap">
                {a.initiatives.map((x) => <Link key={x.id} to={`/initiatives/${x.id}`} className="text-caption h-7 px-2.5 inline-flex items-center rounded-full border border-border hover:border-border-strong">{x.title}</Link>)}
                {a.boards.map((b) => <Link key={b.item_id} to={`/initiatives/${b.initiative_id}?tab=board`} className="text-caption h-7 px-2.5 inline-flex items-center rounded-full bg-surface2 text-secondary">{b.initiative}: {b.stage}</Link>)}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <span className="text-ui font-semibold text-text">Timeline</span>
            {a.timeline.length === 0 ? <p className="m-0 text-caption text-muted">No signals yet.</p> : (
              <ol className="m-0 p-0 list-none flex flex-col gap-2 border-l border-border ml-1" data-timeline="">
                {a.timeline.slice(0, 60).map((t) => (
                  <li key={t.id} className="relative pl-4">
                    <span className="absolute -left-[4px] top-[7px] w-2 h-2 rounded-full bg-primary" />
                    <div className="text-ui text-text">{t.label}{t.contact ? <span className="text-secondary"> · {t.contact}</span> : null}</div>
                    <div className="text-caption text-muted">{fmtDate(t.occurred_at)}{t.initiative ? ` · ${t.initiative}` : ""}{t.channel ? ` · ${t.channel}` : ""}{t.detail?.page ? ` · ${t.detail.page}` : ""}{t.detail?.text ? ` · ${t.detail.text}` : ""}</div>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="border-t border-border pt-4 flex flex-col gap-3">
            {!edit ? <button type="button" className="text-caption text-primary hover:underline self-start" onClick={() => setEdit(true)}>Edit account details</button> : (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  {([["industry", "Industry"], ["country", "Country"], ["segment", "Segment"], ["list_name", "List"], ["owner_name", "Owner"]] as const).map(([k, l]) => (
                    <Field key={k} label={l}><input className="input !py-1.5" value={(f as any)[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
                  ))}
                </div>
                <Field label="Notes"><textarea className="input min-h-[70px]" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
                <button type="button" className="btn-primary text-sm self-start" disabled={busy} onClick={() => run(async () => { await gtmApi.patchAccount(a.id, f); setEdit(false); }, "Saved and re-scored.")}>Save</button>
              </>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}

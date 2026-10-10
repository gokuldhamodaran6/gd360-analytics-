import { useCallback, useEffect, useMemo, useState } from "react";
import { errorText, Initiative, initiativesApi, Member, Outreach, TeamData } from "../api/initiatives";
import { Banner, CopyField, Empty, Field, fmt, fmtDate, Section, Sheet, Stat, Tier } from "./ui";

type Props = { i: Initiative; onError: (s: string) => void };

export const STATUS_TONE: Record<string, string> = {
  not_contacted: "text-muted", invited: "text-secondary", replied: "text-primary", interested: "text-primary", registered: "text-good",
  attended: "text-good", meeting: "text-good", opportunity: "text-good", declined: "text-danger", not_now: "text-warning", bounced: "text-danger",
};

export default function TeamTab({ i, onError }: Props) {
  const [data, setData] = useState<TeamData | null>(null);
  const [rows, setRows] = useState<Outreach[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [links, setLinks] = useState<Member | null>(null);
  const [log, setLog] = useState<Outreach | null>(null);
  const [who, setWho] = useState("");
  const [status, setStatus] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    initiativesApi.team(i.id).then(setData).catch((e) => onError(errorText(e)));
    initiativesApi.outreach(i.id).then(setRows).catch(() => undefined);
  }, [i.id, onError]);
  useEffect(load, [load]);

  const shown = useMemo(() => (rows || []).filter((r) => (!who || r.member_id === who) && (!status || r.status === status)), [rows, who, status]);
  const t = data?.total || {};

  return (
    <div className="flex flex-col gap-5">
      {note && <Banner kind="good" onClose={() => setNote("")}>{note}</Banner>}
      <Section title="Team outreach" sub="Personal invites from LinkedIn, Sales Navigator, email and calls - logged by each person in two taps, plus everything GD360 sees on its own."
        actions={i.can_edit ? <>
          <button type="button" className="btn-secondary text-sm" onClick={() => setAssigning(true)} disabled={!data?.members.length} data-assign="">Assign accounts</button>
          <button type="button" className="btn-primary text-sm" onClick={() => setAdding(true)} data-add-member="">Add person</button>
        </> : undefined}>
        <div className="grid gap-5 grid-cols-[repeat(auto-fill,minmax(120px,1fr))]">
          <Stat label="On lists" value={fmt(t.assigned ?? 0)} />
          <Stat label="Invited personally" value={fmt(t.invited ?? 0)} />
          <Stat label="Replied" value={fmt(t.replied ?? 0)} hint={t.reply_rate !== null && t.reply_rate !== undefined ? `${t.reply_rate}% reply rate` : undefined} />
          <Stat label="Registered" value={fmt(t.registered ?? 0)} />
          <Stat label="Meetings" value={fmt(t.meetings ?? 0)} />
          <Stat label="Follow-ups overdue" value={fmt(t.overdue ?? 0)} tone={t.overdue ? "danger" : undefined} />
        </div>
      </Section>

      {!data ? <div className="h-40 rounded-card bg-surface2 animate-pulse" /> : data.members.length === 0 ? (
        <div className="flex gap-5 flex-wrap items-start">
          <div className="flex-[2_1_420px]"><Empty title="No one on the team yet" body="Add the people working on this - account executives, SDRs, customer success, booth staff. Each gets a private page to log their invites and replies, and a personal registration link that credits them automatically."
            action={i.can_edit ? <button type="button" className="btn-primary text-sm" onClick={() => setAdding(true)}>Add the first person</button> : undefined} /></div>
          <Roles data={data} />
        </div>
      ) : (
        <>
          <Section title="Leaderboard" sub="Per person. Stale = no update in 3 days.">
            <div className="overflow-x-auto -mx-5 px-5">
              <table className="w-full min-w-[860px] text-ui" data-leaderboard="">
                <thead><tr className="text-left text-caption text-muted border-b border-border">
                  <th className="py-2 font-medium">Person</th><th className="font-medium">Team</th>
                  {["On list", "Invited", "Replied", "Registered", "Attended", "Meetings", "Reply rate", "Overdue"].map((h) => <th key={h} className="font-medium text-right px-2">{h}</th>)}
                  <th className="font-medium text-right">Last update</th><th />
                </tr></thead>
                <tbody>
                  {data.members.map((m) => {
                    const goal = m.targets || {};
                    return (
                      <tr key={m.id} className="border-b border-border last:border-0" data-member={m.name}>
                        <td className="py-2.5 pr-2"><div className="text-text font-medium">{m.name}</div><div className="text-caption text-muted">{m.role || "Team member"}</div></td>
                        <td className="text-secondary">{m.team || "—"}</td>
                        <td className="text-right px-2 tabular-nums">{m.stats.assigned}</td>
                        <td className="text-right px-2 tabular-nums">{m.stats.invited}{goal.invites ? <span className="text-muted">/{goal.invites}</span> : null}</td>
                        <td className="text-right px-2 tabular-nums">{m.stats.replied}</td>
                        <td className="text-right px-2 tabular-nums">{m.stats.registered}{goal.registrations ? <span className="text-muted">/{goal.registrations}</span> : null}</td>
                        <td className="text-right px-2 tabular-nums">{m.stats.attended}</td>
                        <td className="text-right px-2 tabular-nums">{m.stats.meetings}{goal.meetings ? <span className="text-muted">/{goal.meetings}</span> : null}</td>
                        <td className="text-right px-2 tabular-nums">{m.stats.reply_rate !== null ? `${m.stats.reply_rate}%` : "—"}</td>
                        <td className={`text-right px-2 tabular-nums ${m.stats.overdue ? "text-danger font-medium" : "text-muted"}`}>{m.stats.overdue}</td>
                        <td className="text-right text-caption whitespace-nowrap">{m.stale ? <span className="text-warning">Stale · {m.last_update_at ? fmtDate(m.last_update_at) : "never"}</span> : <span className="text-muted">{m.last_update_at ? fmtDate(m.last_update_at) : "—"}</span>}</td>
                        <td className="text-right pl-2 whitespace-nowrap">
                          <button type="button" className="text-caption text-primary hover:underline" onClick={() => setLinks(m)}>Links</button>
                          {i.can_edit && <button type="button" className="text-caption text-secondary hover:text-text ml-3" onClick={async () => {
                            try { const r = await initiativesApi.nudge(i.id, m.id); setNote(r.emailed ? `Nudge emailed to ${m.name}.` : `Copy this to ${m.name}: ${r.message}`); } catch (e) { onError(errorText(e)); }
                          }}>Nudge</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>

          <div className="flex gap-5 flex-wrap items-start">
            <Section title="Which outreach works" sub="Reply and registration rate by the channel last used." className="flex-[1_1_380px]">
              {data.channels.length === 0 ? <p className="m-0 text-ui text-muted">No outreach logged yet.</p> : (
                <table className="w-full text-ui" data-channels="">
                  <thead><tr className="text-left text-caption text-muted"><th className="font-medium py-1">Channel</th><th className="font-medium text-right">Invited</th><th className="font-medium text-right">Reply rate</th><th className="font-medium text-right">Registered</th></tr></thead>
                  <tbody>{data.channels.sort((a, b) => b.invited - a.invited).map((c) => (
                    <tr key={c.channel} className="border-t border-border"><td className="py-2">{c.label}</td><td className="text-right tabular-nums">{c.invited}</td>
                      <td className="text-right tabular-nums">{c.reply_rate !== null ? `${c.reply_rate}%` : "—"}</td><td className="text-right tabular-nums">{c.registered}</td></tr>
                  ))}</tbody>
                </table>
              )}
            </Section>
            <Section title="Target accounts vs existing customers" className="flex-[1_1_300px]">
              <div className="grid grid-cols-2 gap-4">
                {(["target", "customer"] as const).map((s) => {
                  const v = data.segments[s] || {};
                  return (
                    <div key={s} className="rounded-ctl border border-border p-3">
                      <div className="text-caption text-muted">{s === "target" ? "Target accounts" : "Existing customers"}</div>
                      <div className="text-[20px] font-semibold tabular-nums text-text">{v.registered || 0}<span className="text-caption text-muted font-normal"> / {v.assigned || 0} registered</span></div>
                      <div className="text-caption text-secondary">{v.meetings || 0} meetings</div>
                    </div>
                  );
                })}
              </div>
            </Section>
            {data.teams.length > 1 && (
              <Section title="By team" className="flex-[1_1_300px]">
                {data.teams.map((tm) => (
                  <div key={tm.team} className="flex items-center justify-between text-ui py-1 border-b border-border last:border-0">
                    <span className="text-text">{tm.team} <span className="text-caption text-muted">· {tm.people}</span></span>
                    <span className="tabular-nums text-secondary text-caption">{tm.invited || 0} invited · {tm.registered || 0} registered · {tm.meetings || 0} meetings</span>
                  </div>
                ))}
              </Section>
            )}
          </div>

          <Section title="Every account and person on a list" sub="Log a touch for anyone - the rep's own page shows the same list."
            actions={<div className="flex gap-2 flex-wrap">
              <select className="input !w-auto !py-1.5 text-caption" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Person"><option value="">Everyone</option>{data.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
              <select className="input !w-auto !py-1.5 text-caption" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">Any status</option>{data.statuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
            </div>}>
            {!rows ? <div className="h-24 rounded-ctl bg-surface2 animate-pulse" /> : shown.length === 0 ? <p className="m-0 text-ui text-muted">Nothing here yet - assign accounts to the team.</p> : (
              <div className="overflow-x-auto -mx-5 px-5">
                <table className="w-full min-w-[760px] text-ui" data-outreach-table="">
                  <thead><tr className="text-left text-caption text-muted border-b border-border"><th className="py-2 font-medium">Account / person</th><th className="font-medium">Owner</th><th className="font-medium">Status</th><th className="font-medium">Last channel</th><th className="font-medium">Next step</th><th /></tr></thead>
                  <tbody>{shown.slice(0, 300).map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0">
                      <td className="py-2 pr-2"><div className="flex items-center gap-2"><Tier tier={r.tier} /><div className="min-w-0"><div className="text-text truncate">{r.person || r.account}</div>{r.person && r.account && <div className="text-caption text-muted truncate">{r.account}{r.title ? ` · ${r.title}` : ""}</div>}</div>{r.segment === "customer" && <span className="text-[10.5px] px-1.5 rounded bg-surface2 text-secondary">Customer</span>}</div></td>
                      <td className="text-secondary">{r.member || <span className="text-muted">Unassigned</span>}</td>
                      <td className={STATUS_TONE[r.status] || "text-text"}>{r.status_label}{r.touches > 1 ? <span className="text-caption text-muted"> · {r.touches} touches</span> : null}</td>
                      <td className="text-secondary">{r.channel ? (data.channel_options.find((c) => c.key === r.channel)?.label || r.channel.replace("_", " ")) : "—"}</td>
                      <td className={r.overdue ? "text-danger" : "text-secondary"}>{r.next_step_on ? `${r.next_step || "Follow up"} · ${fmtDate(r.next_step_on)}` : "—"}</td>
                      <td className="text-right">{i.can_edit && <button type="button" className="text-caption text-primary hover:underline" onClick={() => setLog(r)}>Log</button>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Section>
          <Roles data={data} />
        </>
      )}

      {adding && data && <MemberSheet i={i} roles={data.roles} onClose={() => setAdding(false)} onSaved={(m) => { setAdding(false); setLinks(m); load(); }} onError={onError} />}
      {assigning && data && <AssignSheet i={i} members={data.members} onClose={() => setAssigning(false)} onDone={(n) => { setAssigning(false); setNote(n); load(); }} onError={onError} />}
      {links && <Sheet open onClose={() => setLinks(null)} title={`${links.name}'s links`}>
        <p className="m-0 text-ui text-secondary">Send these to {links.name.split(" ")[0]}. No GD360 login needed.</p>
        <Field label="My invites page - their accounts, two-tap logging" hint="Works on a phone. Keep it private: anyone with it can log for this person."><CopyField value={links.links.page} testId="member-page" /></Field>
        <Field label="Personal registration link" hint="Use it in LinkedIn, Sales Navigator and personal emails. Everyone who registers through it is credited to them automatically."><CopyField value={links.links.invite} testId="member-invite" /></Field>
        {i.can_edit && (
          <div className="flex gap-2 pt-2">
            <button type="button" className="btn-secondary text-sm" onClick={async () => { try { const l = await initiativesApi.newMemberLink(i.id, links.id); setLinks({ ...links, links: { ...links.links, page: l.page } }); } catch (e) { onError(errorText(e)); } }}>Replace page link</button>
            <button type="button" className="btn-secondary text-sm !text-danger" onClick={async () => { try { await initiativesApi.deleteMember(i.id, links.id); setLinks(null); load(); } catch (e) { onError(errorText(e)); } }}>Remove from team</button>
          </div>
        )}
      </Sheet>}
      {log && data && <LogSheet i={i} row={log} data={data} onClose={() => setLog(null)} onSaved={() => { setLog(null); load(); }} onError={onError} />}
    </div>
  );
}

function Roles({ data }: { data: TeamData }) {
  if (!data.roles?.length) return null;
  return (
    <Section title="Roles for this initiative" sub="Who does what, and what each role is measured on." className="flex-[1_1_320px]">
      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(240px,1fr))]">
        {data.roles.map((r) => (
          <div key={r.role} className="rounded-ctl border border-border p-3">
            <div className="text-ui font-medium text-text">{r.role}</div>
            <div className="text-caption text-secondary mt-0.5">{r.does}</div>
            {Object.keys(r.targets || {}).length > 0 && <div className="text-caption text-muted mt-1.5">Each: {Object.entries(r.targets).map(([k, v]) => `${v} ${k.replace("_", "-")}`).join(" · ")}</div>}
          </div>
        ))}
      </div>
    </Section>
  );
}

function MemberSheet({ i, roles, onClose, onSaved, onError }: { i: Initiative; roles: TeamData["roles"]; onClose: () => void; onSaved: (m: Member) => void; onError: (s: string) => void }) {
  const [f, setF] = useState({ name: "", email: "", role: roles[1]?.role || roles[0]?.role || "", team: "" });
  const role = roles.find((r) => r.role === f.role);
  const [tg, setTg] = useState<Record<string, number>>(role?.targets || {});
  useEffect(() => { setTg(roles.find((r) => r.role === f.role)?.targets || {}); }, [f.role, roles]);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title="Add a person"
      footer={<button type="button" className="btn-primary text-sm" disabled={busy || !f.name.trim()} onClick={async () => {
        setBusy(true);
        try { const m = await initiativesApi.addMember(i.id, { ...f, targets: tg }); onSaved(m as Member); } catch (e) { onError(errorText(e)); setBusy(false); }
      }}>Add</button>}>
      <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-member-name="" /></Field>
      <Field label="Work email" hint="Used for nudges. Optional."><input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Role"><input className="input" list="role-list" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} />
          <datalist id="role-list">{roles.map((r) => <option key={r.role} value={r.role} />)}</datalist></Field>
        <Field label="Team" hint="e.g. West, Enterprise"><input className="input" value={f.team} onChange={(e) => setF({ ...f, team: e.target.value })} /></Field>
      </div>
      {role && <p className="m-0 text-caption text-secondary">{role.does}</p>}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        {(["invites", "registrations", "meetings", "walk_ins"] as const).map((k) => (
          <Field key={k} label={`${k.replace("_", "-")} goal`}><input type="number" min={0} className="input" value={tg[k] ?? ""} onChange={(e) => setTg({ ...tg, [k]: Number(e.target.value) })} /></Field>
        ))}
      </div>
    </Sheet>
  );
}

function AssignSheet({ i, members, onClose, onDone, onError }: { i: Initiative; members: Member[]; onClose: () => void; onDone: (msg: string) => void; onError: (s: string) => void }) {
  const [tiers, setTiers] = useState<string[]>(i.audience?.tiers || ["A"]);
  const [ids, setIds] = useState<string[]>(members.map((m) => m.id));
  const [strategy, setStrategy] = useState("round_robin");
  const [segment, setSegment] = useState("");
  const [limit, setLimit] = useState(200);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title="Assign accounts to the team"
      footer={<button type="button" className="btn-primary text-sm" disabled={busy || !ids.length} onClick={async () => {
        setBusy(true);
        try {
          const r = await initiativesApi.assign(i.id, { member_ids: ids, tiers, strategy, segment: segment || null, limit });
          onDone(`Assigned ${r.assigned} accounts${r.skipped ? ` (${r.skipped} were already on someone's list)` : ""}.`);
        } catch (e) { onError(errorText(e)); setBusy(false); }
      }} data-assign-go="">Assign</button>}>
      <p className="m-0 text-ui text-secondary">Best-fit accounts first (ICP score, then engagement). Anything already on someone's list stays where it is.</p>
      <Field label="Tiers"><div className="flex gap-2">{["A", "B", "C"].map((t) => <button key={t} type="button" aria-pressed={tiers.includes(t)} onClick={() => setTiers(tiers.includes(t) ? tiers.filter((x) => x !== t) : [...tiers, t])}
        className={`ui-focus h-8 px-3 rounded-full border text-caption ${tiers.includes(t) ? "border-primary bg-tint text-text" : "border-border text-secondary"}`}>Tier {t}</button>)}</div></Field>
      <Field label="Who"><div className="flex flex-col gap-1.5">{members.map((m) => (
        <label key={m.id} className="flex items-center gap-2 text-ui"><input type="checkbox" checked={ids.includes(m.id)} onChange={() => setIds(ids.includes(m.id) ? ids.filter((x) => x !== m.id) : [...ids, m.id])} />{m.name} <span className="text-caption text-muted">{m.role}</span></label>
      ))}</div></Field>
      <Field label="How"><select className="input" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
        <option value="round_robin">Spread evenly</option><option value="owner">By account owner (falls back to evenly)</option></select></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="These accounts are"><select className="input" value={segment} onChange={(e) => setSegment(e.target.value)}>
          <option value="">Work it out from the account</option><option value="target">Target accounts</option><option value="customer">Existing customers</option></select></Field>
        <Field label="At most"><input type="number" min={1} max={5000} className="input" value={limit} onChange={(e) => setLimit(Number(e.target.value))} /></Field>
      </div>
    </Sheet>
  );
}

export function LogSheet({ i, row, data, onClose, onSaved, onError }: { i: Initiative; row: Outreach; data: TeamData; onClose: () => void; onSaved: () => void; onError: (s: string) => void }) {
  const [f, setF] = useState({ status: "", channel: row.channel || "", note: "", next_step: row.next_step || "", next_step_on: row.next_step_on || "", member_id: row.member_id || "" });
  const [busy, setBusy] = useState(false);
  const channels = data.channel_options || [];
  return (
    <Sheet open onClose={onClose} title={row.person || row.account || "Outreach"}
      footer={<button type="button" className="btn-primary text-sm" disabled={busy} onClick={async () => {
        setBusy(true);
        try { await initiativesApi.patchOutreach(i.id, row.id, { ...f, status: f.status || null, channel: f.channel || null }); onSaved(); } catch (e) { onError(errorText(e)); setBusy(false); }
      }}>Save</button>}>
      <span className="text-caption text-muted">Now: {row.status_label}{row.last_touch_at ? ` · last touch ${fmtDate(row.last_touch_at)}` : ""}</span>
      <Field label="What happened"><select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
        <option value="">No change</option>{data.statuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></Field>
      <Field label="How"><select className="input" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
        <option value="">—</option>{(channels.length ? channels : CHANNEL_OPTIONS).map((c: any) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></Field>
      <Field label="Note"><textarea className="input min-h-[70px]" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Next step"><input className="input" value={f.next_step} onChange={(e) => setF({ ...f, next_step: e.target.value })} placeholder="Follow up" /></Field>
        <Field label="By"><input type="date" className="input" value={f.next_step_on} onChange={(e) => setF({ ...f, next_step_on: e.target.value })} /></Field>
      </div>
      <Field label="Owner"><select className="input" value={f.member_id} onChange={(e) => setF({ ...f, member_id: e.target.value })}>
        <option value="">Unassigned</option>{data.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
      {(row.history || []).length > 0 && (
        <ol className="m-0 pl-4 text-caption text-secondary flex flex-col gap-1">{(row.history || []).slice().reverse().map((h, k) => (
          <li key={k}>{fmtDate(h.at)} · {h.auto ? "GD360" : h.by}: {h.to.replace("_", " ")}{h.channel ? ` via ${h.channel.replace("_", " ")}` : ""}{h.note ? ` - ${h.note}` : ""}</li>
        ))}</ol>
      )}
    </Sheet>
  );
}

export const CHANNEL_OPTIONS = [
  { key: "linkedin", label: "LinkedIn message" }, { key: "sales_navigator", label: "Sales Navigator InMail" }, { key: "email", label: "Personal email" },
  { key: "call", label: "Call" }, { key: "whatsapp", label: "WhatsApp / text" }, { key: "in_person", label: "In person" },
  { key: "marketing_email", label: "Marketing email" }, { key: "personal_link", label: "Personal invite link" }, { key: "other", label: "Other" },
];

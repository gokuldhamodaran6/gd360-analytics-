import { useMemo, useState } from "react";
import { errorText, Initiative, initiativesApi, Task } from "../api/initiatives";
import { Banner, CopyField, Field, fmtDate, Section, Sheet, todayIso } from "./ui";

type Props = { i: Initiative; reload: () => void; onError: (s: string) => void };

const STATUS: { id: Task["status"]; label: string; cls: string }[] = [
  { id: "todo", label: "To do", cls: "text-secondary bg-surface2 border-border" },
  { id: "doing", label: "In progress", cls: "text-primary bg-tint border-tint-border" },
  { id: "review", label: "In review", cls: "text-warning bg-warning-fill border-warning-border" },
  { id: "blocked", label: "Blocked", cls: "text-danger bg-danger-fill border-danger-border" },
  { id: "done", label: "Done", cls: "text-good bg-good-fill border-good-border" },
];

export function StatusSelect({ value, onChange, disabled }: { value: Task["status"]; onChange: (v: Task["status"]) => void; disabled?: boolean }) {
  const s = STATUS.find((x) => x.id === value) || STATUS[0];
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Task["status"])} aria-label="Status" data-task-status={value}
      className={`ui-focus h-[26px] pl-2 pr-6 rounded-full border text-[11.5px] font-medium appearance-none bg-no-repeat cursor-pointer ${s.cls}`}
      style={{ backgroundImage: "linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%)", backgroundPosition: "calc(100% - 11px) 11px, calc(100% - 7px) 11px", backgroundSize: "4px 4px" }}>
      {STATUS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
    </select>
  );
}

export function ApprovalBadge({ t }: { t: Task }) {
  const a = t.approval;
  if (!a || a.state === "none") return null;
  const map = { submitted: ["Awaiting approval", "text-warning"], approved: ["Approved", "text-good"], changes: ["Changes requested", "text-danger"] } as const;
  const [label, cls] = map[a.state as keyof typeof map] || ["", ""];
  return <span className={`text-caption ${cls}`} data-approval={a.state}>{label}{a.version ? ` · v${a.version}` : ""}{a.state !== "submitted" && a.decided_by ? ` · ${a.decided_by}` : ""}</span>;
}

export default function PlanTab({ i, reload, onError }: Props) {
  const [open, setOpen] = useState<Task | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState("");
  const [filter, setFilter] = useState<"all" | "mine" | "open" | "late">("all");
  const now = todayIso();
  const phases = useMemo(() => {
    const ids = new Set(i.phases.map((p) => p.id));
    const list = i.phases.map((p) => ({ ...p, tasks: i.tasks.filter((t) => t.phase_id === p.id) }));
    const loose = i.tasks.filter((t) => !t.phase_id || !ids.has(t.phase_id));
    if (loose.length) list.push({ id: "_", title: "Other tasks", from: 0, to: 0, tasks: loose } as any);
    return list;
  }, [i]);
  const show = (t: Task) => filter === "all" || (filter === "open" && t.status !== "done") || (filter === "late" && t.status !== "done" && !!t.due_on && t.due_on < now);

  const patch = async (t: Task, body: Partial<Task>) => {
    try { await initiativesApi.patchTask(i.id, t.id, body); reload(); } catch (e) { onError(errorText(e)); }
  };
  const add = async (phase: string) => {
    if (!title.trim()) return;
    try {
      await initiativesApi.addTask(i.id, { title: title.trim(), phase_id: phase === "_" ? null : phase, owner_name: owner.trim() || null } as any);
      setTitle(""); setOwner(""); setAdding(null); reload();
    } catch (e) { onError(errorText(e)); }
  };

  const done = i.tasks.filter((t) => t.status === "done").length;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-4">
          <span className="text-ui text-secondary tabular-nums">{done} of {i.tasks.length} done</span>
          <div className="w-[180px] h-1.5 rounded-full bg-surface2 overflow-hidden"><div className="h-full bg-primary rounded-full" style={{ width: `${i.tasks.length ? (100 * done) / i.tasks.length : 0}%` }} /></div>
        </div>
        <div className="inline-flex p-[3px] rounded-full border border-border bg-base" role="tablist" aria-label="Filter tasks">
          {([["all", "All"], ["open", "Open"], ["late", "Overdue"]] as const).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}
              className={`ui-focus h-8 px-3.5 rounded-full text-caption ${filter === k ? "bg-surface2 text-text font-medium" : "text-muted hover:text-text"}`}>{l}</button>
          ))}
        </div>
      </div>

      {phases.map((p) => {
        const tasks = p.tasks.filter(show);
        if (!tasks.length && filter !== "all") return null;
        return (
          <Section key={p.id} title={p.title} sub={p.starts ? `${fmtDate(p.starts)}${p.ends && p.ends !== p.starts ? ` – ${fmtDate(p.ends)}` : ""}` : undefined} tight
            actions={i.can_edit ? <button type="button" className="text-caption text-primary hover:underline" onClick={() => { setAdding(p.id); setTitle(""); }}>+ Add task</button> : undefined}>
            <ul className="m-0 p-0 list-none flex flex-col divide-y divide-border -mx-1" data-phase={p.id}>
              {tasks.map((t) => {
                const late = t.status !== "done" && t.due_on && t.due_on < now;
                return (
                  <li key={t.id} className="px-1 py-2.5 flex items-center gap-3 flex-wrap sm:flex-nowrap" data-task={t.id}>
                    <StatusSelect value={t.status} disabled={!i.can_edit} onChange={(v) => patch(t, { status: v })} />
                    <button type="button" className="ui-focus text-left flex-1 min-w-[200px]" onClick={() => setOpen(t)}>
                      <span className={`text-ui ${t.status === "done" ? "text-muted line-through decoration-border-strong" : "text-text"}`}>{t.title}</span>
                      <span className="flex gap-3 flex-wrap">
                        <ApprovalBadge t={t} />
                        {t.evidence.length > 0 && <span className="text-caption text-muted">{t.evidence.length} deliverable{t.evidence.length > 1 ? "s" : ""}</span>}
                        {t.origin === "walk-in" && <span className="text-caption text-series-2">From walk-in</span>}
                        {t.origin === "assistant" && <span className="text-caption text-muted">Added by the assistant</span>}
                      </span>
                    </button>
                    <span className="text-caption text-secondary w-[110px] truncate">{t.owner_name || <span className="text-muted">No owner</span>}</span>
                    <span className={`text-caption tabular-nums w-[64px] text-right ${late ? "text-danger font-medium" : "text-muted"}`}>{t.due_on ? fmtDate(t.due_on) : "—"}</span>
                  </li>
                );
              })}
            </ul>
            {adding === p.id && (
              <form className="flex gap-2 flex-wrap" onSubmit={(e) => { e.preventDefault(); add(p.id); }}>
                <input className="input !py-2 text-ui flex-[2_1_240px]" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" aria-label="New task" />
                <input className="input !py-2 text-ui flex-[1_1_140px]" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Owner" aria-label="Owner" />
                <button type="submit" className="btn-primary text-sm !py-2" disabled={!title.trim()}>Add</button>
                <button type="button" className="text-caption text-muted" onClick={() => setAdding(null)}>Cancel</button>
              </form>
            )}
          </Section>
        );
      })}

      {open && <TaskSheet i={i} t={i.tasks.find((x) => x.id === open.id) || open} onClose={() => setOpen(null)} reload={reload} onError={onError} />}
    </div>
  );
}

function TaskSheet({ i, t, onClose, reload, onError }: { i: Initiative; t: Task; onClose: () => void; reload: () => void; onError: (s: string) => void }) {
  const [form, setForm] = useState({ title: t.title, detail: t.detail || "", owner_name: t.owner_name || "", due_on: t.due_on || "", status: t.status });
  const [ev, setEv] = useState({ label: "", url: "", version: "" });
  const [ap, setAp] = useState({ approver: t.approval?.approver || "", approver_email: "", note: "" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const a = t.approval;

  const run = async (fn: () => Promise<any>, ok?: string) => {
    setBusy(true);
    try { await fn(); reload(); if (ok) setMsg(ok); } catch (e) { onError(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <Sheet open onClose={onClose} title="Task" wide
      footer={i.can_edit ? (
        <>
          <button type="button" className="btn-secondary text-sm !text-danger" disabled={busy} onClick={() => run(async () => { await initiativesApi.deleteTask(i.id, t.id); onClose(); })}>Delete</button>
          <button type="button" className="btn-primary text-sm" disabled={busy || !form.title.trim()} onClick={() => run(() => initiativesApi.patchTask(i.id, t.id, { ...form, due_on: form.due_on || null } as any), "Saved.")}>Save</button>
        </>
      ) : undefined}>
      {msg && <Banner kind="good" onClose={() => setMsg("")}>{msg}</Banner>}
      <Field label="Title"><input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} disabled={!i.can_edit} /></Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Owner"><input className="input" value={form.owner_name} onChange={(e) => setForm({ ...form, owner_name: e.target.value })} disabled={!i.can_edit} /></Field>
        <Field label="Due"><input type="date" className="input" value={form.due_on} onChange={(e) => setForm({ ...form, due_on: e.target.value })} disabled={!i.can_edit} /></Field>
        <Field label="Status"><select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Task["status"] })} disabled={!i.can_edit}>
          {STATUS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
      </div>
      <Field label="Notes"><textarea className="input min-h-[80px]" value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} disabled={!i.can_edit} /></Field>

      <div className="border-t border-border pt-4 flex flex-col gap-3">
        <div>
          <div className="text-ui font-semibold text-text">Deliverables</div>
          <p className="m-0 text-caption text-muted">The Figma file, the doc, the build - with its version, so everyone knows which one is final.</p>
        </div>
        {t.evidence.length === 0 ? <p className="m-0 text-caption text-muted">None yet.</p> : (
          <ul className="m-0 p-0 list-none flex flex-col gap-2" data-evidence="">
            {t.evidence.map((e, idx) => (
              <li key={idx} className="flex items-center gap-3 rounded-ctl border border-border px-3 py-2">
                <span className="text-[10.5px] font-mono uppercase tracking-[0.08em] text-muted w-[46px] shrink-0">{e.kind}</span>
                <span className="min-w-0 flex-1">
                  {e.url ? <a href={e.url} target="_blank" rel="noreferrer" className="text-ui text-text hover:underline truncate block">{e.label}</a> : <span className="text-ui text-text">{e.label}</span>}
                  <span className="text-caption text-muted">{e.version ? `Version ${e.version} · ` : ""}added {fmtDate(e.added_at)}</span>
                </span>
                {i.can_edit && <button type="button" className="text-caption text-muted hover:text-danger" onClick={() => run(() => initiativesApi.addEvidence(i.id, t.id, { remove_index: idx }))}>Remove</button>}
              </li>
            ))}
          </ul>
        )}
        {i.can_edit && (
          <form className="grid gap-2 sm:grid-cols-[1fr_1.4fr_90px_auto]" onSubmit={(e) => { e.preventDefault(); run(async () => { await initiativesApi.addEvidence(i.id, t.id, ev); setEv({ label: "", url: "", version: "" }); }); }}>
            <input className="input !py-2 text-ui" placeholder="Name (e.g. Event banner)" value={ev.label} onChange={(e) => setEv({ ...ev, label: e.target.value })} aria-label="Deliverable name" />
            <input className="input !py-2 text-ui" placeholder="Link (Figma, Drive, Notion…)" value={ev.url} onChange={(e) => setEv({ ...ev, url: e.target.value })} aria-label="Deliverable link" />
            <input className="input !py-2 text-ui" placeholder="Version" value={ev.version} onChange={(e) => setEv({ ...ev, version: e.target.value })} aria-label="Version" />
            <button type="submit" className="btn-secondary text-sm !py-2" disabled={busy || (!ev.label.trim() && !ev.url.trim())}>Add</button>
          </form>
        )}
      </div>

      <div className="border-t border-border pt-4 flex flex-col gap-3" data-approval-panel="">
        <div>
          <div className="text-ui font-semibold text-text">Approval</div>
          <p className="m-0 text-caption text-muted">Send it to whoever signs off. They decide from a link - no GD360 account needed - and the decision is kept with the version.</p>
        </div>
        {a && a.state !== "none" && (
          <div className={`rounded-ctl border px-3.5 py-3 flex flex-col gap-1 ${a.state === "approved" ? "border-good-border bg-good-fill" : a.state === "changes" ? "border-danger-border bg-danger-fill" : "border-warning-border bg-warning-fill"}`}>
            <span className="text-ui text-text font-medium">
              {a.state === "submitted" ? `Waiting for ${a.approver}` : a.state === "approved" ? `Approved by ${a.decided_by}` : `Changes requested by ${a.decided_by}`}
              {a.version ? ` · v${a.version}` : ""}
            </span>
            {a.decision_note && <span className="text-caption text-secondary">“{a.decision_note}”</span>}
            {a.state === "submitted" && t.approval_link && <CopyField value={t.approval_link} label="Approval link" testId="approval-link" />}
          </div>
        )}
        {i.can_edit && (!a || a.state !== "submitted") && (
          <form className="grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); run(async () => {
            const r = await initiativesApi.requestApproval(i.id, t.id, { approver: ap.approver.trim(), approver_email: ap.approver_email.trim() || undefined, note: ap.note.trim() || undefined });
            setMsg(r.emailed ? `Sent to ${ap.approver} by email.` : "Approval link ready - copy it to the approver.");
          }); }}>
            <input className="input !py-2 text-ui" placeholder="Approver (e.g. Priya, Senior designer)" value={ap.approver} onChange={(e) => setAp({ ...ap, approver: e.target.value })} aria-label="Approver" data-approver="" />
            <input className="input !py-2 text-ui" placeholder="Their email (optional)" value={ap.approver_email} onChange={(e) => setAp({ ...ap, approver_email: e.target.value })} aria-label="Approver email" />
            <input className="input !py-2 text-ui sm:col-span-2" placeholder="What should they check? (optional)" value={ap.note} onChange={(e) => setAp({ ...ap, note: e.target.value })} aria-label="Note" />
            <div className="sm:col-span-2"><button type="submit" className="btn-primary text-sm" disabled={busy || !ap.approver.trim()} data-request-approval="">{a?.state === "changes" ? "Send the new version for approval" : "Send for approval"}</button></div>
          </form>
        )}
        {i.can_edit && a?.state === "submitted" && (
          <div className="flex flex-col gap-2">
            <span className="text-caption text-muted">Decided in a meeting? Record it here.</span>
            <input className="input !py-2 text-ui" placeholder="Note (required for changes)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Decision note" />
            <div className="flex gap-2">
              <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => run(() => initiativesApi.decide(i.id, t.id, { decision: "approve", note }))}>Mark approved</button>
              <button type="button" className="btn-secondary text-sm" disabled={busy || !note.trim()} onClick={() => run(() => initiativesApi.decide(i.id, t.id, { decision: "changes", note }))}>Changes requested</button>
            </div>
          </div>
        )}
        {(a?.history || []).length > 0 && (
          <ol className="m-0 pl-4 flex flex-col gap-1 text-caption text-secondary">
            {(a?.history || []).slice().reverse().map((h, idx) => (
              <li key={idx}>{fmtDate(h.at)} · {h.by} · {h.action === "submitted" ? "sent for approval" : h.action === "approved" ? "approved" : "requested changes"}{h.version ? ` (v${h.version})` : ""}{h.note ? ` - ${h.note}` : ""}</li>
            ))}
          </ol>
        )}
      </div>
    </Sheet>
  );
}

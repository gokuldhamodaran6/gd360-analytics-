// Mission Control · Pipeline & leads — deals by stage, demo requests and
// product-qualified workspaces, all from GD360's own CRM tables.
import { Fragment, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { mcPatch, mcPost, useMC } from "../api";
import {
  ActionButton, ago, Card, dateShort, dateTime, Drawer, Empty, ErrorBox, fmtN, fmtPct, fmtUSD, Kpi, Loading, Modal, PageHead, Pill, Seg, useCan, useMe, useToast,
} from "../ui";

type View = "pipeline" | "leads" | "pql";
const NO = "Your role can't do this";
const STAGE_COLOR: Record<string, string> = { new: "#4B5A57", qualified: "#7AA7FF", demo: "#7AA7FF", proposal: "#F2B84B", won: "#43E5A0", lost: "#FF7A6B" };
const NEXT: Record<string, string> = { new: "qualified", qualified: "demo", demo: "proposal", proposal: "won" };
const OPEN_STAGES: [string, string][] = [["new", "New lead"], ["qualified", "Qualified"], ["demo", "Demo done"], ["proposal", "Proposal"]];
const LEAD_STATUS = ["new", "contacted", "qualified", "closed"];

const k$ = (n: number | null | undefined) => (n == null ? "—" : n >= 1000 ? `$${fmtN(n / 1000, n % 1000 ? 1 : 0)}k` : fmtUSD(n));
const who = (e?: string | null) => (e ? e.split("@")[0] : "Unassigned");
const masked = (e?: string | null) => !e || e.includes("•");
const scoreTone = (s: number) => (s >= 70 ? "g" : s >= 40 ? "a" : undefined) as "g" | "a" | undefined;
const toISO = (d: string) => (d ? `${d}T00:00:00` : null);

/* ------------------------------------------------------------ new deal */
type DealDraft = { name: string; company: string; contact_name: string; contact_email: string; stage: string; amount: string; seats: string; close_date: string; next_step: string; source: string };
const EMPTY_DEAL: DealDraft = { name: "", company: "", contact_name: "", contact_email: "", stage: "new", amount: "", seats: "", close_date: "", next_step: "", source: "manual" };

function NewDeal({ open, initial, onClose, onCreated }: { open: boolean; initial: DealDraft; onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState<DealDraft>(initial);
  const set = (k: keyof DealDraft) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open={open} onClose={onClose} title="New deal">
      <label className="mc-field">Deal name<input className="mc-input" value={f.name} onChange={set("name")} placeholder="Acme — Business annual" /></label>
      <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" }}>
        <label className="mc-field">Company<input className="mc-input" value={f.company} onChange={set("company")} /></label>
        <label className="mc-field">Stage
          <select className="mc-select" value={f.stage} onChange={set("stage")}>{OPEN_STAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </label>
        <label className="mc-field">Contact name<input className="mc-input" value={f.contact_name} onChange={set("contact_name")} /></label>
        <label className="mc-field">Contact email<input className="mc-input" type="email" value={f.contact_email} onChange={set("contact_email")} /></label>
        <label className="mc-field">Amount (USD / year)<input className="mc-input" type="number" min={0} value={f.amount} onChange={set("amount")} /></label>
        <label className="mc-field">Seats<input className="mc-input" type="number" min={0} value={f.seats} onChange={set("seats")} /></label>
        <label className="mc-field">Expected close<input className="mc-input" type="date" value={f.close_date} onChange={set("close_date")} /></label>
      </div>
      <label className="mc-field">Next step<input className="mc-input" value={f.next_step} onChange={set("next_step")} placeholder="Book the demo" /></label>
      <ActionButton className="mc-btn p" disabled={f.name.trim().length < 2} done="Deal created" run={async () => {
        const d = await mcPost("/crm/deals", {
          name: f.name.trim(), company: f.company || null, contact_name: f.contact_name || null, contact_email: f.contact_email || null,
          stage: f.stage, amount: f.amount === "" ? null : Number(f.amount), seats: f.seats === "" ? null : Number(f.seats),
          close_date: toISO(f.close_date), next_step: f.next_step || null, source: f.source,
        });
        onCreated(d.id);
      }}>Create deal</ActionButton>
      <span className="mc-tip">You're the owner. Creating a deal is written to the audit log.</span>
    </Modal>
  );
}

/* ------------------------------------------------------------ deal panel */
function DealPanel({ id, stages, onChanged }: { id: string; stages: Record<string, string>; onChanged: () => void }) {
  const { data, error, loading, reload } = useMC<any>(`/crm/deals/${id}`);
  const can = useCan()("crm.write");
  const [lostOpen, setLostOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [kind, setKind] = useState("call");
  const [note, setNote] = useState("");
  const [edit, setEdit] = useState<any>(null);
  const after = async () => { await reload(); onChanged(); };
  const patch = (body: any) => mcPatch(`/crm/deals/${id}`, body).then(after);

  if (error) return <ErrorBox text={error} retry={reload} />;
  if (loading && !data) return <Loading rows={3} h={70} />;
  if (!data) return null;
  const d = data.deal;
  const next = NEXT[d.stage];
  const facts: [string, string][] = [
    ["Amount", d.amount == null ? "—" : fmtUSD(d.amount)], ["Seats", fmtN(d.seats)],
    ["Probability", `${Math.round(d.probability * 100)}%`], ["Weighted", d.amount == null ? "—" : fmtUSD(d.amount * d.probability)],
    ["Owner", d.owner_email || "Unassigned"], ["Close date", dateShort(d.close_date)],
    ["Contact", [d.contact_name, d.contact_email].filter(Boolean).join(" · ") || "—"], ["Source", (d.source || "—").replace("_", " ")],
  ];
  const ed = edit || { amount: d.amount ?? "", seats: d.seats ?? "", close_date: d.close_date ? d.close_date.slice(0, 10) : "", next_step: d.next_step || "" };
  const setE = (k: string) => (e: any) => setEdit({ ...ed, [k]: e.target.value });

  return (
    <>
      <span className="mc-lbl" style={{ color: STAGE_COLOR[d.stage] }}>DEAL · {(stages[d.stage] || d.stage).toUpperCase()}</span>
      <h2 style={{ margin: 0, fontSize: 21, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.3 }}>{d.name}</h2>
      {d.company && <span className="mc-tip" style={{ marginTop: -10 }}>{d.company}{d.domain ? ` · ${d.domain}` : ""}</span>}
      <div className="mc-grid" style={{ gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 8 }}>
        {facts.map(([k, v]) => (
          <div key={k} style={{ display: "flex", flexDirection: "column", gap: 2, padding: 10, borderRadius: 12, background: "var(--s2)", minWidth: 0 }}>
            <span style={{ fontSize: 11.5, color: "var(--ink3)" }}>{k}</span>
            <span className="mc-num" style={{ fontSize: 13.5, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis" }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="mc-lbl">NEXT STEP</span>
        <span style={{ fontSize: 13.5, lineHeight: 1.5, color: "#D5DEDB" }}>{d.next_step || "No next step set."}</span>
      </div>
      {d.stage === "lost" && d.lost_reason && <div className="mc-err">Lost: {d.lost_reason}</div>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {next && (
          <ActionButton className="mc-btn p" disabled={!can} title={can ? undefined : NO} done={`Moved to ${stages[next]}`}
            run={() => patch({ stage: next })}>Move to {stages[next]}</ActionButton>
        )}
        {d.stage === "lost" && (
          <ActionButton className="mc-btn" disabled={!can} title={can ? undefined : NO} done="Deal reopened" run={() => patch({ stage: "qualified" })}>Reopen as qualified</ActionButton>
        )}
        {d.stage !== "lost" && d.stage !== "won" && (
          <button type="button" className="mc-btn d" disabled={!can} title={can ? undefined : NO} onClick={() => { setReason(""); setLostOpen(true); }}>Mark lost</button>
        )}
      </div>

      <Card title="EDIT" style={{ background: "var(--s1)" }}>
        <div className="mc-grid" style={{ gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 8 }}>
          <label className="mc-field">Amount<input className="mc-input" type="number" min={0} value={ed.amount} onChange={setE("amount")} disabled={!can} /></label>
          <label className="mc-field">Seats<input className="mc-input" type="number" min={0} value={ed.seats} onChange={setE("seats")} disabled={!can} /></label>
          <label className="mc-field">Close date<input className="mc-input" type="date" value={ed.close_date} onChange={setE("close_date")} disabled={!can} /></label>
        </div>
        <label className="mc-field">Next step<input className="mc-input" value={ed.next_step} onChange={setE("next_step")} disabled={!can} /></label>
        <ActionButton className="mc-btn sm" disabled={!can || !edit} title={can ? undefined : NO} done="Deal saved" run={async () => {
          await patch({ amount: ed.amount === "" ? null : Number(ed.amount), seats: ed.seats === "" ? null : Number(ed.seats),
            close_date: toISO(ed.close_date), next_step: ed.next_step || null });
          setEdit(null);
        }}>Save changes</ActionButton>
      </Card>

      <Card title="LOG ACTIVITY" style={{ background: "var(--s1)" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <select className="mc-select" aria-label="Activity type" value={kind} onChange={(e) => setKind(e.target.value)} disabled={!can}>
            {["call", "email", "meeting", "note"].map((k) => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}
          </select>
          <input className="mc-input" style={{ flex: 1 }} aria-label="What happened" placeholder="What happened?" value={note} onChange={(e) => setNote(e.target.value)} disabled={!can} />
        </div>
        <ActionButton className="mc-btn sm" disabled={!can || !note.trim()} title={can ? undefined : NO} done="Activity logged" run={async () => {
          await mcPost(`/crm/deals/${id}/activities`, { kind, body: note.trim() });
          setNote("");
          await after();
        }}>Log {kind}</ActionButton>
      </Card>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span className="mc-lbl">ACTIVITY</span>
        {data.activities.length === 0 && <Empty>Nothing logged yet.</Empty>}
        {data.activities.map((a: any) => (
          <div key={a.id} style={{ display: "flex", gap: 10, fontSize: 13, lineHeight: 1.45 }}>
            <span className="mc-dot" style={{ background: a.kind === "stage" ? "#7AA7FF" : "#43E5A0", width: 8, height: 8 }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span style={{ color: "#D5DEDB", whiteSpace: "pre-wrap" }}>{a.body}</span>
              <span className="mc-mono" style={{ fontSize: 11, color: "var(--ink3)" }}>{a.kind} · {who(a.by)} · {dateTime(a.t)}</span>
            </div>
          </div>
        ))}
      </div>

      <Modal open={lostOpen} onClose={() => setLostOpen(false)} title="Mark deal lost">
        <label className="mc-field">Why was it lost?
          <textarea className="mc-textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Chose to build in-house" />
        </label>
        <ActionButton className="mc-btn d" disabled={!reason.trim()} done="Marked lost" run={async () => {
          await patch({ stage: "lost", lost_reason: reason.trim() });
          setLostOpen(false);
        }}>Mark lost</ActionButton>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------ leads */
function Leads({ leads, onChanged, openDeal }: { leads: any[]; onChanged: () => void; openDeal: (id: string) => void }) {
  const can = useCan()("crm.write");
  const me = useMe();
  const toast = useToast();
  const [expand, setExpand] = useState<string | null>(null);
  const [notes, setNotes] = useState<{ id: string; text: string } | null>(null);
  const [conv, setConv] = useState<{ id: string; amount: string; seats: string } | null>(null);
  const setStatus = async (id: string, status: string) => {
    try {
      await mcPatch(`/crm/leads/${id}`, { status });
      toast(`Status set to ${status}`);
      onChanged();
    } catch (e: any) {
      toast(e?.response?.data?.detail || "That didn't work.", true);
    }
  };
  if (!leads.length) return <Card><Empty>No demo requests yet. They arrive here from the Enterprise "Talk to us" form.</Empty></Card>;
  return (
    <Card pad={false} style={{ padding: "16px 8px 8px" }}>
      <span className="mc-tip" style={{ padding: "0 12px" }}>{leads.length} demo request(s) · {leads.filter((l) => l.status === "new").length} new · click a score to see why</span>
      <div className="mc-tablewrap">
        <table className="mc-table" style={{ minWidth: 1080 }}>
          <thead><tr><th>RECEIVED</th><th>PERSON</th><th>COMPANY</th><th>TEAM</th><th>THEIR QUESTION</th><th>SCORE</th><th>STATUS</th><th>OWNER</th><th></th></tr></thead>
          <tbody>
            {leads.map((l) => (
              <Fragment key={l.id}>
                <tr>
                  <td className="mc-mono" style={{ fontSize: 12, color: "var(--ink3)", whiteSpace: "nowrap" }}>{ago(l.created_at)}</td>
                  <td><div style={{ display: "flex", flexDirection: "column", gap: 2 }}><b>{l.name || "—"}</b><span className="mc-tip">{l.email}</span></div></td>
                  <td>{l.company || "—"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{l.team_size || "—"}</td>
                  <td style={{ maxWidth: 260, color: "#D5DEDB", lineHeight: 1.45 }}>{l.question || "—"}</td>
                  <td>
                    <button type="button" className="mc-rowbtn" title={l.why.join("\n")} aria-expanded={expand === l.id} onClick={() => setExpand(expand === l.id ? null : l.id)}>
                      <Pill tone={scoreTone(l.score)}>{l.score}</Pill>
                    </button>
                  </td>
                  <td>
                    <select className="mc-select" style={{ height: 32 }} aria-label="Lead status" value={l.status} disabled={!can} title={can ? undefined : NO}
                      onChange={(e) => setStatus(l.id, e.target.value)}>
                      {LEAD_STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {l.owner_email ? who(l.owner_email) : (
                      <ActionButton className="mc-btn sm" disabled={!can || !me} title={can ? undefined : NO} done="Assigned to you"
                        run={() => mcPatch(`/crm/leads/${l.id}`, { owner_email: me!.email }).then(onChanged)}>Assign to me</ActionButton>
                    )}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button type="button" className="mc-btn sm" disabled={!can} title={can ? (l.notes || "Add notes") : NO} onClick={() => setNotes({ id: l.id, text: l.notes || "" })}>Notes{l.notes ? " •" : ""}</button>
                      {l.deal_id
                        ? <button type="button" className="mc-btn sm" onClick={() => openDeal(l.deal_id)}>Open deal</button>
                        : <button type="button" className="mc-btn sm p" disabled={!can} title={can ? undefined : NO} onClick={() => setConv({ id: l.id, amount: "", seats: "" })}>Convert to deal</button>}
                    </div>
                  </td>
                </tr>
                {expand === l.id && (
                  <tr>
                    <td colSpan={9} style={{ background: "var(--s2)" }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                        <span className="mc-lbl">WHY {l.score}</span>
                        {l.why.map((w: string) => <Pill key={w} tone={w.startsWith("−") ? "r" : w.startsWith("+") ? "g" : undefined}>{w}</Pill>)}
                        {l.notes && <span className="mc-tip" style={{ flexBasis: "100%" }}>Notes: {l.notes}</span>}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={!!notes} onClose={() => setNotes(null)} title="Lead notes">
        <textarea className="mc-textarea" rows={5} aria-label="Notes" value={notes?.text || ""} onChange={(e) => setNotes(notes && { ...notes, text: e.target.value })} />
        <ActionButton className="mc-btn p" done="Notes saved" run={async () => {
          await mcPatch(`/crm/leads/${notes!.id}`, { notes: notes!.text });
          setNotes(null);
          onChanged();
        }}>Save notes</ActionButton>
        <span className="mc-tip">Notes are also added to the lead's activity history.</span>
      </Modal>

      <Modal open={!!conv} onClose={() => setConv(null)} title="Convert to deal">
        <span className="mc-tip">Creates a deal in Qualified with the next step "Book the demo", and marks the lead qualified.</span>
        <div className="mc-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="mc-field">Amount (USD / year)<input className="mc-input" type="number" min={0} value={conv?.amount || ""} onChange={(e) => setConv(conv && { ...conv, amount: e.target.value })} /></label>
          <label className="mc-field">Seats<input className="mc-input" type="number" min={0} value={conv?.seats || ""} onChange={(e) => setConv(conv && { ...conv, seats: e.target.value })} /></label>
        </div>
        <ActionButton className="mc-btn p" done="Deal created" run={async () => {
          const r = await mcPost(`/crm/leads/${conv!.id}/convert`, { amount: conv!.amount === "" ? null : Number(conv!.amount), seats: conv!.seats === "" ? null : Number(conv!.seats) });
          setConv(null);
          onChanged();
          openDeal(r.deal_id);
        }}>Create deal</ActionButton>
      </Modal>
    </Card>
  );
}

/* ------------------------------------------------------------ screen */
export default function Crm() {
  const [params, setParams] = useSearchParams();
  const v = params.get("view");
  const view: View = v === "leads" || v === "pql" ? v : "pipeline";
  const setView = (x: View) => { const p = new URLSearchParams(params); if (x === "pipeline") p.delete("view"); else p.set("view", x); setParams(p, { replace: true }); };
  const { data, error, loading, reload } = useMC<any>("/crm");
  const can = useCan()("crm.write");
  const [deal, setDeal] = useState<string | null>(null);
  const [draft, setDraft] = useState<DealDraft | null>(null);

  const stages: Record<string, string> = Object.fromEntries((data?.stages || []).map((s: any) => [s.key, s.label]));
  const st = data?.stats;
  const repMax = Math.max(1, ...(data?.reps || []).map((r: any) => r.best + r.commit));

  return (
    <div className="mc-page">
      <PageHead eyebrow="Growth · CRM" title="Pipeline & leads" sub="One funnel, two doors: Enterprise demo requests and product-qualified sign-ups.">
        <Seg label="View" value={view} onChange={setView} options={[["pipeline", "Pipeline"], ["leads", `Leads${st?.leads_new ? ` · ${st.leads_new}` : ""}`], ["pql", "Product-qualified"]]} />
        <button type="button" className="mc-btn" onClick={reload}>Refresh</button>
        <button type="button" className="mc-btn p" disabled={!can} title={can ? undefined : NO} onClick={() => setDraft({ ...EMPTY_DEAL })}>New deal</button>
      </PageHead>

      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Loading rows={6} />}
      {data && (
        <>
          <section aria-label="Pipeline metrics" className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))" }}>
            <Kpi label="WEIGHTED PIPELINE" value={k$(st.weighted)} sub={`${st.open_deals} open deal(s)`} />
            <Kpi label="WON" value={k$(st.won_total)} sub={`${st.won_count} deal(s) all time`} tone={st.won_count ? "good" : undefined} />
            <Kpi label="WIN RATE · 90D" value={fmtPct(st.win_rate_90d, 0)} sub="won ÷ closed" />
            <Kpi label="SPEED TO LEAD" value={st.speed_to_lead_hours == null ? "—" : `${fmtN(st.speed_to_lead_hours, 1)}h`} sub="median to first touch" tone={st.speed_to_lead_hours > 24 ? "warn" : undefined} />
            <Kpi label="SALES CYCLE" value={st.sales_cycle_days == null ? "—" : `${st.sales_cycle_days}d`} sub="median, created → won" />
            <Kpi label="NEW LEADS · 7D" value={fmtN(st.new_leads_7d)} sub={`${st.leads_new} still untouched`} tone={st.leads_new ? "warn" : undefined} />
          </section>

          {view === "pipeline" && (
            <>
              <div style={{ overflowX: "auto", paddingBottom: 6 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(190px, 1fr))", gap: 10, minWidth: 1180 }}>
                  {data.columns.map((c: any) => (
                    <section key={c.key} className="mc-card" aria-label={c.label} style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, background: "#0A0D0E", minHeight: 160 }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "2px 2px 6px", borderBottom: `2px solid ${STAGE_COLOR[c.key]}` }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontWeight: 700, fontSize: 13.5 }}>{c.label}</span>
                          <span className="mc-mono mc-num" style={{ fontSize: 11.5, color: "var(--ink2)" }}>{c.count}</span>
                        </div>
                        <span className="mc-mono mc-num" style={{ fontSize: 11.5, color: "var(--ink3)" }}>
                          {c.key === "lost" ? k$(c.total) : c.key === "won" ? `${k$(c.total)} closed` : `${k$(c.total)} × ${Math.round(c.probability * 100)}% = ${k$(c.weighted)}`}
                        </span>
                      </div>
                      {c.deals.length === 0 && <span className="mc-tip" style={{ padding: "0 2px" }}>No deals here.</span>}
                      {c.deals.map((d: any) => (
                        <button key={d.id} type="button" onClick={() => setDeal(d.id)}
                          style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", display: "flex", flexDirection: "column", gap: 6, padding: 12, borderRadius: 12, border: `1px solid ${deal === d.id ? "var(--g)" : "var(--line)"}`, background: "var(--s2)", width: "100%" }}>
                          <span style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.35 }}>{d.name}</span>
                          <span style={{ fontSize: 12, color: "var(--ink2)", lineHeight: 1.4 }}>
                            {[d.seats ? `${d.seats} seats` : null, d.next_step, d.stage === "lost" ? d.lost_reason : null].filter(Boolean).join(" · ") || d.company || "—"}
                          </span>
                          <span style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: 11.5 }}>
                            <span className="mc-mono mc-num">{d.amount == null ? "—" : fmtUSD(d.amount)}</span>
                            <span style={{ color: "var(--ink3)" }}>{who(d.owner_email)}</span>
                          </span>
                        </button>
                      ))}
                    </section>
                  ))}
                </div>
              </div>

              <Card title="FORECAST BY REP · OPEN PIPELINE">
                {data.reps.length === 0 ? <Empty>No deals yet. Add one with New deal or convert a demo request.</Empty> : data.reps.map((r: any) => (
                  <div key={r.owner} style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center" }}>
                    <span style={{ width: 150, fontWeight: 700, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis" }} title={r.owner}>{who(r.owner === "Unassigned" ? null : r.owner)}</span>
                    <div style={{ flex: "1 1 300px", position: "relative", height: 22, borderRadius: 6, background: "var(--line0)" }} title={`commit ${fmtUSD(r.commit)} · best case ${fmtUSD(r.best)}`}>
                      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 6, width: `${(r.best / repMax) * 100}%`, background: "rgba(67,229,160,.25)" }} />
                      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 6, width: `${(r.commit / repMax) * 100}%`, background: "var(--g)" }} />
                    </div>
                    <span className="mc-mono mc-num" style={{ fontSize: 12.5, color: "var(--ink2)" }}>commit {k$(r.commit)} · best case {k$(r.best)} · won {k$(r.won)}</span>
                  </div>
                ))}
                <span className="mc-tip"><b style={{ color: "var(--g)" }}>Solid</b> commit = deals in Proposal · <b style={{ color: "#8FD9B8" }}>light</b> best case = Qualified + Demo + Proposal.</span>
              </Card>
            </>
          )}

          {view === "leads" && <Leads leads={data.leads} onChanged={reload} openDeal={setDeal} />}

          {view === "pql" && (
            <Card title="PRODUCT-QUALIFIED · EARLY-ACCESS WORKSPACES WHOSE USAGE FITS A PAID PLAN">
              {data.pql.length === 0 ? <Empty>No workspace has crossed a team-plan threshold yet.</Empty> : (
                <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))" }}>
                  {data.pql.map((p: any) => (
                    <div key={p.workspace_id} className="mc-card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8, background: "var(--s2)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
                        <span style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.35 }}>{p.name}</span>
                        <Pill tone={p.fit === "Enterprise" ? "w" : p.fit === "Business" ? "g" : "b"}>fits {p.fit}</Pill>
                      </div>
                      <span className="mc-tip">{p.owner_email}{p.domain ? ` · ${p.domain}` : ""}</span>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{p.reasons.map((r: string) => <Pill key={r}>{r}</Pill>)}</div>
                      <span className="mc-mono mc-num" style={{ fontSize: 12, color: "var(--ink2)" }}>{p.members} member(s) · {fmtN(p.chats_30d)} questions 30d</span>
                      <button type="button" className="mc-btn sm" style={{ alignSelf: "flex-start" }} disabled={!can} title={can ? undefined : NO}
                        onClick={() => setDraft({ ...EMPTY_DEAL, name: `${p.domain || p.name} — ${p.fit}`, company: p.domain || "", contact_email: masked(p.owner_email) ? "" : p.owner_email,
                          stage: "qualified", seats: String(p.members), next_step: "Reach out about a paid plan", source: "pql" })}>Create deal</button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}
        </>
      )}

      <Drawer open={!!deal} onClose={() => setDeal(null)} label="Deal">
        {deal && <DealPanel key={deal} id={deal} stages={stages} onChanged={reload} />}
      </Drawer>
      {draft && <NewDeal open initial={draft} onClose={() => setDraft(null)} onCreated={(id) => { setDraft(null); reload(); setDeal(id); }} />}
    </div>
  );
}

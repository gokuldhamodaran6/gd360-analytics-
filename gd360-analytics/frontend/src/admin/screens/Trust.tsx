// Mission Control · Security & privacy — sign-in posture, customer roles,
// risks, abuse signals and privacy requests on their 30-day clock.
import { useState } from "react";
import { mcDownload, mcPatch, mcPost, useMC } from "../api";
import {
  ActionButton, Card, dateShort, dateTime, Empty, ErrorBox, fmtN, HBars, Kpi, Loading, Modal, PageHead, Pill, useCan,
} from "../ui";

const NO = "Your role can't do this";
const KIND: Record<string, string> = { export: "Export my data", delete: "Delete my data", correct: "Correct my data" };
const STATUS_TONE: Record<string, "g" | "b" | "a" | "r" | undefined> = { received: "a", in_review: "b", completed: "g", rejected: "r" };

export default function Trust() {
  const { data, error, loading, reload } = useMC<any>("/trust");
  const can = useCan();
  const canWrite = can("privacy.write"), canExec = can("privacy.execute"), canUnlock = can("users.unlock");
  const [logOpen, setLogOpen] = useState(false);
  const [form, setForm] = useState({ email: "", kind: "export", notes: "" });
  const [close, setClose] = useState<{ id: string; email: string; status: "completed" | "rejected"; note: string } | null>(null);

  const p = data?.posture;

  return (
    <div className="mc-page">
      <PageHead eyebrow="Trust · customers" title="Security & privacy"
        sub="Who can do what inside customer workspaces, how they sign in, and every privacy request on its 30-day legal clock.">
        <button type="button" className="mc-btn" onClick={reload}>Refresh</button>
        <button type="button" className="mc-btn p" disabled={!canWrite} title={canWrite ? undefined : NO}
          onClick={() => { setForm({ email: "", kind: "export", notes: "" }); setLogOpen(true); }}>Log privacy request</button>
      </PageHead>

      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Loading rows={6} />}
      {data && (
        <>
          <section aria-label="Security posture" className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))" }}>
            <Kpi label="LOCKED OUT NOW" value={fmtN(p.locked)} sub="too many wrong passwords" tone={p.locked ? "warn" : undefined} />
            <Kpi label="SUSPENDED" value={fmtN(p.suspended)} sub="accounts turned off by staff" />
            <Kpi label="FAILED SIGN-INS" value={fmtN(p.failed_logins_pending)} sub="not yet cleared by a good sign-in" tone={p.failed_logins_pending > 20 ? "warn" : undefined} />
            <Kpi label="SIGN-INS · 24H" value={fmtN(p.logins_24h)} sub="successful" />
            <Kpi label="PUBLIC DASHBOARDS" value={fmtN(p.public_dashboards)} sub="anyone with the link can view" tone={p.public_dashboards ? "warn" : undefined} />
            <Kpi label="STAFF WITH ACCESS" value={fmtN(p.staff)} sub="invited to Mission Control" to="/admin/access" />
          </section>

          <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))" }}>
            <Card title="CUSTOMER ROLES · ALL WORKSPACES">
              {data.roles.length === 0 ? <Empty>No workspace members yet.</Empty>
                : <HBars items={data.roles.map((r: any) => ({ k: r.role, v: r.n }))} />}
            </Card>
            <Card title="RISKS TO REVIEW">
              {data.risks.map((r: any) => (
                <div key={r.k} style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", fontSize: 13.5, paddingBottom: 10, borderBottom: "1px solid var(--line0)" }}>
                  <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <span className="mc-dot" style={{ marginTop: 0, background: r.n ? "var(--amber)" : "var(--g)" }} />{r.k}
                  </span>
                  <span className="mc-mono mc-num" style={{ fontWeight: 700, color: r.n ? "var(--amber)" : "var(--ink3)" }}>{fmtN(r.n)}</span>
                </div>
              ))}
            </Card>
          </div>

          <Card title="PRIVACY REQUESTS · GDPR / CCPA · 30-DAY CLOCK" right={<span className="mc-tip">Completed and rejected requests are kept with who handled them.</span>}>
            {data.privacy.length === 0 ? <Empty>No privacy requests yet. Log one when someone asks to export, delete or correct their data.</Empty> : (
              <div className="mc-tablewrap">
                <table className="mc-table" style={{ minWidth: 940 }}>
                  <thead><tr><th>PERSON</th><th>TYPE</th><th>RECEIVED</th><th>DUE</th><th>STATUS</th><th>HANDLED BY</th><th></th></tr></thead>
                  <tbody>
                    {data.privacy.map((r: any) => {
                      const done = r.status === "completed" || r.status === "rejected";
                      return (
                        <tr key={r.id}>
                          <td style={{ maxWidth: 280 }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                              <b>{r.email}</b>
                              {!r.user_found && <span className="mc-tip">No GD360 account with this email</span>}
                              {r.notes && <span className="mc-tip" style={{ whiteSpace: "pre-wrap" }}>{r.notes}</span>}
                            </div>
                          </td>
                          <td><Pill>{KIND[r.kind] || r.kind}</Pill></td>
                          <td className="mc-mono" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{dateShort(r.received_at)}</td>
                          <td className="mc-mono mc-num" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                            {dateShort(r.due_at)}
                            {r.days_left != null && (
                              <span style={{ color: r.days_left < 7 ? "var(--red)" : "var(--ink3)", fontWeight: r.days_left < 7 ? 700 : 400 }}>
                                {" "}· {r.days_left < 0 ? `${-r.days_left}d late` : `${r.days_left}d left`}
                              </span>
                            )}
                          </td>
                          <td><Pill tone={STATUS_TONE[r.status]}>{r.status.replace("_", " ")}</Pill>{r.completed_at && <span className="mc-tip"> {dateShort(r.completed_at)}</span>}</td>
                          <td style={{ color: "var(--ink2)" }}>{r.handled_by ? r.handled_by.split("@")[0] : "—"}</td>
                          <td>
                            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                              {r.status === "received" && (
                                <ActionButton className="mc-btn sm" disabled={!canWrite} title={canWrite ? undefined : NO} done="Review started"
                                  run={() => mcPatch(`/privacy-requests/${r.id}`, { status: "in_review" }).then(reload)}>Start review</ActionButton>
                              )}
                              {r.kind === "export" && r.user_found && (
                                <ActionButton className="mc-btn sm" disabled={!canExec} title={canExec ? "Everything GD360 holds about them, as JSON" : NO} done="Export downloaded"
                                  run={() => mcDownload(`/privacy-requests/${r.id}/export`, "gd360-data-export.json")}>Download data</ActionButton>
                              )}
                              {!done && (
                                <>
                                  <button type="button" className="mc-btn sm p" disabled={!canExec} title={canExec ? undefined : NO}
                                    onClick={() => setClose({ id: r.id, email: r.email, status: "completed", note: "" })}>Mark completed</button>
                                  <button type="button" className="mc-btn sm d" disabled={!canExec} title={canExec ? undefined : NO}
                                    onClick={() => setClose({ id: r.id, email: r.email, status: "rejected", note: "" })}>Reject</button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))" }}>
            <Card title="ABUSE & FRAUD">
              {data.abuse.map((a: any) => (
                <div key={a.key} style={{ display: "flex", flexDirection: "column", gap: 6, paddingBottom: 12, borderBottom: "1px solid var(--line0)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13.5 }}>
                    <span>{a.k}</span>
                    <span className="mc-mono mc-num" style={{ fontWeight: 700, color: a.n ? "var(--red)" : "var(--ink3)" }}>{fmtN(a.n)}</span>
                  </div>
                  {a.sample.map((s: string) => <span key={s} className="mc-mono" style={{ fontSize: 12, color: "var(--ink2)", paddingLeft: 10 }}>{s}</span>)}
                  {a.n > a.sample.length && <span className="mc-tip" style={{ paddingLeft: 10 }}>+ {a.n - a.sample.length} more</span>}
                </div>
              ))}
            </Card>
            <Card title={`LOCKED OUT · ${data.locked_people.length}`}>
              {data.locked_people.length === 0 ? <Empty>Nobody is locked out right now.</Empty> : data.locked_people.map((u: any) => (
                <div key={u.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", paddingBottom: 10, borderBottom: "1px solid var(--line0)" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <span style={{ fontWeight: 600, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis" }}>{u.email}</span>
                    <span className="mc-tip">Locked until {dateTime(u.until)} — or unlock now</span>
                  </div>
                  <ActionButton className="mc-btn sm" disabled={!canUnlock} title={canUnlock ? "Clears the lock and the failed sign-in count" : NO} done="Unlocked"
                    run={() => mcPost(`/people/${u.id}/unlock`).then(reload)}>Unlock</ActionButton>
                </div>
              ))}
            </Card>
          </div>
        </>
      )}

      <Modal open={logOpen} onClose={() => setLogOpen(false)} title="Log privacy request">
        <label className="mc-field">Their email<input className="mc-input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@company.com" /></label>
        <label className="mc-field">They asked to
          <select className="mc-select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="mc-field">Notes (optional)<textarea className="mc-textarea" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="How it came in, identity check done, etc." /></label>
        <ActionButton className="mc-btn p" disabled={!form.email.includes("@")} done="Request logged · due in 30 days" run={async () => {
          await mcPost("/privacy-requests", { email: form.email.trim(), kind: form.kind, notes: form.notes.trim() || null });
          setLogOpen(false);
          reload();
        }}>Log request</ActionButton>
        <span className="mc-tip">The 30-day clock starts today. We match the email to a GD360 account automatically.</span>
      </Modal>

      <Modal open={!!close} onClose={() => setClose(null)} title={close?.status === "rejected" ? "Reject request" : "Mark request completed"}>
        <span className="mc-tip">{close?.email}</span>
        <label className="mc-field">{close?.status === "rejected" ? "Why are you rejecting it?" : "What was done?"}
          <textarea className="mc-textarea" rows={3} value={close?.note || ""} onChange={(e) => setClose(close && { ...close, note: e.target.value })}
            placeholder={close?.status === "rejected" ? "Couldn't verify identity after two attempts." : "Export sent to the verified address."} />
        </label>
        <ActionButton className={close?.status === "rejected" ? "mc-btn d" : "mc-btn p"} disabled={!close?.note.trim()}
          done={close?.status === "rejected" ? "Request rejected" : "Request completed"} run={async () => {
            await mcPatch(`/privacy-requests/${close!.id}`, { status: close!.status, notes: close!.note.trim() });
            setClose(null);
            reload();
          }}>{close?.status === "rejected" ? "Reject" : "Mark completed"}</ActionButton>
        <span className="mc-tip">The note is kept on the request with your name and the date.</span>
      </Modal>
    </div>
  );
}

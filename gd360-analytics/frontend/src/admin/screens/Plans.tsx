// Mission Control · Plans & entitlements — the matrix enforcement will read,
// per-workspace overrides, and the internal plan catalog.
import { useEffect, useRef, useState } from "react";
import { errText, mcGet, mcPost, mcPut, useMC } from "../api";
import {
  ActionButton, ago, Card, dateShort, Empty, ErrorBox, fmtN, fmtUSD, Loading, Modal, PageHead, Pill, Seg, useCan, useMe, useToast,
} from "../ui";

const NO = "Your role can't do this";
const PLAN_INK: Record<string, string> = { "Early access": "#BDF3DA", Plus: "#F2B84B", Team: "#7AA7FF", Business: "#43E5A0", Enterprise: "#E8EEEC" };
const PAID = ["Plus", "Team", "Business", "Enterprise"];
const IMPACT_KEYS = ["chats.per_user_month", "sources.max", "automations.max", "ml.models", "seats.min_max"];
const STATUS_TONE: Record<string, "g" | "a" | "r" | undefined> = { active: "g", pending: "a", revoked: "r" };

function priceLine(c: any) {
  if (!c) return "—";
  if (c.monthly == null) return "custom";
  if (c.monthly === 0) return "free";
  return `${fmtUSD(c.monthly)} / person / mo`;
}

/* ------------------------------------------------------------ matrix cell */
function Cell({ value, was, changed, plan, label, canEdit, onSave }: { value: string; was?: string; changed: boolean; plan: string; label: string; canEdit: boolean; onSave: (v: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  const busy = useRef(false);
  const toast = useToast();
  useEffect(() => setV(value), [value]);
  const cancel = () => { setEditing(false); setV(value); };
  const save = async () => {
    const nv = v.trim();
    if (!nv || nv === value) return cancel();
    busy.current = true;
    try {
      await onSave(nv);
      toast(`${plan} · ${label} set to ${nv}`);
      setEditing(false);
    } catch (e) {
      toast(errText(e, "Couldn't save that cell."), true);
    } finally {
      busy.current = false;
    }
  };
  const tdStyle = { background: changed ? "rgba(242,184,75,.09)" : undefined, color: value === "—" ? "var(--ink4)" : changed ? "var(--amber)" : "var(--ink)", fontWeight: changed ? 700 : 400 };
  const tip = changed ? `Changed${was ? ` · default ${was}` : ""}` : undefined;
  if (editing) {
    return (
      <td style={tdStyle}>
        <input autoFocus className="mc-input mc-mono" style={{ height: 30, width: "100%", minWidth: 90, fontSize: 12.5 }} value={v} maxLength={60}
          aria-label={`${label} for ${plan}`} onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") cancel(); }}
          onBlur={() => { if (!busy.current) cancel(); }} />
      </td>
    );
  }
  return (
    <td className="mc-num" style={tdStyle} title={tip}>
      {canEdit ? (
        <button type="button" className="mc-rowbtn" onClick={() => setEditing(true)} aria-label={`Edit ${label} for ${plan}, now ${value}`} title={tip || "Click to edit · Enter saves · Esc cancels"}>{value}</button>
      ) : value}
    </td>
  );
}

/* ------------------------------------------------------------ impact preview */
function Impact({ matrix }: { matrix: any[] }) {
  const [key, setKey] = useState(IMPACT_KEYS[0]);
  const [plan, setPlan] = useState("Team");
  const row = matrix.find((r) => r.key === key);
  const live = row ? row.values[1 + PAID.indexOf(plan)] : "";
  const [value, setValue] = useState(live);
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState("");
  useEffect(() => setValue(live), [key, plan, live]);
  useEffect(() => {
    if (!value.trim()) { setRes(null); return; }
    let alive = true;
    const id = setTimeout(() => {
      setErr("");
      mcGet(`/plans/impact?key=${encodeURIComponent(key)}&plan=${encodeURIComponent(plan)}&value=${encodeURIComponent(value)}`)
        .then((r) => alive && setRes(r)).catch((e) => alive && setErr(errText(e, "Couldn't check impact.")));
    }, 300);
    return () => { alive = false; clearTimeout(id); };
  }, [key, plan, value]);
  const hot = res?.supported && res.limit != null && res.over > 0;
  return (
    <Card title={<span className="mc-lbl" style={{ color: hot ? "var(--amber)" : "var(--g)" }}>IMPACT PREVIEW · TRY A LIMIT BEFORE YOU SAVE IT</span>}
      style={{ borderColor: hot ? "rgba(242,184,75,.4)" : "var(--g-bd)" }}>
      <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
        <label className="mc-field">Entitlement
          <select className="mc-select" value={key} onChange={(e) => setKey(e.target.value)}>
            {IMPACT_KEYS.map((k) => <option key={k} value={k}>{matrix.find((r) => r.key === k)?.label || k}</option>)}
          </select>
        </label>
        <label className="mc-field">Plan
          <select className="mc-select" value={plan} onChange={(e) => setPlan(e.target.value)}>
            {PAID.map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
        <label className="mc-field">Limit to test
          <input className="mc-input mc-mono" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 300" />
        </label>
      </div>
      {err && <ErrorBox text={err} />}
      {res && !res.supported && <span className="mc-tip">We can't measure this entitlement yet.</span>}
      {res?.supported && res.limit == null && <span className="mc-tip">Enter a number to see who would go over. ∞, “unlimited” and “custom” mean no limit.</span>}
      {res?.supported && res.limit != null && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 15, lineHeight: 1.5 }}>
            {res.total === 0 ? <>No active workspaces fit <b>{plan}</b> today, so nobody would be over.</> : (
              <><b className="mc-num" style={{ color: hot ? "var(--amber)" : "var(--g)" }}>{res.over} of {res.total}</b> workspaces that fit {plan} would be over this limit ({fmtN(res.limit)}).</>
            )}
          </span>
          {res.names.length > 0 && <span className="mc-tip">Over: {res.names.join(" · ")}</span>}
          <span className="mc-tip">Live {plan} value: <span className="mc-mono">{live || "—"}</span>. This only previews — edit the cell in the matrix to change it.</span>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ new override */
function NewOverride({ matrix, open, onClose, onSaved }: { matrix: any[]; open: boolean; onClose: () => void; onSaved: () => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<any[]>([]);
  const [ws, setWs] = useState<any>(null);
  const [key, setKey] = useState(matrix[0]?.key || "");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [days, setDays] = useState(30);
  const [err, setErr] = useState("");
  const toast = useToast();
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const id = setTimeout(() => {
      mcGet(`/workspaces/search?q=${encodeURIComponent(q.trim())}`).then((r) => alive && setHits(r.items)).catch((e) => alive && setErr(errText(e)));
    }, 250);
    return () => { alive = false; clearTimeout(id); };
  }, [q, open]);
  useEffect(() => {
    if (open) { setWs(null); setQ(""); setValue(""); setReason(""); setDays(30); setErr(""); }
  }, [open]);
  const ok = ws && key && value.trim() && reason.trim().length >= 3 && days >= 1 && days <= 365;
  return (
    <Modal open={open} onClose={onClose} title="New override">
      <span className="mc-tip">A per-workspace exception. Needs a reason and an expiry. Finance or an Owner approves it unless you can approve.</span>
      {ws ? (
        <div className="mc-note" style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
          <span><b style={{ color: "var(--ink)" }}>{ws.name}</b> · {ws.owner_email || "no owner"}</span>
          <button type="button" className="mc-btn sm" onClick={() => setWs(null)}>Change</button>
        </div>
      ) : (
        <div className="mc-field">
          <label htmlFor="ov-q">Workspace</label>
          <input id="ov-q" className="mc-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by workspace name or owner email" autoFocus />
          <div style={{ display: "flex", flexDirection: "column", maxHeight: 190, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 10 }}>
            {hits.length === 0 && <span className="mc-tip" style={{ padding: 10 }}>No workspaces match.</span>}
            {hits.map((h) => (
              <button key={h.id} type="button" className="mc-rowbtn" onClick={() => setWs(h)} style={{ padding: "8px 10px", borderBottom: "1px solid var(--line0)" }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{h.name}{h.personal ? " · personal" : ""}</span>
                <span className="mc-mono" style={{ fontSize: 11.5, color: "var(--ink3)" }}>{h.owner_email || h.id}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="mc-grid" style={{ gridTemplateColumns: "2fr 1fr" }}>
        <label className="mc-field">Entitlement
          <select className="mc-select" value={key} onChange={(e) => setKey(e.target.value)}>
            {matrix.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </label>
        <label className="mc-field">New value
          <input className="mc-input mc-mono" value={value} maxLength={60} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 50" />
        </label>
      </div>
      <label className="mc-field">Reason
        <textarea className="mc-textarea" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this workspace needs it" />
      </label>
      <label className="mc-field">Expires after (days)
        <input className="mc-input" type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} />
      </label>
      {err && <ErrorBox text={err} />}
      <ActionButton className="mc-btn p" disabled={!ok} run={async () => {
        const r = await mcPost("/plans/overrides", { workspace_id: ws.id, key, value: value.trim(), reason: reason.trim(), days });
        toast(r.status === "active" ? "Override is active" : "Override sent for approval");
        onClose();
        onSaved();
      }}>Create override</ActionButton>
    </Modal>
  );
}

/* ------------------------------------------------------------ catalog card */
function PlanCard({ plan, c, fits, canEdit, onSaved }: { plan: string; c: any; fits: number; canEdit: boolean; onSaved: () => void }) {
  const [m, setM] = useState(c.monthly ?? "");
  const [a, setA] = useState(c.annual ?? "");
  const [s, setS] = useState(c.min_seats ?? 1);
  useEffect(() => { setM(c.monthly ?? ""); setA(c.annual ?? ""); setS(c.min_seats ?? 1); }, [c]);
  const free = plan === "Early access";
  const dirty = String(m) !== String(c.monthly ?? "") || String(a) !== String(c.annual ?? "") || String(s) !== String(c.min_seats ?? 1);
  const num = (v: any) => (v === "" || v == null ? null : Number(v));
  return (
    <div className="mc-card mc-pad" style={{ display: "flex", flexDirection: "column", gap: 10, borderColor: free ? "var(--g-bd)" : undefined }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 18, fontWeight: 800, color: PLAN_INK[plan] }}>{plan}</span>
        <Pill tone={free ? "g" : undefined}>{c.visibility}</Pill>
      </div>
      <span className="mc-num" style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em" }}>
        {c.monthly == null ? "Custom" : c.monthly === 0 ? "$0" : fmtUSD(c.monthly)}
        {c.monthly ? <span style={{ fontSize: 13, color: "var(--ink3)", fontWeight: 600 }}> / person / mo</span> : null}
      </span>
      <span className="mc-sub">
        {free ? "Everyone is here while billing isn't live." : c.monthly == null ? `Order form. Forecasts assume ${fmtUSD(c.assumed_mrr || 0)} a month per account.` : `Annual ${fmtUSD(c.annual)} per person. Min ${c.min_seats} seat${c.min_seats === 1 ? "" : "s"}.`}
      </span>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, borderTop: "1px solid var(--line0)", paddingTop: 10 }}>
        <span style={{ color: "var(--ink3)" }}>{free ? "Active workspaces" : "Active workspaces that fit"}</span>
        <span className="mc-mono mc-num">{fmtN(fits)}</span>
      </div>
      {!free && (
        <div className="mc-grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <label className="mc-field" style={{ fontSize: 11.5 }}>Monthly $
            <input className="mc-input mc-mono" type="number" min={0} value={m} placeholder="custom" disabled={!canEdit} title={canEdit ? undefined : NO} onChange={(e) => setM(e.target.value)} style={{ height: 32 }} />
          </label>
          <label className="mc-field" style={{ fontSize: 11.5 }}>Annual $
            <input className="mc-input mc-mono" type="number" min={0} value={a} placeholder="custom" disabled={!canEdit} title={canEdit ? undefined : NO} onChange={(e) => setA(e.target.value)} style={{ height: 32 }} />
          </label>
          <label className="mc-field" style={{ fontSize: 11.5 }}>Min seats
            <input className="mc-input mc-mono" type="number" min={1} value={s} disabled={!canEdit} title={canEdit ? undefined : NO} onChange={(e) => setS(e.target.value)} style={{ height: 32 }} />
          </label>
        </div>
      )}
      {!free && (
        <ActionButton className="mc-btn sm" disabled={!canEdit || !dirty} title={canEdit ? undefined : NO} done={`${plan} saved`}
          run={async () => { await mcPut("/plans/catalog", { plan, monthly: num(m), annual: num(a), min_seats: num(s) }); onSaved(); }}>
          Save {plan}
        </ActionButton>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ page */
export default function Plans() {
  const [tab, setTab] = useState<"matrix" | "overrides" | "catalog">("matrix");
  const [newOv, setNewOv] = useState(false);
  const { data, error, loading, reload } = useMC<any>("/plans");
  const can = useCan();
  const me = useMe();
  const canPlans = can("plans.write");
  const pending = data ? data.overrides.filter((o: any) => o.status === "pending").length : 0;
  const keyLabel = (k: string) => data?.matrix.find((r: any) => r.key === k)?.label || k;
  const activeWs = data ? Object.values(data.fits as Record<string, number>).reduce((s, n) => s + n, 0) : 0;

  return (
    <div className="mc-page">
      <PageHead eyebrow="Revenue · plans" title="Plans & entitlements" sub="One source of truth for what each plan can do. Prices and limits live here, inside Mission Control only.">
        <Seg<"matrix" | "overrides" | "catalog"> label="Section" value={tab} onChange={setTab}
          options={[["matrix", "Entitlement matrix"], ["overrides", `Overrides${pending ? ` · ${pending} pending` : ""}`], ["catalog", "Plan catalog"]]} />
        <button type="button" className="mc-btn" onClick={reload}>Refresh</button>
      </PageHead>

      <div className="mc-alert" style={{ borderColor: "#F2B84B55", background: "#F2B84B0D" }}>
        <span className="mc-dot" style={{ background: "#F2B84B" }} />
        <span style={{ fontSize: 13.5, lineHeight: 1.45 }}><b>Billing isn't live — this matrix is what enforcement will read.</b> Everyone is on free early access today; nothing here limits customers yet.</span>
      </div>

      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Loading rows={4} />}
      {data && tab === "matrix" && (
        <>
          <Impact matrix={data.matrix} />
          <Card pad={false} style={{ padding: "14px 6px 4px" }}>
            <div style={{ padding: "0 12px", display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <span className="mc-lbl">ENTITLEMENT MATRIX</span>
              <span className="mc-tip">{canPlans ? "Click a cell to edit · Enter saves · amber = changed from default" : "Read-only for your role · amber = changed from default"}</span>
            </div>
            <div className="mc-tablewrap">
              <table className="mc-table" style={{ minWidth: 1040 }}>
                <thead>
                  <tr>
                    <th style={{ width: 250 }}>ENTITLEMENT</th>
                    {data.plans.map((p: string) => (
                      <th key={p}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <span style={{ color: PLAN_INK[p], fontFamily: "Geist, sans-serif", fontSize: 13, letterSpacing: 0, fontWeight: 700 }}>{p}</span>
                          <span style={{ letterSpacing: 0 }}>{priceLine(data.catalog[p])}</span>
                        </div>
                      </th>
                    ))}
                    <th>ENFORCE</th>
                  </tr>
                </thead>
                <tbody>
                  {data.matrix.map((r: any) => (
                    <tr key={r.key}>
                      <td>
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <span style={{ fontWeight: 600 }}>{r.label}</span>
                          <span className="mc-mono" style={{ fontSize: 11, color: "var(--ink3)" }}>{r.key}</span>
                        </div>
                      </td>
                      {r.values.map((v: string, i: number) => (
                        <Cell key={i} value={v} was={r.defaults?.[i]} changed={r.changed.includes(i)} plan={data.plans[i]} label={r.label} canEdit={canPlans}
                          onSave={async (nv) => { await mcPut("/plans/cell", { key: r.key, plan: data.plans[i], value: nv }); reload(); }} />
                      ))}
                      <td>
                        <ActionButton className="mc-btn sm" disabled={!canPlans} title={canPlans ? `Switch to ${r.enforce === "hard" ? "soft" : "hard"}` : NO}
                          done={`${r.label}: ${r.enforce === "hard" ? "soft" : "hard"} limit`}
                          run={async () => { await mcPut("/plans/enforce", { key: r.key, enforce: r.enforce === "hard" ? "soft" : "hard" }); reload(); }}>
                          <span style={{ color: r.enforce === "hard" ? "var(--red)" : "var(--g)", fontWeight: 700, letterSpacing: ".04em" }}>{r.enforce.toUpperCase()}</span>
                        </ActionButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <span className="mc-tip">Soft = warn people and let them run a little over. Hard = block at the limit. ∞ means no limit.</span>
        </>
      )}

      {data && tab === "overrides" && (
        <Card title="OVERRIDES · PER-WORKSPACE EXCEPTIONS" right={
          <button type="button" className="mc-btn p sm" disabled={!can("overrides.request")} title={can("overrides.request") ? undefined : NO} onClick={() => setNewOv(true)}>New override</button>
        }>
          <span className="mc-tip">Every override has a reason, an approver and an expiry. You can't approve your own request.</span>
          {data.overrides.length === 0 ? <Empty>No overrides yet. Use “New override” to give one workspace more than its plan allows.</Empty> : (
            <div className="mc-tablewrap">
              <table className="mc-table" style={{ minWidth: 980 }}>
                <thead><tr><th>WORKSPACE</th><th>ENTITLEMENT</th><th>OVERRIDE</th><th>REASON</th><th>REQUESTED</th><th>EXPIRES</th><th>STATUS</th><th></th></tr></thead>
                <tbody>
                  {data.overrides.map((o: any) => {
                    const mine = o.requested_by === me?.email;
                    const canApprove = can("overrides.approve") && !mine;
                    const canRevoke = can("overrides.approve") || mine;
                    return (
                      <tr key={o.id}>
                        <td style={{ fontWeight: 700 }}>{o.workspace}</td>
                        <td><div style={{ display: "flex", flexDirection: "column", gap: 2 }}><span>{keyLabel(o.key)}</span><span className="mc-mono" style={{ fontSize: 11, color: "var(--ink3)" }}>{o.key}</span></div></td>
                        <td className="mc-mono mc-num" style={{ color: "var(--g)", fontWeight: 700 }}>{o.value}</td>
                        <td style={{ color: "#D5DEDB", maxWidth: 240, lineHeight: 1.45 }}>{o.reason}</td>
                        <td><div style={{ display: "flex", flexDirection: "column", gap: 2 }}><span style={{ fontSize: 12.5 }}>{o.requested_by}</span><span className="mc-tip">{ago(o.created_at)}{o.approved_by ? ` · approved by ${o.approved_by}` : ""}</span></div></td>
                        <td className="mc-mono" style={{ fontSize: 12 }}>{dateShort(o.expires_at)}</td>
                        <td><Pill tone={STATUS_TONE[o.status]}>{o.status}</Pill></td>
                        <td>
                          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                            {o.status === "pending" && (
                              <ActionButton className="mc-btn sm p" disabled={!canApprove} title={canApprove ? undefined : mine ? "Someone else has to approve your own request" : NO}
                                done="Override approved" run={async () => { await mcPost(`/plans/overrides/${o.id}/approve`); reload(); }}>Approve</ActionButton>
                            )}
                            {(o.status === "pending" || o.status === "active") && (
                              <ActionButton className="mc-btn sm d" disabled={!canRevoke} title={canRevoke ? undefined : NO} confirm="Revoke it?"
                                done="Override revoked" run={async () => { await mcPost(`/plans/overrides/${o.id}/revoke`); reload(); }}>Revoke</ActionButton>
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
          <NewOverride matrix={data.matrix} open={newOv} onClose={() => setNewOv(false)} onSaved={reload} />
        </Card>
      )}

      {data && tab === "catalog" && (
        <>
          <section aria-label="Plan catalog" className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
            {data.plans.map((p: string) => (
              <PlanCard key={p} plan={p} c={data.catalog[p] || {}} fits={p === "Early access" ? activeWs : data.fits[p] || 0} canEdit={canPlans} onSaved={reload} />
            ))}
          </section>
          <span className="mc-tip">“Fit” = the smallest paid plan whose limits cover a workspace's usage today. Only workspaces with questions or sources count.</span>
        </>
      )}

      {data && tab !== "overrides" && (
        <Card title="CHANGE HISTORY">
          {data.history.length === 0 ? <Empty>No plan changes yet. Edits to the matrix, prices and overrides show up here.</Empty> : data.history.map((h: any, i: number) => (
            <div key={i} style={{ display: "flex", gap: 10, fontSize: 13, lineHeight: 1.45 }}>
              <span className="mc-mono" style={{ fontSize: 11, color: "var(--ink3)", width: 64, flex: "none", paddingTop: 2 }}>{ago(h.t)}</span>
              <span style={{ color: "#D5DEDB" }}>{h.text} <span style={{ color: "var(--ink3)" }}>· {h.by}</span></span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

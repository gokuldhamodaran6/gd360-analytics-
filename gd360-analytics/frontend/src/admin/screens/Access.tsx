// Mission Control · Staff access & audit — who on the GD360 team can do what,
// time-boxed elevation, and the hash-chained log of every admin action.
import { useEffect, useState } from "react";
import { errText, mcDelete, mcPatch, mcPost, useMC } from "../api";
import {
  ActionButton, ago, Card, dateTime, Empty, ErrorBox, Loading, PageHead, Pill, Seg, useCan, useMe, useToast,
} from "../ui";

const NO_PERM = "Your role can't do this";

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

const initialsOf = (s: string) => s.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((x) => x[0]?.toUpperCase()).join("") || "?";
const reqTone = (s: string) => (s === "approved" ? "g" : s === "pending" ? "a" : s === "denied" ? "r" : undefined) as "g" | "a" | "r" | undefined;

function StaffRoleSelect({ row, roles, onDone }: { row: any; roles: { key: string; label: string }[]; onDone: () => void }) {
  const me = useMe();
  const can = useCan();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const self = row.email === me?.email;
  const ownerOnly = row.role === "admin" && me?.role !== "owner";
  const blocked = !can("staff.manage") ? NO_PERM : self ? "You can't change your own access" : ownerOnly ? "Only an Owner can change an Admin" : "";
  const change = async (role: string) => {
    if (role === row.role) return;
    setBusy(true);
    try {
      await mcPatch(`/staff/${row.id}`, { role });
      toast(`${row.email} is now ${roles.find((r) => r.key === role)?.label || role}`);
      onDone();
    } catch (e) {
      toast(errText(e, "Couldn't change the role."), true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <select className="mc-select" style={{ height: 32, fontSize: 12.5 }} aria-label={`Role for ${row.email}`} value={row.role}
      disabled={!!blocked || busy} title={blocked || "Change role"} onChange={(e) => change(e.target.value)}>
      {roles.filter((r) => r.key !== "owner").map((r) => (
        <option key={r.key} value={r.key} disabled={r.key === "admin" && me?.role !== "owner"}>{r.label}</option>
      ))}
    </select>
  );
}

function StaffCard({ roles }: { roles: { key: string; label: string }[] }) {
  const { data, error, loading, reload } = useMC<any>("/staff");
  const me = useMe();
  const can = useCan();
  const manage = can("staff.manage");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("support_agent");
  const staff: any[] = data?.staff || [];
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  return (
    <Card title={`STAFF · ${staff.length}`}>
      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Loading rows={2} h={60} />}
      {data && (staff.length === 0 ? <Empty>No staff yet. Owners come from the ADMIN_EMAILS setting.</Empty> : (
        <div className="mc-tablewrap">
          <table className="mc-table" style={{ minWidth: 720 }}>
            <thead><tr><th>PERSON</th><th>ROLE</th><th>STATUS</th><th>LAST SEEN</th><th>ACTIONS</th></tr></thead>
            <tbody>
              {staff.map((s) => {
                const self = s.email === me?.email;
                const ownerOnly = s.role === "admin" && me?.role !== "owner";
                const blocked = !manage ? NO_PERM : self ? "You can't change your own access" : ownerOnly ? "Only an Owner can change an Admin" : "";
                return (
                  <tr key={s.id || s.email}>
                    <td>
                      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <span style={{ width: 32, height: 32, borderRadius: 32, background: "var(--g-tint)", border: "1px solid var(--g-bd)", color: "var(--g)", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 12, flex: "none" }}>{initialsOf(s.name || s.email)}</span>
                        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                          <span style={{ fontWeight: 700 }}>{s.name || s.email.split("@")[0]}{self && <span className="mc-tip"> · you</span>}</span>
                          <span className="mc-tip">{s.email}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      {s.fixed ? (
                        <span title="Set in the ADMIN_EMAILS setting"><Pill tone="w">Owner</Pill> <span className="mc-tip">fixed</span></span>
                      ) : <StaffRoleSelect row={s} roles={roles} onDone={reload} />}
                    </td>
                    <td>
                      <Pill tone={s.status === "active" ? "g" : s.status === "disabled" ? "r" : "a"}>{s.status}</Pill>
                      {!s.signed_up && <span className="mc-tip" style={{ marginLeft: 6 }}>no GD360 sign-up yet</span>}
                    </td>
                    <td className="mc-mono" style={{ fontSize: 12, color: "var(--ink2)" }}>{s.fixed ? "—" : ago(s.last_seen_at)}</td>
                    <td>
                      {s.fixed ? <span className="mc-tip">Change ADMIN_EMAILS to edit</span> : (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {s.status === "disabled" ? (
                            <ActionButton className="mc-btn sm" run={async () => { await mcPatch(`/staff/${s.id}`, { status: "active" }); reload(); }}
                              done="Access restored" disabled={!!blocked} title={blocked || "Restore Mission Control access"}>Enable</ActionButton>
                          ) : (
                            <ActionButton className="mc-btn sm" run={async () => { await mcPatch(`/staff/${s.id}`, { status: "disabled" }); reload(); }}
                              done="Access disabled" disabled={!!blocked} title={blocked || "Block Mission Control access, keep the record"}>Disable</ActionButton>
                          )}
                          <ActionButton className="mc-btn sm d" run={async () => { await mcDelete(`/staff/${s.id}`); reload(); }} done="Removed from Mission Control"
                            disabled={!!blocked} title={blocked || "Remove from Mission Control"} confirm="Remove?">Remove</ActionButton>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <span className="mc-lbl">INVITE STAFF</span>
        {manage ? (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <label htmlFor="inv-email" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Email</label>
              <input id="inv-email" className="mc-input" type="email" style={{ flex: "1 1 220px" }} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@gd360.dev" />
              <select className="mc-select" aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
                {roles.filter((r) => r.key !== "owner" && (r.key !== "admin" || me?.role === "owner")).map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>
              <ActionButton className="mc-btn p" disabled={!validEmail} title={validEmail ? "Give this email a Mission Control role" : "Enter a valid email"} done="Invited"
                run={async () => { await mcPost("/staff", { email: email.trim(), role }); setEmail(""); reload(); }}>Invite</ActionButton>
            </div>
            <span className="mc-tip">They get access as soon as they sign in to GD360 with this email. Owners come from ADMIN_EMAILS.</span>
          </>
        ) : <span className="mc-tip">Only Owners and Admins can invite staff or change roles.</span>}
      </div>
    </Card>
  );
}

function JitCard() {
  const me = useMe();
  const can = useCan();
  const { data, error, loading, reload } = useMC<any>("/access-requests");
  const lacking = (me?.permissions || []).filter((p: any) => !me?.perms.includes(p.key));
  const [perm, setPerm] = useState("");
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState(60);
  const chosen = perm || lacking[0]?.key || "";
  const reqs: any[] = data?.requests || [];
  const pending = reqs.filter((r) => r.status === "pending").length;
  const label = (k: string) => me?.permissions.find((p: any) => p.key === k)?.label || k;

  return (
    <Card title={`JUST-IN-TIME ACCESS${pending ? ` · ${pending} PENDING` : ""}`}>
      {me && me.grants.length > 0 && (
        <div className="mc-note">
          Active grants: {me.grants.map((g: any) => `${label(g.permission)} until ${dateTime(g.expires_at)}`).join(" · ")}
        </div>
      )}
      {lacking.length === 0 ? (
        <span className="mc-tip">Your role already has every permission, so there's nothing to request.</span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label className="mc-field">Permission you need
            <select className="mc-select" value={chosen} onChange={(e) => setPerm(e.target.value)}>
              {lacking.map((p: any) => <option key={p.key} value={p.key}>{p.label} ({p.key})</option>)}
            </select>
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <label className="mc-field" style={{ flex: "1 1 200px" }}>Why (ticket number helps)
              <input className="mc-input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Ticket #1042 — customer locked out" />
            </label>
            <label className="mc-field">For
              <select className="mc-select" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                {[15, 30, 60, 120, 240, 480].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>)}
              </select>
            </label>
          </div>
          <ActionButton className="mc-btn p" disabled={reason.trim().length < 3 || !chosen} title={reason.trim().length < 3 ? "Give a reason first" : "Ask an Owner or Admin to approve"}
            done="Request sent" run={async () => { await mcPost("/access-requests", { permission: chosen, reason: reason.trim(), minutes }); setReason(""); reload(); }}>
            Request access
          </ActionButton>
          <span className="mc-tip">An Owner or Admin approves it. Access ends on its own; reload Mission Control after approval to use it.</span>
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <span className="mc-lbl">{can("access.approve") ? "ALL REQUESTS" : "YOUR REQUESTS"}</span>
        {error && <ErrorBox text={error} retry={reload} />}
        {loading && !data && <Loading rows={1} h={60} />}
        {data && reqs.length === 0 && <Empty>No access requests yet.</Empty>}
        {reqs.map((r) => {
          const own = r.staff_email === me?.email;
          const block = !can("access.approve") ? NO_PERM : own ? "You can't approve your own request" : "";
          return (
            <div key={r.id} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", borderRadius: 12, border: `1px solid ${r.status === "pending" ? "rgba(242,184,75,.4)" : "var(--line0)"}`, background: r.status === "pending" ? "rgba(242,184,75,.05)" : "transparent" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 13.5, flex: "1 1 200px", minWidth: 0 }}>
                  <b>{r.staff_email}</b> asks for <span className="mc-mono" style={{ color: "var(--g-soft)" }}>{r.permission}</span> for {r.minutes} min
                </span>
                <Pill tone={reqTone(r.status)}>{r.status}</Pill>
              </div>
              <span className="mc-tip">“{r.reason}” · {ago(r.created_at)}{r.decided_by ? ` · decided by ${r.decided_by}` : ""}{r.status === "approved" && r.expires_at ? ` · ends ${dateTime(r.expires_at)}` : ""}</span>
              {r.status === "pending" && (
                <div style={{ display: "flex", gap: 6 }}>
                  <ActionButton className="mc-btn sm p" disabled={!!block} title={block || `Grant for ${r.minutes} min`} done="Approved"
                    run={async () => { await mcPost(`/access-requests/${r.id}/approve`); reload(); }}>Approve {r.minutes} min</ActionButton>
                  <ActionButton className="mc-btn sm d" disabled={!!block} title={block || "Deny this request"} done="Denied"
                    run={async () => { await mcPost(`/access-requests/${r.id}/deny`); reload(); }}>Deny</ActionButton>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function MatrixCard() {
  const me = useMe();
  const [hl, setHl] = useState<string>(me?.role || "");
  const roles: { key: string; label: string }[] = me?.roles || [];
  const perms: { key: string; label: string; roles: string[] }[] = me?.permissions || [];
  const hlLabel = roles.find((r) => r.key === hl)?.label;
  const hlCount = perms.filter((p) => p.roles.includes(hl)).length;
  return (
    <Card title="PERMISSION MATRIX · PICK A ROLE TO HIGHLIGHT IT" right={<span className="mc-tip">✓ has it · — doesn't</span>}>
      <div className="mc-tablewrap">
        <table className="mc-table" style={{ minWidth: 1100 }}>
          <thead>
            <tr>
              <th>PERMISSION</th>
              {roles.map((r) => (
                <th key={r.key} style={{ padding: "0 4px 10px", textAlign: "center" }}>
                  <button type="button" aria-pressed={hl === r.key} onClick={() => setHl(hl === r.key ? "" : r.key)}
                    style={{ all: "unset", cursor: "pointer", padding: "4px 6px", borderRadius: 6, whiteSpace: "normal", display: "inline-block", maxWidth: 82, lineHeight: 1.3, textAlign: "center",
                      background: hl === r.key ? "var(--g-tint)" : "transparent", color: hl === r.key ? "var(--g)" : "var(--ink3)", boxShadow: hl === r.key ? "inset 0 0 0 1px var(--g-bd)" : "none" }}>
                    {r.label.toUpperCase()}{r.key === me?.role ? " · YOU" : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {perms.map((p) => (
              <tr key={p.key}>
                <td>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 13 }}>{p.label}</span>
                    <span className="mc-mono" style={{ fontSize: 11, color: "var(--ink3)" }}>{p.key}</span>
                  </div>
                </td>
                {roles.map((r) => {
                  const has = p.roles.includes(r.key);
                  const on = hl === r.key;
                  return (
                    <td key={r.key} style={{ textAlign: "center", background: on ? "#0F1A16" : undefined, color: has ? (on ? "var(--g)" : "var(--ink)") : "var(--ink4)", fontWeight: has ? 800 : 400 }}
                      aria-label={`${r.label}: ${has ? "has" : "doesn't have"} ${p.label}`}>
                      {has ? "✓" : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hl && <span className="mc-tip">{hlLabel} has {hlCount} of {perms.length} permissions.{hl === me?.role && me?.grants.length ? ` You also hold ${me.grants.length} time-boxed grant(s).` : ""}</span>}
    </Card>
  );
}

function AuditCard() {
  const can = useCan();
  const allowed = can("audit.read");
  const [kind, setKind] = useState<"all" | "staff" | "customer">("all");
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 350);
  const qs = new URLSearchParams({ kind, q: dq, limit: "200" }).toString();
  const { data, error, loading, reload } = useMC<any>(allowed ? `/audit?${qs}` : null);
  const verify = useMC<any>(allowed ? "/audit/verify" : null);
  const events: any[] = data?.events || [];
  const v = verify.data;

  if (!allowed) {
    return (
      <Card title="AUDIT LOG · APPEND-ONLY, HASH-CHAINED">
        <Empty>Your role can't read the audit log. Ask for “audit.read” with just-in-time access above.</Empty>
      </Card>
    );
  }
  return (
    <Card title="AUDIT LOG · APPEND-ONLY, HASH-CHAINED"
      right={v ? (
        <span title={`${v.events} staff events checked`}>
          <Pill tone={v.intact ? "g" : "r"}>{v.intact ? `✓ Chain intact · ${v.events} events` : `✕ ${v.broken_links} broken link${v.broken_links === 1 ? "" : "s"}`}</Pill>
        </span>
      ) : verify.error ? <Pill tone="r">Couldn't verify</Pill> : <span className="mc-tip">Verifying…</span>}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <Seg<"all" | "staff" | "customer"> label="Event kind" value={kind} onChange={setKind} options={[["all", "All"], ["staff", "Staff"], ["customer", "Customer"]]} />
        <label htmlFor="audit-q" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Search the audit log</label>
        <input id="audit-q" className="mc-input" style={{ flex: "1 1 220px" }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search actor, action or text" />
        <button type="button" className="mc-btn" onClick={() => { reload(); verify.reload(); }}>Refresh</button>
      </div>
      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Loading rows={2} h={60} />}
      {data && (events.length === 0 ? (
        <Empty>{dq ? "Nothing matches that search." : "No events yet."}</Empty>
      ) : (
        <div className="mc-tablewrap">
          <table className="mc-table" style={{ minWidth: 860 }}>
            <thead><tr><th>WHEN</th><th>KIND</th><th>WHO</th><th>WHAT</th><th>HASH</th></tr></thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i}>
                  <td className="mc-mono" style={{ fontSize: 12, color: "var(--ink2)", whiteSpace: "nowrap" }} title={e.t}>{dateTime(e.t)}</td>
                  <td><Pill tone={e.kind === "staff" ? "a" : "b"}>{e.kind}</Pill></td>
                  <td style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{e.actor || "—"}</td>
                  <td>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ color: "#D5DEDB" }}>{e.text}</span>
                      <span className="mc-tip"><span className="mc-mono">{e.action}</span>{e.reason ? ` · reason: ${e.reason}` : ""}</span>
                    </div>
                  </td>
                  <td className="mc-mono" style={{ fontSize: 11.5, color: "var(--ink3)" }}>{e.hash || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {data && <span className="mc-tip">Newest first · up to 200 events{loading ? " · updating…" : ""}. Staff events are chained with SHA-256, so any edit or deletion breaks the chain.</span>}
    </Card>
  );
}

export default function Access() {
  const me = useMe();
  const roles: { key: string; label: string }[] = me?.roles || [];
  return (
    <div className="mc-page">
      <PageHead eyebrow="Trust · internal" title="Staff access & audit"
        sub={`Least privilege for the GD360 team: roles, time-boxed access and an append-only log of every admin action. You are ${me?.role_label || "staff"} with ${me?.perms.length ?? 0} permissions.`} />
      <div className="mc-row">
        <div className="mc-col" style={{ flex: "999 1 560px", gap: 16 }}>
          <StaffCard roles={roles} />
        </div>
        <div className="mc-col" style={{ flex: "1 1 320px", gap: 16 }}>
          <JitCard />
        </div>
      </div>
      <MatrixCard />
      <AuditCard />
    </div>
  );
}

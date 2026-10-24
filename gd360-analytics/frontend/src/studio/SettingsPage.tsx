// 2026-10-19 (R56, admin board "Settings"): one Settings page with its own navigation - the workspace (general,
// members), security (sign-in and two-step, workspace policies, the audit log) and the plan. Every switch here is a
// real setting the backend enforces; what GD360 does not do yet (SAML single sign-on, SCIM) is said plainly.
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../api/AuthContext";
import { workspaceApi, type WorkspaceDetail } from "../api/client";
import { trustApi, type AuditEvent, type Policies } from "../api/ops";
import { v2Api, type PlanSummary } from "../api/v2";
import { TwoStepSection } from "../components/TwoStepSection";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { Ic } from "./icons";
import { fmtWhen, ListPage } from "./Page";

type Sec = "general" | "members" | "authentication" | "policies" | "audit" | "usage";
const NAV: { group: string; items: { id: Sec; label: string }[] }[] = [
  { group: "Workspace", items: [{ id: "general", label: "General" }, { id: "members", label: "Members" }] },
  { group: "Security", items: [{ id: "authentication", label: "Authentication" }, { id: "policies", label: "Policies" }, { id: "audit", label: "Audit log" }] },
  { group: "Billing", items: [{ id: "usage", label: "Plan and usage" }] },
];
const TITLE: Record<Sec, [string, string]> = {
  general: ["General", "The workspace's name and what is in it."],
  members: ["Members", "Who is in this workspace, and what each person may do."],
  authentication: ["Authentication", "How people sign in, and the second step that protects an account."],
  policies: ["Policies", "Rules for everyone in this workspace. Changes are written to the audit log."],
  audit: ["Audit log", "Every sign-in, export, share, agent action and setting change, newest first."],
  usage: ["Plan and usage", "What this workspace's plan includes and how much of it is used this month."],
};

function Card({ title, sub, right, children }: { title: string; sub?: string; right?: ReactNode; children?: ReactNode }) {
  return (
    <div className="sd-card" style={{ overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "16px 20px", borderBottom: children ? "1px solid rgb(var(--color-border))" : undefined }}>
        <div style={{ flex: 1, minWidth: 0 }}><b style={{ fontSize: 15 }}>{title}</b>{sub && <div className="sd-sub" style={{ marginTop: 2 }}>{sub}</div>}</div>
        {right}
      </div>
      {children}
    </div>
  );
}
function Row({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 20px", borderTop: "1px solid rgb(var(--color-border))", flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 220 }}><div style={{ fontSize: 14 }}>{title}</div>{sub && <div className="sd-sub" style={{ fontSize: 12.5, marginTop: 2 }}>{sub}</div>}</div>
      {right}
    </div>
  );
}
function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      style={{ width: 40, height: 24, borderRadius: 12, border: 0, padding: 2, cursor: disabled ? "default" : "pointer", background: on ? "rgb(var(--color-primary))" : "rgb(var(--color-border-strong))", opacity: disabled ? .5 : 1, display: "flex", justifyContent: on ? "flex-end" : "flex-start" }}>
      <span style={{ width: 20, height: 20, borderRadius: 10, background: "#fff", boxShadow: "0 1px 2px rgb(0 0 0 / .2)" }} />
    </button>
  );
}

export default function SettingsPage() {
  const { section } = useParams();
  const navigate = useNavigate();
  const sec: Sec = (NAV.flatMap((g) => g.items).some((i) => i.id === section) ? section : "general") as Sec;
  const { activeWorkspaceId, workspaces } = useWorkspaceNav();
  const { user } = useAuth();
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [policies, setPolicies] = useState<Policies | null>(null);
  const [audit, setAudit] = useState<{ events: AuditEvent[]; total: number } | null>(null);
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [name, setName] = useState("");
  const isAdmin = ws?.role === "owner" || ws?.role === "admin";

  useEffect(() => {
    if (!activeWorkspaceId) return;
    workspaceApi.get(activeWorkspaceId).then((d) => { setDetail(d); setName(d.name); }).catch(() => setDetail(null));
  }, [activeWorkspaceId]);
  useEffect(() => {
    setErr(""); setMsg("");
    if (sec === "policies" || sec === "authentication") trustApi.overview(activeWorkspaceId).then((o) => setPolicies(o.policies)).catch((e) => setErr(e?.response?.data?.detail || "Only an owner or admin can see the policies."));
    if (sec === "audit") trustApi.audit(activeWorkspaceId, { page: 1 }).then((a: any) => setAudit({ events: a.events, total: a.total })).catch((e) => setErr(e?.response?.data?.detail || "Only an owner or admin can read the audit log."));
    if (sec === "usage") v2Api.plan().then(setPlan).catch(() => setPlan(null));
  }, [sec, activeWorkspaceId]);

  const setPolicy = async (k: keyof Policies, v: any) => {
    if (!policies) return;
    const before = policies;
    setPolicies({ ...policies, [k]: v });
    try { const r = await trustApi.setPolicies(activeWorkspaceId, { [k]: v } as any); setPolicies(r.rules); setMsg("Saved. The change is in the audit log."); }
    catch (e: any) { setPolicies(before); setErr(e?.response?.data?.detail || "Couldn't change that policy."); }
  };
  const [title, sub] = TITLE[sec];
  const inviteUrl = detail?.invite_token ? `${window.location.origin}/invite/${detail.invite_token}` : "";

  return (
    <ListPage data="settings" crumbs={[{ label: "Settings", to: "/settings" }, { label: title }]} mainClass="sdp-settings">
      <div style={{ display: "flex", gap: 32, alignItems: "flex-start", flexWrap: "wrap" }}>
        <nav aria-label="Settings" className="sdp-snav" style={{ flex: "0 0 210px", display: "flex", flexDirection: "column", gap: 2 }} data-settings-nav="">
          <b style={{ fontSize: 16, margin: "0 10px 10px" }}>Settings</b>
          {NAV.map((g) => (
            <div key={g.group} style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 12 }}>
              <span className="sd-lbl" style={{ margin: "0 10px 4px" }}>{g.group}</span>
              {g.items.map((i) => (
                <button key={i.id} type="button" className={`sd-tool${sec === i.id ? " on" : ""}`} style={{ justifyContent: "space-between", height: 34, fontSize: 14 }}
                  onClick={() => navigate(`/settings/${i.id}`)} data-settings-item={i.id}>
                  {i.label}{i.id === "members" && detail ? <span className="sd-sub sd-mono" style={{ fontSize: 12 }}>{detail.members.length}</span> : null}
                </button>
              ))}
            </div>
          ))}
          <span className="sd-lbl" style={{ margin: "0 10px 4px" }}>Also</span>
          <Link className="sd-tool" style={{ height: 34, fontSize: 14 }} to="/profile">Your profile</Link>
          <Link className="sd-tool" style={{ height: 34, fontSize: 14 }} to="/trust">Trust center</Link>
          <Link className="sd-tool" style={{ height: 34, fontSize: 14 }} to="/settings/domains">Company domain</Link>
        </nav>
        <div style={{ flex: "1 1 520px", minWidth: 0, maxWidth: 940, display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="sdp-hd"><div><h1>{title}</h1><p>{sub}</p></div></div>
          {err && <div className="sd-err">{err}</div>}
          {msg && <div className="sd-card" style={{ padding: "10px 14px", fontSize: 13.5, color: "rgb(var(--color-primary))" }}>{msg}</div>}

          {sec === "general" && (
            <Card title="Workspace" sub={ws?.is_personal ? "Your personal workspace: only you see what is in it." : "Shared with its members."}>
              <Row title="Name" right={
                <form style={{ display: "flex", gap: 8 }} onSubmit={async (e) => { e.preventDefault(); if (!activeWorkspaceId || !name.trim()) return; try { await workspaceApi.rename(activeWorkspaceId, name.trim()); setMsg("Renamed."); } catch (x: any) { setErr(x?.response?.data?.detail || "Couldn't rename it."); } }}>
                  <input className="sd-in" value={name} onChange={(e) => setName(e.target.value)} disabled={!isAdmin || ws?.is_personal} aria-label="Workspace name" />
                  {isAdmin && !ws?.is_personal && <button type="submit" className="sd-pill">Save</button>}
                </form>} />
              <Row title="Data sources" sub="Connected to this workspace" right={<span className="sd-mono">{ws?.datasource_count ?? "–"}</span>} />
              <Row title="Members" right={<span className="sd-mono">{detail?.members.length ?? ws?.member_count ?? "–"}</span>} />
              <Row title="Your role" right={<span className="sd-chip">{ws?.role || "–"}</span>} />
              <Row title="Created" right={<span className="sd-sub">{detail ? new Date(detail.created_at).toLocaleDateString() : "–"}</span>} />
            </Card>
          )}

          {sec === "members" && (
            <Card title={`${detail?.members.length ?? 0} member${detail?.members.length === 1 ? "" : "s"}`} sub="Viewers can open everything but change nothing. Data rules on each source still apply to each person."
              right={inviteUrl && isAdmin ? <button type="button" className="sd-btnp" onClick={() => { void navigator.clipboard?.writeText(inviteUrl).catch(() => undefined); setMsg("Invite link copied. Anyone with it can join as a member."); }} data-settings-invite="">Copy invite link</button> : undefined}>
              <div className="sd-tw">
                <table className="sd-t">
                  <thead><tr><th>Name</th><th>Email</th><th>Role</th><th className="r">Joined</th><th /></tr></thead>
                  <tbody>{(detail?.members || []).map((m) => (
                    <tr key={m.user_id}>
                      <td>{m.full_name || m.email.split("@")[0]}{m.user_id === user?.id ? <span className="sd-sub"> · you</span> : null}</td>
                      <td className="sd-sub">{m.email}</td>
                      <td>{isAdmin && m.role !== "owner" && m.user_id !== user?.id ? (
                        <select className="sdp-sel" value={m.role} onChange={async (e) => { try { await workspaceApi.updateMemberRole(activeWorkspaceId!, m.user_id, e.target.value as any); setDetail(await workspaceApi.get(activeWorkspaceId!)); setMsg("Role changed."); } catch (x: any) { setErr(x?.response?.data?.detail || "Couldn't change the role."); } }} aria-label={`Role of ${m.email}`}>
                          <option value="admin">Admin</option><option value="member">Member</option><option value="viewer">Viewer</option></select>
                      ) : <span className="sd-chip">{m.role}</span>}</td>
                      <td className="r sd-sub">{fmtWhen(m.created_at)}</td>
                      <td className="r">{isAdmin && m.role !== "owner" && m.user_id !== user?.id && <button type="button" className="sd-tool sm danger" onClick={async () => { try { await workspaceApi.removeMember(activeWorkspaceId!, m.user_id); setDetail(await workspaceApi.get(activeWorkspaceId!)); setMsg("Removed."); } catch (x: any) { setErr(x?.response?.data?.detail || "Couldn't remove them."); } }}>Remove</button>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </Card>
          )}

          {sec === "authentication" && <>
            <Card title="Sign-in methods" sub="How people in this workspace sign in today.">
              <Row title="Email and password" sub="Passwords are hashed; a reset link expires after one use." right={<span className="sd-chip good"><span className="sd-dot good" />On</span>} />
              <Row title="Require two-step sign-in for everyone" sub="Members without it are asked to set it up before they continue." right={<Toggle on={!!policies?.require_mfa} disabled={!isAdmin || !policies} onChange={(v) => void setPolicy("require_mfa", v)} label="Require two-step sign-in" />} />
              <Row title="Single sign-on (SAML) and SCIM provisioning" sub="Not available in Euliv yet. Tell your Euliv contact if your company needs it; we will not show a switch that does nothing." right={<span className="sd-chip">Not yet</span>} />
            </Card>
            <Card title="Your two-step sign-in" sub="An authenticator app code after your password."><div style={{ padding: "16px 20px" }}><TwoStepSection /></div></Card>
          </>}

          {sec === "policies" && (
            <Card title="Workspace policies" sub="Enforced for every member.">
              <Row title="Require two-step sign-in" sub="Every member, every sign-in." right={<Toggle on={!!policies?.require_mfa} disabled={!isAdmin || !policies} onChange={(v) => void setPolicy("require_mfa", v)} label="Require two-step sign-in" />} />
              <Row title="Block public links" sub="No dashboard can be shared with people outside the workspace." right={<Toggle on={!!policies?.block_public_links} disabled={!isAdmin || !policies} onChange={(v) => void setPolicy("block_public_links", v)} label="Block public links" />} />
              <Row title="Email outside the company needs approval" sub="Scheduled reports and alerts to other domains wait for an admin." right={<Toggle on={!!policies?.external_email_needs_approval} disabled={!isAdmin || !policies} onChange={(v) => void setPolicy("external_email_needs_approval", v)} label="External email needs approval" />} />
              <Row title="Publishing on the company domain needs approval" right={<Toggle on={!!policies?.domain_publish_needs_approval} disabled={!isAdmin || !policies} onChange={(v) => void setPolicy("domain_publish_needs_approval", v)} label="Domain publishing needs approval" />} />
              <Row title="Review access every" sub="Owners are reminded to review who can see what." right={
                <select className="sdp-sel" value={policies?.review_every_days ?? 90} disabled={!isAdmin || !policies} onChange={(e) => void setPolicy("review_every_days", Number(e.target.value))} aria-label="Review access every">
                  {[30, 60, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}</select>} />
              <Row title="Row and column rules, personal data" sub="Who sees which rows and columns of each source." right={<Link to="/trust" className="sd-pill">Open the Trust center</Link>} />
            </Card>
          )}

          {sec === "audit" && (
            <Card title={`${audit?.total?.toLocaleString() ?? "–"} events`} right={<Link to="/trust#audit" className="sd-pill">Search and export</Link>}>
              <div className="sd-tw">
                <table className="sd-t">
                  <thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead>
                  <tbody>{(audit?.events || []).map((e) => (
                    <tr key={e.id}><td className="sd-sub">{fmtWhen(e.at)}</td><td>{e.actor}</td><td>{e.label}</td><td className="sd-sub" style={{ maxWidth: 360 }} title={e.what}>{e.what || "—"}</td></tr>
                  ))}
                    {audit && !audit.events.length && <tr><td colSpan={4}><div className="sd-empty">Nothing recorded yet.</div></td></tr>}</tbody>
                </table>
              </div>
            </Card>
          )}

          {sec === "usage" && (
            <Card title={plan ? `${plan.label} plan` : "Plan"} sub={plan?.who} right={<Link to="/settings/plan" className="sd-btnp">Change plan</Link>}>
              {(plan?.meters || []).map((m) => (
                <Row key={m.key} title={m.label} sub={m.limit == null ? "No limit on this plan" : `${m.used.toLocaleString()} of ${m.limit.toLocaleString()}`}
                  right={m.limit != null ? <span style={{ width: 180, height: 8, borderRadius: 4, background: "rgb(var(--color-surface2))", overflow: "hidden", display: "inline-block" }}>
                    <i style={{ display: "block", height: "100%", width: `${Math.min(100, (m.used / Math.max(1, m.limit)) * 100)}%`, background: m.over ? "rgb(var(--sd-bad))" : m.near ? "rgb(var(--sd-warn))" : "rgb(var(--color-primary))" }} /></span>
                    : <span className="sd-mono">{m.used.toLocaleString()}</span>} />
              ))}
              {!plan && <div className="sd-empty">Reading the plan…</div>}
            </Card>
          )}
          <span className="sd-note">Changes here are recorded in the audit log with who made them. <Ic n="shield" s={13} /></span>
        </div>
      </div>
    </ListPage>
  );
}

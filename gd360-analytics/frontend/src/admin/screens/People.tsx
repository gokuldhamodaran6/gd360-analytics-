// Mission Control · People — every user, their usage and status, with the
// support actions (unlock, sign out, suspend, change workspace role).
import { ReactNode, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { errText, mcDownload, mcPatch, mcPost, useMC } from "../api";
import {
  ActionButton, ago, Card, Chips, dateShort, dateTime, Drawer, Empty, ErrorBox, fmtN, Loading, Modal, PageHead, Pill, prioTone, useCan, useToast,
} from "../ui";

type Status = "all" | "active" | "new" | "dormant" | "locked" | "suspended";
const STATUSES: Status[] = ["all", "active", "new", "dormant", "locked", "suspended"];
const STATUS_LABEL: Record<Status, string> = { all: "Everyone", active: "Active", new: "New", dormant: "Dormant", locked: "Locked", suspended: "Suspended" };
const NO_PERM = "Your role can't do this";

const statusTone = (s?: string) =>
  (s === "active" ? "g" : s === "locked" || s === "suspended" ? "r" : s === "dormant" ? "a" : s === "new" ? "b" : undefined) as "g" | "r" | "a" | "b" | undefined;

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

const initialsOf = (s: string) => s.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((x) => x[0]?.toUpperCase()).join("") || "?";

const Fact = ({ k, v }: { k: string; v: ReactNode }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "10px 12px", borderRadius: 12, border: "1px solid var(--line0)", background: "var(--s1)", minWidth: 0 }}>
    <span className="mc-lbl" style={{ fontSize: 10 }}>{k}</span>
    <span style={{ fontSize: 13.5, overflowWrap: "anywhere" }}>{v}</span>
  </div>
);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="mc-lbl">{title}</span>
      {children}
    </div>
  );
}

function RoleSelect({ personId, ws, onDone }: { personId: string; ws: any; onDone: () => void }) {
  const can = useCan();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const allowed = can("users.write");
  const change = async (role: string) => {
    if (role === ws.role) return;
    setBusy(true);
    try {
      await mcPatch(`/people/${personId}/role`, { workspace_id: ws.id, role });
      toast(`Role in “${ws.name}” is now ${role}`);
      onDone();
    } catch (e) {
      toast(errText(e, "Couldn't change the role."), true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <select className="mc-select" style={{ height: 32, fontSize: 12.5 }} aria-label={`Role in ${ws.name}`} value={ws.role} disabled={!allowed || busy}
      title={allowed ? "Change workspace role" : NO_PERM} onChange={(e) => change(e.target.value)}>
      <option value="owner">owner</option>
      <option value="member">member</option>
      <option value="viewer">viewer</option>
    </select>
  );
}

function PersonDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data, error, loading, reload } = useMC<any>(`/people/${encodeURIComponent(id)}`);
  const can = useCan();
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [reason, setReason] = useState("");
  const after = () => { reload(); onChanged(); };
  const p = data?.person;
  const suspended = !!data?.suspended_at;
  const locked = p?.status === "locked";

  return (
    <Drawer open onClose={onClose} label="Person details">
      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Loading rows={4} h={70} />}
      {p && (
        <>
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <span style={{ width: 52, height: 52, borderRadius: 16, background: "var(--g-tint)", border: "1px solid var(--g-bd)", color: "var(--g)", display: "grid", placeItems: "center", fontWeight: 900, fontSize: 18, flex: "none" }}>{initialsOf(p.name || p.email)}</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em", overflowWrap: "anywhere" }}>{p.name || p.email}</h2>
              <span className="mc-mono" style={{ fontSize: 12, color: "var(--ink2)", overflowWrap: "anywhere" }}>{p.email}</span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Pill tone="g">{p.plan}</Pill>
                <Pill tone={statusTone(p.status)}>{p.status}</Pill>
                <Pill>{p.lifecycle}</Pill>
                {p.staff && <Pill tone="w">Staff</Pill>}
              </div>
            </div>
          </div>

          {locked && (
            <div className="mc-alert" style={{ borderColor: "#F2B84B55", background: "#F2B84B0D", fontSize: 13, lineHeight: 1.5 }}>
              <span className="mc-dot" style={{ background: "var(--amber)" }} />
              <span>Locked after {p.failed_logins} failed sign-in{p.failed_logins === 1 ? "" : "s"}. Unlocks by itself at {dateTime(p.locked_until)} — or unlock now.</span>
            </div>
          )}
          {suspended && (
            <div className="mc-alert" style={{ borderColor: "#FF7A6B55", background: "#FF7A6B0D", fontSize: 13, lineHeight: 1.5 }}>
              <span className="mc-dot" style={{ background: "var(--red)" }} />
              <span>Suspended since {dateTime(data.suspended_at)}. They can't sign in until reactivated.</span>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <ActionButton className="mc-btn sm" run={async () => { await mcPost(`/people/${p.id}/unlock`); after(); }} done="Unlocked"
              disabled={!can("users.unlock") || !locked} title={!can("users.unlock") ? NO_PERM : !locked ? "Not locked right now" : "Clear failed sign-ins and unlock"}>Unlock</ActionButton>
            <ActionButton className="mc-btn sm" run={async () => { await mcPost(`/people/${p.id}/signout`); after(); }} done="Signed out everywhere"
              disabled={!can("users.unlock")} title={can("users.unlock") ? "End every session on every device" : NO_PERM} confirm="Sign them out on every device?">Sign out everywhere</ActionButton>
            {suspended ? (
              <ActionButton className="mc-btn sm" run={async () => { await mcPost(`/people/${p.id}/reactivate`); after(); }} done="Reactivated"
                disabled={!can("users.write")} title={can("users.write") ? "Let them sign in again" : NO_PERM}>Reactivate</ActionButton>
            ) : (
              <button type="button" className="mc-btn sm d" disabled={!can("users.write")} title={can("users.write") ? "Block sign-in and end sessions" : NO_PERM}
                onClick={() => { setReason(""); setSuspendOpen(true); }}>Suspend</button>
            )}
            <Link to={`/admin/accounts/${encodeURIComponent(p.account)}`} className="mc-btn sm">Open account</Link>
          </div>

          <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 8 }}>
            <Fact k="Company" v={p.company || "—"} />
            <Fact k="Email type" v={p.corporate ? "Company domain" : "Free mail"} />
            <Fact k="Signed up" v={dateShort(p.signed_up)} />
            <Fact k="Last active" v={ago(p.last_active)} />
            <Fact k="Last sign-in" v={ago(p.last_login)} />
            <Fact k="Questions" v={<span className="mc-num">{fmtN(p.chats_30d)} in 30d · {fmtN(p.chats_total)} total</span>} />
            <Fact k="Sources" v={fmtN(p.sources)} />
            <Fact k="Dashboards" v={`${fmtN(p.dashboards)} · ${fmtN(p.published)} published`} />
            <Fact k="ML · automations" v={`${fmtN(p.ml_models)} · ${fmtN(p.automations)}`} />
          </div>

          <Section title={`WORKSPACES · ${data.workspaces.length}`}>
            {data.workspaces.length === 0 ? <span className="mc-tip">Not in any workspace.</span> : data.workspaces.map((w: any) => (
              <div key={w.id} style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--line0)" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>{w.name}</span>
                  <span className="mc-tip">{w.personal ? "Personal" : "Shared"} · {w.members} member{w.members === 1 ? "" : "s"}</span>
                </div>
                <RoleSelect personId={p.id} ws={w} onDone={after} />
              </div>
            ))}
          </Section>

          <Section title={`SOURCES · ${data.sources.length}`}>
            {data.sources.length === 0 ? <span className="mc-tip">No data sources yet.</span> : data.sources.map((s: any, i: number) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                <span className="mc-mono" style={{ fontSize: 11.5, color: "var(--ink3)", width: 84, flex: "none" }}>{s.kind}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                {s.sync_error ? <span title={s.sync_error}><Pill tone="r">failing</Pill></span> : <span className="mc-tip">{dateShort(s.created_at)}</span>}
              </div>
            ))}
          </Section>

          <Section title="RECENT ACTIVITY">
            {data.recent.length === 0 ? <span className="mc-tip">No recorded activity.</span> : data.recent.map((r: any, i: number) => (
              <div key={i} style={{ display: "flex", gap: 10, fontSize: 13 }}>
                <span className="mc-mono" style={{ fontSize: 11, color: "var(--ink3)", width: 64, flex: "none", paddingTop: 2 }}>{ago(r.t)}</span>
                <span style={{ color: "#D5DEDB" }}>{r.text}</span>
              </div>
            ))}
          </Section>

          <Section title="STAFF ACTIONS">
            {data.staff_actions.length === 0 ? <span className="mc-tip">No staff actions on this person.</span> : data.staff_actions.map((r: any, i: number) => (
              <div key={i} style={{ display: "flex", gap: 10, fontSize: 13 }}>
                <span className="mc-mono" style={{ fontSize: 11, color: "var(--ink3)", width: 64, flex: "none", paddingTop: 2 }}>{ago(r.t)}</span>
                <span style={{ color: "#D5DEDB", overflowWrap: "anywhere" }}>{r.text}</span>
              </div>
            ))}
          </Section>

          <Section title={`TICKETS · ${data.tickets.length}`}>
            {data.tickets.length === 0 ? <span className="mc-tip">No tickets.</span> : data.tickets.map((t: any) => (
              <Link key={t.id} to={`/admin/support?t=${encodeURIComponent(t.id)}`} style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--ink)", fontSize: 13 }}>
                <Pill tone={prioTone(t.priority)}>{t.priority}</Pill>
                <span style={{ flex: 1, minWidth: 0 }}>#{t.number} {t.subject}</span>
                <span className="mc-tip">{t.status}</span>
              </Link>
            ))}
          </Section>

          <span className="mc-tip">Conversation content stays hidden. Every action here is written to the audit log.</span>
        </>
      )}

      <Modal open={suspendOpen} onClose={() => setSuspendOpen(false)} title="Suspend this person?">
        <p style={{ margin: 0, color: "var(--ink2)", fontSize: 13.5, lineHeight: 1.55 }}>
          They are signed out everywhere and can't sign in until someone reactivates them. Their data stays as it is.
        </p>
        <label className="mc-field">Reason (goes in the audit log)
          <textarea className="mc-textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Abuse report on ticket #1042" maxLength={500} />
        </label>
        <ActionButton className="mc-btn d" disabled={reason.trim().length < 3} title={reason.trim().length < 3 ? "Give a reason first" : undefined}
          run={async () => { await mcPost(`/people/${id}/suspend`, { reason: reason.trim() }); setSuspendOpen(false); after(); }} done="Suspended">
          Suspend
        </ActionButton>
      </Modal>
    </Drawer>
  );
}

export default function People() {
  const [params, setParams] = useSearchParams();
  const urlQ = params.get("q") || "";
  const urlStatus = params.get("status") || "all";
  const status: Status = (STATUSES as string[]).includes(urlStatus) ? (urlStatus as Status) : "all";
  const openId = params.get("open");

  const [qIn, setQIn] = useState(urlQ);
  const [lifecycle, setLifecycle] = useState("all");
  const [domain, setDomain] = useState("all");
  const [sort, setSort] = useState("recent");

  // keep the box in step when the top-bar search changes the URL
  useEffect(() => setQIn(urlQ), [urlQ]);
  const dq = useDebounced(qIn, 300);
  useEffect(() => {
    if (dq === urlQ) return;
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      if (dq) n.set("q", dq); else n.delete("q");
      return n;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);

  const setParam = (k: string, v: string | null) =>
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      if (v) n.set(k, v); else n.delete(k);
      return n;
    });

  const filterKey = [urlQ.trim(), status, lifecycle, domain, sort].join("|");
  const [pg, setPg] = useState({ key: filterKey, page: 1 });
  const page = pg.key === filterKey ? pg.page : 1;
  const size = 50;
  const filters = new URLSearchParams({ q: urlQ.trim(), status, lifecycle, domain });
  const listQs = new URLSearchParams({ q: urlQ.trim(), status, lifecycle, domain, sort, page: String(page), size: String(size) }).toString();
  const { data, error, loading, reload } = useMC<any>(`/people?${listQs}`);
  const items: any[] = data?.items || [];
  const total: number = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / size));
  const c = data?.counts;
  const filtered = !!(urlQ.trim() || status !== "all" || lifecycle !== "all" || domain !== "all");

  return (
    <div className="mc-page">
      <PageHead eyebrow="Customers" title="People"
        sub={c ? `${fmtN(c.all)} people · ${fmtN(c.active)} active in 14 days · ${fmtN(c.new)} yet to ask a question · ${fmtN(c.locked)} locked · ${fmtN(c.suspended)} suspended. Everyone is on early access.` : "Everyone who has signed up."}>
        <ActionButton run={() => mcDownload(`/people/export.csv?${filters.toString()}`, "gd360-people.csv")} done="CSV downloaded">Export CSV</ActionButton>
        <button type="button" className="mc-btn" onClick={reload}>Refresh</button>
      </PageHead>

      <Card>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <label htmlFor="people-q" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Search people</label>
          <input id="people-q" className="mc-input" style={{ flex: "1 1 240px" }} value={qIn} onChange={(e) => setQIn(e.target.value)} placeholder="Search by name, email or company" />
          <select className="mc-select" aria-label="Lifecycle stage" value={lifecycle} onChange={(e) => setLifecycle(e.target.value)}>
            <option value="all">Any stage</option>
            <option value="Signed up">Signed up</option>
            <option value="Activated">Activated</option>
            <option value="Engaged">Engaged</option>
            <option value="Dormant">Dormant</option>
          </select>
          <select className="mc-select" aria-label="Email type" value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="all">Any email</option>
            <option value="corporate">Company domain</option>
            <option value="freemail">Free mail</option>
          </select>
          <select className="mc-select" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="recent">Last active</option>
            <option value="chats">Most questions</option>
            <option value="newest">Newest</option>
            <option value="name">Name</option>
          </select>
        </div>
        <Chips<Status> label="Status" value={status} onChange={(v) => setParam("status", v === "all" ? null : v)}
          options={STATUSES.map((s) => [s, c ? `${STATUS_LABEL[s]} · ${fmtN(c[s])}` : STATUS_LABEL[s]] as [Status, string])} />
      </Card>

      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Loading rows={4} />}
      {data && (
        <Card title={`${fmtN(total)} ${total === 1 ? "PERSON" : "PEOPLE"} · SORTED BY ${({ recent: "LAST ACTIVE", chats: "QUESTIONS", newest: "NEWEST", name: "NAME" } as Record<string, string>)[sort]}${loading ? " · UPDATING…" : ""}`}>
          {items.length === 0 ? (
            <Empty>{filtered ? "No one matches. Clear a filter or search by domain." : "No one has signed up yet."}</Empty>
          ) : (
            <div className="mc-tablewrap">
              <table className="mc-table" style={{ minWidth: 1000 }}>
                <thead><tr><th>PERSON</th><th>ACCOUNT</th><th>STAGE</th><th>STATUS</th><th>QUESTIONS 30D</th><th>SOURCES</th><th>DASHBOARDS</th><th>SIGNED UP</th><th>LAST ACTIVE</th></tr></thead>
                <tbody>
                  {items.map((u) => (
                    <tr key={u.id} className={`click${openId === u.id ? " sel" : ""}`} onClick={() => setParam("open", u.id)}>
                      <td>
                        <button type="button" className="mc-rowbtn" onClick={(e) => { e.stopPropagation(); setParam("open", u.id); }}>
                          <span style={{ fontWeight: 700 }}>{u.name || u.email}{u.staff && <span style={{ marginLeft: 6 }}><Pill tone="w">Staff</Pill></span>}</span>
                          <span className="mc-tip">{u.email}</span>
                        </button>
                      </td>
                      <td>
                        <Link to={`/admin/accounts/${encodeURIComponent(u.account)}`} onClick={(e) => e.stopPropagation()} style={{ color: "var(--ink2)" }}>
                          {u.corporate ? u.account : u.company || "Personal"}
                        </Link>
                      </td>
                      <td>{u.lifecycle}</td>
                      <td><Pill tone={statusTone(u.status)}>{u.status}</Pill></td>
                      <td className="mc-mono mc-num">{fmtN(u.chats_30d)}</td>
                      <td className="mc-mono mc-num">{fmtN(u.sources)}</td>
                      <td className="mc-mono mc-num">{fmtN(u.dashboards)}</td>
                      <td className="mc-mono" style={{ fontSize: 12, color: "var(--ink2)" }}>{dateShort(u.signed_up)}</td>
                      <td className="mc-mono" style={{ fontSize: 12, color: "var(--ink2)" }}>{ago(u.last_active)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {total > size && (
            <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
              <span className="mc-tip mc-num">{fmtN((page - 1) * size + 1)}–{fmtN(Math.min(total, page * size))} of {fmtN(total)}</span>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button type="button" className="mc-btn sm" disabled={page <= 1 || loading} onClick={() => setPg({ key: filterKey, page: page - 1 })}>← Previous</button>
                <span className="mc-mono" style={{ fontSize: 12, color: "var(--ink2)" }}>Page {page} of {pages}</span>
                <button type="button" className="mc-btn sm" disabled={page >= pages || loading} onClick={() => setPg({ key: filterKey, page: page + 1 })}>Next →</button>
              </div>
            </div>
          )}
        </Card>
      )}

      {openId && (
        <PersonDrawer key={openId} id={openId} onClose={() => setParam("open", null)} onChanged={reload} />
      )}
    </div>
  );
}

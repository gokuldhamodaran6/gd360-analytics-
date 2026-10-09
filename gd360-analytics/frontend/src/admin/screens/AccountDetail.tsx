// Mission Control · Account 360 — one account: usage, people, workspaces,
// sources, tickets, deals, health and the next best action.
import { ReactNode, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMC } from "../api";
import { ago, bandTone, Card, dateShort, Empty, ErrorBox, fmtN, fmtUSD, Loading, Pill, prioTone, Seg } from "../ui";

type Tab = "overview" | "people" | "workspaces" | "tickets" | "timeline";

const initialsOf = (s: string) => s.split(/[\s@.:]+/).filter(Boolean).slice(0, 2).map((x) => x[0]?.toUpperCase()).join("") || "?";
const isMasked = (e?: string | null) => !!e && e.includes("•");

function WeeklyChart({ weeks }: { weeks: { week: string; active: number; members: number }[] }) {
  const H = 160;
  const max = Math.max(1, ...weeks.map((w) => Math.max(w.active, w.members)));
  return (
    <div>
      <div style={{ height: H, display: "grid", gridTemplateColumns: `repeat(${weeks.length}, minmax(0,1fr))`, gap: 8, alignItems: "end", borderBottom: "1px solid var(--line)" }}>
        {weeks.map((w) => (
          <div key={w.week} title={`Week of ${dateShort(w.week)}: ${w.active} active of ${w.members} members`}
            style={{ position: "relative", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
            {w.members > 0 && <div aria-hidden="true" style={{ position: "absolute", left: -4, right: -4, bottom: (w.members / max) * (H - 20), borderTop: "2px dashed var(--line2)" }} />}
            <span className="mc-mono mc-num" style={{ fontSize: 11, color: "var(--ink2)" }}>{w.active || ""}</span>
            <div style={{ width: "70%", height: (w.active / max) * (H - 20), minHeight: w.active ? 2 : 0, borderRadius: "5px 5px 2px 2px", background: "var(--g)" }} />
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${weeks.length}, minmax(0,1fr))`, gap: 8, marginTop: 6 }}>
        {weeks.map((w) => <span key={w.week} className="mc-mono" style={{ fontSize: 10.5, color: "var(--ink3)", textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dateShort(w.week)}</span>)}
      </div>
    </div>
  );
}

const Fact = ({ k, v }: { k: string; v: ReactNode }) => (
  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
    <span style={{ color: "var(--ink3)" }}>{k}</span><span style={{ textAlign: "right", minWidth: 0, overflowWrap: "anywhere" }}>{v}</span>
  </div>
);

export default function AccountDetail() {
  const { key: rawKey = "" } = useParams();
  let key = rawKey;
  try { key = decodeURIComponent(rawKey); } catch { /* already decoded */ }
  const { data, error, loading, reload } = useMC<any>(key ? `/accounts/${encodeURIComponent(key)}` : null);
  const [tab, setTab] = useState<Tab>("overview");

  if (error) {
    return (
      <div className="mc-page">
        <nav aria-label="Breadcrumb" className="mc-crumb"><Link to="/admin/accounts">Accounts</Link><span>/</span><span>{key}</span></nav>
        <ErrorBox text={error} retry={reload} />
      </div>
    );
  }
  if (loading && !data) return <div className="mc-page"><Loading rows={6} /></div>;
  if (!data) return null;

  const a = data.account;
  const weeks: any[] = data.weeks || [];
  const breadth: any[] = data.breadth || [];
  const nba = data.next_best_action;
  const healthColor = a.health_band === "Healthy" ? "var(--g)" : a.health_band === "Watch" ? "var(--amber)" : "var(--red)";
  const peakActive = Math.max(0, ...weeks.map((w) => w.active));
  const lastWeek = weeks[weeks.length - 1];
  const kpis: [string, string, string][] = [
    ["PEOPLE", fmtN(a.users), `${fmtN(a.active_users_30d)} asked in 30 days`],
    ["QUESTIONS · 30D", fmtN(a.chats_30d), `${fmtN(a.chats_7d)} in the last 7 days`],
    ["QUESTIONS · ALL TIME", fmtN(a.chats_total), `since ${dateShort(a.signed_up)}`],
    ["DATA SOURCES", fmtN(a.sources), `${data.sources.filter((s: any) => s.sync_error).length} failing to sync`],
    ["DASHBOARDS", fmtN(a.dashboards), `${fmtN(a.published)} published`],
    ["ML MODELS", fmtN(a.ml_models), "trained in ML Studio"],
    ["AUTOMATIONS", fmtN(a.automations), "scheduled jobs"],
    ["OPEN TICKETS", fmtN(a.open_tickets), a.open_tickets ? "waiting on us" : "nothing waiting"],
  ];

  return (
    <div className="mc-page">
      <nav aria-label="Breadcrumb" className="mc-crumb"><Link to="/admin/accounts">Accounts</Link><span>/</span><span>{a.name}</span></nav>

      <section className="mc-card" style={{ padding: 22, display: "flex", flexWrap: "wrap", gap: 20, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 16, alignItems: "center", minWidth: 0 }}>
          <span style={{ width: 60, height: 60, borderRadius: 18, background: "var(--g-tint)", border: "1px solid var(--g-bd)", color: "var(--g)", display: "grid", placeItems: "center", fontWeight: 900, fontSize: 22, flex: "none" }}>{initialsOf(a.name || a.key)}</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, letterSpacing: "-0.03em", overflowWrap: "anywhere" }}>{a.name}</h1>
              <Pill tone="g">{a.plan || "Early access"}</Pill>
              <Pill tone="b">Fits {a.fit}</Pill>
              {a.personal && <Pill>Personal</Pill>}
            </div>
            <span style={{ fontSize: 13.5, color: "var(--ink2)" }}>
              {a.personal ? "Personal account" : a.domain} · signed up {dateShort(a.signed_up)} · last active {ago(a.last_active)}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}><span className="mc-lbl">PEOPLE</span><span className="mc-num" style={{ fontSize: 22, fontWeight: 800 }}>{fmtN(a.users)}</span></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}><span className="mc-lbl">ACTIVE 30D</span><span className="mc-num" style={{ fontSize: 22, fontWeight: 800 }}>{fmtN(a.active_users_30d)}</span></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}><span className="mc-lbl">HEALTH</span><span className="mc-num" style={{ fontSize: 22, fontWeight: 800, color: healthColor }}>{a.health} · {a.health_band}</span></div>
        </div>
      </section>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <Seg<Tab> label="Account sections" value={tab} onChange={setTab} options={[
          ["overview", "Overview"], ["people", `People · ${data.members.length}`], ["workspaces", "Workspaces & sources"],
          ["tickets", "Tickets & deals"], ["timeline", "Timeline"],
        ]} />
        <span style={{ flex: 1 }} />
        <button type="button" className="mc-btn" onClick={reload} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
      </div>

      <div className="mc-row">
        <div className="mc-col" style={{ flex: "999 1 560px", gap: 16 }}>
          {tab === "overview" && (
            <>
              <section aria-label="Account metrics" className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))" }}>
                {kpis.map(([k, v, sub]) => (
                  <div key={k} className="mc-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
                    <span className="mc-lbl">{k}</span>
                    <span className="mc-num" style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>{v}</span>
                    <span style={{ fontSize: 12, color: "var(--ink2)" }}>{sub}</span>
                  </div>
                ))}
              </section>
              <Card title="WEEKLY ACTIVE PEOPLE vs MEMBERS · 12 WEEKS" right={<span className="mc-mono" style={{ fontSize: 11.5, color: "var(--ink2)" }}><span style={{ color: "var(--g)" }}>■</span> active  ┄ members</span>}>
                {weeks.length === 0 ? <Empty>No weekly data yet.</Empty> : <WeeklyChart weeks={weeks} />}
                <span className="mc-tip">
                  {peakActive === 0 ? "Nobody in this account has asked a question in the last 12 weeks." :
                    `This week ${lastWeek?.active ?? 0} of ${lastWeek?.members ?? 0} members asked a question. Peak: ${peakActive} in one week.`}
                </span>
              </Card>
              <Card title={`FEATURE BREADTH · ${breadth.filter((b) => b.on).length} OF ${breadth.length} FAMILIES USED`}>
                <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 8 }}>
                  {breadth.map((b) => (
                    <div key={b.k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 12, border: `1px solid ${b.on ? "var(--g-bd)" : "var(--line)"}`, background: b.on ? "var(--g-tint)" : "transparent" }}>
                      <span aria-hidden="true" style={{ color: b.on ? "var(--g)" : "var(--ink4)", fontWeight: 800 }}>{b.on ? "✓" : "—"}</span>
                      <span style={{ fontSize: 13, color: b.on ? "var(--ink)" : "var(--ink3)", flex: 1 }}>{b.k}</span>
                      <span className="mc-mono mc-num" style={{ fontSize: 12, color: "var(--ink2)" }}>{b.k === "Warehouse" ? (b.on ? "yes" : "no") : fmtN(b.v)}</span>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          )}

          {tab === "people" && (
            <Card title={`${data.members.length} MEMBERS`} right={<Link to={`/admin/people?q=${encodeURIComponent(a.personal ? (data.members[0]?.email || "") : a.domain || "")}`} className="mc-btn sm">Open in People</Link>}>
              {data.members.length === 0 ? <Empty>No members.</Empty> : (
                <div className="mc-tablewrap">
                  <table className="mc-table" style={{ minWidth: 720 }}>
                    <thead><tr><th>PERSON</th><th>WORKSPACE ROLE</th><th>STAGE</th><th>STATUS</th><th>QUESTIONS 30D</th><th>LAST ACTIVE</th></tr></thead>
                    <tbody>
                      {data.members.map((m: any) => {
                        const q = isMasked(m.email) ? m.name || "" : m.email;
                        return (
                          <tr key={m.id}>
                            <td>
                              <Link to={`/admin/people?q=${encodeURIComponent(q)}&open=${encodeURIComponent(m.id)}`} className="mc-rowbtn" style={{ color: "var(--ink)" }}>
                                <span style={{ fontWeight: 700 }}>{m.name || m.email}</span>
                                <span className="mc-tip">{m.email}</span>
                              </Link>
                            </td>
                            <td>{m.roles.length ? m.roles.join(", ") : "—"}</td>
                            <td>{m.lifecycle}</td>
                            <td><Pill tone={m.status === "active" ? "g" : m.status === "locked" || m.status === "suspended" ? "r" : m.status === "dormant" ? "a" : undefined}>{m.status}</Pill></td>
                            <td className="mc-mono mc-num">{fmtN(m.chats_30d)}</td>
                            <td className="mc-mono" style={{ fontSize: 12, color: "var(--ink2)" }}>{ago(m.last_active)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}

          {tab === "workspaces" && (
            <>
              <Card title={`${data.workspaces.length} WORKSPACES`}>
                {data.workspaces.length === 0 ? <Empty>No workspaces yet.</Empty> : (
                  <div className="mc-tablewrap">
                    <table className="mc-table" style={{ minWidth: 760 }}>
                      <thead><tr><th>WORKSPACE</th><th>MEMBERS</th><th>ACTIVE 30D</th><th>QUESTIONS 30D</th><th>SOURCES</th><th>ML</th><th>AUTOMATIONS</th><th>FITS</th></tr></thead>
                      <tbody>
                        {data.workspaces.map((w: any) => (
                          <tr key={w.id}>
                            <td>
                              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                <span style={{ fontWeight: 700 }}>{w.name}</span>
                                <span className="mc-tip">{w.personal ? "Personal" : "Shared"} · {w.owner_email || "no owner"} · {dateShort(w.created_at)}</span>
                              </div>
                            </td>
                            <td className="mc-mono mc-num">{fmtN(w.members)}</td>
                            <td className="mc-mono mc-num">{fmtN(w.active_30d)}</td>
                            <td className="mc-mono mc-num">{fmtN(w.chats_30d)}</td>
                            <td className="mc-mono mc-num">{fmtN(w.sources)}{w.warehouse ? " · WH" : ""}</td>
                            <td className="mc-mono mc-num">{fmtN(w.ml_models)}</td>
                            <td className="mc-mono mc-num">{fmtN(w.automations)}</td>
                            <td>{w.fit}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
              <Card title={`${data.sources.length} CONNECTED SOURCES`}>
                {data.sources.length === 0 ? <Empty>No data sources connected yet.</Empty> : (
                  <div className="mc-tablewrap">
                    <table className="mc-table" style={{ minWidth: 620 }}>
                      <thead><tr><th>SOURCE</th><th>KIND</th><th>ADDED</th><th>LAST SYNC</th><th>STATUS</th></tr></thead>
                      <tbody>
                        {data.sources.map((s: any) => (
                          <tr key={s.id}>
                            <td style={{ fontWeight: 600 }}>{s.name}</td>
                            <td><span className="mc-mono" style={{ fontSize: 12 }}>{s.kind}</span> <span className="mc-tip">· {s.group}</span></td>
                            <td className="mc-mono" style={{ fontSize: 12, color: "var(--ink2)" }}>{dateShort(s.created_at)}</td>
                            <td className="mc-mono" style={{ fontSize: 12, color: "var(--ink2)" }}>{s.last_synced_at ? ago(s.last_synced_at) : "—"}</td>
                            <td>{s.sync_error ? <span title={s.sync_error}><Pill tone="r">Failing</Pill></span> : <Pill tone="g">OK</Pill>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          )}

          {tab === "tickets" && (
            <>
              <Card title={`TICKETS · ${data.tickets.length}`} right={<Link to="/admin/support" className="mc-btn sm">Open support</Link>}>
                {data.tickets.length === 0 ? <Empty>No tickets from this account.</Empty> : data.tickets.map((t: any) => (
                  <Link key={t.id} to={`/admin/support?t=${encodeURIComponent(t.id)}`} style={{ display: "flex", gap: 10, alignItems: "center", color: "var(--ink)", padding: "8px 0", borderBottom: "1px solid var(--line0)", flexWrap: "wrap" }}>
                    <Pill tone={prioTone(t.priority)}>{t.priority}</Pill>
                    <span style={{ flex: "1 1 240px", minWidth: 0, fontSize: 13.5 }}>#{t.number} {t.subject}</span>
                    <span className="mc-tip">{t.status} · {t.assignee || "unassigned"} · {ago(t.created_at)}</span>
                  </Link>
                ))}
              </Card>
              <Card title={`DEALS · ${data.deals.length}`} right={<Link to="/admin/crm" className="mc-btn sm">Open pipeline</Link>}>
                {data.deals.length === 0 ? <Empty>{a.personal ? "Deals are tracked for company accounts." : "No deals for this domain yet."}</Empty> : data.deals.map((d: any) => (
                  <div key={d.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--line0)", flexWrap: "wrap" }}>
                    <span style={{ flex: "1 1 240px", fontWeight: 600 }}>{d.name}</span>
                    <Pill tone={d.stage === "won" ? "g" : d.stage === "lost" ? "r" : "b"}>{d.stage}</Pill>
                    <span className="mc-mono mc-num">{fmtUSD(d.amount)}</span>
                    <span className="mc-tip">{d.owner || "no owner"}{d.close_date ? ` · close ${dateShort(d.close_date)}` : ""}</span>
                  </div>
                ))}
              </Card>
            </>
          )}

          {tab === "timeline" && (
            <Card title="TIMELINE · CUSTOMER AND STAFF ACTIONS">
              {data.timeline.length === 0 ? <Empty>No recorded actions yet.</Empty> : data.timeline.map((e: any, i: number) => (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13, lineHeight: 1.45 }}>
                  <span className="mc-mono" style={{ fontSize: 11, color: "var(--ink3)", width: 64, flex: "none", paddingTop: 2 }}>{ago(e.t)}</span>
                  <span className="mc-dot" style={{ background: e.who === "staff" ? "var(--amber)" : "var(--blue)", width: 8, height: 8 }} />
                  <span style={{ color: "#D5DEDB", flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{e.text}</span>
                  <Pill tone={e.who === "staff" ? "a" : "b"}>{e.who}</Pill>
                </div>
              ))}
            </Card>
          )}
        </div>

        <aside className="mc-col" style={{ flex: "1 1 300px", gap: 16 }} aria-label="Account summary">
          {nba && (
            <Card title="NEXT BEST ACTION" style={{ borderColor: "var(--g-bd)", background: "#0A120F" }}>
              <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: "-0.01em" }}>{nba.title}</span>
              <span style={{ fontSize: 13, color: "var(--ink2)", lineHeight: 1.5 }}>{nba.why}</span>
              <Link to={`/admin/${nba.href}`} className="mc-btn p" style={{ alignSelf: "flex-start" }}>{nba.cta} →</Link>
            </Card>
          )}
          <Card title={`HEALTH ${a.health} · HOW IT IS SCORED`}>
            {(a.health_parts || []).map((p: any) => (
              <div key={p.k} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13 }}>
                  <span>{p.k}</span><span className="mc-mono mc-num" style={{ color: "var(--ink2)" }}>{p.score} / {p.weight}</span>
                </div>
                <div className="mc-bar"><div style={{ width: `${(p.score / Math.max(1, p.weight)) * 100}%`, background: p.score / Math.max(1, p.weight) >= 0.7 ? "var(--g)" : p.score / Math.max(1, p.weight) >= 0.4 ? "var(--amber)" : "var(--red)" }} /></div>
              </div>
            ))}
            <span className="mc-tip">70+ is healthy, 40–69 watch, under 40 at risk. Billing isn't scored until paid plans launch.</span>
          </Card>
          <Card title="ACCOUNT">
            <Fact k="Key" v={<span className="mc-mono" style={{ fontSize: 12 }}>{a.key}</span>} />
            <Fact k="Plan" v={a.plan || "Early access"} />
            <Fact k="Usage fits" v={a.fit} />
            <Fact k="Signed up" v={dateShort(a.signed_up)} />
            <Fact k="Last active" v={ago(a.last_active)} />
            <Fact k="Workspaces" v={fmtN(data.workspaces.length)} />
          </Card>
        </aside>
      </div>
    </div>
  );
}

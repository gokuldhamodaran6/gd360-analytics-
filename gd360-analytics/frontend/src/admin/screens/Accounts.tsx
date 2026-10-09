// Mission Control · Accounts — every company and personal account, with
// usage, health and the plan their usage already fits.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMC } from "../api";
import { ago, bandTone, Card, Chips, Empty, ErrorBox, fmtN, Kpi, Loading, PageHead, Pill, Seg } from "../ui";

type Kind = "all" | "company" | "personal";
type Band = "all" | "Healthy" | "Watch" | "At risk";
type Sort = "users" | "chats" | "health" | "recent" | "name";

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export default function Accounts() {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [band, setBand] = useState<Band>("all");
  const [sort, setSort] = useState<Sort>("users");
  const dq = useDebounced(q.trim());
  const qs = new URLSearchParams({ q: dq, kind, band, sort }).toString();
  const { data, error, loading, reload } = useMC<any>(`/accounts?${qs}`);
  const items: any[] = data?.items || [];
  const t = data?.totals;
  const filtered = !!(dq || kind !== "all" || band !== "all");

  return (
    <div className="mc-page">
      <PageHead eyebrow="Customers" title="Accounts"
        sub={t ? `${fmtN(t.all)} accounts · ${fmtN(t.company)} company · ${fmtN(t.personal)} personal. Company accounts group people by email domain. Everyone is on early access.` : "Companies and personal accounts, with usage and health."}>
        <button type="button" className="mc-btn" onClick={reload}>Refresh</button>
      </PageHead>

      {t && (
        <section aria-label="Account totals" className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" }}>
          <Kpi label="All accounts" value={fmtN(t.all)} sub="company + personal" />
          <Kpi label="Company accounts" value={fmtN(t.company)} sub="grouped by email domain" />
          <Kpi label="Personal accounts" value={fmtN(t.personal)} sub="free-mail sign-ups" />
          <Kpi label="At risk" value={fmtN(t.at_risk)} sub="health under 40, has asked before" tone={t.at_risk ? "warn" : undefined} />
        </section>
      )}

      <Card>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <label htmlFor="acct-q" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Search accounts</label>
          <input id="acct-q" className="mc-input" style={{ flex: "1 1 220px" }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or domain" />
          <Seg<Kind> label="Account type" value={kind} onChange={setKind} options={[["all", "All"], ["company", "Company"], ["personal", "Personal"]]} />
          <label className="mc-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>Sort
            <select className="mc-select" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="users">Most people</option>
              <option value="chats">Most questions</option>
              <option value="health">Lowest health</option>
              <option value="recent">Recently active</option>
              <option value="name">Name</option>
            </select>
          </label>
        </div>
        <Chips<Band> label="Health band" value={band} onChange={setBand} options={[["all", "Any health"], ["Healthy", "Healthy"], ["Watch", "Watch"], ["At risk", "At risk"]]} />
      </Card>

      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Loading rows={4} />}
      {data && (
        <Card title={`${fmtN(items.length)} ${items.length === 1 ? "ACCOUNT" : "ACCOUNTS"}${loading ? " · UPDATING…" : ""}`} pad>
          {items.length === 0 ? (
            <Empty>{filtered ? "No accounts match. Clear a filter or search by domain." : "No accounts yet. They appear as soon as someone signs up."}</Empty>
          ) : (
            <div className="mc-tablewrap">
              <table className="mc-table" style={{ minWidth: 1060 }}>
                <thead>
                  <tr><th>ACCOUNT</th><th>PEOPLE</th><th>ACTIVE 30D</th><th>QUESTIONS 30D</th><th>SOURCES</th><th>DASHBOARDS</th><th>HEALTH</th><th>FITS</th><th>TICKETS</th><th>LAST ACTIVE</th></tr>
                </thead>
                <tbody>
                  {items.map((a) => (
                    <tr key={a.key}>
                      <td>
                        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                          <Link to={`/admin/accounts/${encodeURIComponent(a.key)}`} style={{ fontWeight: 700, color: "var(--ink)" }}>{a.name || a.key}</Link>
                          <span className="mc-tip">{a.personal ? "Personal" : a.domain}{a.warehouse ? " · warehouse" : ""}{a.deals ? ` · ${a.deals} deal${a.deals === 1 ? "" : "s"}` : ""}</span>
                        </div>
                      </td>
                      <td className="mc-mono mc-num">{fmtN(a.users)}</td>
                      <td className="mc-mono mc-num">{fmtN(a.active_users_30d)}</td>
                      <td className="mc-mono mc-num">{fmtN(a.chats_30d)}</td>
                      <td className="mc-mono mc-num">{fmtN(a.sources)}</td>
                      <td className="mc-mono mc-num">{fmtN(a.dashboards)}</td>
                      <td><Pill tone={bandTone(a.health_band)}>{a.health} · {a.health_band}</Pill></td>
                      <td>{a.fit}</td>
                      <td className="mc-mono mc-num" style={{ color: a.open_tickets ? "var(--amber)" : undefined }}>{fmtN(a.open_tickets)}</td>
                      <td className="mc-mono" style={{ fontSize: 12, color: "var(--ink2)" }}>{ago(a.last_active)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {items.length >= 500 && <span className="mc-tip">Showing the first 500. Search or filter to narrow it down.</span>}
        </Card>
      )}
    </div>
  );
}

// Mission Control · Funnels & retention — activation, weekly retention,
// feature adoption, answer quality and connector health.
import { useState } from "react";
import { useMC } from "../api";
import { Card, Empty, ErrorBox, fmtN, fmtPct, HBars, Kpi, Loading, PageHead, Seg } from "../ui";

type SegKey = "all" | "corporate" | "freemail";
const SEG_LABEL: Record<SegKey, string> = { all: "All", corporate: "Company domain", freemail: "Freemail" };

const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
};
const weekLabel = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const minutes = (m: number | null | undefined) => {
  if (m == null) return null;
  if (m < 1) return `${Math.round(m * 60)} s`;
  if (m < 60) return `${m.toFixed(m < 10 ? 1 : 0)} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`;
  return `${(m / 1440).toFixed(1)} days`;
};
const kindLabel = (k: string) => (k || "—").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function Funnel({ steps }: { steps: { k: string; n: number }[] }) {
  const first = steps[0]?.n || 0;
  let worst = -1;
  let worstDrop = 0;
  steps.forEach((s, i) => {
    if (i === 0 || !steps[i - 1].n) return;
    const drop = 1 - s.n / steps[i - 1].n;
    if (drop > worstDrop) { worstDrop = drop; worst = i; }
  });
  const H = 180;
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${steps.length}, minmax(0,1fr))`, gap: 8, alignItems: "end", height: H + 56 }}>
        {steps.map((s, i) => {
          const prev = i > 0 ? steps[i - 1].n : 0;
          const drop = i > 0 && prev ? Math.round((1 - s.n / prev) * 100) : null;
          const hi = i === worst;
          return (
            <div key={s.k} style={{ display: "flex", flexDirection: "column", gap: 6, justifyContent: "flex-end", height: "100%" }}
              title={`${s.k}: ${fmtN(s.n)}${drop != null ? ` · ${drop}% dropped from the step before` : ""}`}>
              <span className="mc-num" style={{ fontSize: 20, fontWeight: 800 }}>{fmtN(s.n)}</span>
              <span className="mc-mono mc-num" style={{ fontSize: 11, color: hi ? "var(--amber)" : "var(--ink3)" }}>
                {i === 0 ? "100%" : `${first ? ((s.n / first) * 100).toFixed(1) : 0}%`}{drop != null ? ` · −${drop}%` : ""}
              </span>
              <div style={{ height: first ? Math.max(s.n ? 4 : 0, (s.n / first) * H) : 0, borderRadius: "8px 8px 3px 3px", background: hi ? "#F2B84B" : i === 0 ? "#7AA7FF" : "#2C9C70" }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${steps.length}, minmax(0,1fr))`, gap: 8 }}>
        {steps.map((s) => <span key={s.k} style={{ fontSize: 12, color: "var(--ink2)", lineHeight: 1.35 }}>{s.k}</span>)}
      </div>
      <span style={{ fontSize: 13.5, color: "#D5DEDB", lineHeight: 1.5 }}>
        {worst > 0
          ? <>Biggest drop: <b>{steps[worst - 1].k.toLowerCase()} → {steps[worst].k.toLowerCase()}</b> — <b style={{ color: "var(--amber)" }}>{Math.round(worstDrop * 100)}%</b> of people stop here. Fix this step first.</>
          : "No drop-off between steps in this cohort."}
      </span>
    </>
  );
}

function Heat({ rows }: { rows: any[] }) {
  const cols = rows[0]?.cells.length || 9;
  return (
    <div className="mc-tablewrap">
      <table style={{ borderCollapse: "separate", borderSpacing: 3, minWidth: 640, width: "100%", fontSize: 12 }}>
        <thead>
          <tr>
            <th className="mc-lbl" style={{ textAlign: "left", fontWeight: 500, padding: "0 6px 6px" }}>SIGN-UP WEEK</th>
            <th className="mc-lbl" style={{ fontWeight: 500, padding: "0 6px 6px", textAlign: "right" }}>N</th>
            {Array.from({ length: cols }).map((_, i) => <th key={i} className="mc-lbl" style={{ fontWeight: 500, paddingBottom: 6 }}>W{i}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.week}>
              <td style={{ padding: "0 6px", whiteSpace: "nowrap" }}>{weekLabel(r.week)}</td>
              <td className="mc-mono mc-num" style={{ padding: "0 6px", color: r.n ? "var(--ink2)" : "var(--ink4)", textAlign: "right" }}>{r.n}</td>
              {r.cells.map((v: number | null, i: number) => {
                const show = v != null && r.n > 0;
                return (
                  <td key={i} title={show ? `${weekLabel(r.week)} cohort · week ${i}: ${v}% active` : undefined}
                    style={{ height: 30, minWidth: 44, borderRadius: 6, textAlign: "center", fontFamily: "Geist Mono, monospace", fontVariantNumeric: "tabular-nums",
                      background: show ? `rgba(67,229,160,${(0.06 + (v / 100) * 0.84).toFixed(2)})` : "transparent",
                      color: show ? (v > 45 ? "#04140D" : "var(--ink)") : "var(--ink4)", fontWeight: show && v > 45 ? 700 : 500,
                      border: show ? "none" : "1px solid var(--line0)" }}>
                    {show ? `${v}%` : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Product() {
  const [cohort, setCohort] = useState("");
  const [seg, setSeg] = useState<SegKey>("all");
  const { data, error, loading, reload } = useMC<any>(`/product?seg=${seg}${cohort ? `&cohort=${cohort}` : ""}`);
  const cohorts: string[] = data?.cohorts?.length ? data.cohorts : data?.cohort ? [data.cohort] : [];
  const active = cohort || data?.cohort || "";
  const ttfa = minutes(data?.ttfa_median_min);
  const heatEmpty = data && data.heat.every((r: any) => !r.n);

  return (
    <div className="mc-page">
      <PageHead eyebrow="Product" title="Funnels & retention" sub="From sign-up to a published dashboard: who activates, who comes back, what they use, and how good the answers are.">
        <label className="mc-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <span className="mc-lbl">COHORT</span>
          <select className="mc-select" value={active} onChange={(e) => setCohort(e.target.value)} aria-label="Sign-up month">
            {cohorts.map((c) => <option key={c} value={c}>{monthLabel(c)}</option>)}
          </select>
        </label>
        <Seg<SegKey> label="Segment" value={seg} onChange={setSeg} options={[["all", "All"], ["corporate", "Company domain"], ["freemail", "Freemail"]]} />
        <button type="button" className="mc-btn" onClick={reload}>Refresh</button>
      </PageHead>

      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Loading rows={6} />}
      {data && (
        <>
          <Card title={`ACTIVATION FUNNEL · ${monthLabel(data.cohort).toUpperCase()} SIGN-UPS · ${SEG_LABEL[seg].toUpperCase()}`}
            right={<span className="mc-mono" style={{ fontSize: 12, color: "var(--ink2)" }}>time to first proven answer: {ttfa ? `median ${ttfa}` : "no proven answers yet"}</span>}>
            {data.funnel[0]?.n ? <Funnel steps={data.funnel} /> : <Empty>Nobody in this segment signed up in {monthLabel(data.cohort)}. Try another month or “All”.</Empty>}
          </Card>

          <div className="mc-row">
            <Card title="WEEKLY RETENTION · % OF SIGN-UP WEEK ACTIVE IN WEEK N" style={{ flex: "999 1 560px" }}
              right={<span className="mc-tip">active = asked at least one question</span>}>
              {heatEmpty ? <Empty>No sign-ups in the last 8 weeks for this segment, so there's nothing to retain yet.</Empty> : <Heat rows={data.heat} />}
              <span className="mc-tip">Last 8 sign-up weeks{seg !== "all" ? ` · ${SEG_LABEL[seg].toLowerCase()} only` : ""}. Darker green = more of that week's sign-ups came back. Blank = that week hasn't happened yet.</span>
            </Card>
            <Card title={`FEATURE ADOPTION · % OF ${fmtN(data.active_30d)} PEOPLE ACTIVE IN 30 DAYS`} style={{ flex: "1 1 320px" }}>
              {data.active_30d ? <HBars items={data.adoption} fmt={(v) => fmtPct(v, 0)} max={100} /> : <Empty>Nobody asked a question in the last 30 days.</Empty>}
            </Card>
          </div>

          <section aria-label="Answer quality" className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))" }}>
            {data.quality.map((q: any) => <Kpi key={q.k} label={q.k} value={q.v} sub={q.sub} />)}
          </section>

          <Card title="CONNECTORS · NEW SOURCES IN THE LAST 90 DAYS">
            {data.connectors.length === 0 ? <Empty>No sources connected in the last 90 days.</Empty> : (
              <div className="mc-tablewrap">
                <table className="mc-table" style={{ minWidth: 560 }}>
                  <thead><tr><th>CONNECTOR</th><th>SOURCES</th><th>SHARE</th><th>SYNC OK</th></tr></thead>
                  <tbody>
                    {data.connectors.map((c: any) => (
                      <tr key={c.kind}>
                        <td style={{ fontWeight: 600 }}>{kindLabel(c.kind)} <span className="mc-mono" style={{ fontSize: 11, color: "var(--ink3)" }}>{c.kind}</span></td>
                        <td className="mc-mono mc-num">{fmtN(c.n)}</td>
                        <td className="mc-mono mc-num">{fmtPct(c.share)}</td>
                        <td className="mc-mono mc-num" style={{ color: c.ok == null ? "var(--ink3)" : c.ok < 90 ? "var(--amber)" : "var(--g)", fontWeight: 700 }}>{c.ok == null ? "—" : `${c.ok}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <span className="mc-tip">Sync OK = share of those sources with no sync error right now. Amber under 90%.</span>
          </Card>
        </>
      )}
    </div>
  );
}

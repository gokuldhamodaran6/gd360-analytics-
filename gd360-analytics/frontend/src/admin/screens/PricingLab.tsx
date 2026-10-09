// Mission Control · Pricing lab & forecast — which plan each early-access
// workspace would land on, what that is worth, and a 24-month MRR planner.
// Everything below the data fetch is a client-side calculator.
import { useMemo, useState } from "react";
import { useMC } from "../api";
import { Bar, Card, Chips, Empty, ErrorBox, fmtN, fmtUSD, LineChart, Loading, PageHead, Pill, Seg } from "../ui";

const PLAN_INK: Record<string, string> = { Plus: "#F2B84B", Team: "#7AA7FF", Business: "#43E5A0", Enterprise: "#E8EEEC" };
const DEFAULT_CONV: Record<string, number> = { Plus: 12, Team: 20, Business: 25, Enterprise: 30 };
const RULES: Record<string, string> = {
  Plus: "One person, ≤ 200 questions a month, ≤ 5 sources.",
  Team: "2+ members or a warehouse; ≤ 500 questions per person, ≤ 25 sources.",
  Business: "10+ members, > 500 questions per person or > 25 sources.",
  Enterprise: "50+ members. Priced at the assumed contract value.",
};

type Levers = { eaMul: number; churn: number; exp: number; new0: number; growth: number; cost: number; margin: number };
type Preset = "bear" | "base" | "bull" | "custom";
const PRESETS: Record<Exclude<Preset, "custom">, Omit<Levers, "cost" | "margin">> = {
  bear: { eaMul: 0.6, churn: 5, exp: 0.5, new0: 750, growth: 5 },
  base: { eaMul: 1, churn: 3, exp: 1.5, new0: 1500, growth: 10 },
  bull: { eaMul: 1.4, churn: 2, exp: 2.5, new0: 2500, growth: 15 },
};

const k$ = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1)}k` : fmtUSD(n));

function Slider({ label, value, display, min, max, step, onChange }: { label: string; value: number; display: string; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="mc-field">
      <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>{label} <b className="mc-num mc-mono" style={{ color: "var(--ink)" }}>{display}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))}
        style={{ accentColor: "#43E5A0", width: "100%" }} />
    </label>
  );
}

export default function PricingLab() {
  const { data, error, loading, reload } = useMC<any>("/pricing-lab");
  const [conv, setConv] = useState<Record<string, number>>(DEFAULT_CONV);
  const [cap, setCap] = useState("200");
  const [preset, setPreset] = useState<Preset>("base");
  const [lv, setLv] = useState<Levers>({ ...PRESETS.base, cost: 20000, margin: 80 });

  const dist: any[] = data?.distribution || [];
  const expected = dist.reduce((s, d) => s + (d.mrr * (conv[d.plan] ?? 0)) / 100, 0);
  const ceiling = dist.reduce((s, d) => s + d.mrr, 0);
  const counted = data?.workspaces_counted || 0;

  const setLever = (k: keyof Levers) => (v: number) => {
    setLv((s) => ({ ...s, [k]: v }));
    if (k !== "cost" && k !== "margin") setPreset("custom");
  };
  const pickPreset = (p: Preset) => {
    setPreset(p);
    if (p !== "custom") setLv((s) => ({ ...s, ...PRESETS[p] }));
  };

  const fc = useMemo(() => {
    const now = new Date();
    const months = Array.from({ length: 24 }, (_, t) =>
      new Date(now.getFullYear(), now.getMonth() + 1 + t, 1).toLocaleDateString("en-GB", { month: "short", year: "2-digit" }));
    const ea = expected * lv.eaMul;
    let m = 0;
    let nw = lv.new0;
    const series: number[] = [];
    for (let t = 0; t < 24; t++) {
      m = m * (1 - lv.churn / 100 + lv.exp / 100) + nw + (t < 2 ? ea / 2 : 0);
      nw *= 1 + lv.growth / 100;
      series.push(m);
    }
    const be = series.findIndex((v) => (v * lv.margin) / 100 >= lv.cost);
    return { months, series, ea, be, beMrr: lv.margin > 0 ? lv.cost / (lv.margin / 100) : null };
  }, [expected, lv]);

  const capRow = data?.caps.find((c: any) => String(c.cap) === cap);

  return (
    <div className="mc-page">
      <PageHead eyebrow="Revenue · planning" title="Pricing lab & forecast"
        sub="Which plan each early-access workspace would land on, what that is worth, and where MRR could go from here. Billing isn't live, so every number here is a projection.">
        <button type="button" className="mc-btn" onClick={reload}>Refresh</button>
      </PageHead>

      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Loading rows={4} />}
      {data && (
        <>
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 640 }}>
                <span className="mc-lbl">FIT-TO-PLAN · {fmtN(counted)} ACTIVE EARLY-ACCESS WORKSPACES</span>
                <span className="mc-sub">Each workspace gets the smallest paid plan that covers today's usage. Set how many you expect to convert.</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                <span className="mc-lbl">EXPECTED NEW MRR</span>
                <span className="mc-num" style={{ fontSize: 30, fontWeight: 800, color: "var(--g)", letterSpacing: "-0.03em" }}>{fmtUSD(expected)}</span>
                <span className="mc-mono" style={{ fontSize: 11.5, color: "var(--ink3)" }}>of {fmtUSD(ceiling)} if every workspace converted</span>
              </div>
            </div>
            {counted === 0 ? <Empty>No active workspaces yet. Workspaces show up here once they ask a question or connect a source.</Empty> : (
              <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))" }}>
                {dist.map((d) => {
                  const share = counted ? (d.n / counted) * 100 : 0;
                  const c = conv[d.plan] ?? 0;
                  return (
                    <div key={d.plan} style={{ padding: 16, borderRadius: 14, border: "1px solid var(--line)", background: "var(--s2)", display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                        <span style={{ fontWeight: 800, fontSize: 16, color: PLAN_INK[d.plan] }}>{d.plan}</span>
                        <span className="mc-mono mc-num" style={{ fontSize: 12, color: "var(--ink2)" }}>{fmtN(d.n)} · {share.toFixed(1)}%</span>
                      </div>
                      <Bar pct={share} color={PLAN_INK[d.plan]} />
                      <span className="mc-tip">{RULES[d.plan]}</span>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                        <span style={{ color: "var(--ink3)" }}>{fmtN(d.seats)} seats · ceiling</span>
                        <span className="mc-mono mc-num">{fmtUSD(d.mrr)}/mo</span>
                      </div>
                      <Slider label={`${d.plan} conversion`} value={c} display={`${c}%`} min={0} max={60} step={1}
                        onChange={(v) => setConv((s) => ({ ...s, [d.plan]: v }))} />
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, borderTop: "1px solid var(--line0)", paddingTop: 8 }}>
                        <span style={{ color: "var(--ink3)" }}>{fmtUSD(d.mrr)} × {c}%</span>
                        <span className="mc-mono mc-num" style={{ fontWeight: 700 }}>{fmtUSD((d.mrr * c) / 100)}/mo</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 12, borderTop: "1px solid var(--line0)" }}>
              <span className="mc-lbl">PLUS CHAT CAP · SHARE OF ACTIVE PEOPLE ABOVE IT (30 DAYS)</span>
              <Chips label="Plus chat cap" value={cap} onChange={setCap}
                options={data.caps.map((c: any) => [String(c.cap), `${c.cap} chats → ${c.pct}%`] as [string, string])} />
              {capRow && (
                <span className="mc-sub">
                  At <b>{capRow.cap}</b> questions a month, <b style={{ color: capRow.pct > 20 ? "var(--amber)" : "var(--g)" }}>{fmtN(capRow.over)} of {fmtN(data.active_people)}</b> active people ({capRow.pct}%) would hit the Plus cap.
                </span>
              )}
            </div>
          </Card>

          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 760 }}>
                <span className="mc-lbl">24-MONTH FORECAST · {fc.months[0].toUpperCase()} – {fc.months[23].toUpperCase()}</span>
                <span className="mc-sub">
                  Each month, MRR = last month's MRR × (1 − churn + expansion) + new-logo MRR (growing by the growth rate) + early-access conversions, half in each of the first two months — starting from $0 because billing isn't live.
                </span>
              </div>
              <Seg label="Scenario" value={preset} onChange={pickPreset} options={[["bear", "Bear"], ["base", "Base"], ["bull", "Bull"]]} />
            </div>
            <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 16 }}>
              <Slider label="Early-access conversion × expected" value={lv.eaMul} display={`${lv.eaMul.toFixed(1)}× = ${fmtUSD(fc.ea)}`} min={0} max={3} step={0.1} onChange={setLever("eaMul")} />
              <Slider label="Churn per month" value={lv.churn} display={`${lv.churn}%`} min={0} max={10} step={0.5} onChange={setLever("churn")} />
              <Slider label="Expansion per month" value={lv.exp} display={`${lv.exp}%`} min={0} max={5} step={0.5} onChange={setLever("exp")} />
              <Slider label={`New-logo MRR in ${fc.months[0]}`} value={lv.new0} display={fmtUSD(lv.new0)} min={0} max={20000} step={250} onChange={setLever("new0")} />
              <Slider label="New-logo growth per month" value={lv.growth} display={`${lv.growth}%`} min={0} max={30} step={1} onChange={setLever("growth")} />
              <Slider label="Cost base per month" value={lv.cost} display={fmtUSD(lv.cost)} min={0} max={150000} step={1000} onChange={setLever("cost")} />
              <Slider label="Gross margin" value={lv.margin} display={`${lv.margin}%`} min={30} max={95} step={1} onChange={setLever("margin")} />
            </div>
            <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))" }}>
              {[
                [`MRR · ${fc.months[11]}`, k$(fc.series[11]), "var(--g)"],
                [`ARR exit · ${fc.months[11]}`, k$(fc.series[11] * 12), "var(--ink)"],
                [`MRR · ${fc.months[23]}`, k$(fc.series[23]), "var(--ink)"],
                ["Break-even", fc.be >= 0 ? fc.months[fc.be] : `after ${fc.months[23]}`, fc.be >= 0 && fc.be < 12 ? "var(--g)" : "var(--amber)"],
              ].map(([k, v, ink]) => (
                <div key={k} style={{ padding: "12px 14px", borderRadius: 12, background: "var(--s2)", display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mc-lbl">{k}</span>
                  <span className="mc-num" style={{ fontSize: 21, fontWeight: 800, color: ink }}>{v}</span>
                </div>
              ))}
            </div>
            <LineChart label={`Forecast MRR reaches ${k$(fc.series[11])} in ${fc.months[11]}`} height={220} fmt={k$}
              points={fc.series.map((v, i) => ({ label: fc.months[i], value: v }))} />
            <span className="mc-tip">
              Break-even = first month where MRR × {lv.margin}% margin covers the {fmtUSD(lv.cost)} cost base{fc.beMrr != null ? ` (MRR ≥ ${k$(fc.beMrr)})` : ""}. Presets change the growth levers only.
            </span>
          </Card>

          <Card title="TOP WORKSPACES BY FIT" pad>
            {data.top.length === 0 ? <Empty>No active workspaces yet.</Empty> : (
              <div className="mc-tablewrap">
                <table className="mc-table" style={{ minWidth: 820 }}>
                  <thead><tr><th>WORKSPACE</th><th>OWNER</th><th>FITS</th><th>MEMBERS</th><th>QUESTIONS 30D</th><th>PER PERSON</th><th>SOURCES</th><th>WAREHOUSE</th></tr></thead>
                  <tbody>
                    {data.top.map((w: any) => (
                      <tr key={w.id}>
                        <td style={{ fontWeight: 700 }}>{w.name}</td>
                        <td style={{ color: "var(--ink2)" }}>{w.owner_email || "—"}</td>
                        <td><Pill tone={w.fit === "Business" ? "g" : w.fit === "Team" ? "b" : w.fit === "Plus" ? "a" : "w"}>{w.fit}</Pill></td>
                        <td className="mc-mono mc-num">{fmtN(w.members)}</td>
                        <td className="mc-mono mc-num">{fmtN(w.chats_30d)}</td>
                        <td className="mc-mono mc-num">{fmtN(w.chats_per_user, 1)}</td>
                        <td className="mc-mono mc-num">{fmtN(w.sources)}</td>
                        <td>{w.warehouse ? "yes" : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

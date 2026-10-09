// Mission Control · AI usage & cost — metered model calls, estimated cost,
// per-person monthly caps and feature kill switches.
import { useEffect, useState } from "react";
import { mcPut, useMC } from "../api";
import {
  ActionButton, ago, Bar, Card, dateShort, Empty, ErrorBox, fmtN, fmtUSD, HBars, Kpi, LineChart, Loading, Modal, PageHead, Pill, Seg, useCan,
} from "../ui";

const NO = "Your role can't do this";
const usd = (v: number | null | undefined) =>
  v == null ? "—" : v === 0 ? "$0" : Math.abs(v) < 0.01 ? `$${v.toFixed(4)}` : Math.abs(v) < 100 ? fmtUSD(v, 2) : fmtUSD(v);
const compact = (n: number | null | undefined) =>
  n == null ? "—" : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : fmtN(n);
const secs = (ms: number | null | undefined) => (ms == null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const lbl = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function CapModal({ person, onClose, onSaved }: { person: any; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState("");
  useEffect(() => setV(person?.cap ? String(person.cap) : ""), [person]);
  const n = Number(v);
  const ok = v.trim() !== "" && Number.isFinite(n) && n > 0;
  return (
    <Modal open={!!person} onClose={onClose} title="Monthly AI cap">
      {person && (
        <>
          <span className="mc-sub">Cap for <b style={{ color: "var(--ink)" }}>{person.email}</b>. When their estimated AI cost for the month reaches it, their AI pauses until next month.</span>
          <label className="mc-field">Cap in US dollars per month
            <input className="mc-input mc-mono" type="number" min={0.5} step={0.5} autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="e.g. 25" />
          </label>
          <span className="mc-tip">Spent in this period: {usd(person.cost)} over {fmtN(person.calls)} calls.</span>
          <ActionButton className="mc-btn p" disabled={!ok} done="Cap saved" run={async () => {
            await mcPut("/ai/caps", { user_id: person.user_id, usd: n });
            onClose();
            onSaved();
          }}>Save cap</ActionButton>
        </>
      )}
    </Modal>
  );
}

export default function AiCost() {
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const [capFor, setCapFor] = useState<any>(null);
  const { data, error, loading, reload } = useMC<any>(`/ai?days=${days}`);
  const can = useCan();
  const canAi = can("ai.write");
  const k = data?.kpis;
  const totalCost = k?.cost || 0;
  const series = data?.series || [];

  return (
    <div className="mc-page">
      <PageHead eyebrow="Product · unit economics" title="AI usage & cost" sub="Every model call is metered: who made it, for which feature, on which model, what it cost and how fast it was.">
        <Seg<"7" | "30" | "90"> label="Period" value={days} onChange={setDays} options={[["7", "7D"], ["30", "30D"], ["90", "90D"]]} />
        <button type="button" className="mc-btn" onClick={reload}>Refresh</button>
      </PageHead>

      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Loading rows={8} />}
      {data && (
        <>
          <div className="mc-note">
            {data.metering_since
              ? <>Metering started <b style={{ color: "var(--ink)" }}>{dateShort(data.metering_since)}</b> ({ago(data.metering_since)}) — earlier usage isn't counted. Cost is an estimate from list prices.</>
              : <>Metering hasn't recorded a model call yet. Cost is an estimate from list prices.</>}
          </div>

          <section aria-label="Key metrics" className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" }}>
            <Kpi label="Model calls" value={fmtN(k.calls)} sub={`${fmtN(k.chats)} questions asked`} />
            <Kpi label="AI cost" value={usd(k.cost)} sub={`last ${days} days`} estimate />
            <Kpi label="Cost per question" value={usd(k.cost_per_chat)} sub="AI cost ÷ questions asked" estimate />
            <Kpi label="Tokens in / out" value={`${compact(k.tokens_in)} / ${compact(k.tokens_out)}`} sub={`${compact((k.tokens_in || 0) + (k.tokens_out || 0))} total`} />
            <Kpi label="Latency p50 / p95" value={`${secs(k.p50_ms)} / ${secs(k.p95_ms)}`} sub="per model call" />
            <Kpi label="Error rate" value={k.error_rate == null ? "—" : `${k.error_rate}%`} sub="calls that didn't return ok" tone={k.error_rate > 2 ? "warn" : undefined} />
          </section>

          {k.calls === 0 ? <Card><Empty>No model calls in the last {days} days. Try a longer period.</Empty></Card> : (
            <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(420px,1fr))" }}>
              <Card title="DAILY AI COST · EST.">
                {/* plotted in thousandths of a dollar so small daily costs still get readable axis ticks */}
                <LineChart label="Estimated AI cost per day" fmt={(v) => usd(v / 1000)} points={series.map((s: any) => ({ label: lbl(s.date), value: s.cost * 1000 }))} />
              </Card>
              <Card title="MODEL CALLS PER DAY">
                <LineChart label="Model calls per day" color="#7AA7FF" points={series.map((s: any) => ({ label: lbl(s.date), value: s.calls }))} />
              </Card>
            </div>
          )}

          <div className="mc-row">
            <Card title="BY MODEL" style={{ flex: "999 1 520px" }}>
              {data.by_model.length === 0 ? <Empty>No calls in this period.</Empty> : (
                <div className="mc-tablewrap">
                  <table className="mc-table" style={{ minWidth: 560 }}>
                    <thead><tr><th>MODEL</th><th>CALLS</th><th>TOKENS</th><th>COST · EST.</th><th style={{ width: 140 }}>SHARE OF COST</th></tr></thead>
                    <tbody>
                      {data.by_model.map((m: any) => {
                        const share = totalCost ? (m.cost / totalCost) * 100 : 0;
                        return (
                          <tr key={m.k}>
                            <td className="mc-mono" style={{ fontSize: 12.5 }}>{m.k}</td>
                            <td className="mc-mono mc-num">{fmtN(m.calls)}</td>
                            <td className="mc-mono mc-num">{compact(m.tokens)}</td>
                            <td className="mc-mono mc-num" style={{ fontWeight: 700 }}>{usd(m.cost)}</td>
                            <td><div style={{ display: "flex", gap: 8, alignItems: "center" }}><div style={{ flex: 1 }}><Bar pct={share} /></div><span className="mc-mono mc-num" style={{ fontSize: 11.5, color: "var(--ink2)", width: 38, textAlign: "right" }}>{share.toFixed(0)}%</span></div></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <Card title="BY FEATURE · COST" style={{ flex: "1 1 320px" }}>
              {data.by_feature.length === 0 ? <Empty>No calls in this period.</Empty> : (
                <HBars items={data.by_feature.map((f: any) => ({ k: f.k, v: f.cost, sub: `${fmtN(f.calls)} calls` }))} fmt={usd} />
              )}
            </Card>
          </div>

          <Card title="TOP PEOPLE BY AI COST · MONTHLY CAPS" right={<span className="mc-tip">A cap pauses that person's AI once their month's cost reaches it.</span>}>
            {data.top_users.length === 0 ? <Empty>No metered calls by people in this period, and no caps set.</Empty> : (
              <div className="mc-tablewrap">
                <table className="mc-table" style={{ minWidth: 820 }}>
                  <thead><tr><th>PERSON</th><th>PLAN</th><th>QUESTIONS 30D</th><th>CALLS</th><th>COST · EST.</th><th>MONTHLY CAP</th><th></th></tr></thead>
                  <tbody>
                    {data.top_users.map((u: any) => (
                      <tr key={u.user_id}>
                        <td style={{ fontWeight: 600 }}>{u.email}</td>
                        <td><Pill>{u.plan}</Pill></td>
                        <td className="mc-mono mc-num">{fmtN(u.chats_30d)}</td>
                        <td className="mc-mono mc-num">{fmtN(u.calls)}</td>
                        <td className="mc-mono mc-num" style={{ fontWeight: 700 }}>{usd(u.cost)}</td>
                        <td className="mc-mono mc-num" style={{ color: u.cap ? "var(--amber)" : "var(--ink3)" }}>{u.cap ? `${fmtUSD(u.cap, 2)} / mo` : "none"}</td>
                        <td>
                          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                            <button type="button" className="mc-btn sm" disabled={!canAi} title={canAi ? undefined : NO} onClick={() => setCapFor(u)}>{u.cap ? "Change cap" : "Set cap"}</button>
                            {u.cap != null && (
                              <ActionButton className="mc-btn sm d" disabled={!canAi} title={canAi ? undefined : NO} done="Cap removed"
                                run={async () => { await mcPut("/ai/caps", { user_id: u.user_id, usd: null }); reload(); }}>Remove cap</ActionButton>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <CapModal person={capFor} onClose={() => setCapFor(null)} onSaved={reload} />

          <Card title="FEATURE KILL SWITCHES">
            <span className="mc-sub">Pausing makes that feature answer “paused, try again shortly” for everyone. Use it when a feature's cost or errors spike. Takes effect within 30 seconds.</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {data.kill_switches.map((s: any) => (
                <ActionButton key={s.key} className="mc-btn" disabled={!canAi} title={canAi ? (s.paused ? `Resume ${s.label}` : `Pause ${s.label}`) : NO}
                  confirm={s.paused ? `Resume ${s.label} for everyone?` : `Pause ${s.label} for everyone?`}
                  done={`${s.label} ${s.paused ? "resumed" : "paused"}`}
                  run={async () => { await mcPut("/kill-switches", { key: s.key, paused: !s.paused }); reload(); }}>
                  <span aria-hidden="true" style={{ width: 30, height: 18, borderRadius: 18, background: s.paused ? "#FF7A6B" : "#43E5A0", position: "relative", flex: "none" }}>
                    <span style={{ position: "absolute", top: 2, left: s.paused ? 2 : 14, width: 14, height: 14, borderRadius: 14, background: "#07090A" }} />
                  </span>
                  {s.label}
                  <span style={{ fontSize: 11.5, color: s.paused ? "var(--red)" : "var(--ink3)" }}>{s.paused ? "paused" : "on"}</span>
                </ActionButton>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

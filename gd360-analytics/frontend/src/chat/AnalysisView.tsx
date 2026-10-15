// 2026-10-15 (R48): the analysis page on the canvas - finding first, then the evidence, the caveat, the
// composed figure, the risk tiers and what to do (mockup board 02). Every number comes from the runner's
// typed result; the prose was checked against it before it got here.
import { useState } from "react";
import type { Analysis, Signal, Tier } from "../api/v2";

const n0 = (v: number | null | undefined) => (v == null ? "—" : Math.round(v).toLocaleString());
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const pct = (v: number) => `${Number(v).toFixed(1)}%`;

function HBars({ rows, max, unit, color, baseline, baselineLabel, title, sub, ariaLabel }: {
  rows: { label: string; value: number; muted?: boolean; note?: string }[]; max: number; unit?: string; color: string;
  baseline?: number | null; baselineLabel?: string; title: string; sub?: string; ariaLabel: string;
}) {
  const hasNote = rows.some((r) => r.note);
  const W = 430, L = 158, R = hasNote ? 104 : 44, rowH = 30, top = 18;
  const H = top + rows.length * rowH + 30;
  const x = (v: number) => L + (Math.max(0, Math.min(v, max)) / max) * (W - L - R);
  const ticks = max >= 20 ? [0, max / 4, max / 2, (3 * max) / 4, max] : [0, max / 2, max];
  return (
    <figure className="an-fig">
      <span className="t">{title}</span>
      {sub && <span className="u">{sub}</span>}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
        {ticks.map((t) => <line key={t} className="gr" x1={x(t)} y1={top - 6} x2={x(t)} y2={H - 26} />)}
        {rows.map((r, i) => {
          const y = top + i * rowH;
          return (
            <g key={i}>
              <text x={L - 10} y={y + 15} textAnchor="end" className={r.muted ? "muted" : ""}>{r.label.length > 26 ? r.label.slice(0, 25) + "…" : r.label}</text>
              <rect x={L} y={y + 2} width={Math.max(x(r.value) - L, 3)} height={18} rx={4} fill={r.muted ? "rgb(var(--color-faint))" : color} />
              <text x={x(r.value) + 7} y={y + 15} className="val">{unit === "%" ? `${r.value}` : r.value}{r.note ? ` · ${r.note}` : ""}</text>
            </g>
          );
        })}
        {baseline != null && (
          <g>
            <line x1={x(baseline)} y1={top - 8} x2={x(baseline)} y2={H - 26} stroke="rgb(var(--color-text))" strokeWidth={1.5} strokeDasharray="5 4" />
            <text x={x(baseline) + 6} y={top - 10} className="val">{baselineLabel}</text>
          </g>
        )}
        <line className="ax" x1={L} y1={H - 26} x2={W - R} y2={H - 26} />
        {ticks.map((t) => <text key={"t" + t} x={x(t)} y={H - 10} textAnchor="middle">{unit === "%" ? `${Math.round(t)}` : t % 1 ? t.toFixed(2) : t}</text>)}
      </svg>
    </figure>
  );
}

function PRCurve({ curve, point, random, testN, ap }: { curve: [number, number][]; point: { recall: number; precision: number }; random: number; testN: number; ap: number }) {
  const W = 430, H = 260, L = 50, R = 24, T = 18, B = 46;
  const x = (r: number) => L + r * (W - L - R);
  const y = (p: number) => T + (1 - p) * (H - T - B);
  const pts = [...curve].sort((a, b) => a[0] - b[0]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
  return (
    <figure className="an-fig">
      <span className="t">Untouched test set: precision vs recall</span>
      <span className="u">{n0(testN)} rows the model never saw · average precision {ap}</span>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Precision-recall curve on ${testN} held-out rows, average precision ${ap}`}>
        {[0.25, 0.5, 0.75].map((v) => <line key={v} className="gr" x1={x(v)} y1={T} x2={x(v)} y2={H - B} />)}
        <line className="gr" x1={L} y1={y(0.5)} x2={W - R} y2={y(0.5)} />
        <line className="ax" x1={L} y1={H - B} x2={W - R} y2={H - B} /><line className="ax" x1={L} y1={T} x2={L} y2={H - B} />
        <line x1={L} y1={y(random)} x2={W - R} y2={y(random)} stroke="rgb(var(--color-faint))" strokeWidth={1.5} strokeDasharray="5 4" />
        <text x={L + 6} y={y(random) - 6} className="muted">Random ranking, {random}</text>
        <path d={d} fill="none" stroke="rgb(var(--color-primary))" strokeWidth={2.5} strokeLinejoin="round" />
        <circle cx={x(point.recall)} cy={y(point.precision)} r={4.5} fill="rgb(var(--color-primary))" stroke="rgb(var(--color-base))" strokeWidth={2} />
        <text x={x(point.recall) - 8} y={y(point.precision) + 22} textAnchor="end" className="val">Recall {point.recall} · precision {point.precision}</text>
        {[0, 0.25, 0.5, 0.75, 1].map((v) => <text key={"x" + v} x={x(v)} y={H - B + 18} textAnchor="middle">{v}</text>)}
        <text x={(L + W - R) / 2} y={H - 8} textAnchor="middle" className="muted">Recall (cases found)</text>
        {[0, 0.5, 1].map((v) => <text key={"y" + v} x={L - 8} y={y(v) + 4} textAnchor="end">{v}</text>)}
      </svg>
    </figure>
  );
}

function TierBars({ tiers, entities }: { tiers: Tier[]; entities: string }) {
  const W = 430, H = 260, L = 58, B = 46, T = 28;
  const max = Math.max(...tiers.map((t) => t.count), 1);
  const nice = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / nice) * nice;
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const colors: Record<string, string> = { high: "rgb(var(--color-danger))", medium: "rgb(var(--color-warning))", low: "rgb(var(--color-primary))" };
  const total = tiers.reduce((a, t) => a + t.count, 0);
  return (
    <figure className="an-fig">
      <span className="t">Current {entities} by risk tier</span>
      <span className="u">{n0(total)} {entities} scored out of fold · high = score 0.70 or more</span>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={tiers.map((t) => `${t.count} ${t.label.toLowerCase()}`).join(", ")}>
        {[0.25, 0.5, 0.75, 1].map((f) => <g key={f}><line className="gr" x1={L} y1={y(top * f)} x2={W - 24} y2={y(top * f)} /><text x={L - 8} y={y(top * f) + 4} textAnchor="end">{n0(top * f)}</text></g>)}
        <text x={L - 8} y={y(0) + 4} textAnchor="end">0</text>
        {tiers.map((t, i) => {
          const cx = L + 60 + i * 120;
          return (
            <g key={t.key}>
              <rect x={cx - 40} y={y(t.count)} width={80} height={Math.max(y(0) - y(t.count), 3)} rx={4} fill={colors[t.key]} />
              <text x={cx} y={y(t.count) - 8} textAnchor="middle" className="val">{n0(t.count)}</text>
              <text x={cx} y={H - B + 18} textAnchor="middle">{t.label}</text>
            </g>
          );
        })}
        <line className="ax" x1={L} y1={y(0)} x2={W - 24} y2={y(0)} />
        <text x={(L + W) / 2} y={H - 8} textAnchor="middle" className="muted">{cap(entities)}</text>
      </svg>
    </figure>
  );
}

function SignalTable({ signals, verb }: { signals: Signal[]; verb: string }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="an-table">
        <thead><tr><th>Signal group</th><th style={{ textAlign: "right" }}>{cap(verb)} in this group</th><th>Comparison group</th></tr></thead>
        <tbody>
          {signals.map((s) => (
            <tr key={s.column}><td>{cap(s.group)}</td><td className="n">{pct(s.group_rate)}</td><td>{pct(s.compare_rate)} with {s.compare}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AnalysisView({ a, onAsk, onOpenMethod }: { a: Analysis; onAsk?: (q: string) => void; onOpenMethod?: () => void }) {
  const [listOpen, setListOpen] = useState(false);
  const p = a.prose || { headline: "", summary: [], limitation: "", written_by: "template", replaced: [] };
  const ent = a.table.entities;
  const verb = a.target.verb;
  const tiers = a.tiers || [];
  const high = tiers[0];
  const byDim = a.by_dimension;
  const title = a.title || "Analysis";
  const risk = a.risk_list;
  return (
    <article className="an" data-c2-analysis={a.recipe}>
      <div className="an-head">
        <span className="c2-eb">Analysis · {a.table.source}</span>
        <h1>{title}</h1>
      </div>

      <section>
        <h2>Executive summary</h2>
        {p.summary[0] && <p className="p">{p.summary[0]}</p>}
        <p className="p"><b>{p.headline}</b>{p.summary[1] ? ` ${p.summary[1]}` : ""}</p>
        {p.limitation && <div className="an-call" data-c2-limitation=""><b>Important limitation.</b> {p.limitation}</div>}
      </section>

      {a.recipe === "segment" && byDim && (
        <section>
          <h2>{cap(a.target.noun)} by {byDim.label}</h2>
          <div className="an-grid">
            <HBars title={`${cap(a.target.noun)} rate by ${byDim.label}`} sub={`share who ${verb} · dashed line is all ${ent}, ${a.baseline.rate}%`} unit="%" color="rgb(var(--color-danger))"
              rows={byDim.values.map((v) => ({ label: v.value, value: v.rate, muted: v.rate < a.baseline.rate }))} max={Math.max(40, Math.ceil(Math.max(...byDim.values.map((v) => v.rate)) / 10) * 10)}
              baseline={a.baseline.rate} baselineLabel={`All ${ent} ${a.baseline.rate}%`} ariaLabel={`${a.target.noun} rate by ${byDim.label}`} />
            <HBars title={`${cap(ent)} who ${verb}, by ${byDim.label}`} sub="count" color="rgb(var(--color-primary))"
              rows={byDim.values.map((v) => ({ label: v.value, value: v.positives, note: `of ${n0(v.n)}` }))} max={Math.max(...byDim.values.map((v) => v.positives), 1)} ariaLabel={`count who ${verb} by ${byDim.label}`} />
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="an-table">
              <thead><tr><th>{cap(byDim.label)}</th><th style={{ textAlign: "right" }}>{cap(ent)}</th><th style={{ textAlign: "right" }}>{cap(verb)}</th><th style={{ textAlign: "right" }}>Rate</th><th style={{ textAlign: "right" }}>vs all</th></tr></thead>
              <tbody>
                {byDim.values.map((v) => <tr key={v.value}><td>{v.value}</td><td className="n">{n0(v.n)}</td><td className="n">{n0(v.positives)}</td><td className="n">{pct(v.rate)}</td><td className="n" style={{ color: v.vs_all_pp > 0 ? "rgb(var(--color-danger))" : "rgb(var(--color-good))" }}>{v.vs_all_pp > 0 ? "+" : ""}{v.vs_all_pp} pp</td></tr>)}
                <tr className="total"><td>All</td><td className="n">{n0(a.baseline.n)}</td><td className="n">{n0(a.baseline.positives)}</td><td className="n">{pct(a.baseline.rate)}</td><td className="n">—</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {a.recipe === "signal" && a.focus && (
        <section>
          <h2>{cap(a.focus.label)} against {a.target.noun}</h2>
          <div className="an-grid">
            {a.focus.kind !== "flat" && (
              <HBars title={`${cap(a.target.noun)} rate, %`} sub={`dashed line is all ${ent}, ${a.baseline.rate}%`} unit="%" color="rgb(var(--color-danger))"
                rows={[{ label: a.focus.group, value: a.focus.group_rate }, { label: a.focus.compare, value: a.focus.compare_rate, muted: true }]}
                max={Math.max(40, Math.ceil(Math.max(a.focus.group_rate, a.focus.compare_rate) / 10) * 10)} baseline={a.baseline.rate} baselineLabel={`All ${ent} ${a.baseline.rate}%`} ariaLabel={`${a.focus.label} against ${a.target.noun}`} />
            )}
            {a.importance.length > 0 && (
              <HBars title="Where it ranks among the signals" sub="held-out precision lost when the signal is shuffled · not causal" color="rgb(var(--color-primary))"
                rows={a.importance.map((d) => ({ label: d.label, value: d.value, muted: d.column !== a.focus!.column }))} max={Math.max(...a.importance.map((d) => d.value), 0.05)} ariaLabel="signal strength" />
            )}
          </div>
          {a.focus.values && a.focus.values.length > 0 && (
            <div style={{ overflowX: "auto" }}><table className="an-table"><thead><tr><th>{cap(a.focus.label)}</th><th style={{ textAlign: "right" }}>{cap(ent)}</th><th style={{ textAlign: "right" }}>Rate</th></tr></thead>
              <tbody>{a.focus.values.map((v) => <tr key={v.value}><td>{v.value}</td><td className="n">{n0(v.n)}</td><td className="n">{pct(v.rate)}</td></tr>)}</tbody></table></div>
          )}
        </section>
      )}

      {a.signals.length > 0 && (
        <section>
          <h2>{a.recipe === "outcome" ? "1. " : ""}The signals most associated with {a.target.noun}</h2>
          {p.signals_note && <p className="p">{p.signals_note}</p>}
          <SignalTable signals={a.signals} verb={verb} />
          <p className="p muted">These groups overlap; their effects should not be added together.</p>
        </section>
      )}

      {a.recipe === "outcome" && (a.importance.length > 0 || a.model) && (
        <div className="an-grid" data-c2-figures="">
          {a.importance.length > 0 && (
            <HBars title="Strongest predictive signals" sub="held-out precision lost when the signal is shuffled · not causal" color="rgb(var(--color-primary))"
              rows={a.importance.map((d) => ({ label: d.label, value: d.value }))} max={Math.max(...a.importance.map((d) => d.value), 0.05)} ariaLabel="signal strength in the model" />
          )}
          {a.segments.length > 0 && (
            <HBars title="Observed rate by group" sub={`historical ${a.target.noun} rate, % · dashed line is all ${ent}, ${a.baseline.rate}%`} unit="%" color="rgb(var(--color-danger))"
              rows={a.segments.map((s) => ({ label: s.label, value: s.rate, muted: !s.highlight }))} max={Math.max(40, Math.ceil(Math.max(...a.segments.map((s) => s.rate)) / 10) * 10)}
              baseline={a.baseline.rate} baselineLabel={`All ${ent} ${a.baseline.rate}%`} ariaLabel={`${a.target.noun} rate by group against the overall rate`} />
          )}
          {a.model && <PRCurve curve={a.model.pr_curve} point={a.model.point} random={a.model.baseline_ap} testN={a.model.test_n} ap={a.model.ap} />}
          {tiers.length > 0 && <TierBars tiers={tiers} entities={ent} />}
        </div>
      )}

      {tiers.length > 0 && (
        <section data-c2-tiers="">
          <h2>{a.recipe === "outcome" ? "2. " : ""}Who is likely to {a.target.noun === "churn" ? "leave" : `${verb.split(" ")[0]}`} next</h2>
          {p.tiers_note && <p className="p">{p.tiers_note}</p>}
          <div className="an-tiers">
            {tiers.map((t) => (
              <div key={t.key} className={`an-tier ${t.key}`}>
                <span className="v">{n0(t.count)}</span><span className="l">{t.label}</span>
                <span className="m">{t.rule} · {t.hist_rate}% of this band {verb} historically · {t.action}</span>
              </div>
            ))}
          </div>
          {risk && risk.rows.length > 0 && (
            <>
              <button type="button" className="c2-nx sm" onClick={() => setListOpen((o) => !o)} data-c2-risk-list="">{listOpen ? "Hide the list" : `See the ${n0(Math.min(risk.rows.length, risk.total_high || risk.rows.length))} to call first`}</button>
              {listOpen && (
                <div style={{ overflowX: "auto" }}>
                  <table className="an-table">
                    <thead><tr><th>{a.id_column || "Row"}</th><th style={{ textAlign: "right" }}>Score</th><th>Signals tripped</th></tr></thead>
                    <tbody>{risk.rows.slice(0, 50).map((r, i) => <tr key={i}><td className="c2-mono">{String(r.id)}</td><td className="n">{Number(r.score).toFixed(2)}</td><td>{(r.signals || []).join(" · ") || "—"}</td></tr>)}</tbody>
                  </table>
                  <p className="p muted" style={{ fontSize: 13 }}>Top 50 by score. Say "get me the full high-risk list" for all {n0(risk.total_high)} as a table you can download.</p>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {a.recommendations.length > 0 && (
        <section data-c2-recs="">
          <h2>{a.recipe === "outcome" ? "3. " : ""}What to do</h2>
          <div className="an-recs">
            {a.recommendations.map((r) => (
              <div key={r.n} className="an-rec">
                <span className="n">{r.n}</span>
                <div><p className="h">{r.title}</p><p className="b">{r.body}</p></div>
                <div className="r"><b>{n0(r.reach)} {ent}</b>{r.reach_note}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="an-foot">
        <span className="c2-eb">How this was worked out</span>
        <p className="p muted" style={{ fontSize: 13.5 }}>
          {a.method.formulas.filter(Boolean).join(" · ")}
          {a.table.sampled ? ` · a fair sample of ${n0(a.table.rows_used)} rows was read` : ""}
          {onOpenMethod && <> · <button type="button" className="an-link" onClick={onOpenMethod}>Open the method and code</button></>}
        </p>
        {onAsk && (
          <div className="c2-next">
            <button type="button" className="c2-nx sm" onClick={() => onAsk("make this a dashboard")}>Make a dashboard</button>
            <button type="button" className="c2-nx sm" onClick={() => onAsk(`write a one-page brief from this analysis`)}>Save as a document</button>
            {high && high.count > 0 && <button type="button" className="c2-nx sm" onClick={() => onAsk(`get me the ${high.count} high-risk ${ent} as a list`)}>Get the {n0(high.count)} as a list</button>}
            <button type="button" className="c2-nx sm" onClick={() => onAsk(`alert me if the ${a.target.noun} rate goes above ${Math.ceil(a.baseline.rate + 2)}%`)}>Alert me</button>
          </div>
        )}
      </div>
    </article>
  );
}

export function AnalysisMethod({ a }: { a: Analysis }) {
  return (
    <div className="c2-doc" data-c2-analysis-method="">
      <h1 style={{ fontSize: 24 }}>How I worked it out</h1>
      <p style={{ color: "rgb(var(--color-secondary))" }}>{a.question}</p>
      {a.method.steps.map((s, i) => (
        <div key={i} style={{ marginBottom: 14 }}>
          <h3 style={{ margin: "0 0 2px" }}>{i + 1}. {s.label}{s.ms != null ? <span style={{ fontWeight: 400, color: "rgb(var(--color-muted))", fontSize: 13 }}> · {(s.ms / 1000).toFixed(1)} s</span> : null}</h3>
          {s.detail && <p style={{ margin: 0, fontSize: 14, color: "rgb(var(--color-secondary))" }}>{s.detail}</p>}
        </div>
      ))}
      <h2>Formulas</h2>
      <ul>{a.method.formulas.filter(Boolean).map((f, i) => <li key={i}>{f}</li>)}</ul>
      {a.model && a.model.leaks.length > 0 && (<><h2>Removed as leaks</h2><ul>{a.model.leaks.map((l) => <li key={l.column}><code>{l.column}</code> — {l.reason}</li>)}</ul></>)}
      <h2>Code</h2>
      <pre className="c2-mono" style={{ whiteSpace: "pre-wrap", fontSize: 12.5, lineHeight: 1.5, background: "rgb(var(--color-surface))", borderRadius: 12, padding: "12px 14px", overflow: "auto" }}>{a.method.code}</pre>
    </div>
  );
}

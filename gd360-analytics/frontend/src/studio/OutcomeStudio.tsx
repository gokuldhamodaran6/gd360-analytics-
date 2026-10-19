// 2026-10-19 (R56, Studio board "Analysis, step by step"): an outcome analysis ("why do customers leave, who is
// next") on the canvas as numbered steps - the data, the metric, the findings, the signals, the figures, who is
// likely next, what to do - each with Ask. The same numbers as the R48 report; only the shape is the Studio's.
import { useState } from "react";
import type { Turn } from "../api/v2";
import { cap, HBars, n0, pct, PRCurve, SignalTable, TierBars } from "../chat/AnalysisView";
import { StepCard, type FrameBits } from "./AnalysisStudio";
import { MenuButton, StudioFrame } from "./Frame";
import { Ic } from "./icons";

export function OutcomeStudio({ turn, frame, onAsk, onPrefill, onOpenMethod }: {
  turn: Turn; frame: FrameBits; onAsk: (q: string) => void; onPrefill: (q: string) => void; onOpenMethod: () => void;
}) {
  const a = turn.analysis!;
  const [listOpen, setListOpen] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const p = a.prose || { headline: "", summary: [], limitation: "", written_by: "template", replaced: [] };
  const ent = a.table.entities;
  const verb = a.target.verb;
  const tiers = a.tiers || [];
  const high = tiers[0];
  const risk = a.risk_list;
  const byDim = a.by_dimension;
  let n = 0;
  const next = () => ++n;
  const ask = (what: string) => <button type="button" className="sd-tool sm" onClick={() => onPrefill(`About ${what}: `)}><Ic n="wand" />Ask</button>;
  const download = () => {
    const blob = new Blob([turn.document?.markdown || ""], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a"); el.href = url; el.download = `${(a.title || "analysis").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60)}.md`;
    document.body.appendChild(el); el.click(); el.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  return (
    <StudioFrame kind="analysis" tabs={frame.tabs} addMenu={frame.addMenu} onClose={frame.onClose}
      status={`${n0(a.baseline.n)} ${ent}${a.model ? " · model tested" : ""}${a.elapsed_s ? ` · ${Math.round(a.elapsed_s)} s` : ""}`}
      actions={<>
        <button type="button" className="sd-pill" onClick={() => { void navigator.clipboard?.writeText(window.location.href).catch(() => undefined); }}><Ic n="share" />Share</button>
        <MenuButton className="sd-btnp" label="Turn into" align="right" data="turn-into">
          {(close) => <>
            <button type="button" onClick={() => { close(); onAsk("make this a dashboard"); }} data-sd-into="dashboard"><span>A dashboard</span><small>the rate, the signals and who is next, live</small></button>
            <button type="button" onClick={() => { close(); onAsk("write a one-page brief from this analysis"); }} data-sd-into="doc"><span>A document</span><small>a one-page brief, every number linked</small></button>
            {high && high.count > 0 && <button type="button" onClick={() => { close(); onAsk(`get me the ${high.count} high-risk ${ent} as a list`); }}><span>A list of the {n0(high.count)}</span><small>Excel and CSV of every row</small></button>}
            <button type="button" onClick={() => { close(); onAsk(`alert me if the ${a.target.noun} rate goes above ${Math.ceil(a.baseline.rate + 2)}%`); }}><span>An alert</span><small>when the rate passes {Math.ceil(a.baseline.rate + 2)}%</small></button>
          </>}
        </MenuButton>
      </>}
      tools={<>
        <button type="button" className="sd-tool" onClick={() => onAsk(turn.question)}><Ic n="play" />Run again</button>
        <span className="sd-vr" />
        <span className="sd-tool" style={{ cursor: "default" }}><Ic n="db" />{a.table.source} · {a.table.table}</span>
        <span className="sd-tool" style={{ cursor: "default" }}><Ic n="filter" />{a.table.sampled ? `a fair sample of ${n0(a.table.rows_used)} rows` : `all ${n0(a.table.rows_used)} rows`}</span>
        <span className="sd-vr" />
        <button type="button" className={`sd-tool${showCode ? " on" : ""}`} onClick={() => setShowCode((s) => !s)} data-sd-show-code=""><Ic n="code" />{showCode ? "Hide code" : "Show code"}</button>
        <button type="button" className="sd-tool" onClick={onOpenMethod} data-c2-open-method=""><Ic n="test" />Method</button>
        <button type="button" className="sd-tool" onClick={download}><Ic n="dl" />Download</button>
      </>}>
      <div className="sd-nb an-wrap" data-c2-analysis-canvas="" data-c2-analysis={a.recipe}>
        <StepCard n={next()} kind="data" title={`${cap(ent)} from ${a.table.table}`} acts={ask(`the data (${a.table.table})`)}
          foot={<><span className="sd-chip">{n0(a.table.rows_used)} rows</span><span className="sd-chip">{a.table.columns} columns</span><span className="sd-chip"><Ic n="db" />{a.table.source}</span>
            {a.has_dates ? <span className="sd-chip">dated rows</span> : <span className="sd-chip">no dates · group against group</span>}</>}>
          <div className="sd-sub">Every {ent.replace(/s$/, "")} is one row. {a.target.label ? `The outcome is ${a.target.label}.` : ""}</div>
          {showCode && <pre className="sd-code">{a.method.code}</pre>}
        </StepCard>
        <StepCard n={next()} kind="metric" title={`${cap(a.target.noun)} rate`} acts={ask(`the ${a.target.noun} rate`)}>
          <span className="sd-fx" style={{ alignSelf: "flex-start" }}>{a.method.formulas[0] || `${a.target.noun} rate = ${ent} who ${verb} ÷ all ${ent}`}</span>
          <div className="sd-big"><span className="sd-lbl">All {ent}</span><span className="v">{pct(a.baseline.rate)}</span><span className="sd-chip">{n0(a.baseline.positives)} of {n0(a.baseline.n)}</span></div>
        </StepCard>
        <StepCard n={next()} kind="text" title="Findings" acts={ask("the findings")}
          badge={p.written_by === "template" ? <span className="sd-chip">Written from the numbers</span> : null}>
          <div className="sd-prose">
            {p.summary[0] && <p>{p.summary[0]}</p>}
            <p><b>{p.headline}</b>{p.summary[1] ? ` ${p.summary[1]}` : ""}</p>
          </div>
          {p.limitation && <div className="an-call" data-c2-limitation=""><b>Important limitation.</b> {p.limitation}</div>}
        </StepCard>
        {a.recipe === "segment" && byDim && (
          <StepCard n={next()} kind="chart" title={`${cap(a.target.noun)} by ${byDim.label}`} acts={ask(`${a.target.noun} by ${byDim.label}`)}>
            <div className="an-grid">
              <HBars title={`${cap(a.target.noun)} rate by ${byDim.label}`} sub={`share who ${verb} · dashed line is all ${ent}, ${a.baseline.rate}%`} unit="%" color="rgb(var(--color-danger))"
                rows={byDim.values.map((v) => ({ label: v.value, value: v.rate, muted: v.rate < a.baseline.rate }))} max={Math.max(40, Math.ceil(Math.max(...byDim.values.map((v) => v.rate)) / 10) * 10)}
                baseline={a.baseline.rate} baselineLabel={`All ${ent} ${a.baseline.rate}%`} ariaLabel={`${a.target.noun} rate by ${byDim.label}`} />
              <HBars title={`${cap(ent)} who ${verb}, by ${byDim.label}`} sub="count" color="rgb(var(--color-primary))"
                rows={byDim.values.map((v) => ({ label: v.value, value: v.positives, note: `of ${n0(v.n)}` }))} max={Math.max(...byDim.values.map((v) => v.positives), 1)} ariaLabel={`count who ${verb} by ${byDim.label}`} />
            </div>
          </StepCard>
        )}
        {a.recipe === "signal" && a.focus && a.focus.kind !== "flat" && (
          <StepCard n={next()} kind="chart" title={`${cap(a.focus.label)} against ${a.target.noun}`} acts={ask(a.focus.label)}>
            <HBars title={`${cap(a.target.noun)} rate, %`} sub={`dashed line is all ${ent}, ${a.baseline.rate}%`} unit="%" color="rgb(var(--color-danger))"
              rows={[{ label: a.focus.group, value: a.focus.group_rate }, { label: a.focus.compare, value: a.focus.compare_rate, muted: true }]}
              max={Math.max(40, Math.ceil(Math.max(a.focus.group_rate, a.focus.compare_rate) / 10) * 10)} baseline={a.baseline.rate} baselineLabel={`All ${ent} ${a.baseline.rate}%`} ariaLabel={`${a.focus.label} against ${a.target.noun}`} />
          </StepCard>
        )}
        {a.signals.length > 0 && (
          <StepCard n={next()} kind="table" title={`The signals most associated with ${a.target.noun}`} acts={ask("the signals")}>
            {p.signals_note && <div className="sd-sub">{p.signals_note}</div>}
            <SignalTable signals={a.signals} verb={verb} />
            <div className="sd-note">These groups overlap; their effects should not be added together.</div>
          </StepCard>
        )}
        {a.recipe === "outcome" && (a.importance.length > 0 || a.model) && (
          <StepCard n={next()} kind="chart" title="What predicts it, and how well" acts={ask("the model and its signals")}
            foot={a.model ? <span className="sd-proof"><span className="sd-dot violet" />Modelled · tested on {n0(a.model.test_n)} {ent} it never saw · AP {a.model.ap}</span> : undefined}>
            <div className="an-grid" data-c2-figures="">
              {a.importance.length > 0 && <HBars title="Strongest predictive signals" sub="held-out precision lost when the signal is shuffled · not causal" color="rgb(var(--color-primary))"
                rows={a.importance.map((d) => ({ label: d.label, value: d.value }))} max={Math.max(...a.importance.map((d) => d.value), 0.05)} ariaLabel="signal strength in the model" />}
              {a.segments.length > 0 && <HBars title="Observed rate by group" sub={`historical ${a.target.noun} rate, % · dashed line is all ${ent}, ${a.baseline.rate}%`} unit="%" color="rgb(var(--color-danger))"
                rows={a.segments.map((s) => ({ label: s.label, value: s.rate, muted: !s.highlight }))} max={Math.max(40, Math.ceil(Math.max(...a.segments.map((s) => s.rate)) / 10) * 10)}
                baseline={a.baseline.rate} baselineLabel={`All ${ent} ${a.baseline.rate}%`} ariaLabel={`${a.target.noun} rate by group against the overall rate`} />}
              {a.model && <PRCurve curve={a.model.pr_curve} point={a.model.point} random={a.model.baseline_ap} testN={a.model.test_n} ap={a.model.ap} />}
              {tiers.length > 0 && <TierBars tiers={tiers} entities={ent} />}
            </div>
          </StepCard>
        )}
        {tiers.length > 0 && (
          <StepCard n={next()} kind="table" title={`Who is likely to ${a.target.noun === "churn" ? "leave" : verb.split(" ")[0]} next`} acts={ask("who is likely next")}>
            <div data-c2-tiers="" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {p.tiers_note && <div className="sd-sub">{p.tiers_note}</div>}
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
                  <button type="button" className="sd-pill sm" style={{ alignSelf: "flex-start" }} onClick={() => setListOpen((o) => !o)} data-c2-risk-list="">{listOpen ? "Hide the list" : `See the ${n0(Math.min(risk.rows.length, risk.total_high || risk.rows.length))} to call first`}</button>
                  {listOpen && (
                    <div className="sd-card sd-tw">
                      <table className="sd-t">
                        <thead><tr><th>{a.id_column || "Row"}</th><th className="r">Score</th><th>Signals tripped</th></tr></thead>
                        <tbody>{risk.rows.slice(0, 50).map((r, i) => <tr key={i}><td className="sd-mono">{String(r.id)}</td><td className="num">{Number(r.score).toFixed(2)}</td><td>{(r.signals || []).join(" · ") || "—"}</td></tr>)}</tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
          </StepCard>
        )}
        {a.recommendations.length > 0 && (
          <StepCard n={next()} kind="text" title="What to do" acts={ask("what to do")}>
            <div className="an-recs" data-c2-recs="">
              {a.recommendations.map((r) => (
                <div key={r.n} className="an-rec">
                  <span className="n">{r.n}</span>
                  <div><p className="h">{r.title}</p><p className="b">{r.body}</p></div>
                  <div className="r"><b>{n0(r.reach)} {ent}</b>{r.reach_note}</div>
                </div>
              ))}
            </div>
          </StepCard>
        )}
      </div>
    </StudioFrame>
  );
}

// Event 360: the whole event on one screen - one timeline, the numbers
// before / during / after, the funnel, the expectations and the channels.
import { useMemo, useState } from "react";
import { Initiative } from "../api/initiatives";
import { Overview } from "../api/eventos";
import { Bullet, C, FunnelSteps, PHASE_COLOR, TimeArea } from "./charts";
import { ActionList, Card, Eyebrow, fmtv, Legend, MetricRow, money, Seg, Skel, TruthPill } from "./kit";
import type { EvTab } from "./EventShell";

type Metric = "registrations" | "checkins" | "mentions" | "spend";

export default function Overview360({ i, ov, reload = () => undefined, goto: go, readOnly = false }: { i?: Initiative; ov: Overview | null; reload?: () => void; goto?: (t: EvTab) => void; readOnly?: boolean }) {
  const goto = go || (() => undefined);
  const ro = readOnly || !i;
  const [metric, setMetric] = useState<Metric>("registrations");
  const daily = ov?.daily || [];
  const series = useMemo(() => {
    const color = { registrations: C.primary, checkins: C.s(2), mentions: C.violet, spend: C.warning }[metric];
    const label = { registrations: "Registrations", checkins: "Check-ins", mentions: "Posts about the event", spend: "Ad spend" }[metric];
    return [{ key: metric, label, color, kind: "area" as const, values: daily.map((d) => Number(d[metric]) || 0) }];
  }, [daily, metric]);
  if (!ov) return <div className="grid gap-4"><Skel h={140} /><Skel h={300} /><Skel h={260} /></div>;
  const ev = ov.event;
  const sc = ov.score;
  const cur = ov.currency;
  const now = sc.now.score;
  const pred = sc.predicted;
  const met = sc.goals.filter((g) => g.meets).length;
  const finals = sc.goals.filter((g) => g.final).length;
  const headline = now !== null
    ? `${met} of ${finals} goals met${finals < sc.goals.length ? ` · ${sc.goals.length - finals} still counting` : ""}`
    : pred?.median !== null && pred?.median !== undefined ? `Predicted ${pred.median} (80% range ${pred.p10}–${pred.p90}) · ${pred.odds70}% chance of meeting expectations`
      : "Add the success goals to see a prediction";
  const totals = {
    before: daily.filter((d) => d.phase === "before"), during: daily.filter((d) => d.phase === "during"), after: daily.filter((d) => d.phase === "after"),
  };
  const phaseTitle = { before: "Before", during: "During", after: "After" } as const;
  const range = (ph: "before" | "during" | "after") => {
    const w = ev.windows;
    const f = (s: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "–");
    if (ph === "before") return `${f(w.open)} – ${f(w.start)}`;
    if (ph === "during") return `${f(w.start)} – ${f(w.end)}`;
    return `${f(w.end)} – ${f(w.close)}`;
  };
  const daysFrom = (ph: "before" | "during" | "after") => totals[ph].length;
  return (
    <div className="flex flex-col gap-5" data-screen="event360">
      <Card tone="accent">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-1 min-w-0">
            <Eyebrow>Event 360 · everything about this event, in one place</Eyebrow>
            <div className="text-[19px] sm:text-[21px] font-semibold text-text tracking-tight text-balance">{headline}</div>
            <div className="text-caption text-muted flex flex-wrap gap-x-3 gap-y-1 items-center">
              {now !== null && <span>Score {now} · {sc.now.confidence}% backed by counted or matched numbers{sc.now.capped ? " · capped at 60 by a safety goal" : ""}</span>}
              {Object.entries(sc.truth_mix).map(([k, v]) => <span key={k} className="inline-flex items-center gap-1"><TruthPill truth={k} small /> {v}%</span>)}
            </div>
          </div>
          <Seg label="Timeline" value={metric} onChange={(v) => setMetric(v as Metric)} items={[
            { id: "registrations", label: "Registrations" }, { id: "checkins", label: "Check-ins" }, { id: "mentions", label: "Posts" }, { id: "spend", label: "Spend" },
          ]} />
        </div>
        <TimeArea ariaLabel={`${series[0].label} per day across the event's life, before, during and after`} dates={daily.map((d) => d.date)}
          phases={daily.map((d) => d.phase)} series={series} height={230}
          yFormat={metric === "spend" ? (v) => money(v, cur) : undefined} />
        <Legend items={[{ label: "Before", color: PHASE_COLOR.before }, { label: "During", color: PHASE_COLOR.during }, { label: "After", color: PHASE_COLOR.after }]} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        {(["before", "during", "after"] as const).map((ph) => (
          <Card key={ph} className="relative overflow-hidden" pad>
            <span className="absolute inset-x-0 top-0 h-[2px]" style={{ background: PHASE_COLOR[ph] }} />
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em]" style={{ color: PHASE_COLOR[ph] }}>{phaseTitle[ph]} · {range(ph)}</span>
              <span className="text-caption text-muted">{daysFrom(ph) ? `${daysFrom(ph)} days` : ""}</span>
            </div>
            <div className="flex flex-col">
              {ov.kpis[ph].map((k) => <MetricRow key={k.key} k={k} currency={cur} />)}
            </div>
            {!ro && <button type="button" className="self-start text-caption text-brand-ink hover:underline"
              onClick={() => goto(ph === "before" ? "growth" : ph === "during" ? "live" : "report")}>
              {ph === "before" ? "Open growth and demand →" : ph === "during" ? "Open the live view →" : "Open the report →"}
            </button>}
          </Card>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_1fr_1fr]">
        <Card title="From first view to won deal" sub="Every stage, counted or matched">
          {ov.funnel.length ? <FunnelSteps rows={ov.funnel} /> : <div className="text-caption text-muted">The funnel fills in as people register.</div>}
        </Card>
        <Card title="Expectations, one line each" sub="dot = actual or so far · tick = target · band = the agreed range"
          right={ro ? undefined : <button type="button" className="text-brand-ink hover:underline" onClick={() => goto("success")}>Open</button>}>
          {sc.goals.length ? (
            <div className="flex flex-col gap-2.5">
              {sc.goals.map((g) => (
                <div key={g.id} className="flex flex-col gap-0.5" data-goal-line={g.metric}>
                  <div className="flex items-baseline justify-between gap-2 text-caption">
                    <span className="text-text truncate">{g.label} <span className="text-muted">· {g.owner_name}</span></span>
                    <span className="tabular-nums font-mono shrink-0" style={{ color: g.score === null ? C.muted : g.score >= 70 ? C.good : C.warning }}>
                      {g.score !== null ? Math.round(g.score) : g.likelihood !== null && g.likelihood !== undefined ? `${g.likelihood}%` : "–"}
                    </span>
                  </div>
                  <Bullet low={g.low} target={g.target} high={g.high} actual={g.actual} lowerIsBetter={g.lower_is_better} predicted={!g.final}
                    fmtv={(v) => fmtv(v, g.unit, cur)} />
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2 items-start text-caption text-muted">No goals yet. Agree what success means before spending a rupee.
              {!ro && <button type="button" className="btn-primary text-sm" onClick={() => goto("success")}>Set the goals</button>}</div>
          )}
        </Card>
        <Card title="Where people came from" sub="Registrations, ICP share and cost per ICP person"
          right={ro ? undefined : <button type="button" className="text-brand-ink hover:underline" onClick={() => goto("growth")}>All channels</button>}>
          <div className="flex flex-col">
            <div className="grid grid-cols-[minmax(0,1fr)_56px_48px_72px] gap-2 text-[11.5px] text-muted pb-2 border-b border-border"><span>Channel</span><span className="text-right">Regs</span><span className="text-right">ICP</span><span className="text-right">Per ICP</span></div>
            {ov.channels.slice(0, 7).map((c) => (
              <div key={c.channel} className="grid grid-cols-[minmax(0,1fr)_56px_48px_72px] gap-2 py-2 border-b border-border last:border-b-0 text-ui items-center">
                <span className="truncate text-text">{c.channel}</span>
                <span className="text-right tabular-nums">{c.registrations.toLocaleString()}</span>
                <span className="text-right tabular-nums text-secondary">{c.icp_share !== null ? `${Math.round(c.icp_share)}%` : "–"}</span>
                <span className="text-right tabular-nums text-secondary">{c.cost_per_icp ? money(c.cost_per_icp, cur) : "–"}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className={`grid gap-4 ${ro ? "" : "lg:grid-cols-[1.4fr_1fr]"}`}>
        {!ro && i && <ActionList initiativeId={i.id} actions={ov.actions || []} canEdit={ov.can_edit} onChanged={reload} empty="Nothing needs you right now - the agent watches the numbers and suggests the next move." />}
        {!ro && !ev.sample && ov.setup && ov.setup.ready < 100 ? (
          <Card title={`Tracking readiness ${ov.setup.ready}%`} sub="What's left before every number fills itself in" right={<button type="button" className="text-brand-ink hover:underline" onClick={() => goto("setup")}>Finish setup</button>}>
            <div className="flex flex-col">
              {ov.setup.checks.map((c) => (
                <div key={c.key} className="flex items-center gap-2.5 py-2 border-t border-border first:border-t-0 text-ui">
                  {c.ok ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-good))" strokeWidth="2.4"><path d="M5 12l5 5 9-10" /></svg>
                    : <span className="w-4 h-4 rounded-full border-2 border-warning" />}
                  <span className={c.ok ? "text-secondary" : "text-text"}>{c.label}</span>
                  {!c.ok && <span className="ml-auto text-caption text-warning">{c.fix}</span>}
                </div>
              ))}
            </div>
          </Card>
        ) : (
          <Card title="Money" sub="Cost, income and what came back">
            <div className="grid grid-cols-2 gap-4">
              {[["Event cost", ov.values.total_cost], ["Sponsor and ticket income", ov.values.income]].map(([l, v]) => (
                <div key={String(l)} className="flex flex-col"><span className="text-caption text-muted">{l}</span>
                  <span className="text-[22px] font-semibold tabular-nums">{money(v as number | null, cur)}</span></div>
              ))}
            </div>
            {!ro && <button type="button" className="self-start text-caption text-brand-ink hover:underline" onClick={() => goto("report")}>P&amp;L, pipeline and ROI in the report →</button>}
          </Card>
        )}
      </div>
    </div>
  );
}

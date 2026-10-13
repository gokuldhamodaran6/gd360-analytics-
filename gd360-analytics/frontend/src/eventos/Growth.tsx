// Growth: are we on track to fill the room with the right people?
import { useEffect, useMemo, useState } from "react";
import { Initiative } from "../api/initiatives";
import { eventApi, errText, Growth } from "../api/eventos";
import { Banner } from "../initiatives/ui";
import { C, FunnelSteps, TimeArea } from "./charts";
import { ActionList, Card, Eyebrow, KpiTile, Legend, money, Skel } from "./kit";

export default function GrowthTab({ i }: { i: Initiative }) {
  const [g, setG] = useState<Growth | null>(null);
  const [err, setErr] = useState("");
  const load = () => { eventApi.growth(i.id).then(setG).catch((e) => setErr(errText(e))); };
  useEffect(load, [i.id]);
  const chart = useMemo(() => {
    if (!g) return null;
    const dates = g.cumulative.map((c) => c.date);
    const actual: (number | null)[] = g.cumulative.map((c) => c.actual);
    const phases = g.cumulative.map((c) => c.phase as string | null);
    const med: (number | null)[] = actual.map(() => null), lo: (number | null)[] = actual.map(() => null), hi: (number | null)[] = actual.map(() => null);
    const f = g.forecast;
    if (f && !f.done && f.curve.length) {
      const last = actual.length - 1;
      if (last >= 0) { med[last] = actual[last]; lo[last] = actual[last]; hi[last] = actual[last]; }
      for (const c of f.curve) {
        if (dates.includes(c.date)) continue;
        dates.push(c.date); actual.push(null); phases.push("before");
        med.push(c.median); lo.push(c.lo); hi.push(c.hi);
      }
    }
    return { dates, actual, med, lo, hi, phases };
  }, [g]);
  if (!g || !chart) return <div className="grid gap-4"><Skel h={110} /><Skel h={340} /></div>;
  const cur = g.currency;
  const f = g.forecast;
  return (
    <div className="flex flex-col gap-5" data-screen="growth">
      {err && <Banner kind="error">{err}</Banner>}
      <div className="flex flex-col gap-1"><Eyebrow>Growth · before the event</Eyebrow>
        <h2 className="m-0 text-[20px] font-semibold text-text">Are we on track to fill the room with the right people?</h2></div>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">{g.kpis.map((k) => <KpiTile key={k.key} k={k} currency={cur} />)}</div>
      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Card title="Registrations vs forecast" sub={f ? (f.done ? "Final count - registration has closed" : `Forecast: ${f.basis}`) : "Set the event date to forecast"}
          right={g.odds !== null && g.target ? <span className="text-text">{g.odds}% chance of {g.target.toLocaleString()}</span> : null}>
          <TimeArea ariaLabel="Cumulative registrations, with the forecast and its 80% range to the event day" dates={chart.dates} phases={chart.phases} height={270}
            series={[{ key: "actual", label: "Registered", color: C.primary, kind: "area", values: chart.actual },
              { key: "median", label: "Forecast", color: C.blue, kind: "dash", values: chart.med }]}
            band={{ lo: chart.lo, hi: chart.hi, color: C.blue }} target={g.target} targetLabel="needed" />
          <Legend items={[{ label: "Registered", color: C.primary }, { label: "Forecast · 80% band", color: C.blue, dash: true }, { label: "Needed to meet the attendance goal", color: C.warning, dash: true }]} />
          {f?.note && <div className="text-caption text-muted">{f.note}</div>}
        </Card>
        <Card title="Journey to the room" sub="Step-to-step conversion">
          {g.funnel.length ? <FunnelSteps rows={g.funnel} /> : <div className="text-caption text-muted">Fills in with the first registrations.</div>}
        </Card>
      </div>
      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <Card title="Channels" sub="Registrations, ICP share, show-up and the cost of each ICP person">
          <div className="overflow-x-auto">
            <table className="w-full text-ui min-w-[620px]">
              <thead><tr className="text-[11.5px] text-muted text-left">
                <th className="font-normal pb-2">Channel</th><th className="font-normal pb-2 text-right">Registrations</th><th className="font-normal pb-2 text-right">ICP</th>
                <th className="font-normal pb-2 text-right">Came</th><th className="font-normal pb-2 text-right">Spend</th><th className="font-normal pb-2 text-right">Per ICP person</th>
              </tr></thead>
              <tbody>
                {g.channels.map((c) => {
                  const best = Math.min(...g.channels.filter((x) => x.cost_per_icp).map((x) => x.cost_per_icp as number));
                  return (
                    <tr key={c.channel} className="border-t border-border" data-channel={c.channel}>
                      <td className="py-2 text-text">{c.channel}</td>
                      <td className="py-2 text-right tabular-nums">{c.registrations.toLocaleString()}</td>
                      <td className="py-2 text-right tabular-nums text-secondary">{c.icp_share !== null ? `${Math.round(c.icp_share)}%` : "–"}</td>
                      <td className="py-2 text-right tabular-nums text-secondary">{c.came ? c.came.toLocaleString() : "–"}{c.show_rate !== null && c.came ? <span className="text-muted"> · {Math.round(c.show_rate)}%</span> : null}</td>
                      <td className="py-2 text-right tabular-nums text-secondary">{c.spend ? money(c.spend, cur) : "–"}</td>
                      <td className="py-2 text-right tabular-nums" style={{ color: c.cost_per_icp && c.cost_per_icp === best ? C.good : undefined }}>{c.cost_per_icp ? money(c.cost_per_icp, cur) : "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Ads, synced" sub={g.ads.sources.length ? `From ${g.ads.sources.map((s: any) => s.platform).join(", ")} · campaigns named INIT-${(g.event.code || "").toUpperCase()}-* count here` : "Connect Meta Ads or Google Ads - spend arrives by itself"}>
          {g.ads.campaigns.length ? (
            <div className="flex flex-col">
              {g.ads.campaigns.slice(0, 8).map((c) => (
                <div key={c.platform + c.campaign} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 py-2 border-t border-border first:border-t-0">
                  <div className="min-w-0"><div className="text-ui text-text truncate font-mono text-[12.5px]">{c.campaign}</div>
                    <div className="text-caption text-muted">{c.platform} · {c.clicks.toLocaleString()} clicks · matched by {c.how}</div></div>
                  <div className="text-ui tabular-nums text-right">{money(c.spend, cur)}</div>
                </div>
              ))}
              <div className="pt-2 border-t border-border flex justify-between text-ui"><span className="text-muted">Total synced spend</span><b className="tabular-nums">{money(g.ads.total, cur)}</b></div>
            </div>
          ) : <div className="text-caption text-muted">No campaigns matched yet. Name them INIT-{(g.event.code || "CODE").toUpperCase()}-… or map them in Setup.</div>}
          {g.ads.unmatched?.length > 0 && <div className="text-caption text-warning">{g.ads.unmatched.length} recent campaigns don't follow the naming rule - map the ones that belong to this event in Setup.</div>}
        </Card>
      </div>
      <ActionList initiativeId={i.id} actions={g.actions} canEdit={g.can_edit} onChanged={load} />
    </div>
  );
}

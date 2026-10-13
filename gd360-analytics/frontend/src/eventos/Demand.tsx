// Demand: not how many registered - how many of the right people will walk in.
import { useEffect, useState } from "react";
import { Initiative } from "../api/initiatives";
import { Demand, eventApi, errText } from "../api/eventos";
import { Banner } from "../initiatives/ui";
import { C, HBar, Histogram } from "./charts";
import { ActionList, Card, Eyebrow, Skel } from "./kit";

export default function DemandTab({ i }: { i: Initiative }) {
  const [d, setD] = useState<Demand | null>(null);
  const [err, setErr] = useState("");
  const load = () => { eventApi.demand(i.id).then(setD).catch((e) => setErr(errText(e))); };
  useEffect(load, [i.id]);
  if (!d) return <div className="grid gap-4"><Skel h={110} /><Skel h={320} /></div>;
  const su = d.showup;
  const after = d.event.phase_now !== "before";
  const cap = d.capacity;
  const fire = d.fire_limit;
  const gauge = Math.max(cap || 0, fire || 0, d.predicted_attendance) * 1.08 || 1;
  const tiles: [string, string, string, string?][] = [
    ["Registered", su.registered.toLocaleString(), d.forecast && !d.forecast.done && d.forecast.median ? `forecast ${d.forecast.median.toLocaleString()} by the day` : "final"],
    [after ? "Expected (before the day)" : "Will come (predicted)", `${su.rate ?? "–"}%`, `${su.expected.toLocaleString()} people, one by one`],
    ["In the room, with walk-ins", d.predicted_attendance.toLocaleString(), cap ? `room holds ${cap.toLocaleString()}` : "add the capacity in Setup", d.predicted_attendance > (cap || Infinity) ? C.warning : undefined],
    ["ICP people expected", d.icp_predicted !== null ? d.icp_predicted.toLocaleString() : "–", "from the ICP share of sign-ups"],
    ["Meetings booked", d.meetings_booked.toLocaleString(), "they come 1.2 points more often"],
  ];
  return (
    <div className="flex flex-col gap-5" data-screen="demand">
      {err && <Banner kind="error">{err}</Banner>}
      <div className="flex flex-col gap-1"><Eyebrow>Demand · {after ? "how the prediction did" : `${d.event.days_to_go ?? "–"} days to go`}</Eyebrow>
        <h2 className="m-0 text-[20px] font-semibold text-text">Not how many registered: how many of the right people will walk in</h2></div>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
        {tiles.map(([l, v, s, col]) => (
          <div key={l} className="rounded-card border border-border bg-surface px-4 py-3.5 flex flex-col gap-1"><span className="text-caption text-muted">{l}</span>
            <span className="text-[24px] font-semibold tabular-nums leading-tight" style={{ color: col }}>{v}</span><span className="text-caption text-secondary truncate">{s}</span></div>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <Card title={`${su.registered.toLocaleString()} registered · who will actually come`} sub="Chance of coming, per person - an explainable score, not a black box">
          <Histogram ariaLabel="Registrants by predicted chance of coming" height={200} bins={su.bins}
            labels={su.bins.map((_, k) => `${k * 10}–${k * 10 + 10}`)} colors={su.bins.map((_, k) => (k < 4 ? C.danger : k < 6 ? C.warning : C.primary))} />
          <div className="grid grid-cols-3 gap-3">
            {[["Likely no-shows", su.likely_no, C.danger], ["Undecided", su.undecided, C.warning], ["Coming", su.coming, C.primary]].map(([l, v, c]) => (
              <div key={String(l)} className="flex flex-col"><span className="text-caption text-muted">{l}</span><span className="text-[20px] font-semibold tabular-nums" style={{ color: c as string }}>{Number(v).toLocaleString()}</span></div>
            ))}
          </div>
          <div className="text-caption text-muted">Signals: {su.model}.</div>
        </Card>
        <Card title="Groups and what to do">
          <div className="overflow-x-auto">
            <table className="w-full text-ui">
              <thead><tr className="text-[11.5px] text-muted text-left"><th className="font-normal pb-2">Group</th><th className="font-normal pb-2 text-right">People</th>
                <th className="font-normal pb-2 text-right">Will come</th>{after && <th className="font-normal pb-2 text-right">Came</th>}</tr></thead>
              <tbody>
                {su.groups.map((g) => (
                  <tr key={g.group} className="border-t border-border" data-group={g.group}>
                    <td className="py-2 text-text">{g.group}</td><td className="py-2 text-right tabular-nums">{g.people.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums" style={{ color: g.will_come >= 70 ? C.good : g.will_come >= 55 ? C.text : C.warning }}>{g.will_come}%</td>
                    {after && <td className="py-2 text-right tabular-nums text-secondary">{g.people ? `${Math.round((100 * g.came) / g.people)}%` : "–"}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {after && <div className="text-caption text-muted">"Came" checks the prediction against the door scans - the next event starts from what was right here.</div>}
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Room and safety" sub="Predicted peak against the room and the fire limit">
          <div className="relative h-4 rounded-full bg-border/60 overflow-hidden">
            <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(100 * d.predicted_attendance) / gauge}%`, background: d.predicted_attendance > (cap || Infinity) ? C.warning : C.primary }} />
            {cap ? <span className="absolute inset-y-0 w-[2px] bg-text" style={{ left: `${(100 * cap) / gauge}%` }} title="capacity" /> : null}
            {fire ? <span className="absolute inset-y-0 w-[2px] bg-danger" style={{ left: `${(100 * fire) / gauge}%` }} title="fire limit" /> : null}
          </div>
          <div className="flex justify-between text-caption text-muted"><span>{d.predicted_attendance.toLocaleString()} expected</span>
            <span>{cap ? `room ${cap.toLocaleString()}` : ""}{fire ? ` · fire limit ${fire.toLocaleString()}` : ""}</span></div>
        </Card>
        <Card title="Who is coming" sub="Seniority of registrants">
          <div className="flex flex-col gap-2">{d.seniority.map((s) => <HBar key={s.label} label={s.label} value={s.n} max={Math.max(...d.seniority.map((x) => x.n))} />)}</div>
        </Card>
        <Card title="Target accounts covered" sub={d.accounts ? `${d.accounts.target.toLocaleString()} in your account list` : "Import your target accounts to see coverage"}>
          {d.accounts ? (<>
            <div className="flex h-4 rounded-full overflow-hidden gap-[2px]">
              <div style={{ width: `${(100 * d.accounts.covered) / Math.max(d.accounts.target, 1)}%`, background: C.primary }} />
              <div style={{ width: `${(100 * d.accounts.missing) / Math.max(d.accounts.target, 1)}%`, background: C.border }} />
            </div>
            <div className="text-caption text-secondary">{d.accounts.covered.toLocaleString()} have someone registered · {d.accounts.missing.toLocaleString()} have nobody yet - give that list to sales with a personal invite link each.</div>
          </>) : null}
          <div className="flex flex-col gap-2 pt-1">{d.cities.slice(0, 5).map((c) => <HBar key={c.label} label={c.label} value={c.n} max={Math.max(...d.cities.map((x) => x.n))} color={C.blue} />)}</div>
        </Card>
      </div>
      <ActionList initiativeId={i.id} actions={d.actions.filter((a) => a.state === "proposed")} canEdit={d.can_edit} onChanged={load} />
    </div>
  );
}

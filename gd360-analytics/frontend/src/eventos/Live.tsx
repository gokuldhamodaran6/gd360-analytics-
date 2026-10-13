// Live: the command centre for event day - arrivals against the plan,
// the floor, the rooms, the stream, what needs a person now.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Initiative } from "../api/initiatives";
import { eventApi, errText, Live } from "../api/eventos";
import { Banner } from "../initiatives/ui";
import { C, MinuteLine, TimeArea } from "./charts";
import { ActionList, Card, Eyebrow, KpiTile, Legend, LiveDot, Skel } from "./kit";

function zoneColor(p: number | null) {
  if (p === null) return "rgb(var(--color-surface2))";
  if (p >= 90) return "rgb(var(--color-danger) / 0.32)";
  if (p >= 60) return "rgb(var(--color-warning) / 0.28)";
  return "rgb(var(--color-primary) / 0.22)";
}

export default function LiveTab({ i }: { i: Initiative }) {
  const [d, setD] = useState<Live | null>(null);
  const [err, setErr] = useState("");
  const [at, setAt] = useState<Date | null>(null);
  const [sess, setSess] = useState<string | null>(null);
  const [tv, setTv] = useState(false);
  const load = useCallback(() => {
    eventApi.live(i.id).then((x) => { setD(x); setAt(new Date()); }).catch((e) => setErr(errText(e)));
  }, [i.id]);
  useEffect(load, [load]);
  useEffect(() => {
    if (d?.event.phase_now !== "during") return;
    const t = window.setInterval(load, 15000);
    return () => window.clearInterval(t);
  }, [d?.event.phase_now, load]);
  const streamed = useMemo(() => (d ? d.sessions.filter((s) => d.stream.some((x) => x.session_id === s.id)) : []), [d]);
  const curSess = sess || streamed[0]?.id || null;
  const curve = useMemo(() => {
    if (!d || !curSess) return [] as number[];
    return d.stream.filter((x) => x.session_id === curSess).sort((a, b) => (a.minute ?? 0) - (b.minute ?? 0)).map((x) => x.viewers);
  }, [d, curSess]);
  if (!d) return <div className="grid gap-4"><Skel h={110} /><Skel h={320} /></div>;
  const live = d.event.phase_now === "during";
  const inside = d.zones.filter((z) => !z.outside);
  const gates = d.zones.filter((z) => z.outside);
  const lastQ: Record<string, number> = {};
  for (const q of d.queue) lastQ[q.zone] = q.minutes;
  return (
    <div className={`flex flex-col gap-5 ${tv ? "fixed inset-0 z-50 bg-base overflow-y-auto p-6" : ""}`} data-screen="live">
      {err && <Banner kind="error">{err}</Banner>}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1">
          <Eyebrow>{live ? "Event day" : d.event.phase_now === "before" ? "Event day - not started" : "Event day - replay"}{at ? ` · updated ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}</Eyebrow>
          <h2 className="m-0 text-[20px] font-semibold text-text flex items-center gap-3">Live command centre {live && <LiveDot />}</h2>
          {!live && <span className="text-caption text-muted">{d.event.phase_now === "before" ? "On the day this fills itself from the staff app, the door scans, the stream and the room counters." : "How the day went, minute by minute."}</span>}
        </div>
        <div className="flex gap-2">
          <a className="btn-secondary text-sm" href={d.links.staff} target="_blank" rel="noreferrer">Open the staff app ↗</a>
          <button type="button" className="btn-secondary text-sm" onClick={() => setTv((x) => !x)}>{tv ? "Exit TV mode" : "TV mode"}</button>
        </div>
      </div>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-6">{d.kpis.map((k) => <KpiTile key={k.key} k={k} accent={k.key === "attended" ? C.primary : undefined} />)}</div>
      <div className="grid gap-4 xl:grid-cols-[1.25fr_1fr]">
        <div className="flex flex-col gap-4 min-w-0">
          <Card title="Arrivals against the plan" sub="Gate scans and walk-ins, every 10 minutes, against the expected arrival curve">
            {d.arrivals.length ? (<>
              <TimeArea ariaLabel="Cumulative arrivals against the plan" dates={d.arrivals.map((a) => a.t)} xFmt={(s) => s} height={230}
                series={[{ key: "plan", label: "Plan", color: C.blue, kind: "dash", values: d.arrivals.map((a) => a.plan) },
                  { key: "actual", label: "Checked in", color: C.primary, kind: "area", values: d.arrivals.map((a) => a.actual) }]} />
              <Legend items={[{ label: "Checked in", color: C.primary }, { label: "Plan from the show-up model", color: C.blue, dash: true }]} />
            </>) : <div className="text-caption text-muted">Set the start time in Setup to draw the plan.</div>}
          </Card>
          <Card title="Rooms" sub="Door scans against capacity; ratings from the 1-tap after each session">
            <div className="flex flex-col">
              {d.sessions.length ? d.sessions.map((s) => (
                <div key={s.id} className="grid grid-cols-[52px_minmax(0,1fr)_minmax(120px,0.6fr)_40px] gap-3 items-center py-2.5 border-t border-border first:border-t-0" data-session={s.id}>
                  <span className="font-mono text-caption text-muted">{s.starts_at ? new Date(s.starts_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "–"}</span>
                  <div className="min-w-0"><div className="text-ui text-text truncate">{s.title}</div><div className="text-caption text-muted truncate">{s.room}{s.speaker ? ` · ${s.speaker}` : ""}</div></div>
                  <div className="flex flex-col gap-1">
                    <div className="h-1.5 rounded-full bg-border/60 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${Math.min(100, s.fill || 0)}%`, background: (s.fill || 0) > 100 ? C.danger : (s.fill || 0) > 85 ? C.warning : C.primary }} /></div>
                    <span className="text-[11.5px] tabular-nums" style={{ color: (s.fill || 0) > 100 ? C.danger : C.muted }}>{s.in_room.toLocaleString()}{s.capacity ? ` / ${s.capacity.toLocaleString()}` : ""}{s.online_peak ? ` · ${s.online_peak.toLocaleString()} online` : ""}</span>
                  </div>
                  <span className="text-caption tabular-nums text-warning text-right">{s.rating ? `${s.rating}★` : "–"}</span>
                </div>
              )) : <div className="text-caption text-muted">Add the agenda in Setup - each session gets a door scan in the staff app.</div>}
            </div>
          </Card>
        </div>
        <div className="flex flex-col gap-4 min-w-0">
          <Card title="The floor, now" sub="Room counters and door scans - people counted, never filmed">
            {inside.length ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {inside.map((z) => (
                  <div key={z.id} className="rounded-ctl border border-border p-3 min-h-[86px] flex flex-col justify-between transition-colors" style={{ background: zoneColor(z.pct) }} data-zone={z.id}>
                    <span className="text-caption font-medium text-text">{z.name}</span>
                    <span className="font-mono text-[18px] tabular-nums text-text">{z.now !== null ? z.now.toLocaleString() : "–"}</span>
                    <span className="text-[11px] text-secondary">{z.capacity ? `of ${z.capacity.toLocaleString()}${z.pct !== null ? ` · ${z.pct}%` : ""}` : ""}</span>
                  </div>
                ))}
                {gates.map((z) => (
                  <div key={z.id} className="rounded-ctl border border-border p-3 flex flex-col justify-between bg-surface2" data-gate={z.id}>
                    <span className="text-caption font-medium text-text">{z.name}</span>
                    <span className="font-mono text-[16px] tabular-nums" style={{ color: (lastQ[z.name] || 0) > 10 ? C.danger : C.text }}>{lastQ[z.name] !== undefined ? `${Math.round(lastQ[z.name])} min queue` : "–"}</span>
                  </div>
                ))}
              </div>
            ) : <div className="text-caption text-muted">Add the zones (rooms, expo, gates) in Setup. Counters post to the occupancy hook; staff can also tap a count in the app.</div>}
            <Legend items={[{ label: "under 60%", color: "rgb(var(--color-primary) / 0.5)" }, { label: "60–90%", color: "rgb(var(--color-warning) / 0.6)" }, { label: "over 90%", color: "rgb(var(--color-danger) / 0.6)" }]} />
          </Card>
          {streamed.length > 0 && (
            <Card title="Livestream, minute by minute" sub="Who stayed - the dips show the moment people left"
              right={<select className="input !py-1 !w-auto text-caption" value={curSess || ""} onChange={(e) => setSess(e.target.value)} aria-label="Session">
                {streamed.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select>}>
              <MinuteLine ariaLabel="Viewers per minute" points={curve} height={190} />
            </Card>
          )}
          <Card title="Just arrived" sub="Check-ins and walk-ins as they happen">
            <div className="flex flex-col">
              {d.feed.length ? d.feed.map((f, k) => (
                <div key={k} className="flex items-center gap-2.5 py-2 border-t border-border first:border-t-0 text-ui">
                  <span className="font-mono text-caption text-muted w-[44px]">{new Date(f.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: f.kind === "walk_in" ? C.blue : C.primary }} />
                  <span className="text-text truncate">{f.who}</span><span className="text-muted truncate">{f.company || ""}</span>
                  <span className="ml-auto text-[11px] text-muted">{f.kind === "walk_in" ? "walk-in" : f.gate || ""}{f.tier !== "free" ? ` · ${f.tier}` : ""}</span>
                </div>
              )) : <div className="text-caption text-muted">Nobody checked in yet.</div>}
            </div>
          </Card>
        </div>
      </div>
      <ActionList initiativeId={i.id} actions={d.actions.filter((a) => a.state === "proposed")} canEdit={d.can_edit} onChanged={load} title="Needs a person now" empty="Everything is running - the agent flags full rooms, long queues and sponsors falling behind." />
    </div>
  );
}

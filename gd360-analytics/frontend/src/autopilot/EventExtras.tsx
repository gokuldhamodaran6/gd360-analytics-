// 2026-10-17 (R53): the event types Event OS was missing - Webinar 360 (complete ten minutes after the end),
// the online event's viewers per track, and the solo meetup's report card at 9 am the next morning.
import { useEffect, useState } from "react";
import { errorText, Initiative } from "../api/initiatives";
import { autopilotApi, Webinar360 } from "../api/autopilot";
import { Banner, Empty, fmt, Heat, Section, Stat } from "../initiatives/ui";
import { C, MinuteLine } from "../eventos/charts";
import { Card } from "../eventos/kit";

export function Webinar360Tab({ i }: { i: Initiative }) {
  const [w, setW] = useState<Webinar360 | null>(null);
  const [tracks, setTracks] = useState<{ track: string; curve: { minute: number; viewers: number }[]; peak: number; avg: number; drops: any[] }[] | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [heat, setHeat] = useState<"all" | "hot" | "warm" | "cold">("all");
  useEffect(() => {
    autopilotApi.webinar360(i.id).then(setW).catch((e) => setErr(errorText(e, "Couldn't load Webinar 360.")));
    autopilotApi.online(i.id).then((r) => { setTracks(r.tracks); setNote(r.note); }).catch(() => setTracks([]));
  }, [i.id]);
  if (err) return <Banner kind="error">{err}</Banner>;
  if (!w) return <div className="grid gap-4">{[120, 240].map((h, k) => <div key={k} className="rounded-card bg-surface2 animate-pulse" style={{ height: h }} />)}</div>;
  const people = w.people.filter((p) => heat === "all" || p.heat === heat);
  const curve = w.viewers.curve.map((p) => p.viewers);
  return (
    <div className="flex flex-col gap-5" data-webinar360="">
      <Banner kind={w.ready ? "good" : "info"}>
        {w.ready ? `Webinar 360 completed itself ${w.ready_at ? new Date(w.ready_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""} - ten minutes after the end. The Follow-up agent has the hot list.`
          : "This fills in on its own ten minutes after the webinar ends: attendance, minutes watched, who's hot, questions and pipeline."}
      </Banner>
      <Card>
        <div className="grid gap-5 grid-cols-[repeat(auto-fill,minmax(140px,1fr))]">
          <Stat label="Registered" value={w.registered.toLocaleString()} />
          <Stat label="Joined" value={w.joined.toLocaleString()} />
          <Stat label="Attendance" value={w.attendance_rate !== null ? `${w.attendance_rate}%` : "—"} hint="Live webinars typically 35–60%" />
          <Stat label="Average minutes" value={w.avg_minutes !== null ? `${w.avg_minutes}` : "—"} hint={`of ${w.minutes_planned} planned`} />
          <Stat label="CTA clicks" value={w.cta_clicks.toLocaleString()} />
          <Stat label="Replay views" value={w.replay_views.toLocaleString()} />
        </div>
      </Card>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] items-start">
        <Section title="Viewers minute by minute" sub={w.viewers.peak ? `Peak ${fmt(w.viewers.peak)}, average ${fmt(w.viewers.avg)}.` : "From Zoom / Teams join and leave events, or viewer counts."}>
          {curve.some((v) => v > 0) ? (
            <MinuteLine points={curve} ariaLabel="Viewers per minute" color={C.primary}
              markers={w.viewers.drops.slice(0, 3).map((d) => ({ i: Math.min(curve.length - 1, Math.round((d.minute / Math.max(1, w.minutes_planned)) * (curve.length - 1))), label: `drop at ${d.minute}′` }))} />
          ) : <Empty title="No viewer curve yet" body="Connect Zoom, or upload the Teams attendance report in Evidence. Minutes per person still count from attendance." />}
        </Section>
        <Section title="Who's hot" sub="Hot: watched 80% or more, or asked a question and watched 40%. Warm: 40%.">
          <div className="flex gap-2 flex-wrap">
            {(["all", "hot", "warm", "cold"] as const).map((h) => (
              <button key={h} type="button" onClick={() => setHeat(h)} aria-pressed={heat === h} data-heat-filter={h}
                className={`ui-focus h-8 px-3 rounded-full border text-caption ${heat === h ? "bg-tint border-tint-border text-text" : "border-border text-muted hover:text-text"}`}>
                {h === "all" ? `All ${w.people.length}` : `${h[0].toUpperCase()}${h.slice(1)} ${w.heat[h]}`}</button>
            ))}
          </div>
          {people.length === 0 ? <p className="m-0 text-ui text-muted">Nobody here yet.</p> : (
            <ul className="m-0 p-0 list-none flex flex-col divide-y divide-border max-h-[340px] overflow-y-auto" data-heat-list="">
              {people.slice(0, 100).map((p, k) => (
                <li key={k} className="py-2 flex items-center gap-3 min-w-0">
                  <div className="min-w-0 flex-1"><div className="text-ui text-text truncate">{p.name}</div>
                    <div className="text-caption text-muted truncate">{p.company || "—"} · {p.minutes} min{p.questions ? ` · ${p.questions} question${p.questions > 1 ? "s" : ""}` : ""}</div></div>
                  <Heat heat={p.heat} score={p.score} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
      {tracks && tracks.length > 1 && (
        <Section title="Online tracks" sub={note}>
          <div className="grid gap-5 md:grid-cols-2">
            {tracks.map((t, k) => (
              <div key={t.track} className="flex flex-col gap-2" data-track={t.track}>
                <div className="flex justify-between text-caption"><span className="text-text font-medium">{t.track}</span><span className="text-muted tabular-nums">peak {fmt(t.peak)} · avg {fmt(t.avg)}</span></div>
                <MinuteLine points={t.curve.map((p) => p.viewers)} height={140} color={C.s([1, 5, 3, 2][k % 4])} ariaLabel={`${t.track} viewers per minute`} />
              </div>
            ))}
          </div>
        </Section>
      )}
      <div className="grid gap-5 md:grid-cols-2 items-start">
        <Section title="Questions asked" sub={`${w.questions.length} from the Q&A`}>
          {w.questions.length === 0 ? <p className="m-0 text-ui text-muted">No questions recorded.</p> : (
            <ul className="m-0 pl-4 flex flex-col gap-1.5 text-ui text-text">{w.questions.slice(0, 15).map((q, k) => <li key={k}>{q}</li>)}</ul>
          )}
        </Section>
        <Section title="Pipeline" sub="Deals at the companies that joined.">
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Sourced" value={fmt(w.pipeline.sourced ?? 0, "money")} />
            <Stat label="Influenced" value={fmt(w.pipeline.influenced ?? 0, "money")} />
            <Stat label="Won" value={fmt(w.pipeline.won ?? 0, "money")} />
          </div>
          <span className="text-caption text-muted">Truth: {w.truth}.</span>
        </Section>
      </div>
    </div>
  );
}

export function SoloCard({ i }: { i: Initiative }) {
  const [c, setC] = useState<Awaited<ReturnType<typeof autopilotApi.solo>> | null>(null);
  useEffect(() => { autopilotApi.solo(i.id).then(setC).catch(() => setC(null)); }, [i.id]);
  if (!c) return null;
  return (
    <Card title="Meetup report card" sub={c.ready_at ? "Ready at 9 am the morning after" : "Arrives at 9 am the morning after the meetup"} tone="accent">
      <div className="flex gap-6 flex-wrap items-center" data-solo-card="">
        <div className="flex flex-col"><span className="text-[34px] leading-none font-semibold tabular-nums text-text">{c.score ?? "—"}</span><span className="text-caption text-muted">score</span></div>
        <div className="grid grid-cols-3 gap-5 flex-1 min-w-[260px]">
          <Stat label="Came" value={c.came} hint={c.expected !== null ? `${c.expected} expected` : undefined} />
          <Stat label="Walk-ins" value={c.walk_ins} />
          <Stat label="Registered" value={c.registered} />
        </div>
      </div>
      <ul className="m-0 pl-4 text-ui text-secondary flex flex-col gap-1">{c.lines.map((l, k) => <li key={k}>{l}</li>)}</ul>
    </Card>
  );
}

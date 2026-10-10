import { useCallback, useEffect, useMemo, useState } from "react";
import { errorText, Initiative, initiativesApi, Today, Update } from "../api/initiatives";
import { fmt, fmtDate, fmtTime, Section, todayIso } from "./ui";

type Props = { i: Initiative; reload: () => void; onError: (s: string) => void };

const PRESETS = [
  { id: "post", label: "Post or ad went live", kind: "post", hint: "LinkedIn post for the US webinar is live" },
  { id: "approval", label: "Something was approved", kind: "approval", hint: "Banner v3 approved by Priya" },
  { id: "milestone", label: "Milestone", kind: "milestone", hint: "Venue contract signed" },
  { id: "metric", label: "Numbers from a platform", kind: "metric", hint: "LinkedIn: reach 4,200, 63 clicks, 180 engagements" },
  { id: "risk", label: "Risk or blocker", kind: "risk", hint: "Catering quote is late - may slip a day" },
  { id: "update", label: "Note", kind: "update", hint: "Anything the team should know" },
];
const KIND_DOT: Record<string, string> = { post: "bg-series-1", approval: "bg-good", milestone: "bg-primary", metric: "bg-series-3", risk: "bg-danger", deliverable: "bg-series-4", system: "bg-border-strong", update: "bg-secondary" };
const NUM_FIELDS = ["reach", "impressions", "clicks", "engagements", "spend"] as const;

function shift(day: string, n: number) {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function UpdatesTab({ i, reload, onError }: Props) {
  const [day, setDay] = useState(todayIso());
  const [today, setToday] = useState<Today | null>(null);
  const [log, setLog] = useState<Update[] | null>(null);
  const [preset, setPreset] = useState(PRESETS[0]);
  const [text, setText] = useState("");
  const [linkId, setLinkId] = useState("");
  const [nums, setNums] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    initiativesApi.today(i.id, day).then(setToday).catch((e) => onError(errorText(e)));
    initiativesApi.updates(i.id).then(setLog).catch(() => undefined);
  }, [i.id, day, onError]);
  useEffect(load, [load]);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const numbers: Record<string, number> = {};
      Object.entries(nums).forEach(([k, v]) => { const n = Number(String(v).replace(/,/g, "")); if (v !== "" && !Number.isNaN(n)) numbers[k] = n; });
      await initiativesApi.addUpdate(i.id, { text: text.trim(), kind: preset.kind, numbers, link_id: linkId || undefined });
      setText(""); setNums({}); setLinkId("");
      load(); reload();
    } catch (e) { onError(errorText(e)); } finally { setBusy(false); }
  };

  const grouped = useMemo(() => {
    const m = new Map<string, Update[]>();
    (log || []).forEach((u) => { const k = u.occurred_at.slice(0, 10); m.set(k, [...(m.get(k) || []), u]); });
    return Array.from(m.entries());
  }, [log]);
  const posts = i.tracked.filter((l) => l.kind !== "landing_page");

  return (
    <div className="flex gap-5 flex-wrap items-start">
      <div className="flex-[2_1_560px] min-w-0 flex flex-col gap-5">
        <Section title={day === todayIso() ? "Today" : fmtDate(day, true)} sub="Everything that happened on this initiative that day - tracked by GD360 or logged by the team."
          actions={<div className="flex items-center gap-1">
            <button type="button" className="btn-secondary text-sm !px-2.5 !py-1.5" onClick={() => setDay(shift(day, -1))} aria-label="Previous day">‹</button>
            <input type="date" className="input !w-auto !py-1.5 text-caption" value={day} max={todayIso()} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label="Day" />
            <button type="button" className="btn-secondary text-sm !px-2.5 !py-1.5" disabled={day >= todayIso()} onClick={() => setDay(shift(day, 1))} aria-label="Next day">›</button>
          </div>}>
          {!today ? <div className="h-24 rounded-ctl bg-surface2 animate-pulse" /> : (
            <>
              {today.tiles.length > 0 ? (
                <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(130px,1fr))]" data-day-tiles="">
                  {today.tiles.map((t) => (
                    <div key={t.label} className="rounded-ctl border border-border px-3 py-2.5">
                      <div className="text-[20px] font-semibold tabular-nums text-text leading-tight">{fmt(t.value)}</div>
                      <div className="text-caption text-muted">{t.label}{t.source === "logged" ? " · logged" : ""}</div>
                    </div>
                  ))}
                </div>
              ) : <p className="m-0 text-ui text-muted">No activity recorded on this day.</p>}
              <div className="grid gap-5 sm:grid-cols-2">
                <Mini title="Finished" items={today.completed.map((t) => `${t.title}${t.owner ? ` · ${t.owner}` : ""}`)} />
                <Mini title="Due" items={today.due.map((t) => `${t.title}${t.owner ? ` · ${t.owner}` : ""}`)} empty="Nothing due." />
                <Mini title="Approvals" items={today.approvals.map((a) => `${a.task}: ${a.action === "submitted" ? "sent for approval" : a.action === "approved" ? "approved" : "changes requested"} · ${a.by}${a.version ? ` · v${a.version}` : ""}`)} />
              </div>
            </>
          )}
        </Section>

        <Section title="Log" sub="Newest first.">
          {!log ? <div className="h-24 rounded-ctl bg-surface2 animate-pulse" /> : grouped.length === 0 ? <p className="m-0 text-ui text-muted">Nothing logged yet.</p> : (
            <div className="flex flex-col gap-5" data-update-log="">
              {grouped.map(([d, ups]) => (
                <div key={d} className="flex flex-col gap-2">
                  <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">{d === todayIso() ? "Today" : fmtDate(d, true)}</span>
                  <ol className="m-0 p-0 list-none flex flex-col gap-2.5 border-l border-border ml-1">
                    {ups.map((u) => (
                      <li key={u.id} className="relative pl-4 flex gap-3 items-start group">
                        <span className={`absolute -left-[4.5px] top-[7px] w-2 h-2 rounded-full ${KIND_DOT[u.kind] || "bg-secondary"}`} />
                        <div className="min-w-0 flex-1">
                          <div className="text-ui text-text">{u.text}</div>
                          <div className="text-caption text-muted flex gap-2 flex-wrap">
                            <span>{fmtTime(u.occurred_at)}</span>{u.author && <span>· {u.author}</span>}
                            {u.channel && <span>· {u.channel}</span>}{u.paid !== null && u.paid !== undefined && <span>· {u.paid ? "Paid" : "Organic"}</span>}{u.region && <span>· {u.region}</span>}
                            {Object.entries(u.numbers || {}).map(([k, v]) => <span key={k} className="text-secondary">· {k} {fmt(v)}</span>)}
                            {u.link && <a href={u.link} target="_blank" rel="noreferrer" className="text-primary hover:underline">· link</a>}
                          </div>
                        </div>
                        {i.can_edit && u.kind !== "system" && <button type="button" className="text-caption text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-danger" onClick={async () => { try { await initiativesApi.deleteUpdate(i.id, u.id); load(); reload(); } catch (e) { onError(errorText(e)); } }}>Delete</button>}
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      {i.can_edit && (
        <div className="flex-[1_1_340px] min-w-0 lg:sticky lg:top-4">
          <Section title="Log an update" sub="Write it the way you'd say it - numbers like “reach 4.2k” or “63 clicks” are picked up automatically.">
            <div className="flex gap-1.5 flex-wrap">
              {PRESETS.map((p) => <button key={p.id} type="button" onClick={() => setPreset(p)} aria-pressed={preset.id === p.id}
                className={`ui-focus h-[28px] px-2.5 rounded-full border text-caption ${preset.id === p.id ? "border-primary bg-tint text-text" : "border-border text-secondary"}`}>{p.label}</button>)}
            </div>
            <textarea className="input min-h-[90px] text-ui" value={text} onChange={(e) => setText(e.target.value)} placeholder={preset.hint} maxLength={2000} data-update-text="" aria-label="Update" />
            {(preset.kind === "post" || preset.kind === "metric") && (
              <>
                {posts.length > 0 && (
                  <select className="input text-ui" value={linkId} onChange={(e) => setLinkId(e.target.value)} aria-label="Which post">
                    <option value="">Which post or ad? (optional)</option>
                    {posts.map((l) => <option key={l.id} value={l.id}>{l.label}{l.paid ? " · paid" : " · organic"}{l.region ? ` · ${l.region}` : ""}</option>)}
                  </select>
                )}
                <div className="grid grid-cols-2 gap-2">
                  {NUM_FIELDS.map((k) => (
                    <label key={k} className="flex flex-col gap-1"><span className="text-caption text-muted capitalize">{k}</span>
                      <input className="input !py-1.5 tabular-nums" inputMode="decimal" value={nums[k] || ""} onChange={(e) => setNums({ ...nums, [k]: e.target.value })} /></label>
                  ))}
                </div>
              </>
            )}
            <button type="button" className="btn-primary text-sm" disabled={busy || !text.trim()} onClick={submit} data-log-update="">Log it</button>
            <p className="m-0 text-caption text-muted">Or tell the assistant: “Posted on LinkedIn, reach 4k” - it logs the same way.</p>
          </Section>
        </div>
      )}
    </div>
  );
}

function Mini({ title, items, empty = "—" }: { title: string; items: string[]; empty?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-caption font-medium text-secondary">{title}</span>
      {items.length === 0 ? <span className="text-caption text-muted">{empty}</span> : items.slice(0, 6).map((x, k) => <span key={k} className="text-ui text-text">{x}</span>)}
    </div>
  );
}

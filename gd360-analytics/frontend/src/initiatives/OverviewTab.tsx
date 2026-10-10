import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { errorText, Initiative, initiativesApi, Today } from "../api/initiatives";
import { CopyField, fmt, fmtDate, Meter, Section, todayIso } from "./ui";

type Props = { i: Initiative; goto: (t: any) => void; reload: () => void; onError: (s: string) => void };

export function askHref(sourceId: string, question: string) {
  return `/?source=${encodeURIComponent(sourceId)}&q=${encodeURIComponent(question)}`;
}

export default function OverviewTab({ i, goto, reload, onError }: Props) {
  const [today, setToday] = useState<Today | null>(null);
  const [quick, setQuick] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { initiativesApi.today(i.id).then(setToday).catch(() => undefined); }, [i.id, i.tasks.length]);

  const now = todayIso();
  const open = i.tasks.filter((t) => t.status !== "done").sort((a, b) => (a.due_on || "9999").localeCompare(b.due_on || "9999"));
  const pending = i.tasks.filter((t) => t.approval?.state === "submitted");
  const plan = i.tracking_plan;
  const counts = { live: plan.filter((r) => r.state === "live" || r.state === "connected").length, setup: plan.filter((r) => r.state === "setup").length, manual: plan.filter((r) => r.state === "manual").length };
  const people = ["event", "webinar"].includes(i.kind);

  const log = async () => {
    if (!quick.trim()) return;
    setSaving(true);
    try {
      await initiativesApi.addUpdate(i.id, { text: quick.trim() });
      setQuick("");
      setToday(await initiativesApi.today(i.id));
      reload();
    } catch (e) { onError(errorText(e)); } finally { setSaving(false); }
  };

  return (
    <div className="flex gap-5 flex-wrap items-start">
      <div className="flex-[2_1_560px] min-w-0 flex flex-col gap-5">
        <Section title="Targets" sub="Actual against target, counted from what GD360 tracks." actions={<button type="button" className="text-caption text-primary hover:underline" onClick={() => goto("results")}>All results →</button>}>
          {i.targets.length === 0 ? <p className="m-0 text-ui text-muted">No targets yet - add them on the Results tab.</p> : (
            <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2" data-overview-targets="">
              {i.targets.map((t) => <Meter key={t.key} t={t} />)}
            </div>
          )}
        </Section>

        <Section title={`Today · ${fmtDate(now)}`} sub="Tracked activity and what the team logged." actions={<button type="button" className="text-caption text-primary hover:underline" onClick={() => goto("updates")}>Full log →</button>}>
          {today && today.tiles.length > 0 ? (
            <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(130px,1fr))]" data-today-tiles="">
              {today.tiles.map((t) => (
                <div key={t.label} className="rounded-ctl border border-border px-3 py-2.5">
                  <div className="text-[20px] font-semibold tabular-nums text-text leading-tight">{fmt(t.value)}</div>
                  <div className="text-caption text-muted">{t.label}<span className="ml-1 text-[10.5px] uppercase tracking-[0.06em] opacity-70">{t.source === "logged" ? "logged" : ""}</span></div>
                </div>
              ))}
            </div>
          ) : <p className="m-0 text-ui text-muted">Nothing recorded yet today.</p>}
          {i.can_edit && (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); log(); }}>
              <input className="input text-ui" value={quick} onChange={(e) => setQuick(e.target.value)} maxLength={2000} data-quick-update=""
                placeholder="Log what happened, e.g. “LinkedIn post live, reach 4.2k, 63 clicks” or “Design approved by Priya”" aria-label="Log an update" />
              <button type="submit" className="btn-secondary text-sm shrink-0" disabled={saving || !quick.trim()}>Log</button>
            </form>
          )}
          {today && today.updates.length > 0 && (
            <ul className="m-0 p-0 list-none flex flex-col gap-2">
              {today.updates.slice(0, 4).map((u) => (
                <li key={u.id} className="text-ui text-secondary flex gap-2"><span className="text-muted tabular-nums shrink-0 w-[64px] whitespace-nowrap">{new Date(u.occurred_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span><span className="min-w-0">{u.text}</span></li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Next up" actions={<button type="button" className="text-caption text-primary hover:underline" onClick={() => goto("plan")}>Whole plan →</button>}>
          {open.length === 0 ? <p className="m-0 text-ui text-muted">Every task is done.</p> : (
            <ul className="m-0 p-0 list-none flex flex-col divide-y divide-border" data-next-up="">
              {open.slice(0, 6).map((t) => {
                const late = t.due_on && t.due_on < now;
                return (
                  <li key={t.id} className="py-2.5 flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${t.status === "blocked" ? "bg-danger" : late ? "bg-danger" : t.status === "review" ? "bg-warning" : t.status === "doing" ? "bg-primary" : "bg-border-strong"}`} />
                    <span className="text-ui text-text flex-1 min-w-0 truncate">{t.title}</span>
                    {t.owner_name && <span className="text-caption text-muted hidden sm:inline">{t.owner_name}</span>}
                    <span className={`text-caption tabular-nums shrink-0 ${late ? "text-danger" : "text-muted"}`}>{t.due_on ? fmtDate(t.due_on) : ""}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>

      <div className="flex-[1_1_320px] min-w-0 flex flex-col gap-5">
        {i.summary && (
          <Section title="Strategy">
            <p className="m-0 text-ui text-text leading-relaxed">{i.summary}</p>
            {(i.plan_meta.strategy || []).length > 0 && (
              <ul className="m-0 p-0 list-none flex flex-col gap-1.5">{(i.plan_meta.strategy || []).map((s) => <li key={s} className="flex gap-2 text-caption text-secondary"><span className="mt-[6px] w-1 h-1 rounded-full bg-primary shrink-0" />{s}</li>)}</ul>
            )}
          </Section>
        )}

        <Section title="Tracking" sub="Is every number being counted?" actions={<button type="button" className="text-caption text-primary hover:underline" onClick={() => goto("tracking")}>Open →</button>}>
          <div className="flex gap-5">
            <Mini n={counts.live} label="Counted" cls="text-good" />
            <Mini n={counts.setup} label="Need setup" cls={counts.setup ? "text-warning" : "text-muted"} />
            <Mini n={counts.manual} label="Logged by hand" cls="text-secondary" />
          </div>
          {plan.filter((r) => r.state === "setup").slice(0, 2).map((r) => (
            <div key={r.key} className="rounded-ctl border border-warning-border bg-warning-fill px-3 py-2 text-caption text-text"><b className="font-medium">{r.label}:</b> {r.how}</div>
          ))}
        </Section>

        {pending.length > 0 && (
          <Section title="Waiting for approval">
            {pending.map((t) => (
              <div key={t.id} className="flex flex-col gap-0.5">
                <span className="text-ui text-text">{t.title}</span>
                <span className="text-caption text-muted">{t.approval?.approver}{t.approval?.version ? ` · v${t.approval.version}` : ""} · sent {fmtDate(t.approval?.requested_at)}</span>
              </div>
            ))}
          </Section>
        )}

        {i.connected_data.length > 0 && (
          <Section title="Ask your connected data" sub="Already in GD360 - nothing to set up.">
            <div className="flex flex-col gap-2" data-connected-data="">
              {i.connected_data.slice(0, 4).map((c) => (
                <Link key={c.id} to={askHref(c.id, c.questions[0])} className="ui-focus rounded-ctl border border-border px-3 py-2.5 hover:border-border-strong">
                  <div className="text-caption text-muted">{c.name} · {c.covers}</div>
                  <div className="text-ui text-text">{c.questions[0]} →</div>
                </Link>
              ))}
            </div>
          </Section>
        )}

        {people && (
          <Section title="Links to share">
            <div className="flex flex-col gap-1.5"><span className="text-caption text-secondary">Registration page</span><CopyField value={i.links_public.registration} testId="reg-link" /></div>
            <div className="flex flex-col gap-1.5"><span className="text-caption text-secondary">Walk-in capture (for your booth team's phones)</span><CopyField value={i.links_public.walk_in} testId="walkin-link" /></div>
          </Section>
        )}
      </div>
    </div>
  );
}

function Mini({ n, label, cls }: { n: number; label: string; cls: string }) {
  return <div className="flex flex-col"><span className={`text-[22px] font-semibold tabular-nums leading-tight ${cls}`}>{n}</span><span className="text-caption text-muted">{label}</span></div>;
}

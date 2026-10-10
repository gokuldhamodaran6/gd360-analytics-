import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Catalog, errorText, Initiative, initiativesApi, Results, Target } from "../api/initiatives";
import { Banner, fmt, fmtDate, Heat, Meter, Section, StackBars, Tier } from "./ui";

type Props = { i: Initiative; reload: () => void; onError: (s: string) => void };
const GROUPS = ["Registrations", "Attendance", "Website", "Email", "Outreach", "Meetings", "Other"];

export default function ResultsTab({ i, reload, onError }: Props) {
  const [r, setR] = useState<Results | null>(null);
  const [edit, setEdit] = useState(false);
  const [targets, setTargets] = useState<Target[]>(i.targets);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [outcome, setOutcome] = useState("");
  const [saved, setSaved] = useState("");

  const load = useCallback(() => {
    initiativesApi.results(i.id).then((x) => { setR(x); setOutcome(x.outcome || ""); }).catch((e) => onError(errorText(e)));
  }, [i.id, onError]);
  useEffect(load, [load]);
  useEffect(() => { setTargets(i.targets); }, [i.targets]);
  useEffect(() => { if (edit && !catalog) initiativesApi.catalog().then(setCatalog).catch(() => undefined); }, [edit, catalog]);

  const series = useMemo(() => {
    if (!r) return { rows: [], keys: [] as string[] };
    const keys = GROUPS.filter((g) => r.series.some((s) => s[g]));
    // last 30 days, filled
    const days: Record<string, any>[] = [];
    const by = new Map(r.series.map((s) => [s.date, s]));
    const end = new Date();
    for (let k = 29; k >= 0; k--) {
      const d = new Date(end); d.setDate(d.getDate() - k);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      days.push({ date: iso, ...(by.get(iso) || {}) });
    }
    return { rows: days, keys };
  }, [r]);

  const saveTargets = async () => {
    try {
      await initiativesApi.patch(i.id, { targets: targets.map((t) => ({ key: t.key, label: t.label, target: t.target, unit: t.unit, auto: t.auto, why: t.why, ...(t.auto ? {} : { actual: t.actual }) })) });
      setEdit(false); reload(); load(); setSaved("Targets saved.");
    } catch (e) { onError(errorText(e)); }
  };

  return (
    <div className="flex flex-col gap-5">
      {saved && <Banner kind="good" onClose={() => setSaved("")}>{saved}</Banner>}
      <Section title="Results against targets" sub="Automatic ones are counted by GD360; manual ones are updated by the owner."
        actions={i.can_edit ? (edit ? <>
          <button type="button" className="btn-secondary text-sm" onClick={() => { setTargets(i.targets); setEdit(false); }}>Cancel</button>
          <button type="button" className="btn-primary text-sm" onClick={saveTargets}>Save</button>
        </> : <button type="button" className="btn-secondary text-sm" onClick={() => setEdit(true)} data-edit-targets="">Edit targets</button>) : undefined}>
        {!edit ? (
          <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">{(r?.targets || i.targets).map((t) => <Meter key={t.key} t={t} />)}</div>
        ) : (
          <div className="flex flex-col gap-2">
            {targets.map((t, k) => (
              <div key={t.key} className="flex items-center gap-3 flex-wrap rounded-ctl border border-border px-3 py-2">
                <span className="text-ui text-text flex-1 min-w-[180px]">{t.label} <span className="text-caption text-muted">· {t.auto ? "automatic" : "manual"}</span></span>
                <label className="flex items-center gap-1.5 text-caption text-muted">Target<input type="number" className="input !py-1 !w-[110px]" value={t.target ?? ""} onChange={(e) => setTargets(targets.map((x, j) => j === k ? { ...x, target: e.target.value === "" ? null : Number(e.target.value) } : x))} /></label>
                {!t.auto && <label className="flex items-center gap-1.5 text-caption text-muted">Actual<input type="number" className="input !py-1 !w-[110px]" value={t.actual ?? ""} onChange={(e) => setTargets(targets.map((x, j) => j === k ? { ...x, actual: e.target.value === "" ? null : Number(e.target.value) } : x))} /></label>}
                <button type="button" className="text-caption text-muted hover:text-danger" onClick={() => setTargets(targets.filter((_, j) => j !== k))}>Remove</button>
              </div>
            ))}
            {catalog && (
              <select className="input !w-auto !py-1.5 text-caption" value="" aria-label="Add a target" onChange={(e) => {
                const key = e.target.value; if (!key) return;
                const m = catalog.metrics[key];
                setTargets([...targets, { key, label: m.label, unit: m.unit, auto: m.auto, target: null, actual: null }]);
              }}>
                <option value="">+ Add a target</option>
                {Object.entries(catalog.metrics).filter(([k]) => !targets.some((t) => t.key === k)).map(([k, m]) => <option key={k} value={k}>{m.label}{m.auto ? "" : " (manual)"}</option>)}
              </select>
            )}
          </div>
        )}
      </Section>

      <Section title="Activity, last 30 days" sub="Signals tagged to this initiative, by day.">
        {!r ? <div className="h-36 rounded-ctl bg-surface2 animate-pulse" /> : series.keys.length === 0 ? <p className="m-0 text-ui text-muted">No tracked activity yet.</p> : (
          <StackBars rows={series.rows} keys={series.keys} labelKey="date" />
        )}
      </Section>

      {r?.ab && <Banner kind={r.ab.state === "winner" ? "good" : "info"}><b className="font-medium">A/B · {r.ab.a} vs {r.ab.b}:</b> {r.ab.text}</Banner>}

      {r && r.breakdown.length > 0 && (
        <Section title="Channels" sub="This initiative's own posts, ads and pages only.">
          <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
            {r.breakdown.map((b, k) => (
              <div key={k} className="rounded-ctl border border-border p-3 flex flex-col gap-1">
                <div className="flex justify-between text-ui"><span className="capitalize text-text font-medium">{b.channel.replace("_", " ")}</span><span className={`text-caption ${b.mode === "Paid" ? "text-warning" : "text-good"}`}>{b.mode}{b.region ? ` · ${b.region}` : ""}</span></div>
                <div className="text-caption text-secondary">{[b.reach ? `${fmt(b.reach)} reach` : null, `${fmt(b.clicks)} clicks`, `${fmt(b.visits)} visits`, `${fmt(b.conversions)} conversions`, b.spend ? `${fmt(b.spend, "money")} spend` : null].filter(Boolean).join(" · ")}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Accounts that engaged" sub="Every account with a signal on this initiative, most active first.">
        {!r ? <div className="h-24 rounded-ctl bg-surface2 animate-pulse" /> : r.accounts.length === 0 ? <p className="m-0 text-ui text-muted">No accounts yet.</p> : (
          <div className="overflow-x-auto -mx-5 px-5">
            <table className="w-full min-w-[600px] text-ui" data-engaged-accounts="">
              <thead><tr className="text-left text-caption text-muted border-b border-border"><th className="py-2 font-medium">Account</th><th className="font-medium">Tier</th><th className="font-medium text-right px-2">Signals here</th><th className="font-medium">Heat</th><th className="font-medium">Last activity</th></tr></thead>
              <tbody>{r.accounts.slice(0, 50).map((a) => (
                <tr key={a.id} className="border-b border-border last:border-0">
                  <td className="py-2"><Link to={`/accounts?account=${a.id}`} className="text-text hover:underline">{a.name}</Link><div className="text-caption text-muted">{[a.industry, a.country].filter(Boolean).join(" · ")}</div></td>
                  <td><Tier tier={a.icp_tier} /></td>
                  <td className="text-right px-2 tabular-nums">{a.signals}</td>
                  <td><Heat heat={a.heat} score={a.engagement_score} /></td>
                  <td className="text-caption text-muted">{fmtDate(a.last_engaged_at)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="What we learned" sub="Saved with the initiative - the planner reads it the next time you plan something similar.">
        <textarea className="input min-h-[100px] text-ui" value={outcome} onChange={(e) => setOutcome(e.target.value)} disabled={!i.can_edit}
          placeholder="What worked, what to repeat, what to drop next time." data-outcome="" />
        {i.can_edit && (
          <div className="flex gap-2 flex-wrap">
            <button type="button" className="btn-secondary text-sm" onClick={async () => { try { await initiativesApi.patch(i.id, { outcome }); setSaved("Saved."); } catch (e) { onError(errorText(e)); } }}>Save notes</button>
            {i.status !== "done" && <button type="button" className="btn-primary text-sm" onClick={async () => { try { await initiativesApi.patch(i.id, { outcome, status: "done" }); reload(); setSaved("Marked as finished. Its results now inform future plans."); } catch (e) { onError(errorText(e)); } }}>Mark as finished</button>}
          </div>
        )}
      </Section>
    </div>
  );
}

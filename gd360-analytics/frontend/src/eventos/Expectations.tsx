// The expectation contract: who expects what, the agreed range, how it's
// measured, signed - and the odds from simulating the event 3,000 times.
import { useCallback, useEffect, useState } from "react";
import { Initiative } from "../api/initiatives";
import { eventApi, errText, Goal, GoalsData } from "../api/eventos";
import { Banner, CopyField, Field, Sheet } from "../initiatives/ui";
import { Bullet, C, Histogram, Ring, TimeArea } from "./charts";
import { Card, Eyebrow, fmtv, Skel, TruthPill } from "./kit";

const EMPTY = { owner_name: "", owner_role: "", owner_email: "", label: "", metric: "attended", target: "", low: "", high: "", weight: "15",
  lower_is_better: false, safety: false, actual_typed: "" };

export default function Expectations({ i, onChanged }: { i: Initiative; onChanged: () => void }) {
  const [d, setD] = useState<GoalsData | null>(null);
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState<Goal | "new" | null>(null);
  const [form, setForm] = useState<any>(EMPTY);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { eventApi.goals(i.id).then(setD).catch((e) => setErr(errText(e))); }, [i.id]);
  useEffect(load, [load]);
  const after = () => { load(); onChanged(); };
  const open = (g: Goal | "new") => {
    setEdit(g);
    setForm(g === "new" ? EMPTY : { owner_name: g.owner_name, owner_role: g.owner_role || "", owner_email: g.owner_email || "", label: g.label, metric: g.metric,
      target: String(g.target), low: String(g.low), high: String(g.high), weight: String(g.weight), lower_is_better: g.lower_is_better, safety: g.safety,
      actual_typed: g.actual_typed === null ? "" : String(g.actual_typed) });
  };
  const save = async () => {
    setBusy(true); setErr("");
    const body = { ...form, target: Number(form.target), low: Number(form.low), high: Number(form.high), weight: Number(form.weight || 0),
      actual_typed: form.actual_typed === "" ? null : Number(form.actual_typed) };
    try {
      if (edit === "new") await eventApi.addGoal(i.id, body);
      else if (edit) await eventApi.patchGoal(i.id, edit.id, body);
      setEdit(null); after();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const act = async (fn: () => Promise<any>) => { setErr(""); try { await fn(); after(); } catch (e) { setErr(errText(e)); } };
  if (!d) return <div className="grid gap-4"><Skel h={220} /><Skel h={360} /></div>;
  const cur = d.event.currency;
  const sim = d.predicted;
  const now = d.now.score;
  const hist = sim?.hist || [];
  const labels = hist.map((_, k) => (k % 4 === 0 ? String(40 + k * 2.5) : ""));
  const colors = hist.map((_, k) => (40 + k * 2.5 >= 70 ? C.primary : 40 + k * 2.5 >= 60 ? C.blue : C.faint));
  const metrics = d.metrics;
  return (
    <div className="flex flex-col gap-5" data-screen="success">
      {err && <Banner kind="error" onClose={() => setErr("")}>{err}</Banner>}
      <div className="grid gap-4 lg:grid-cols-[1fr_1.15fr]">
        <Card tone="accent">
          <div className="flex items-center gap-5 flex-wrap">
            <Ring value={now ?? sim?.median ?? null} size={132} stroke={11} color={now === null ? C.blue : C.primary} sub={now === null ? "predicted" : "of 100"} />
            <div className="flex flex-col gap-1.5 min-w-0 flex-1">
              <Eyebrow>Success, agreed before a rupee is spent</Eyebrow>
              <div className="text-[19px] font-semibold text-text text-balance">
                {now !== null ? `Event success score ${now}` : sim?.median !== null && sim?.median !== undefined ? `Predicted ${sim.median}, range ${sim.p10}–${sim.p90}` : "No goals yet"}
              </div>
              <p className="m-0 text-caption text-muted leading-relaxed max-w-[440px]">Each goal scores 0 at the bad end of its range, 70 on target and 100 at the good end. Weighted, then shown with its
                confidence - how much rests on counted proof rather than reports. A missed safety goal caps the score at 60.</p>
              <div className="text-caption text-secondary">{d.signed} of {d.total} goals signed{now !== null ? ` · ${d.now.confidence}% backed by counted numbers` : ""}</div>
            </div>
          </div>
        </Card>
        <Card title={`${(sim?.runs || 3000).toLocaleString()} simulated events with today's numbers`} sub="Where the score could land; green = meets expectations (70+)"
          right={sim?.odds70 !== null && sim?.odds70 !== undefined ? <span className="text-text font-medium">{sim.odds70}% chance of 70+</span> : null}>
          {hist.length ? <Histogram bins={hist} labels={labels} colors={colors} height={170} ariaLabel="Distribution of simulated event scores"
            marker={sim?.median ? { at: (sim.median - 40) / 2.5, label: `median ${sim.median}` } : null} />
            : <div className="text-caption text-muted">Add goals to see the odds.</div>}
        </Card>
      </div>

      <Card title={`The expectation contract · ${d.goals.length} owner${d.goals.length === 1 ? "" : "s"}`} sub="A goal without a way to measure it can't be signed. Changing a signed target needs signing again - and the report shows it."
        right={d.can_edit ? <button type="button" className="btn-primary text-sm" onClick={() => open("new")}>Add a goal</button> : null}>
        {!d.goals.length && d.suggested.length > 0 && (
          <div className="rounded-card border border-dashed border-tint-border bg-tint/30 p-4 flex flex-col gap-3">
            <div className="text-ui text-text font-medium">A starting contract for this {d.event.format_label.toLowerCase()} - change anything before signing</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {d.suggested.map((s: any, k: number) => (
                <div key={k} className="rounded-ctl border border-border bg-surface px-3 py-2 text-caption">
                  <span className="text-text font-medium">{s.owner_name}</span> · {s.label} · target {fmtv(s.target, metrics[s.metric]?.unit || "count", cur)}
                </div>
              ))}
            </div>
            {d.can_edit && <button type="button" className="btn-primary text-sm self-start" onClick={() => act(() => eventApi.addSuggested(i.id))}>Use this contract</button>}
          </div>
        )}
        <div className="flex flex-col gap-3">
          {d.goals.map((g) => (
            <div key={g.id} className="rounded-card border border-border p-4 grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)_minmax(220px,0.9fr)_150px] items-center" data-goal={g.metric}>
              <div className="flex items-center gap-3 min-w-0">
                <span className="w-9 h-9 rounded-full grid place-items-center text-[12px] font-semibold bg-surface2 border border-border shrink-0">
                  {g.owner_name.split(/[\s·]+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join("").toUpperCase()}</span>
                <div className="min-w-0">
                  <div className="text-ui font-medium text-text truncate">{g.owner_name}</div>
                  <div className={`text-caption ${g.signed ? "text-good" : "text-warning"}`}>{g.signed ? `signed v${g.version}${g.signed_by ? ` · ${g.signed_by}` : ""}` : g.version > 1 ? `changed - needs signing (v${g.version})` : "not signed yet"}</div>
                </div>
              </div>
              <div className="min-w-0 flex flex-col gap-1">
                <div className="text-ui text-text">{g.label}{g.safety && <span className="ml-2 text-[11px] text-danger">safety</span>}</div>
                <div className="text-caption text-muted flex items-center gap-2 flex-wrap">
                  <span>{g.metric_label}</span><TruthPill truth={g.truth} small /><span>weight {g.weight}</span>
                  <span>target <b className="text-text font-medium">{fmtv(g.target, g.unit, cur)}</b> · range {fmtv(g.low, g.unit, cur)} → {fmtv(g.high, g.unit, cur)}</span>
                </div>
              </div>
              <div className="min-w-0">
                <Bullet low={g.low} target={g.target} high={g.high} actual={g.actual} lowerIsBetter={g.lower_is_better} predicted={!g.final} fmtv={(v) => fmtv(v, g.unit, cur)} />
                <div className="text-caption text-muted mt-0.5">{g.actual === null ? "Not counted yet" : `${g.final ? "Actual" : "So far"} ${fmtv(g.actual, g.unit, cur)}`}</div>
              </div>
              <div className="flex flex-col items-end gap-1.5">
                {g.score !== null ? (
                  <span className="text-[22px] font-semibold tabular-nums font-mono" style={{ color: g.score >= 70 ? C.good : C.warning }}>{Math.round(g.score)}</span>
                ) : g.likelihood !== undefined && g.likelihood !== null ? (
                  <div className="w-full flex flex-col items-end gap-1">
                    <span className="text-caption" style={{ color: g.likelihood >= 60 ? C.good : g.likelihood >= 40 ? C.blue : C.warning }}>{g.likelihood}% likely</span>
                    <div className="w-full h-1.5 rounded-full bg-border/60 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${g.likelihood}%`, background: g.likelihood >= 60 ? C.good : g.likelihood >= 40 ? C.blue : C.warning }} /></div>
                  </div>
                ) : <span className="text-caption text-muted">–</span>}
                {d.can_edit && (
                  <div className="flex gap-1.5 flex-wrap justify-end">
                    {!g.signed && <button type="button" className="btn-primary !py-1 !px-2 text-[11.5px]" onClick={() => act(() => eventApi.signGoal(i.id, g.id))}>Sign</button>}
                    <button type="button" className="btn-secondary !py-1 !px-2 text-[11.5px]" onClick={() => open(g)}>Edit</button>
                  </div>
                )}
              </div>
              {!g.signed && d.can_edit && (
                <div className="lg:col-span-4 flex items-center gap-2 text-caption text-muted">
                  <span className="shrink-0">Or send {g.owner_name.split(" ")[0]} their sign link:</span>
                  <div className="flex-1 min-w-0"><CopyField value={`${d.sign_base}${g.sign_token}`} label={`Sign link for ${g.owner_name}`} testId={`sign-${g.id}`} /></div>
                </div>
              )}
              {g.history.length > 1 && (
                <details className="lg:col-span-4 text-caption text-muted">
                  <summary className="cursor-pointer">Change history ({g.history.length})</summary>
                  <div className="mt-2 flex flex-col gap-1">
                    {g.history.map((h, k) => <div key={k}><span className="font-mono">{new Date(h.at).toLocaleDateString()}</span> · {h.by} · {h.change}</div>)}
                  </div>
                </details>
              )}
            </div>
          ))}
        </div>
      </Card>

      {d.history.length > 1 && (
        <Card title="The score over time" sub="Predicted while the event is ahead, actual once it is proved">
          <TimeArea ariaLabel="Event success score over time" dates={d.history.map((h) => h.date)} height={190}
            series={[{ key: "score", label: "Score", color: C.primary, kind: "area", values: d.history.map((h) => h.score) }]} target={70} targetLabel="meets expectations" />
        </Card>
      )}

      <Sheet open={edit !== null} onClose={() => setEdit(null)} title={edit === "new" ? "Add a goal" : "Edit goal"}
        footer={<>
          {edit && edit !== "new" && d.can_edit && <button type="button" className="btn-secondary text-sm !text-danger mr-auto" onClick={() => act(async () => { await eventApi.deleteGoal(i.id, (edit as Goal).id); setEdit(null); })}>Delete</button>}
          <button type="button" className="btn-secondary text-sm" onClick={() => setEdit(null)}>Cancel</button>
          <button type="button" className="btn-primary text-sm" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
        </>}>
        {err && <Banner kind="error">{err}</Banner>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Owner (who judges it)"><input className="input" value={form.owner_name} onChange={(e) => setForm({ ...form, owner_name: e.target.value })} placeholder="Kiran · CEO" /></Field>
          <Field label="Their email (for the sign link)"><input className="input" value={form.owner_email} onChange={(e) => setForm({ ...form, owner_email: e.target.value })} placeholder="kiran@company.com" /></Field>
        </div>
        <Field label="What they expect"><input className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Pipeline sourced in 90 days" /></Field>
        <Field label="Measured as" hint={metrics[form.metric] ? `${metrics[form.metric].truth} · counted ${metrics[form.metric].phase === "before" ? "before the event" : metrics[form.metric].phase === "during" ? "on the day" : "after the event"}` : "typed by the owner (reported)"}>
          <select className="input" value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value, lower_is_better: metrics[e.target.value] ? !metrics[e.target.value].higher : form.lower_is_better })}>
            {Object.entries(metrics).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
            <option value="custom">Something else (typed)</option>
          </select>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label={form.lower_is_better ? "Worst acceptable" : "Low end"}><input className="input" inputMode="decimal" value={form.low} onChange={(e) => setForm({ ...form, low: e.target.value })} /></Field>
          <Field label="Target"><input className="input" inputMode="decimal" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} /></Field>
          <Field label="Good end"><input className="input" inputMode="decimal" value={form.high} onChange={(e) => setForm({ ...form, high: e.target.value })} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Weight" hint="How much this goal counts"><input className="input" inputMode="decimal" value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} /></Field>
          {form.metric === "custom" && <Field label="Actual (typed)"><input className="input" inputMode="decimal" value={form.actual_typed} onChange={(e) => setForm({ ...form, actual_typed: e.target.value })} /></Field>}
        </div>
        <label className="flex items-center gap-2 text-ui"><input type="checkbox" checked={form.lower_is_better} onChange={(e) => setForm({ ...form, lower_is_better: e.target.checked })} /> Lower is better (cost, queue time)</label>
        <label className="flex items-center gap-2 text-ui"><input type="checkbox" checked={form.safety} onChange={(e) => setForm({ ...form, safety: e.target.checked })} /> Safety or compliance goal - a miss caps the event score at 60</label>
      </Sheet>
    </div>
  );
}

// 2026-10-17 (R53): Pace - where each target will likely land (an 80% range and the odds of reaching it),
// the three moves that help most, the budget mix from response curves, the autopilot policy and the log of
// everything the agents did (with undo).
import { useCallback, useEffect, useState } from "react";
import { errorText, Initiative } from "../api/initiatives";
import { Action, ApOne, autopilotApi, Mix, Pace } from "../api/autopilot";
import { Banner, Empty, fmt, Section } from "../initiatives/ui";
import { ActionRow, CurveChart, DecisionsPanel, MoveRow, PolicyEditor, RangeRow } from "./kit";

export default function PaceTab({ i, reload, decisions = true }: { i: Initiative; reload: () => void; decisions?: boolean }) {
  const [ap, setAp] = useState<ApOne | null>(null);
  const [pace, setPace] = useState<Pace | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    autopilotApi.one(i.id).then(setAp).catch((e) => setErr(errorText(e)));
    autopilotApi.pace(i.id).then(setPace).catch((e) => setErr(errorText(e, "Couldn't load the forecast.")));
  }, [i.id]);
  useEffect(load, [load]);
  const changed = () => { load(); reload(); };

  return (
    <div className="flex flex-col gap-5" data-pace-tab="">
      {err && <Banner kind="error" onClose={() => setErr("")}>{err}</Banner>}
      {decisions && <DecisionsPanel d={ap?.decisions || null} canEdit={i.can_edit} onChanged={changed} />}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] items-start">
        <Section title="Where it will land" sub={pace?.share_of_time !== null && pace?.share_of_time !== undefined ? `${Math.round(100 * pace.share_of_time)}% of the time has gone. Bars: now, the likely range at the end, and the target (the line).` : "The likely range at the end against each target."}>
          {!pace ? <div className="h-40 rounded-ctl bg-surface2 animate-pulse" /> : pace.forecast.length === 0 ? (
            <Empty title="No targets to forecast" body="Add targets in the plan and the Pacer forecasts each one." />
          ) : <div className="flex flex-col">{pace.forecast.map((f) => <RangeRow key={f.key} f={f} />)}</div>}
        </Section>
        <Section title="Three moves that help most" sub="Ranked by how much they move the target that is furthest behind.">
          {!pace ? <div className="h-40 rounded-ctl bg-surface2 animate-pulse" /> : pace.moves.length === 0 ? (
            <p className="m-0 text-ui text-muted">Nothing to change: every target is on pace or has no data yet.</p>
          ) : (
            <div className="flex flex-col">
              {pace.moves.map((m) => <MoveRow key={m.key} m={m} canEdit={i.can_edit} onDo={async (mv) => {
                try { await autopilotApi.move(i.id, mv.key); changed(); } catch (e) { setErr(errorText(e)); throw e; }
              }} />)}
            </div>
          )}
        </Section>
      </div>
      <MixSection i={i} />
      <ControlsSection i={i} ap={ap} onChanged={changed} onError={setErr} />
    </div>
  );
}

export function MixSection({ i }: { i: Initiative }) {
  const [mix, setMix] = useState<Mix | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { autopilotApi.mix(i.id).then(setMix).catch((e) => setErr(errorText(e))); }, [i.id]);
  return (
    <Section title="Budget mix" sub="Response curves from this initiative's own daily ad spend: where the next dollar buys the most.">
      {err && <Banner kind="error">{err}</Banner>}
      {!mix ? <div className="h-40 rounded-ctl bg-surface2 animate-pulse" /> : !mix.available ? (
        <Empty title="Curves appear after ad spend" body={mix.why} />
      ) : (
        <div className="flex flex-col gap-4" data-mix="">
          <CurveChart mix={mix} />
          <div className="overflow-x-auto">
            <table className="w-full text-caption tabular-nums min-w-[560px]">
              <thead><tr className="text-muted text-left"><th className="font-normal py-1.5">Platform</th><th className="font-normal text-right">Spend</th><th className="font-normal text-right">Results</th>
                <th className="font-normal text-right">Cost per result</th><th className="font-normal text-right">Next $100 buys</th><th className="font-normal text-right">Fit</th></tr></thead>
              <tbody>
                {mix.channels!.map((c) => (
                  <tr key={c.platform} className="border-t border-border" data-mix-row={c.platform}>
                    <td className="py-2 text-text">{c.platform}<span className="text-muted"> · {c.days} days</span></td>
                    <td className="text-right">{fmt(c.spend, "money")}</td><td className="text-right">{fmt(c.results)}</td>
                    <td className="text-right">{c.cost_per_result !== null ? fmt(c.cost_per_result, "money") : "—"}</td>
                    <td className="text-right">{fmt(c.marginal * 100)}</td>
                    <td className="text-right text-muted">{c.fit === "curve" ? `curve${c.r2 !== null ? `, r² ${c.r2}` : ""}` : "straight line (too few days)"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mix.plan_b ? (
            <div className="rounded-ctl border border-tint-border bg-tint/50 p-3.5 flex flex-col gap-1" data-plan-b="">
              <span className="text-ui text-text font-medium">Plan B: {mix.plan_b.title}</span>
              <span className="text-caption text-secondary">{mix.plan_b.detail}</span>
              <span className="text-caption text-muted">GD360 can't change budgets inside Meta or Google Ads. Approving it adds a task with the exact numbers for whoever runs the ads.</span>
            </div>
          ) : <p className="m-0 text-caption text-muted">{mix.note || "The current split is close to the best the curves show."}</p>}
        </div>
      )}
    </Section>
  );
}

export function ControlsSection({ i, ap, onChanged, onError }: { i: Initiative; ap: ApOne | null; onChanged: () => void; onError: (s: string) => void }) {
  const [acts, setActs] = useState<Action[] | null>(null);
  const [all, setAll] = useState(false);
  const loadActs = useCallback(() => { autopilotApi.actions(i.id).then(setActs).catch((e) => onError(errorText(e))); }, [i.id, onError]);
  useEffect(loadActs, [loadActs]);
  const shown = (acts || []).filter((a) => a.state !== "proposed");
  return (
    <div className="grid gap-5 lg:grid-cols-2 items-start">
      <Section title="Autopilot policy" sub="What the agents may do alone for this initiative. Everything they do is logged and can be undone.">
        {!ap ? <div className="h-40 rounded-ctl bg-surface2 animate-pulse" /> : (
          <PolicyEditor p={ap.policy} canEdit={i.can_edit} onSave={async (b) => { try { await autopilotApi.setPolicy(i.id, b); onChanged(); } catch (e) { onError(errorText(e)); } }} />
        )}
      </Section>
      <Section title="What the agents did" sub="Newest first. Undo puts things back the way they were.">
        {!acts ? <div className="h-40 rounded-ctl bg-surface2 animate-pulse" /> : shown.length === 0 ? <p className="m-0 text-ui text-muted">Nothing yet.</p> : (
          <div className="flex flex-col" data-action-log="">
            {(all ? shown : shown.slice(0, 6)).map((a) => <ActionRow key={a.id} a={a} canEdit={i.can_edit} onChanged={() => { loadActs(); onChanged(); }} />)}
            {shown.length > 6 && <button type="button" className="text-caption text-brand-ink hover:underline self-start mt-2" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${shown.length}`}</button>}
          </div>
        )}
      </Section>
    </div>
  );
}

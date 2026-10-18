// 2026-10-17 (R53): Proof - did it work, and how sure are we: targets with how true each number is, the lift
// against what would have happened anyway (and a region test when the initiative had a scope), the pipeline
// it sourced, the show-up calibration for events, the learnings that feed the next plan, and a board PDF.
import { useCallback, useEffect, useState } from "react";
import { errorText, Initiative } from "../api/initiatives";
import { autopilotApi, Proof } from "../api/autopilot";
import { Banner, fmt, Meter, Section, Stat } from "../initiatives/ui";
import { LiftPanel, TruthChip } from "./kit";

export default function ProofTab({ i }: { i: Initiative }) {
  const [p, setP] = useState<Proof | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  const load = useCallback(() => {
    autopilotApi.proof(i.id).then((x) => { setP(x); setText((t) => t || (x.published || x.learnings.map((l) => `• ${l}`).join("\n"))); })
      .catch((e) => setErr(errorText(e, "Couldn't load the proof.")));
  }, [i.id]);
  useEffect(load, [load]);

  const pdf = async () => {
    setBusy("pdf"); setErr("");
    try { await autopilotApi.report(i.id, i.title); } catch (e) { setErr(errorText(e, "Couldn't build the PDF.")); } finally { setBusy(""); }
  };
  const publish = async () => {
    setBusy("pub"); setErr("");
    try { await autopilotApi.publish(i.id, text.trim()); setSaved(true); load(); } catch (e) { setErr(errorText(e)); } finally { setBusy(""); }
  };

  return (
    <div className="flex flex-col gap-5" data-proof-tab="">
      {err && <Banner kind="error" onClose={() => setErr("")}>{err}</Banner>}
      <section className="rounded-card border border-border bg-surface p-5 sm:p-6 flex flex-wrap gap-5 items-center justify-between" data-verdict="">
        <div className="min-w-0 flex-[1_1_420px] flex flex-col gap-1">
          <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Verdict · {p?.period || "…"}</span>
          <div className="text-[19px] leading-snug font-semibold text-text text-balance">{p ? p.verdict : "Working it out…"}</div>
        </div>
        <button type="button" className="btn-primary text-sm" onClick={pdf} disabled={busy === "pdf"} data-report-pdf="">{busy === "pdf" ? "Building…" : "Board report (PDF)"}</button>
      </section>

      {p && (
        <>
          <Section title="Targets" sub="Each number says how true it is: counted by GD360, matched from a source, or typed by a person.">
            <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
              {p.targets.map((t) => (
                <div key={t.key} className="flex flex-col gap-1.5">
                  <Meter t={t} />
                  <div><TruthChip truth={t.truth} title={t.from || undefined} /></div>
                </div>
              ))}
            </div>
          </Section>

          <div className="grid gap-5 lg:grid-cols-2 items-start">
            <Section title="Lift" sub="Compared with what the 8 weeks before predicted for these days (trend and weekday), with a 90% range.">
              <LiftPanel l={p.lift} title="Website sessions, all regions" />
            </Section>
            <Section title="Region test" sub="The regions in scope against every other region as the control.">
              <LiftPanel l={p.geo} title={p.geo.treated ? `Sessions in ${p.geo.treated.join(", ")}` : "Regions in scope"} />
            </Section>
          </div>

          <Section title="Pipeline" sub={`Deals at companies this initiative touched, from ${p.pipeline.sources.map((s) => s.name).join(", ") || "your CRM"}. Sourced: created after the first touch.`}>
            <div className="grid gap-5 grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
              <Stat label={`Sourced · ${p.pipeline.sourced_n} deal${p.pipeline.sourced_n === 1 ? "" : "s"}`} value={fmt(p.pipeline.sourced, "money")} />
              <Stat label={`Influenced · ${p.pipeline.influenced_n}`} value={fmt(p.pipeline.influenced, "money")} />
              <Stat label={`Won · ${p.pipeline.won_n}`} value={fmt(p.pipeline.won, "money")} tone={p.pipeline.won ? "good" : undefined} />
            </div>
            {p.pipeline.deals.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-caption tabular-nums min-w-[520px]">
                  <thead><tr className="text-muted text-left"><th className="font-normal py-1.5">Deal</th><th className="font-normal">Company</th><th className="font-normal">Stage</th><th className="font-normal text-right">Amount</th><th className="font-normal text-right">How</th></tr></thead>
                  <tbody>{p.pipeline.deals.slice(0, 15).map((d: any, k: number) => (
                    <tr key={k} className="border-t border-border"><td className="py-2 text-text">{d.name}</td><td className="text-secondary">{d.company || "—"}</td><td className="text-secondary">{d.stage || "—"}</td>
                      <td className="text-right">{fmt(d.amount, "money")}</td><td className="text-right text-muted">{d.how || d.kind || ""}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Section>

          {p.calibration && <Calibration c={p.calibration} />}

          <Section title="What we learned" sub="Drafted from the numbers. Publish it and the next plan starts from it (the business brain keeps it).">
            <textarea className="input min-h-[140px] text-ui leading-relaxed" value={text} onChange={(e) => { setText(e.target.value); setSaved(false); }} disabled={!i.can_edit} aria-label="Learnings" data-learnings="" />
            <div className="flex items-center gap-3 flex-wrap">
              {i.can_edit && <button type="button" className="btn-primary text-sm" onClick={publish} disabled={busy === "pub" || text.trim().length < 3} data-publish="">{busy === "pub" ? "Publishing…" : p.published ? "Publish again" : "Publish the learnings"}</button>}
              {(saved || p.published) && <span className="text-caption text-good">✓ Published - the next plan reads it</span>}
            </div>
          </Section>
        </>
      )}
      {!p && !err && <div className="grid gap-4">{[140, 220].map((h, k) => <div key={k} className="rounded-card bg-surface2 animate-pulse" style={{ height: h }} />)}</div>}
    </div>
  );
}

export function Calibration({ c }: { c: any }) {
  return (
    <Section title="Show-up calibration" sub="The show-up chance GD360 gave each registration, against who really came.">
      {c.state !== "ok" ? <p className="m-0 text-ui text-muted">{c.why}</p> : (
        <div className="flex flex-col gap-3" data-calibration="">
          <div className="flex flex-col gap-2">
            {c.bands.map((b: any) => (
              <div key={b.band} className="grid grid-cols-[90px_1fr_auto] gap-3 items-center text-caption" data-band={b.band}>
                <span className="text-secondary tabular-nums">{b.band} <span className="text-muted">· {b.n}</span></span>
                <div className="relative h-3 rounded-full bg-surface2">
                  <div className="absolute top-0 bottom-0 rounded-full bg-primary/30" style={{ width: `${b.predicted}%` }} />
                  <div className="absolute -top-0.5 -bottom-0.5 w-[3px] rounded bg-primary" style={{ left: `calc(${Math.min(100, b.came)}% - 1px)` }} title={`${b.came}% came`} />
                </div>
                <span className={`tabular-nums ${b.ok ? "text-good" : "text-warning"}`}>{b.came}% came vs {b.predicted}%</span>
              </div>
            ))}
          </div>
          <p className="m-0 text-caption text-secondary">{c.verdict}. Brier score {c.brier} over {c.n} registrations (0 is perfect, 0.25 is a coin toss).</p>
        </div>
      )}
    </Section>
  );
}

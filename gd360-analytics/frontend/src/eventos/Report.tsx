// The report: expected vs actual for every owner, why, the money, the
// pipeline, the posts, learnings - and the A to Z export (PDF and Excel).
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Initiative } from "../api/initiatives";
import { eventApi, errText, Report } from "../api/eventos";
import { useThemeMode, useTransientTheme } from "../api/ThemeContext";
import { Banner, Field, Sheet } from "../initiatives/ui";
import { Bullet, C, compact, HBar, Ring, TimeArea } from "./charts";
import { Card, Eyebrow, fmtv, money, Skel, TRUTH_COLOR, TruthPill } from "./kit";

const SECTIONS: [string, string][] = [
  ["A", "Summary and success score"], ["B", "Expectations vs actual"], ["C", "Plan and tasks"], ["D", "Budget and P&L"], ["E", "Tracking and channels"],
  ["F", "Registrations and demand"], ["G", "Posts before"], ["H", "Event day"], ["I", "Sessions and livestream"], ["J", "Sponsors"], ["K", "Posts after"],
  ["L", "Follow-up"], ["M", "Pipeline and impact"], ["N", "ROI and confidence"], ["O", "Learnings"], ["P", "Raw data (people, leads, posts)"],
];
const PRESETS: Record<string, string[]> = {
  "Full A–Z": SECTIONS.map((s) => s[0]).filter((s) => s !== "P"), "CEO one-pager": ["A", "B", "N"], "Board deck": ["A", "B", "D", "M", "N", "O"],
  "Finance pack": ["A", "D", "M", "N"], "Marketing pack": ["A", "E", "F", "G", "K", "O"],
};
const PDF_SECTION: Record<string, string> = { A: "summary", B: "goals", D: "money", E: "channels", F: "channels", G: "buzz", K: "buzz", H: "sessions", I: "sessions", J: "sessions", M: "pipeline", N: "money", O: "learnings" };

export default function ReportTab({ i }: { i: Initiative }) {
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState("");
  const [exp, setExp] = useState(false);
  const [sel, setSel] = useState<string[]>(PRESETS["Full A–Z"]);
  const [mask, setMask] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [learn, setLearn] = useState<{ kind: string; title: string; proof: string }[]>([]);
  const [clone, setClone] = useState(false);
  const [cl, setCl] = useState({ title: "", key_date: "" });
  const ref = useRef<HTMLDivElement>(null);
  const screenTheme = useThemeMode();
  const setTransientTheme = useTransientTheme();
  const nav = useNavigate();
  const load = () => { eventApi.report(i.id).then((x) => { setR(x); setLearn(x.learnings); }).catch((e) => setErr(errText(e))); };
  useEffect(load, [i.id]);
  if (!r) return <div className="grid gap-4"><Skel h={180} /><Skel h={380} /></div>;
  const cur = r.currency;
  const sc = r.score;
  const v = r.values;
  const now = sc.now.score;
  const finals = sc.goals.filter((g) => g.final);
  const met = finals.filter((g) => g.meets).length;
  const headline = now !== null
    ? `${r.event.title.replace(/\s*\(sample\)$/, "")} ${now >= 70 ? "beat expectations" : now >= 60 ? "came close to expectations" : "missed expectations"}: ${met} of ${finals.length} goals met`
    : `${r.event.title} - predicted ${sc.predicted?.median ?? "–"}`;
  const tc = r.costs.reduce((s, x) => s + x.amount, 0), ti = r.income.reduce((s, x) => s + x.amount, 0);
  const maxMoney = Math.max(1, ...r.costs.map((x) => x.amount), ...r.income.map((x) => x.amount));
  const doPdf = async () => {
    if (!ref.current) return;
    setBusy("pdf"); setErr("");
    const keep = new Set(sel.map((s) => PDF_SECTION[s]).filter(Boolean));
    keep.add("summary");
    const nodes = Array.from(ref.current.querySelectorAll<HTMLElement>("[data-report-section]"));
    nodes.forEach((n) => { if (!keep.has(n.dataset.reportSection || "")) n.setAttribute("data-pdf-exclude", ""); });
    try {
      const { exportDashboardPdf } = await import("../dashboard/pdfExport");
      await exportDashboardPdf({ target: ref.current, title: `${r.event.title} - A to Z report`, subtitle: `${r.event.format_label} · ${r.event.location || ""} · score ${now ?? sc.predicted?.median ?? "–"}`,
        theme: "screen", orientation: "portrait", currentTheme: screenTheme, setTransientTheme });
    } catch { setErr("Couldn't make the PDF - try again."); } finally {
      nodes.forEach((n) => n.removeAttribute("data-pdf-exclude"));
      setBusy(null);
    }
  };
  const doXlsx = async () => {
    setBusy("xlsx"); setErr("");
    try { await eventApi.exportXlsx(i.id, sel, mask, r.event.title); } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  };
  const saveLearn = async () => {
    setBusy("learn");
    try { await eventApi.putLearnings(i.id, learn); load(); } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  };
  const doClone = async () => {
    setBusy("clone"); setErr("");
    try { const x = await eventApi.clone(i.id, cl.title, cl.key_date || undefined); nav(`/initiatives/${x.id}`); } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  };
  return (
    <div className="flex flex-col gap-5" data-screen="report">
      {err && <Banner kind="error" onClose={() => setErr("")}>{err}</Banner>}
      <div className="flex justify-end gap-2 flex-wrap" data-pdf-exclude="">
        <button type="button" className="btn-secondary text-sm" onClick={() => { setCl({ title: r.event.title.replace(/\s*\(sample\)$/, "").replace(/\d{4}/, (y) => String(Number(y) + 1)) + (/\d{4}/.test(r.event.title) ? "" : " (next)"), key_date: "" }); setClone(true); }}>Plan the next one</button>
        <button type="button" className="btn-primary text-sm" onClick={() => setExp(true)} data-open-export="">Export A–Z</button>
      </div>
      <div ref={ref} className="flex flex-col gap-5">
        <Card tone="accent" className="!gap-4" >
          <div data-report-section="summary" data-pdf-block="" className="flex items-center gap-6 flex-wrap">
            <Ring value={now ?? sc.predicted?.median ?? null} size={128} stroke={11} sub={now === null ? "predicted" : "of 100"} color={now === null ? C.blue : C.primary} />
            <div className="flex flex-col gap-1.5 min-w-0 flex-1">
              <Eyebrow>{r.event.phase_now === "done" ? "Final report" : "Report so far"} · {r.event.windows.start_local ? new Date(r.event.windows.start_local).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : ""}</Eyebrow>
              <h2 className="m-0 text-[22px] sm:text-[26px] font-semibold text-text text-balance tracking-tight">{headline}</h2>
              <p className="m-0 text-ui text-secondary max-w-[760px]">
                {now !== null ? `Score ${now} with ${sc.now.confidence}% confidence. ` : ""}
                {sc.history.length > 1 ? `It moved from ${sc.history[0].score} at planning to ${sc.history[sc.history.length - 1].score}. ` : ""}
                {sc.goals.some((g) => g.history.length > 2) ? "Some targets were changed after signing - shown below." : "Signed targets were never changed."}
              </p>
              <div className="flex gap-2 flex-wrap items-center">{Object.entries(sc.truth_mix).map(([k, p]) => <span key={k} className="inline-flex items-center gap-1 text-caption text-muted"><TruthPill truth={k} small />{p}%</span>)}</div>
            </div>
          </div>
        </Card>

        <div data-report-section="goals" data-pdf-block="">
          <Card title="Expected vs actual, per owner" sub="dot = actual · tick = target · band = agreed range">
            <div className="flex flex-col">
              {sc.goals.map((g) => (
                <div key={g.id} className="grid gap-3 md:grid-cols-[240px_minmax(0,1fr)_130px_90px_50px] items-center py-2.5 border-t border-border first:border-t-0">
                  <div className="min-w-0"><div className="text-ui text-text truncate">{g.label}</div><div className="text-caption text-muted">{g.owner_name}</div></div>
                  <Bullet low={g.low} target={g.target} high={g.high} actual={g.actual} lowerIsBetter={g.lower_is_better} predicted={!g.final} fmtv={(x) => fmtv(x, g.unit, cur)} />
                  <div className="text-ui tabular-nums"><b className="font-semibold">{fmtv(g.actual, g.unit, cur)}</b> <span className="text-caption text-muted">vs {fmtv(g.target, g.unit, cur)}</span></div>
                  <TruthPill truth={g.truth} small />
                  <span className="text-[16px] font-semibold font-mono tabular-nums text-right" style={{ color: g.score === null ? C.muted : g.score >= 70 ? C.good : C.warning }}>{g.score !== null ? Math.round(g.score) : "–"}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2" data-report-section="summary" data-pdf-block="">
          <Card title="The score, from plan to proof" sub="Green line = meets expectations (70)">
            {sc.history.length > 1 ? <TimeArea ariaLabel="Score over time" dates={sc.history.map((h) => h.date)} height={180} target={70} targetLabel="70"
              series={[{ key: "s", label: "Score", color: C.primary, kind: "area", values: sc.history.map((h) => h.score) }]} />
              : <div className="text-caption text-muted">The journey draws as days pass.</div>}
          </Card>
          <Card title="What moved the score" sub="Each goal's distance from target (70 points)">
            <div className="flex flex-col gap-2.5">
              {r.drivers.map((d) => (
                <div key={d.label} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_56px] items-center gap-3">
                  <span className="text-ui text-text truncate">{d.label}</span>
                  <div className="relative h-2.5">
                    <span className="absolute inset-y-0 left-1/2 w-px bg-border-strong" />
                    <div className="absolute inset-y-0 rounded-full" style={{ background: d.delta >= 0 ? C.good : C.warning, left: d.delta >= 0 ? "50%" : `${50 + (d.delta / 70) * 50}%`, width: `${(Math.min(Math.abs(d.delta), 70) / 70) * 50}%` }} />
                  </div>
                  <span className="text-caption tabular-nums text-right" style={{ color: d.delta >= 0 ? C.good : C.warning }}>{d.delta >= 0 ? "+" : ""}{d.delta}</span>
                </div>
              ))}
              {!r.drivers.length && <div className="text-caption text-muted">Appears once goals have numbers.</div>}
            </div>
          </Card>
        </div>

        <div data-report-section="money" data-pdf-block="">
          <Card title="Money" sub={`${cur} · costs typed or synced, income from sponsors and paid passes, revenue expected from pipeline × win rate (modelled)`}>
            <div className="grid gap-3 grid-cols-2 md:grid-cols-5">
              {[["Event cost", money(v.total_cost, cur), v.cost_per_attendee ? `${money(v.cost_per_attendee, cur, true)} per attendee` : ""],
                ["Income", money(v.income, cur), tc ? `covers ${Math.round((100 * ti) / tc)}% of cost` : ""],
                ["Pipeline sourced", money(v.pipeline_sourced, cur), `${r.deals.sourced_n} deals · ${money(r.deals.influenced, cur)} influenced`],
                ["Revenue expected", money(v.expected_revenue, cur), "modelled"], ["ROI", v.roi_pct !== null ? `${v.roi_pct}%` : "–", "(benefit - cost) ÷ cost"]].map(([l, x, s]) => (
                <div key={l} className="flex flex-col"><span className="text-caption text-muted">{l}</span><span className="text-[22px] font-semibold tabular-nums">{x}</span><span className="text-caption text-secondary">{s}</span></div>
              ))}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">{r.costs.map((c) => <HBar key={c.label} label={c.label} value={c.amount} max={maxMoney} right={money(c.amount, cur)} color="rgb(var(--color-border-strong))" />)}</div>
              <div className="flex flex-col gap-2">{r.income.map((c) => <HBar key={c.label} label={c.label} value={c.amount} max={maxMoney} right={money(c.amount, cur)} color={C.primary} />)}
                {!r.income.length && <div className="text-caption text-muted">Add sponsor amounts and ticket prices in Setup.</div>}</div>
            </div>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
          <div data-report-section="pipeline" data-pdf-block="">
            <Card title="Pipeline from the event" sub={r.deals.sources.length ? "HubSpot deals at companies that came" : "Connect HubSpot to match deals to the companies that came"}>
              <div className="flex flex-col">
                {r.deals.deals.slice(0, 9).map((dl: any) => (
                  <div key={dl.deal_id} className="grid grid-cols-[minmax(0,1fr)_90px_80px] gap-2 py-2 border-t border-border first:border-t-0 items-center text-ui">
                    <span className="truncate text-text">{dl.name}</span>
                    <span className="text-caption" style={{ color: dl.won ? C.good : dl.kind === "influenced" ? C.blue : C.text }}>{dl.won ? "won" : dl.kind === "influenced" ? "influenced" : dl.stage}</span>
                    <span className="text-right tabular-nums">{money(dl.amount, cur)}</span>
                  </div>
                ))}
                {!r.deals.deals.length && <div className="text-caption text-muted">No matched deals yet.</div>}
              </div>
            </Card>
          </div>
          <div data-report-section="buzz" data-pdf-block="">
            <Card title="Posts about the event" sub="Found by hashtag, link, code, words or the banner in the picture">
              <div className="grid grid-cols-3 gap-3">
                {(["before", "during", "after"] as const).map((ph) => (
                  <div key={ph} className="flex flex-col"><span className="text-caption text-muted capitalize">{ph}</span><span className="text-[22px] font-semibold tabular-nums">{(r.buzz[ph] ?? 0).toLocaleString()}</span></div>
                ))}
              </div>
              <div className="text-caption text-secondary">{compact(r.buzz.reach || 0)} reach · {r.buzz.positive_share !== null ? `${Math.round(r.buzz.positive_share)}% positive` : ""} · earned media value is never added to ROI</div>
            </Card>
          </div>
        </div>

        <div data-report-section="sessions" data-pdf-block="" className="grid gap-4 lg:grid-cols-2">
          <Card title="Sessions" sub="Fill and rating">
            {r.sessions.slice(0, 8).map((s) => <HBar key={s.id} label={s.title} sub={s.room || undefined} value={s.fill || 0} max={110} right={`${s.fill ?? "–"}% · ${s.rating ?? "–"}★`} color={(s.fill || 0) > 100 ? C.danger : C.primary} />)}
            {!r.sessions.length && <div className="text-caption text-muted">No sessions added.</div>}
          </Card>
          <Card title="Sponsors" sub="Leads against their goal">
            {r.sponsors.slice(0, 8).map((s) => <HBar key={s.id} label={s.name} value={s.leads} max={Math.max(...r.sponsors.map((x) => Math.max(x.leads, x.goal || 0)), 1)} right={`${s.leads}/${s.goal ?? "–"}`} color={s.goal && s.leads >= s.goal ? C.good : C.warning} />)}
            {!r.sponsors.length && <div className="text-caption text-muted">No sponsors.</div>}
          </Card>
        </div>

        <div data-report-section="learnings" data-pdf-block="">
          <Card title="Learnings, each with its proof" sub="Drafted from the numbers - keep, edit or delete. They travel into the next edition." right={r.can_edit ? <button type="button" className="btn-secondary text-sm" data-pdf-exclude="" disabled={busy === "learn"} onClick={saveLearn}>{busy === "learn" ? "Saving…" : "Save learnings"}</button> : null}>
            <div className="grid gap-3 md:grid-cols-3">
              {learn.map((l, k) => (
                <div key={k} className="rounded-card border border-border bg-surface2/40 p-3 flex flex-col gap-1.5">
                  <select className="input !py-1 !w-auto text-caption self-start" value={l.kind} disabled={!r.can_edit} onChange={(e) => setLearn(learn.map((x, j) => (j === k ? { ...x, kind: e.target.value } : x)))} aria-label="Kind">
                    <option value="keep">keep</option><option value="change">change</option><option value="stop">stop</option><option value="fix">fix</option>
                  </select>
                  <input className="input !py-1.5 text-ui" value={l.title} disabled={!r.can_edit} onChange={(e) => setLearn(learn.map((x, j) => (j === k ? { ...x, title: e.target.value } : x)))} aria-label="Learning" />
                  <span className="text-caption text-muted">{l.proof}</span>
                  {r.can_edit && <button type="button" className="text-[11.5px] text-muted hover:text-danger self-start" data-pdf-exclude="" onClick={() => setLearn(learn.filter((_, j) => j !== k))}>Remove</button>}
                </div>
              ))}
              {r.can_edit && <button type="button" data-pdf-exclude="" className="rounded-card border border-dashed border-border-strong p-3 text-caption text-muted hover:text-text" onClick={() => setLearn([...learn, { kind: "keep", title: "", proof: "added by you" }])}>+ Add a learning</button>}
            </div>
          </Card>
        </div>
      </div>

      <Sheet open={exp} onClose={() => setExp(false)} title="Export the event, A to Z" wide
        footer={<>
          <label className="flex items-center gap-2 text-caption mr-auto"><input type="checkbox" checked={mask} onChange={(e) => setMask(e.target.checked)} /> Hide personal data (names and emails masked)</label>
          <button type="button" className="btn-secondary text-sm" disabled={!!busy} onClick={doXlsx}>{busy === "xlsx" ? "Building…" : "Excel (all tables)"}</button>
          <button type="button" className="btn-primary text-sm" disabled={!!busy} onClick={async () => { setExp(false); await doPdf(); }}>{busy === "pdf" ? "Making the PDF…" : "PDF report"}</button>
        </>}>
        <div className="flex gap-2 flex-wrap">{Object.keys(PRESETS).map((p) => (
          <button key={p} type="button" className={`h-7 px-3 rounded-full border text-caption ${PRESETS[p].join() === sel.join() ? "border-tint-border bg-tint text-text" : "border-border text-muted hover:text-text"}`} onClick={() => setSel(PRESETS[p])}>{p}</button>))}</div>
        <div className="grid sm:grid-cols-2 gap-x-6">
          {SECTIONS.map(([k, label]) => (
            <label key={k} className="flex items-center gap-2.5 py-1.5 border-b border-border text-ui">
              <input type="checkbox" checked={sel.includes(k)} onChange={(e) => setSel(e.target.checked ? [...sel, k].sort() : sel.filter((x) => x !== k))} />
              <span className="font-mono text-caption text-brand-ink w-4">{k}</span><span className="text-text">{label}</span>
            </label>
          ))}
        </div>
        <div className="text-caption text-muted">The PDF is the report as you see it, cut into pages between sections. The Excel has every section as its own sheet - with the raw people, leads and posts when P is ticked - and the truth label of every number.</div>
        <div className="flex gap-2 flex-wrap">{Object.entries(TRUTH_COLOR).map(([k]) => <TruthPill key={k} truth={k} small />)}</div>
      </Sheet>
      <Sheet open={clone} onClose={() => setClone(false)} title="Plan the next edition"
        footer={<><button type="button" className="btn-secondary text-sm" onClick={() => setClone(false)}>Cancel</button>
          <button type="button" className="btn-primary text-sm" disabled={!cl.title.trim() || busy === "clone"} onClick={doClone}>{busy === "clone" ? "Creating…" : "Create with the learnings"}</button></>}>
        <p className="m-0 text-ui text-secondary">Same setup, the same goals to sign again, the sponsors to re-invite, and these {learn.length} learnings attached. Nothing counted yet.</p>
        <Field label="Name"><input className="input" value={cl.title} onChange={(e) => setCl({ ...cl, title: e.target.value })} /></Field>
        <Field label="Date" hint="Leave empty for the same date next year"><input type="date" className="input" value={cl.key_date} onChange={(e) => setCl({ ...cl, key_date: e.target.value })} /></Field>
      </Sheet>
    </div>
  );
}

// 2026-10-10: the initiative planner. A sentence becomes a full plan -
// questions only where the answer changes the plan, then targets (learned
// from earlier initiatives), roles, phases with dated tasks, the tools and
// why, and the scope it is measured on. Everything is editable before it
// is created.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { Catalog, errorText, initiativesApi, Kind, PlanDraft } from "../api/initiatives";
import { Banner, fmtDate, KIND_LABEL, KindBadge, KindGlyph, Section, tone } from "../initiatives/ui";

const KINDS: Kind[] = ["event", "webinar", "campaign", "abm", "hiring", "product", "custom"];
const CHANNELS = [
  { id: "organic_social", label: "Organic social" }, { id: "paid_social", label: "Paid social" }, { id: "email", label: "Email" },
  { id: "events", label: "Events" }, { id: "website", label: "Website" }, { id: "paid_search", label: "Paid search" }, { id: "outreach", label: "Sales outreach" },
];
const MARKETING = new Set<Kind>(["event", "webinar", "campaign", "abm"]);

export default function InitiativeNew() {
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [brief, setBrief] = useState(params.get("brief") || "");
  const [kind, setKind] = useState<Kind | "">((params.get("kind") as Kind) || "");
  const [keyDate, setKeyDate] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<PlanDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [change, setChange] = useState("");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [regions, setRegions] = useState("");
  const [channels, setChannels] = useState<string[]>([]);
  const started = useRef(false);

  useEffect(() => { initiativesApi.catalog().then(setCatalog).catch(() => undefined); }, []);

  const draft = async (opts: { instruction?: string; answersOverride?: Record<string, string> } = {}) => {
    if (!brief.trim()) { setError("Describe what you're planning first."); return; }
    setBusy(true);
    setError("");
    try {
      const p = await initiativesApi.draft({
        workspace_id: activeWorkspaceId || undefined, brief: brief.trim(), kind: kind || undefined,
        answers: opts.answersOverride || answers, key_date: keyDate || null,
        previous: opts.instruction && plan ? plan : undefined, instruction: opts.instruction,
      });
      setPlan(p);
      if (!kind) setKind(p.kind);
      if (!keyDate && p.key_date) setKeyDate(p.key_date);
      if (opts.instruction) setChange("");
    } catch (e) {
      setError(errorText(e, "GD360 couldn't write the plan. Try again."));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (started.current || !activeWorkspaceId || !brief.trim()) return;
    started.current = true;
    draft();
  }, [activeWorkspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const answer = (key: string, value: string) => {
    const next = { ...answers, [key]: value };
    setAnswers(next);
    draft({ answersOverride: next });
  };

  const create = async () => {
    if (!plan) return;
    setCreating(true);
    setError("");
    try {
      const scope = MARKETING.has(plan.kind) ? { regions: regions.split(",").map((x) => x.trim()).filter(Boolean), channels } : undefined;
      // a new date means the scheduled due dates no longer fit: let GD360 re-date them
      const moved = !!keyDate && keyDate !== plan.key_date;
      const tasks = moved ? plan.tasks.map((t) => ({ ...t, due_on: "" })) : plan.tasks;
      const out = await initiativesApi.create({ workspace_id: activeWorkspaceId || undefined, brief, plan: { ...plan, tasks, key_date: keyDate || plan.key_date, scope } });
      nav(`/initiatives/${out.id}`);
    } catch (e) {
      setError(errorText(e, "Couldn't create the initiative."));
      setCreating(false);
    }
  };

  const phases = useMemo(() => {
    if (!plan) return [];
    return plan.phases.map((p) => ({ ...p, tasks: plan.tasks.map((t, idx) => ({ ...t, idx })).filter((t) => t.phase === p.id) }));
  }, [plan]);

  const setTask = (idx: number, patch: Partial<PlanDraft["tasks"][number]>) =>
    setPlan((p) => (p ? { ...p, tasks: p.tasks.map((t, i) => (i === idx ? { ...t, ...patch } : t)) } : p));
  const setTarget = (idx: number, value: string) =>
    setPlan((p) => (p ? { ...p, targets: p.targets.map((t, i) => (i === idx ? { ...t, target: value === "" ? null : Number(value) } : t)) } : p));

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="px-4 sm:px-8 pt-16 lg:pt-6 pb-4 border-b border-border flex flex-wrap justify-between items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted"><Link to="/initiatives" className="hover:text-text">Initiatives</Link> / New</span>
            <h1 className="m-0 text-[22px] font-semibold tracking-tight text-text">Plan an initiative</h1>
          </div>
          <button type="button" className="btn-primary text-sm" disabled={!plan || busy || creating} onClick={create} data-create-initiative="">
            {creating ? "Creating…" : "Create initiative"}
          </button>
        </header>

        <div className="px-4 sm:px-8 py-6 pb-24 flex gap-6 flex-wrap items-start">
          <aside className="flex-[1_1_340px] max-w-full lg:max-w-[420px] flex flex-col gap-4 lg:sticky lg:top-4">
            {error && <Banner kind="error" onClose={() => setError("")}>{error}</Banner>}
            <Section title="The brief">
              <textarea className="input min-h-[110px] text-ui leading-relaxed" value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={4000}
                placeholder="What are you planning, for whom, and by when?" aria-label="Brief" data-planner-brief="" />
              <div className="flex flex-col gap-2">
                <span className="text-caption font-medium text-secondary">Kind</span>
                <div className="flex gap-1.5 flex-wrap">
                  {KINDS.map((k) => {
                    const on = kind === k;
                    const c = tone(k);
                    return (
                      <button key={k} type="button" onClick={() => setKind(on ? "" : k)} aria-pressed={on} data-kind-pick={k}
                        className="ui-focus inline-flex items-center gap-1.5 h-[30px] px-2.5 rounded-full border text-caption"
                        style={on ? { color: `rgb(${c})`, background: `rgb(${c} / 0.12)`, borderColor: `rgb(${c} / 0.45)` } : undefined}>
                        <span style={{ color: `rgb(${c})` }}><KindGlyph kind={k} size={13} /></span>
                        <span className={on ? "" : "text-secondary"}>{KIND_LABEL[k]}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className="flex flex-col gap-1.5">
                <span className="text-caption font-medium text-secondary">{kind === "hiring" ? "Start date for the hires" : kind === "product" ? "Launch date" : "Date"} <span className="text-muted font-normal">(optional)</span></span>
                <input type="date" className="input" value={keyDate} onChange={(e) => setKeyDate(e.target.value)} data-planner-date="" />
              </label>
              <button type="button" className="btn-primary text-sm" disabled={busy || !brief.trim()} onClick={() => draft()} data-draft="">
                {busy ? "Writing the plan…" : plan ? "Update the plan" : "Write the plan"}
              </button>
            </Section>

            {plan && plan.questions.length > 0 && (
              <Section title="A few quick questions" sub="Each answer reshapes the plan.">
                <div className="flex flex-col gap-4" data-questions="">
                  {plan.questions.map((q) => (
                    <div key={q.key} className="flex flex-col gap-2">
                      <span className="text-ui text-text">{q.question}</span>
                      <div className="flex gap-1.5 flex-wrap">
                        {q.options.map((o) => (
                          <button key={o} type="button" disabled={busy} onClick={() => answer(q.key, o)} data-answer={o}
                            className={`ui-focus h-[30px] px-3 rounded-full border text-caption ${answers[q.key] === o ? "border-primary bg-tint text-text" : "border-border text-secondary hover:border-border-strong"}`}>{o}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {plan && (
              <Section title="Change something" sub="Say it in plain words - GD360 rewrites the plan.">
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (change.trim()) draft({ instruction: change.trim() }); }}>
                  <input className="input text-ui" value={change} onChange={(e) => setChange(e.target.value)} placeholder="e.g. Budget is $10k, add a speaker dinner" maxLength={1000} aria-label="Change the plan" />
                  <button type="submit" className="btn-secondary text-sm shrink-0" disabled={busy || !change.trim()}>Apply</button>
                </form>
              </Section>
            )}
          </aside>

          <main className="flex-[999_1_560px] min-w-0 flex flex-col gap-4" data-plan-preview="">
            {!plan && !busy && (
              <div className="rounded-card border border-dashed border-border-strong p-10 text-center">
                <div className="text-section font-semibold text-text">Your plan appears here</div>
                <p className="m-0 mt-1.5 text-ui text-muted max-w-[520px] mx-auto">Strategy, targets, roles, a dated task list, the tools to use and why, and exactly how each number is tracked.</p>
              </div>
            )}
            {busy && !plan && <div className="flex flex-col gap-3">{[180, 120, 260].map((h, i) => <div key={i} className="rounded-card bg-surface2 animate-pulse" style={{ height: h }} />)}</div>}
            {plan && (
              <div className={`flex flex-col gap-4 transition-opacity ${busy ? "opacity-60" : ""}`}>
                <Section>
                  <div className="flex items-center gap-2 flex-wrap">
                    <KindBadge kind={plan.kind} />
                    {plan.department && <span className="text-caption text-muted">{plan.department}</span>}
                    <span className="ml-auto text-caption text-muted">{plan.ai ? "Written by GD360's planner" : "GD360's standard plan for this kind"}{plan.history_count ? ` · learned from ${plan.history_count} earlier` : ""}</span>
                  </div>
                  <input className="input !text-[20px] !font-semibold !py-2 !px-2.5 !bg-transparent !border-transparent hover:!border-border focus:!border-primary" value={plan.title}
                    onChange={(e) => setPlan({ ...plan, title: e.target.value })} aria-label="Title" data-plan-title="" />
                  <div className="flex gap-4 flex-wrap text-ui text-secondary">
                    {(keyDate || plan.key_date) && <span>{kind === "hiring" ? "Start" : kind === "product" ? "Launch" : "Date"}: <b className="text-text font-medium">{fmtDate(keyDate || plan.key_date, true)}</b></span>}
                    {plan.location && <span>Where: <b className="text-text font-medium">{plan.location}</b></span>}
                    {plan.budget ? <span>Budget: <b className="text-text font-medium">${plan.budget.toLocaleString()}</b></span> : null}
                    <span>{plan.tasks.length} tasks · {plan.targets.length} targets</span>
                  </div>
                  <p className="m-0 text-body text-text leading-relaxed">{plan.summary}</p>
                  {plan.strategy.length > 0 && (
                    <ul className="m-0 pl-0 list-none grid gap-2 sm:grid-cols-2">
                      {plan.strategy.map((s) => <li key={s} className="flex gap-2 text-ui text-secondary"><span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-primary shrink-0" />{s}</li>)}
                    </ul>
                  )}
                  {plan.compressed && <Banner kind="warning">There's less time than this kind of initiative usually takes - the plan has been compressed so the first task starts today.</Banner>}
                  {plan.learned.length > 0 && (
                    <div className="rounded-ctl border border-tint-border bg-tint px-3.5 py-3 text-ui text-text flex flex-col gap-1">
                      <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-primary">Learned from your earlier initiatives</span>
                      {plan.learned.map((l) => <span key={l}>{l}</span>)}
                    </div>
                  )}
                </Section>

                <Section title="Targets" sub="How success is measured. GD360 counts the ones marked automatic.">
                  <div className="grid gap-3 sm:grid-cols-2" data-plan-targets="">
                    {plan.targets.map((t, idx) => (
                      <div key={t.key} className="rounded-ctl border border-border p-3 flex flex-col gap-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-ui text-text font-medium">{t.label}</span>
                          <span className={`text-[10.5px] font-mono uppercase tracking-[0.08em] ${t.auto ? "text-good" : "text-muted"}`}>{t.auto ? "Automatic" : "Manual"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <input type="number" min={0} className="input !py-1.5 !w-[120px] tabular-nums" value={t.target ?? ""} onChange={(e) => setTarget(idx, e.target.value)} aria-label={`${t.label} target`} />
                          <span className="text-caption text-muted">{t.unit === "pct" ? "%" : t.unit === "money" ? "USD" : ""}</span>
                          <button type="button" className="ml-auto text-caption text-muted hover:text-danger" onClick={() => setPlan({ ...plan, targets: plan.targets.filter((_, i) => i !== idx) })}>Remove</button>
                        </div>
                        {t.why && <span className="text-caption text-muted">{t.why}</span>}
                      </div>
                    ))}
                  </div>
                  {catalog && (
                    <select className="input !w-auto !py-1.5 text-caption" value="" aria-label="Add a target"
                      onChange={(e) => {
                        const k = e.target.value;
                        if (!k) return;
                        const m = catalog.metrics[k];
                        setPlan({ ...plan, targets: [...plan.targets, { key: k, label: m.label, unit: m.unit, auto: m.auto, target: null, actual: null }] });
                      }}>
                      <option value="">+ Add a target</option>
                      {Object.entries(catalog.metrics).filter(([k]) => !plan.targets.some((t) => t.key === k)).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
                    </select>
                  )}
                </Section>

                {MARKETING.has(plan.kind) && (
                  <Section title="Scope" sub="Only activity inside this scope counts toward this initiative - not everything the company posts or sends.">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-caption font-medium text-secondary">Regions</span>
                      <input className="input" value={regions} onChange={(e) => setRegions(e.target.value)} placeholder="e.g. US, Canada" data-scope-regions="" />
                    </label>
                    <div className="flex flex-col gap-1.5">
                      <span className="text-caption font-medium text-secondary">Channels</span>
                      <div className="flex gap-1.5 flex-wrap">
                        {CHANNELS.map((c) => {
                          const on = channels.includes(c.id);
                          return (
                            <button key={c.id} type="button" aria-pressed={on} onClick={() => setChannels(on ? channels.filter((x) => x !== c.id) : [...channels, c.id])}
                              className={`ui-focus h-[30px] px-3 rounded-full border text-caption ${on ? "border-primary bg-tint text-text" : "border-border text-secondary"}`}>{c.label}</button>
                          );
                        })}
                      </div>
                    </div>
                  </Section>
                )}

                {plan.roles.length > 0 && (
                  <Section title="Team roles" sub="Add the people after creating; each gets their own page to log outreach.">
                    <div className="grid gap-3 sm:grid-cols-2">
                      {plan.roles.map((r) => (
                        <div key={r.role} className="rounded-ctl border border-border p-3">
                          <div className="text-ui font-medium text-text">{r.role}</div>
                          <div className="text-caption text-secondary mt-0.5">{r.does}</div>
                          {Object.keys(r.targets || {}).length > 0 && (
                            <div className="text-caption text-muted mt-1.5">Each: {Object.entries(r.targets).map(([k, v]) => `${v} ${k.replace("_", "-")}`).join(" · ")}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </Section>
                )}

                <Section title="The plan" sub="Dates and owners can be changed here or later.">
                  <div className="flex flex-col gap-5" data-plan-phases="">
                    {phases.map((p) => (
                      <div key={p.id} className="flex flex-col gap-2">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-ui font-semibold text-text">{p.title}</span>
                          <span className="text-caption text-muted">{fmtDate(p.starts)}{p.ends && p.ends !== p.starts ? ` – ${fmtDate(p.ends)}` : ""}</span>
                        </div>
                        <ul className="m-0 p-0 list-none flex flex-col rounded-ctl border border-border divide-y divide-border">
                          {p.tasks.map((t) => (
                            <li key={t.idx} className="flex items-center gap-2 px-3 py-2 flex-wrap sm:flex-nowrap">
                              <input className="flex-1 min-w-[180px] bg-transparent text-ui text-text outline-none border-b border-transparent focus:border-primary py-1" value={t.title}
                                onChange={(e) => setTask(t.idx, { title: e.target.value })} aria-label="Task" />
                              {t.tool && catalog?.tools[t.tool] && <span className="text-[11px] px-2 h-[22px] inline-flex items-center rounded-full bg-surface2 text-secondary shrink-0">{catalog.tools[t.tool].name}</span>}
                              <input className="bg-transparent text-caption text-secondary w-[120px] outline-none" placeholder="Owner" value={t.owner || ""} onChange={(e) => setTask(t.idx, { owner: e.target.value })} aria-label="Owner" />
                              <input type="date" className="bg-transparent text-caption text-secondary outline-none w-[132px]" value={t.due_on} onChange={(e) => setTask(t.idx, { due_on: e.target.value })} aria-label="Due" />
                              <button type="button" className="text-muted hover:text-danger text-caption" aria-label="Remove task" onClick={() => setPlan({ ...plan, tasks: plan.tasks.filter((_, i) => i !== t.idx) })}>✕</button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </Section>

                <Section title="Tools" sub="Native ones run inside GD360. Everything else is optional - import or link at any time.">
                  <div className="grid gap-2.5 sm:grid-cols-2" data-plan-tools="">
                    {plan.tools.map((t) => {
                      const m = catalog?.tools[t.key];
                      return (
                        <div key={t.key} className="rounded-ctl border border-border p-3 flex flex-col gap-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-ui font-medium text-text">{m?.name || t.key}</span>
                            <ModeChip mode={m?.mode || "link"} />
                          </div>
                          <span className="text-caption text-secondary">{t.why}</span>
                        </div>
                      );
                    })}
                  </div>
                </Section>

                {plan.assumptions.length > 0 && (
                  <p className="m-0 text-caption text-muted">Assumed: {plan.assumptions.join(" · ")}</p>
                )}
                <div className="flex justify-end">
                  <button type="button" className="btn-primary" disabled={busy || creating} onClick={create}>{creating ? "Creating…" : "Create initiative"}</button>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

export function ModeChip({ mode }: { mode: string }) {
  const map: Record<string, [string, string]> = {
    native: ["In GD360", "text-good bg-good-fill border-good-border"],
    connect: ["Connect", "text-primary bg-tint border-tint-border"],
    import: ["Import CSV", "text-secondary bg-surface2 border-border"],
    link: ["Link", "text-muted bg-surface2 border-border"],
  };
  const [label, cls] = map[mode] || map.link;
  return <span className={`text-[11px] h-[22px] px-2 inline-flex items-center rounded-full border shrink-0 ${cls}`}>{label}</span>;
}

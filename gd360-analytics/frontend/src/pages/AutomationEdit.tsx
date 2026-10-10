// 2026-10-08 (round 12): create or edit an automation. The sentence at the
// top is rebuilt by the server as it is filled in (so it always says what
// will really run); on the right: the next five runs, what each run costs,
// and the message people will receive - built from the real numbers.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import {
  AutomationOptions, AutomationRun, automationsApi, Draft, Every, localTimeZone, Mode, Preview, Schedule, Step, StepType,
  timeZones, Trigger, tzAbbrev, whenParts,
} from "../api/automations";
import { RunRow } from "./Automations";

type Preset = "hour" | "morning" | "week" | "month" | "new_data" | "threshold";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STEP_LABEL: Record<StepType, string> = {
  refresh_project_dashboard: "Refresh a project dashboard",
  rerun_question: "Re-run a project question",
  refresh_dashboard: "Rebuild a classic dashboard",
  sync_source: "Sync an app or API source",
  quality_check: "Check quality rules",
  rescore_model: "Re-score with an ML model",
  summarise: "Summarise what changed",
};

function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  return typeof d === "string" && d.trim() ? d : fallback;
}

function times(): string[] {
  const out: string[] = [];
  for (let h = 0; h < 24; h++) for (const m of [0, 30]) out.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  return out;
}

function timeLabel(t: string): string {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function presetOf(t: Trigger): Preset {
  if (t.type === "new_data") return "new_data";
  if (t.type === "threshold") return "threshold";
  if (t.every === "hour") return "hour";
  if (t.every === "week") return "week";
  if (t.every === "month") return "month";
  return "morning";
}

const BLANK: Draft = {
  name: "",
  enabled: true,
  trigger: { type: "schedule", every: "day", time: "06:00", days: [0, 1, 2, 3, 4] },
  timezone: localTimeZone(),
  steps: [],
  stop_on_quality_fail: true,
  tell: { email: [], mode: "always" },
};

export default function AutomationEdit() {
  const { automationId } = useParams();
  const isNew = !automationId || automationId === "new";
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [draft, setDraft] = useState<Draft>({ ...BLANK, timezone: localTimeZone() });
  const [opts, setOpts] = useState<AutomationOptions | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [testRun, setTestRun] = useState<AutomationRun | null>(null);
  const [testing, setTesting] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const nameTouched = useRef(false);

  // load options, then the automation (or a starting point from the link)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const o = await automationsApi.options();
        if (!alive) return;
        setOpts(o);
        if (!isNew) {
          const a = await automationsApi.get(automationId!);
          if (!alive) return;
          nameTouched.current = true;
          setDraft({
            id: a.id, name: a.name, enabled: a.enabled, trigger: a.trigger, timezone: a.timezone, steps: a.steps,
            stop_on_quality_fail: a.stop_on_quality_fail,
            tell: {
              email: a.tell.email, mode: a.tell.mode,
              slack_keep: !!a.tell.slack, slack_label: a.tell.slack?.label || "",
              teams_keep: !!a.tell.teams, teams_label: a.tell.teams?.label || "",
            },
          });
        } else {
          const start: Draft = { ...BLANK, timezone: localTimeZone(), tell: { email: o.me ? [o.me] : [], mode: "always" } };
          const dashId = params.get("dashboard");
          const runId = params.get("run");
          if (dashId) {
            const pd = o.project_dashboards.find((d) => d.id === dashId);
            const cd = o.dashboards.find((d) => d.id === dashId);
            if (pd || cd) {
              start.steps = [{ type: pd ? "refresh_project_dashboard" : "refresh_dashboard", dashboard_id: dashId }, ...(pd ? [{ type: "summarise" as const }] : [])];
              start.name = `${(pd || cd)!.name} update`;
            }
          } else if (runId) {
            const q = o.questions.find((x) => x.id === runId);
            if (q && q.kpis.length) {
              const k = q.kpis.find((x) => x.key !== "total") || q.kpis[0];
              start.trigger = { type: "threshold", target: { kind: "project_run", run_id: q.id }, kpi: k.key, op: "drops_by", value: 10, check: { every: "hour", minute: 0 } };
              start.name = `${k.label} watch`;
              start.tell = { email: o.me ? [o.me] : [], mode: "always" };
            }
          } else if (params.get("alert")) {
            // 2026-10-10 (round 19): "New → Alert" on the Automations home.
            const q = o.questions.find((x) => x.kpis.length);
            const d = o.project_dashboards.find((x) => x.kpis.length);
            const target = q ? { kind: "project_run" as const, run_id: q.id } : d ? { kind: "dashboard" as const, dashboard_id: d.id } : { kind: "project_run" as const, run_id: "" };
            const k = (q || d)?.kpis.find((x) => x.key !== "total") || (q || d)?.kpis[0];
            start.trigger = { type: "threshold", target, kpi: k?.key || "", op: "drops_by", value: 10, check: { every: "hour", minute: 0 } };
            if (k) start.name = `${k.label} watch`;
          }
          setDraft(start);
        }
        setLoaded(true);
      } catch (e: any) {
        if (e?.response?.status === 404) setNotFound(true);
        else setError(errorText(e, "Couldn't load this automation."));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automationId]);

  // live preview from the server
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      automationsApi.preview(draft).then(setPreview).catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [draft, loaded]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setTell = (patch: Partial<Draft["tell"]>) => setDraft((d) => ({ ...d, tell: { ...d.tell, ...patch } }));

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const body = { ...draft, name: draft.name.trim() || autoName(draft, opts), workspace_id: isNew ? activeWorkspaceId || null : undefined };
      const saved = isNew ? await automationsApi.create(body) : await automationsApi.update(automationId!, body);
      // 2026-10-10 (round 19): a member's automation that emails people
      // outside the company waits for an owner's or admin's OK - say so.
      navigate(saved?.approval?.status === "pending" ? "/automations?waiting=" + encodeURIComponent(saved.id) : "/automations");
    } catch (e: any) {
      setError(errorText(e, "Couldn't save it."));
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setError("");
    setTestRun(null);
    try {
      const { run_id } = await automationsApi.test({ ...draft, name: draft.name.trim() || autoName(draft, opts) });
      for (let i = 0; i < 200; i++) {
        const r = await automationsApi.run(run_id);
        setTestRun(r);
        if (r.status !== "running") break;
        await new Promise((res) => setTimeout(res, 900));
      }
    } catch (e: any) {
      setError(errorText(e, "Couldn't test it."));
    } finally {
      setTesting(false);
    }
  };

  if (notFound) {
    return (
      <div className="min-h-screen grid place-items-center bg-base px-6">
        <div className="text-center">
          <div className="text-section font-semibold text-text">This automation doesn't exist.</div>
          <Link to="/automations" className="btn-primary text-sm mt-4 inline-flex">All automations</Link>
        </div>
      </div>
    );
  }

  const preset = presetOf(draft.trigger);
  const s = preview?.sentence;

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />
        <main className="px-4 sm:px-8 lg:px-10 py-7 max-w-[1240px] mx-auto flex flex-col gap-6">
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div className="flex flex-col gap-1.5 min-w-0 flex-[1_1_320px]">
              <Link to="/automations" className="font-mono text-caption text-muted uppercase tracking-[0.06em] hover:text-text">← Automations</Link>
              <label className="sr-only" htmlFor="automation-name">Name</label>
              <input
                id="automation-name"
                value={draft.name}
                onChange={(e) => {
                  nameTouched.current = true;
                  set({ name: e.target.value });
                }}
                placeholder={isNew ? "New automation" : "Name"}
                maxLength={80}
                className="w-full max-w-[640px] bg-transparent border-0 border-b border-transparent hover:border-border focus:border-border-strong outline-none text-[28px] sm:text-[30px] font-bold tracking-tight text-text placeholder:text-text"
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              <Link to="/automations" className="btn-secondary text-sm">Cancel</Link>
              <button type="button" className="btn-secondary text-sm" onClick={test} disabled={testing || !loaded}>
                {testing ? "Testing…" : "Test it now"}
              </button>
              <button type="button" className="btn-primary text-sm" onClick={save} disabled={saving || !loaded}>
                {saving ? "Saving…" : isNew ? "Turn on" : "Save"}
              </button>
            </div>
          </div>

          <section aria-label="In one sentence" className="rounded-card border p-5 sm:p-6" style={{ borderColor: "rgb(var(--auto-do-border))", background: "rgb(var(--auto-do-fill) / 0.35)" }}>
            <div className="font-mono text-[11px] uppercase tracking-[0.12em]" style={{ color: "rgb(var(--auto-do))" }}>In one sentence</div>
            <p className="m-0 mt-2.5 text-[20px] sm:text-[22px] leading-[1.45] text-text text-balance">
              {s ? (
                <>
                  <span style={{ color: "rgb(var(--auto-when))" }}>{s.when}</span>,{" "}
                  <span style={{ color: "rgb(var(--auto-do))" }}>{lowerFirst(s.do)}</span>
                  {s.tell_sentence ? (
                    <>
                      , then <span style={{ color: "rgb(var(--auto-tell))" }}>{s.tell_sentence}</span>.
                    </>
                  ) : (
                    "."
                  )}
                </>
              ) : (
                <span className="text-muted">…</span>
              )}
            </p>
          </section>

          {error && <div role="alert" className="rounded-card border border-danger-border bg-danger-fill px-4 py-3 text-ui text-text">{error}</div>}

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] items-start">
            <div className="flex flex-col gap-5 min-w-0">
              <Section n={1} part="when" title="When should it run?">
                <WhenEditor draft={draft} set={set} opts={opts} preset={preset} />
              </Section>
              <Section n={2} part="do" title="What should it do?">
                <DoEditor draft={draft} set={set} opts={opts} onAutoName={(n) => { if (!nameTouched.current && isNew) set({ name: n }); }} />
              </Section>
              <Section n={3} part="tell" title="Who should hear about it?">
                <TellEditor draft={draft} setTell={setTell} opts={opts} />
              </Section>
              {testRun && (
                <section className="rounded-card border border-border bg-surface p-5 flex flex-col gap-3" aria-label="Test result">
                  <h2 className="m-0 text-section font-semibold text-text">
                    {testRun.status === "running" ? "Testing…" : testRun.status === "success" ? "The test ran" : "The test stopped"}
                  </h2>
                  <RunRow r={testRun} />
                </section>
              )}
            </div>

            <aside className="flex flex-col gap-4 lg:sticky lg:top-4">
              <SideCard title={draft.trigger.type === "threshold" ? "Next checks" : "Next runs"}>
                {draft.trigger.type === "new_data" ? (
                  <p className="m-0 text-ui text-secondary leading-relaxed">Runs each time the source gets new data — after its next sync.</p>
                ) : (preview?.next_runs || []).length ? (
                  <div className="flex flex-col">
                    {preview!.next_runs.map((r) => {
                      const p = whenParts(r, draft.timezone);
                      return (
                        <div key={r} className="flex justify-between py-2.5 border-t first:border-t-0 border-border text-ui">
                          <span className="text-text">{p.day}</span>
                          <span className="font-mono text-secondary">{p.time}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="m-0 text-ui text-muted">—</p>
                )}
              </SideCard>
              <SideCard title="What each run costs">
                <CostRows preview={preview} />
              </SideCard>
              <SideCard title="What people receive">
                <MessagePreview preview={preview} />
              </SideCard>
            </aside>
          </div>
        </main>
      </div>
    </div>
  );
}

function lowerFirst(t: string): string {
  return t ? t[0].toLowerCase() + t.slice(1) : t;
}

function autoName(d: Draft, o: AutomationOptions | null): string {
  const st = d.steps[0];
  if (st?.dashboard_id) {
    const n = o?.project_dashboards.find((x) => x.id === st.dashboard_id)?.name || o?.dashboards.find((x) => x.id === st.dashboard_id)?.name;
    if (n) return `${n} update`;
  }
  if (d.trigger.type === "threshold") return `${d.trigger.kpi_label || "Number"} watch`;
  return "My automation";
}

function Section({ n, part, title, children }: { n: number; part: "when" | "do" | "tell"; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-border bg-surface p-5 sm:p-6 flex flex-col gap-4" aria-label={title}>
      <h2 className="m-0 flex items-center gap-3 text-[18px] font-semibold text-text">
        <span
          className="w-7 h-7 rounded-[8px] grid place-items-center font-mono text-caption"
          style={{ color: `rgb(var(--auto-${part}))`, background: `rgb(var(--auto-${part}-fill))`, border: `1px solid rgb(var(--auto-${part}-border))` }}
        >
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function SideCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-border bg-surface p-4 flex flex-col gap-3">
      <h3 className="m-0 font-mono text-[11px] uppercase tracking-[0.12em] text-muted font-medium">{title}</h3>
      {children}
    </section>
  );
}

function Pill({ on, onClick, children, part = "when" }: { on: boolean; onClick: () => void; children: React.ReactNode; part?: "when" | "do" | "tell" }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`h-10 px-3.5 rounded-ctl border text-ui transition-colors ${on ? "" : "border-border text-secondary hover:text-text hover:border-border-strong"}`}
      style={on ? { color: `rgb(var(--auto-${part}))`, background: `rgb(var(--auto-${part}-fill))`, borderColor: `rgb(var(--auto-${part}-border))` } : undefined}
    >
      {children}
    </button>
  );
}

const SELECT = "h-10 rounded-ctl border border-border bg-base px-3 text-ui text-text";

// ---------------------------------------------------------------- WHEN ----

function WhenEditor({ draft, set, opts, preset }: { draft: Draft; set: (p: Partial<Draft>) => void; opts: AutomationOptions | null; preset: Preset }) {
  const t = draft.trigger;
  const choose = (p: Preset) => {
    const time = (t as any).time || ((t as any).check?.time) || "06:00";
    if (p === "hour") set({ trigger: { type: "schedule", every: "hour", minute: 0 } });
    if (p === "morning") set({ trigger: { type: "schedule", every: "day", time, days: [0, 1, 2, 3, 4] } });
    if (p === "week") set({ trigger: { type: "schedule", every: "week", time: time === "06:00" ? "08:30" : time, days: [0] } });
    if (p === "month") set({ trigger: { type: "schedule", every: "month", time, day_of_month: 1 } });
    if (p === "new_data") {
      const src = opts?.sources.find((x) => x.new_data);
      set({ trigger: { type: "new_data", datasource_id: src?.id || "" } });
    }
    if (p === "threshold") {
      const q = opts?.questions.find((x) => x.kpis.length);
      const d = opts?.project_dashboards.find((x) => x.kpis.length);
      const target = q ? { kind: "project_run" as const, run_id: q.id } : d ? { kind: "dashboard" as const, dashboard_id: d.id } : { kind: "project_run" as const, run_id: "" };
      const k = (q || d)?.kpis[0];
      set({ trigger: { type: "threshold", target, kpi: k?.key || "", op: "drops_by", value: 10, check: { every: "hour", minute: 0 } } });
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="When">
        {([
          ["hour", "Every hour"], ["morning", "Every morning"], ["week", "Every week"], ["month", "Every month"],
          ["new_data", "When new data lands"], ["threshold", "When a number crosses a line"],
        ] as [Preset, string][]).map(([p, label]) => (
          <Pill key={p} on={preset === p} onClick={() => choose(p)}>{label}</Pill>
        ))}
      </div>
      {t.type === "schedule" && <ScheduleFields sched={t} tz={draft.timezone} onChange={(sc) => set({ trigger: { type: "schedule", ...sc } })} onTz={(tz) => set({ timezone: tz })} />}
      {t.type === "new_data" && (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1.5 text-caption text-muted max-w-[420px]">
            Source
            <select className={SELECT} value={t.datasource_id} onChange={(e) => set({ trigger: { type: "new_data", datasource_id: e.target.value } })}>
              {!t.datasource_id && <option value="">Pick a source…</option>}
              {(opts?.sources || []).filter((x) => x.new_data).map((x) => (
                <option key={x.id} value={x.id}>{x.name} · {x.label}</option>
              ))}
            </select>
          </label>
          <span className="text-caption text-muted">Synced apps, API and streaming sources only — live databases and warehouses are always current, so they never “land”.</span>
        </div>
      )}
      {t.type === "threshold" && <ThresholdFields draft={draft} set={set} opts={opts} />}
    </div>
  );
}

function ScheduleFields({ sched, tz, onChange, onTz }: { sched: Schedule; tz: string; onChange: (s: Schedule) => void; onTz: (tz: string) => void }) {
  const zones = useMemo(timeZones, []);
  const every: Every = sched.every;
  return (
    <div className="flex flex-wrap items-end gap-4">
      {every === "hour" ? (
        <label className="flex flex-col gap-1.5 text-caption text-muted">
          At minute
          <select className={SELECT} value={sched.minute || 0} onChange={(e) => onChange({ ...sched, minute: Number(e.target.value) })}>
            {[0, 5, 10, 15, 20, 30, 45].map((m) => <option key={m} value={m}>:{String(m).padStart(2, "0")}</option>)}
          </select>
        </label>
      ) : (
        <label className="flex flex-col gap-1.5 text-caption text-muted">
          At
          <select className={SELECT} value={sched.time || "06:00"} onChange={(e) => onChange({ ...sched, time: e.target.value })}>
            {times().map((x) => <option key={x} value={x}>{timeLabel(x)}</option>)}
          </select>
        </label>
      )}
      {(every === "day" || every === "week") && (
        <div className="flex flex-col gap-1.5 text-caption text-muted">
          On
          <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Days">
            {DAYS.map((d, i) => {
              const on = (sched.days || []).includes(i);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    const cur = sched.days || [];
                    const next = every === "week" ? [i] : on ? cur.filter((x) => x !== i) : [...cur, i].sort();
                    if (next.length) onChange({ ...sched, days: next });
                  }}
                  className={`h-10 min-w-[44px] px-2 rounded-ctl border text-ui ${on ? "" : "border-border text-muted hover:text-text"}`}
                  style={on ? { color: "rgb(var(--auto-when))", background: "rgb(var(--auto-when-fill))", borderColor: "rgb(var(--auto-when-border))" } : undefined}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {every === "month" && (
        <label className="flex flex-col gap-1.5 text-caption text-muted">
          Day of the month
          <select className={SELECT} value={sched.day_of_month || 1} onChange={(e) => onChange({ ...sched, day_of_month: Number(e.target.value) })}>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1.5 text-caption text-muted">
        Time zone
        <select className={`${SELECT} max-w-[260px] font-mono`} value={tz} onChange={(e) => onTz(e.target.value)}>
          {(zones.includes(tz) ? zones : [tz, ...zones]).map((z) => <option key={z} value={z}>{z}{z === tz ? ` (${tzAbbrev(z)})` : ""}</option>)}
        </select>
      </label>
    </div>
  );
}

function ThresholdFields({ draft, set, opts }: { draft: Draft; set: (p: Partial<Draft>) => void; opts: AutomationOptions | null }) {
  const t = draft.trigger as Extract<Draft["trigger"], { type: "threshold" }>;
  const targetKey = t.target.kind === "project_run" ? `run:${(t.target as any).run_id}` : `dash:${(t.target as any).dashboard_id}`;
  const kpis =
    t.target.kind === "project_run"
      ? opts?.questions.find((q) => q.id === (t.target as any).run_id)?.kpis || []
      : opts?.project_dashboards.find((d) => d.id === (t.target as any).dashboard_id)?.kpis || [];
  const kpi = kpis.find((k) => k.key === t.kpi);
  const pct = !!kpi && (kpi.kind === "percent" || kpi.kind === "ratio" || /%$/.test(kpi.display || ""));
  const upd = (patch: Partial<typeof t>) => set({ trigger: { ...t, ...patch } as Trigger });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1.5 text-caption text-muted min-w-[240px] flex-1 max-w-[440px]">
          Watch
          <select
            className={SELECT}
            value={targetKey}
            onChange={(e) => {
              const [kind, id] = e.target.value.split(":");
              const list = kind === "run" ? opts?.questions.find((q) => q.id === id)?.kpis : opts?.project_dashboards.find((d) => d.id === id)?.kpis;
              upd({ target: kind === "run" ? { kind: "project_run", run_id: id } : { kind: "dashboard", dashboard_id: id }, kpi: list?.[0]?.key || "" } as any);
            }}
          >
            {(opts?.project_dashboards || []).filter((d) => d.kpis.length).length > 0 && (
              <optgroup label="Project dashboards">
                {opts!.project_dashboards.filter((d) => d.kpis.length).map((d) => <option key={d.id} value={`dash:${d.id}`}>{d.name}</option>)}
              </optgroup>
            )}
            {(opts?.questions || []).filter((q) => q.kpis.length).length > 0 && (
              <optgroup label="Answered questions">
                {opts!.questions.filter((q) => q.kpis.length).map((q) => <option key={q.id} value={`run:${q.id}`}>{q.question.slice(0, 70)}</option>)}
              </optgroup>
            )}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-caption text-muted">
          Number
          <select className={SELECT} value={t.kpi} onChange={(e) => upd({ kpi: e.target.value })}>
            {kpis.map((k) => <option key={k.key} value={k.key}>{k.label} (now {k.display})</option>)}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1.5 text-caption text-muted">
          When it
          <select className={SELECT} value={t.op} onChange={(e) => upd({ op: e.target.value as any })}>
            <option value="drops_by">falls by more than</option>
            <option value="rises_by">rises by more than</option>
            <option value="below">drops below</option>
            <option value="above">goes above</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-caption text-muted">
          {t.op === "drops_by" || t.op === "rises_by" ? "Percent (vs the comparison period)" : pct ? "Value (%)" : "Value"}
          <span className="flex items-center gap-2">
            <input
              type="number"
              step="any"
              inputMode="decimal"
              className={`${SELECT} w-[140px] font-mono`}
              value={Number.isFinite(t.value) ? t.value : ""}
              onChange={(e) => upd({ value: e.target.value === "" ? (NaN as any) : Number(e.target.value) })}
            />
            {(t.op === "drops_by" || t.op === "rises_by" || pct) && <span className="text-ui text-muted">%</span>}
          </span>
        </label>
        <label className="flex flex-col gap-1.5 text-caption text-muted">
          Check
          <select
            className={SELECT}
            value={t.check.every === "hour" ? "hour" : `day:${t.check.time || "06:00"}`}
            onChange={(e) =>
              upd({ check: e.target.value === "hour" ? { every: "hour", minute: 0 } : { every: "day", time: e.target.value.split(":").slice(1).join(":"), days: [0, 1, 2, 3, 4, 5, 6] } })
            }
          >
            <option value="hour">every hour</option>
            {["06:00", "08:00", "09:00", "12:00", "18:00"].map((x) => <option key={x} value={`day:${x}`}>every day at {timeLabel(x)}</option>)}
          </select>
        </label>
      </div>
      <p className="m-0 text-caption text-muted leading-relaxed">
        Each check re-runs the saved queries (no AI involved). It tells people when the number <em>crosses</em> the line — not again on every check while it
        stays over it.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ DO ----

function stepTargetName(st: Step, o: AutomationOptions | null): string {
  if (!o) return "";
  if (st.dashboard_id) return o.project_dashboards.find((d) => d.id === st.dashboard_id)?.name || o.dashboards.find((d) => d.id === st.dashboard_id)?.name || "A dashboard";
  if (st.run_id) return o.questions.find((q) => q.id === st.run_id)?.question || "A question";
  if (st.datasource_id) return o.sources.find((x) => x.id === st.datasource_id)?.name || "A source";
  if (st.model_id) return o.models.find((x) => x.id === st.model_id)?.name || "A model";
  return "";
}

function stepTitle(st: Step, o: AutomationOptions | null): string {
  const n = stepTargetName(st, o);
  switch (st.type) {
    case "refresh_project_dashboard": return `Refresh ${n}`;
    case "rerun_question": return `Re-run “${n}”`;
    case "refresh_dashboard": return `Rebuild ${n}`;
    case "sync_source": return `Sync ${n}`;
    case "quality_check": return `Check quality rules on ${n}`;
    case "rescore_model": return `Re-score with ${n}`;
    default: return "Summarise what changed";
  }
}

function stepNote(st: Step, o: AutomationOptions | null): string {
  if (!o) return "";
  if (st.type === "refresh_project_dashboard") {
    const d = o.project_dashboards.find((x) => x.id === st.dashboard_id);
    return d ? `${d.queries} queries · live sources now, synced apps from their last sync` : "";
  }
  if (st.type === "quality_check") {
    const s = o.sources.find((x) => x.id === st.datasource_id);
    return s ? `${s.quality_rules} rule${s.quality_rules === 1 ? "" : "s"} on ${s.name}` : "";
  }
  if (st.type === "summarise") return "A plain-English note on the biggest moves, with numbers from the dashboard";
  if (st.type === "rerun_question") return "The saved, checked queries - no AI involved";
  if (st.type === "rescore_model") return "Saves the scored table as a new version of the model's data";
  if (st.type === "sync_source") return "Copies the newest records from the app";
  return "";
}

function targetsFor(type: StepType, o: AutomationOptions | null): { id: string; name: string }[] {
  if (!o) return [];
  switch (type) {
    case "refresh_project_dashboard": return o.project_dashboards.map((d) => ({ id: d.id, name: d.name }));
    case "refresh_dashboard": return o.dashboards;
    case "rerun_question": return o.questions.map((q) => ({ id: q.id, name: q.question }));
    case "sync_source": return o.sources.filter((s) => s.can_sync).map((s) => ({ id: s.id, name: `${s.name} · ${s.label}` }));
    case "quality_check": return o.sources.filter((s) => s.quality_rules > 0).map((s) => ({ id: s.id, name: `${s.name} (${s.quality_rules} rules)` }));
    case "rescore_model": return o.models;
    default: return [];
  }
}

function withTarget(type: StepType, id: string): Step {
  if (type === "refresh_project_dashboard" || type === "refresh_dashboard") return { type, dashboard_id: id };
  if (type === "rerun_question") return { type, run_id: id };
  if (type === "sync_source" || type === "quality_check") return { type, datasource_id: id };
  if (type === "rescore_model") return { type, model_id: id };
  return { type };
}

function DoEditor({ draft, set, opts, onAutoName }: { draft: Draft; set: (p: Partial<Draft>) => void; opts: AutomationOptions | null; onAutoName: (n: string) => void }) {
  const [adding, setAdding] = useState<{ index: number | null; type: StepType; id: string } | null>(null);
  const steps = draft.steps;
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    set({ steps: next });
  };
  const commit = () => {
    if (!adding) return;
    const st = withTarget(adding.type, adding.id);
    const next = [...steps];
    if (adding.index == null) next.push(st);
    else next[adding.index] = st;
    set({ steps: next });
    if (!steps.length && st.dashboard_id) onAutoName(`${stepTargetName(st, opts)} update`);
    setAdding(null);
  };
  const choices = adding ? targetsFor(adding.type, opts) : [];
  return (
    <div className="flex flex-col gap-2.5">
      {draft.trigger.type === "threshold" && !steps.length && (
        <p className="m-0 text-ui text-secondary">Checking the number is the work; add steps only if something should run when it crosses the line.</p>
      )}
      {steps.map((st, i) => (
        <div key={i} className="flex items-center gap-3 rounded-card border border-border bg-base px-3.5 py-3">
          <span className="flex flex-col shrink-0">
            <button type="button" aria-label="Move up" className="text-muted hover:text-text leading-none text-[11px] disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)}>▲</button>
            <button type="button" aria-label="Move down" className="text-muted hover:text-text leading-none text-[11px] disabled:opacity-30" disabled={i === steps.length - 1} onClick={() => move(i, 1)}>▼</button>
          </span>
          <span className="font-mono text-caption shrink-0" style={{ color: "rgb(var(--auto-do))" }}>{String(i + 1).padStart(2, "0")}</span>
          <span className="flex flex-col min-w-0 flex-1">
            <span className="text-ui text-text truncate">{stepTitle(st, opts)}</span>
            <span className="text-caption text-muted truncate">{stepNote(st, opts)}</span>
          </span>
          {st.type !== "summarise" && (
            <button
              type="button"
              className="h-8 px-2.5 rounded-ctl border border-border-strong text-caption text-text hover:bg-subtle shrink-0"
              onClick={() => setAdding({ index: i, type: st.type, id: st.dashboard_id || st.run_id || st.datasource_id || st.model_id || "" })}
            >
              Edit
            </button>
          )}
          <button type="button" aria-label="Remove step" className="h-8 w-8 rounded-ctl border border-border text-muted hover:text-danger shrink-0" onClick={() => set({ steps: steps.filter((_, j) => j !== i) })}>
            ×
          </button>
        </div>
      ))}
      {adding ? (
        <div className="rounded-card border border-dashed border-border-strong p-3.5 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-caption text-muted">
            Step
            <select
              className={SELECT}
              value={adding.type}
              onChange={(e) => {
                const type = e.target.value as StepType;
                setAdding({ ...adding, type, id: targetsFor(type, opts)[0]?.id || "" });
              }}
            >
              {(Object.keys(STEP_LABEL) as StepType[]).map((k) => (
                <option key={k} value={k} disabled={k !== "summarise" && targetsFor(k, opts).length === 0}>
                  {STEP_LABEL[k]}{k !== "summarise" && targetsFor(k, opts).length === 0 ? " (nothing to pick yet)" : ""}
                </option>
              ))}
            </select>
          </label>
          {adding.type !== "summarise" && (
            <label className="flex flex-col gap-1.5 text-caption text-muted flex-1 min-w-[220px]">
              Which
              <select className={SELECT} value={adding.id} onChange={(e) => setAdding({ ...adding, id: e.target.value })}>
                {choices.map((c) => <option key={c.id} value={c.id}>{c.name.slice(0, 90)}</option>)}
              </select>
            </label>
          )}
          <button type="button" className="btn-primary text-sm" onClick={commit} disabled={adding.type !== "summarise" && !adding.id}>
            {adding.index == null ? "Add step" : "Update step"}
          </button>
          <button type="button" className="btn-secondary text-sm" onClick={() => setAdding(null)}>Cancel</button>
        </div>
      ) : (
        steps.length < 8 && (
          <button
            type="button"
            onClick={() => {
              const type: StepType = opts?.project_dashboards.length ? "refresh_project_dashboard" : opts?.questions.length ? "rerun_question" : "summarise";
              setAdding({ index: null, type, id: targetsFor(type, opts)[0]?.id || "" });
            }}
            className="h-11 rounded-card border border-dashed border-border-strong text-ui text-secondary hover:text-text hover:border-[rgb(var(--auto-do-border))]"
          >
            + Add a step — refresh, check, rebuild, re-score, sync
          </button>
        )
      )}
      {steps.some((x) => x.type === "quality_check") && (
        <label className="flex items-center gap-2.5 text-ui text-text cursor-pointer select-none mt-1">
          <input type="checkbox" className="w-4 h-4 accent-[rgb(var(--color-primary))]" checked={draft.stop_on_quality_fail} onChange={(e) => set({ stop_on_quality_fail: e.target.checked })} />
          Stop and tell people if the data fails a quality rule
        </label>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- TELL ----

function TellEditor({ draft, setTell, opts }: { draft: Draft; setTell: (p: Partial<Draft["tell"]>) => void; opts: AutomationOptions | null }) {
  const [entry, setEntry] = useState("");
  const [slackEdit, setSlackEdit] = useState(!draft.tell.slack_keep);
  const [teamsOpen, setTeamsOpen] = useState(!!draft.tell.teams_keep || !!draft.tell.teams_url);
  const [teamsEdit, setTeamsEdit] = useState(!draft.tell.teams_keep);
  const tell = draft.tell;
  const add = (raw: string) => {
    const parts = raw.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...tell.email];
    for (const p of parts) if (!next.map((x) => x.toLowerCase()).includes(p.toLowerCase())) next.push(p);
    setTell({ email: next.slice(0, 10) });
    setEntry("");
  };
  const ROW = "rounded-card border border-border bg-base px-3.5 py-3 flex flex-wrap items-center gap-3";
  return (
    <div className="flex flex-col gap-3">
      <div className={ROW}>
        <span className="w-[70px] text-ui text-text shrink-0">Email</span>
        <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
          {tell.email.map((e) => (
            <span key={e} className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-1.5 rounded-full bg-subtle text-ui text-text">
              {e === opts?.me ? "me" : e}
              <button type="button" aria-label={`Remove ${e}`} className="text-muted hover:text-danger" onClick={() => setTell({ email: tell.email.filter((x) => x !== e) })}>×</button>
            </span>
          ))}
          <input
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add(entry);
              }
            }}
            onBlur={() => entry.trim() && add(entry)}
            placeholder={tell.email.length ? "Add another…" : "name@company.com"}
            aria-label="Add an email address"
            className="flex-1 min-w-[160px] h-8 bg-transparent border-0 outline-none text-ui text-text placeholder:text-faint"
          />
          {opts?.me && !tell.email.includes(opts.me) && (
            <button type="button" className="text-caption text-muted hover:text-text underline" onClick={() => setTell({ email: [...tell.email, opts.me] })}>
              + me
            </button>
          )}
        </div>
      </div>
      {opts && !opts.email_ready && tell.email.length > 0 && (
        <span className="text-caption text-warning -mt-1">Email isn't switched on for this server yet — runs will record the email and send it once it is.</span>
      )}

      <div className={ROW}>
        <span className="w-[70px] text-ui text-text shrink-0">Slack</span>
        {tell.slack_keep && !slackEdit ? (
          <span className="flex flex-wrap items-center gap-2 flex-1">
            <input
              value={tell.slack_label || ""}
              onChange={(e) => setTell({ slack_label: e.target.value })}
              aria-label="Slack channel name"
              className="w-[160px] h-8 rounded-ctl border border-border bg-surface px-2 text-ui text-text"
            />
            <span className="text-caption text-muted">connected</span>
            <button type="button" className="text-caption text-muted underline hover:text-text" onClick={() => setSlackEdit(true)}>Change link</button>
            <button type="button" className="text-caption text-muted underline hover:text-danger" onClick={() => setTell({ slack_keep: false, slack_remove: true, slack_url: "" })}>Remove</button>
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-2 flex-1">
            <input
              value={tell.slack_label || ""}
              onChange={(e) => setTell({ slack_label: e.target.value })}
              placeholder="#channel"
              aria-label="Slack channel name"
              className="w-[140px] h-8 rounded-ctl border border-border bg-surface px-2 text-ui text-text placeholder:text-faint"
            />
            <input
              value={tell.slack_url || ""}
              onChange={(e) => setTell({ slack_url: e.target.value.trim(), slack_remove: false })}
              placeholder="https://hooks.slack.com/services/…"
              aria-label="Slack incoming webhook link"
              className="flex-1 min-w-[220px] h-8 rounded-ctl border border-border bg-surface px-2 font-mono text-caption text-text placeholder:text-faint"
            />
          </span>
        )}
      </div>
      {!(tell.slack_keep && !slackEdit) && (
        <span className="text-caption text-muted -mt-1">In Slack: Apps › Incoming Webhooks › Add to a channel, then paste the link. GD360 stores it encrypted.</span>
      )}

      {teamsOpen ? (
        <div className={ROW}>
          <span className="w-[70px] text-ui text-text shrink-0">Teams</span>
          {tell.teams_keep && !teamsEdit ? (
            <span className="flex flex-wrap items-center gap-2 flex-1">
              <input value={tell.teams_label || ""} onChange={(e) => setTell({ teams_label: e.target.value })} aria-label="Teams channel name" className="w-[160px] h-8 rounded-ctl border border-border bg-surface px-2 text-ui text-text" />
              <span className="text-caption text-muted">connected</span>
              <button type="button" className="text-caption text-muted underline hover:text-text" onClick={() => setTeamsEdit(true)}>Change link</button>
              <button type="button" className="text-caption text-muted underline hover:text-danger" onClick={() => setTell({ teams_keep: false, teams_remove: true, teams_url: "" })}>Remove</button>
            </span>
          ) : (
            <span className="flex flex-wrap items-center gap-2 flex-1">
              <input value={tell.teams_label || ""} onChange={(e) => setTell({ teams_label: e.target.value })} placeholder="Channel" aria-label="Teams channel name" className="w-[140px] h-8 rounded-ctl border border-border bg-surface px-2 text-ui text-text placeholder:text-faint" />
              <input
                value={tell.teams_url || ""}
                onChange={(e) => setTell({ teams_url: e.target.value.trim(), teams_remove: false })}
                placeholder="https://….logic.azure.com/workflows/…"
                aria-label="Teams workflow webhook link"
                className="flex-1 min-w-[220px] h-8 rounded-ctl border border-border bg-surface px-2 font-mono text-caption text-text placeholder:text-faint"
              />
            </span>
          )}
        </div>
      ) : (
        <button type="button" className="text-ui text-muted hover:text-text self-start underline" onClick={() => setTeamsOpen(true)}>+ Microsoft Teams</button>
      )}

      <div className="flex flex-col gap-2 mt-1">
        <span className="text-caption text-muted">Send it</span>
        <div className="inline-flex flex-wrap gap-1 p-1 rounded-card border border-border bg-base self-start" role="group" aria-label="When to send">
          {([
            ["always", draft.trigger.type === "threshold" ? "Every time it crosses" : "Every time"],
            ["on_change", "Only if something changed"],
            ["on_failure", "Only if it fails"],
          ] as [Mode, string][]).map(([m, label]) => (
            <button
              key={m}
              type="button"
              aria-pressed={tell.mode === m}
              onClick={() => setTell({ mode: m })}
              className={`h-9 px-3 rounded-ctl text-ui ${tell.mode === m ? "bg-surface2 text-text" : "text-muted hover:text-text"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- side ----

function CostRows({ preview }: { preview: Preview | null }) {
  const e = preview?.estimate;
  if (!e) return <p className="m-0 text-ui text-muted">—</p>;
  const rows: [string, string][] = [["Queries", e.queries ? `≈ ${e.queries}` : "—"]];
  if (e.seconds) rows.push(["Time", `≈ ${Math.max(1, Math.round(e.seconds))} s`]);
  if (e.bytes_scanned) rows.push(["Data scanned", `≈ ${(e.bytes_scanned / 1e9).toFixed(1)} GB`]);
  if (e.runs_per_month != null) rows.push(["This month", `≈ ${Math.round(e.runs_per_month)} runs${e.queries ? ` · ${Math.round(e.runs_per_month * e.queries).toLocaleString()} queries` : ""}`]);
  return (
    <div className="flex flex-col gap-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between text-ui">
          <span className="text-text">{k}</span>
          <span className="font-mono text-secondary">{v}</span>
        </div>
      ))}
      {e.runs_per_month != null && e.runs_per_month > 200 && e.queries > 0 && (
        <span className="text-caption text-warning">Hourly runs add up — every check re-runs the queries in your sources.</span>
      )}
      {!e.exact && <span className="text-caption text-muted">Syncs and rebuilds vary with your data.</span>}
    </div>
  );
}

function MessagePreview({ preview }: { preview: Preview | null }) {
  const m = preview?.message;
  if (!m) return <p className="m-0 text-ui text-muted">Pick what it should do to see the message.</p>;
  return (
    <div className="rounded-[10px] bg-[#F2F6F4] text-[#0b1210] p-3.5 flex flex-col gap-2">
      <div className="text-[13px] font-semibold">{m.title}</div>
      <p className="m-0 text-[12.5px] leading-[1.5] text-[#2b3633]">{m.headline}</p>
      {m.kpis.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-[#dde3e1] pt-2">
          {m.kpis.slice(0, 4).map((k) => (
            <div key={k.label} className="flex justify-between gap-2 text-[12px]">
              <span className="text-[#4f5b58] truncate">{k.label}</span>
              <span className="font-mono">
                {k.display}
                {k.delta && <span className={k.delta_dir === "down" ? "text-[#b42318]" : "text-[#0f7a54]"}> {k.delta}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      {m.link && <span className="text-[12.5px] font-semibold text-[#0f7a54]">{m.link_label} →</span>}
    </div>
  );
}

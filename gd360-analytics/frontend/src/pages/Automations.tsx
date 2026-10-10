// 2026-10-10 (round 19): the Automations home (approved board D1, Option A).
// One place for everything that runs by itself in the active workspace -
// automations and alerts, dashboard refreshes and chains (the old Jobs page
// is merged in here) and data syncs:
//   1. four tiles: active, running now, next 24 hours, failed in 24 hours;
//   2. "Needs attention": approvals, failures, shared dashboards that never
//      refresh, failing quality checks - each with its fix one click away;
//   3. the next 24 hours as a timeline;
//   4. every item in one table - kind, schedule (changed inline), the last
//      seven runs, run now, on/off - and a drawer with its full history;
//   5. Run history (every run, all kinds) and Data freshness tabs.
// A Space narrows the page to work on that Space's sources.
//
// Chip, Toggle, RunHistory and RunRow stay exported: AutomationEdit uses RunRow.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { AutomationRun, automationsApi, FreshnessRow } from "../api/automations";
import { datasourceApi, dashboardApi, pipelinesApi, type PipelineStep, type RefreshInterval } from "../api/client";
import { spacesApi, type Space } from "../api/spaces";
import { errorText, opsApi, type OpsAttention, type OpsItem, type OpsKind, type OpsOverview, type OpsRun } from "../api/ops";
import { timeAgo } from "../project/format";
import { Button, ConfirmDialog, Popover, SearchInput, Select, Sheet, Skeleton, ChevronDownIcon, PlayIcon, PlusIcon, RefreshIcon, TrashIcon } from "../ui";
import {
  ago, Banner, EmptyNote, Eyebrow, fmtTime, fmtWhen, inFuture, KIND_LABEL, KIND_PLURAL, KindChip, KindDot, RunBars, secs, StatusDot, Tabs,
} from "../components/OpsParts";

// ------------------------------------------------- kept for AutomationEdit --

export function Chip({ part, children }: { part: "when" | "do" | "tell"; children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-2 min-h-[30px] px-2.5 py-1 rounded-[7px] border text-ui leading-snug"
      style={{
        color: `rgb(var(--auto-${part}))`,
        background: `rgb(var(--auto-${part}-fill))`,
        borderColor: `rgb(var(--auto-${part}-border) / 0.6)`,
      }}
    >
      <span className="font-mono text-[10px] uppercase opacity-75 shrink-0">{part}</span>
      <span>{children}</span>
    </span>
  );
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
      className={`ui-focus relative inline-flex h-[24px] w-[42px] shrink-0 items-center rounded-full transition-colors ${on ? "bg-primary" : "bg-border-strong"} disabled:opacity-40`}
    >
      <span className={`absolute top-[3px] left-[3px] h-[18px] w-[18px] rounded-full bg-[#F2F6F4] shadow transition-transform ${on ? "translate-x-[18px]" : ""}`} />
    </button>
  );
}

export function RunHistory({ runs }: { runs: AutomationRun[] | null }) {
  if (!runs) return <div className="text-ui text-muted">Loading runs…</div>;
  if (!runs.length) return <div className="text-ui text-muted">No runs yet.</div>;
  return (
    <div className="flex flex-col gap-2" aria-label="Recent runs">
      <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Recent runs</span>
      {runs.slice(0, 8).map((r) => (
        <RunRow key={r.id} r={r} />
      ))}
    </div>
  );
}

const REASON: Record<string, string> = {
  schedule: "On schedule", manual: "Run by hand", test: "Test", new_data: "New data", threshold: "Alert", automation: "From an automation",
};

export function RunRow({ r }: { r: AutomationRun }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-ctl border border-border bg-base">
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-3 px-3 py-2.5 text-left" aria-expanded={open}>
        <span className={`w-2 h-2 rounded-full shrink-0 ${r.status === "success" ? "bg-good" : r.status === "failed" ? "bg-danger" : "bg-warning animate-pulse"}`} aria-hidden="true" />
        <span className="text-ui text-text">{REASON[r.reason] || r.reason}</span>
        <span className="text-caption text-muted">{timeAgo(r.started_at)}{r.seconds != null ? ` · ${r.seconds} s` : ""}</span>
        <span className="ml-auto text-caption text-muted truncate max-w-[50%]">
          {r.status === "failed" ? r.error : r.deliveries.length ? r.deliveries.map((d) => `${d.channel} ${d.status === "sent" ? "✓" : d.status === "not_configured" ? "(not set up)" : d.status}`).join(" · ") : r.status === "running" ? "running…" : "nothing to send"}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 flex flex-col gap-2.5">
          {r.message?.headline && <p className="m-0 text-ui text-text">{r.message.headline}</p>}
          <ol className="m-0 p-0 list-none flex flex-col gap-1">
            {r.steps.map((s) => (
              <li key={s.index} className="flex gap-2 text-caption">
                <span className={s.status === "done" ? "text-good" : s.status === "failed" ? "text-danger" : "text-muted"}>{s.status === "done" ? "✓" : s.status === "failed" ? "✕" : "–"}</span>
                <span className="text-secondary">{s.label}</span>
                {s.error && <span className="text-danger">— {s.error}</span>}
                {s.seconds != null && s.status !== "skipped" && <span className="text-muted ml-auto font-mono">{s.seconds} s</span>}
              </li>
            ))}
          </ol>
          {r.deliveries.map((d, i) => (
            <div key={i} className="text-caption text-muted">
              {d.channel === "email" ? "Email" : d.channel === "slack" ? "Slack" : "Teams"} → {d.to}:{" "}
              <span className={d.status === "sent" ? "text-good" : d.status === "failed" ? "text-danger" : "text-warning"}>
                {d.status === "sent" ? "sent" : d.status === "not_configured" ? "not set up on the server yet" : d.status}
              </span>
              {d.detail && d.status !== "not_configured" ? ` — ${d.detail}` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- the page --

type Tab = "work" | "runs" | "freshness";
type KindFilter = "all" | OpsKind;

const INTERVAL_OPTIONS = [
  { value: "off", label: "Only by hand" },
  { value: "15m", label: "Every 15 minutes" },
  { value: "1h", label: "Every hour" },
  { value: "6h", label: "Every 6 hours" },
  { value: "daily", label: "Once a day" },
];
const SYNC_OPTIONS = INTERVAL_OPTIONS.filter((o) => o.value !== "off");

export default function Automations() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [data, setData] = useState<OpsOverview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [spaces, setSpaces] = useState<Space[]>([]);
  const spaceId = params.get("space") || "";
  const tab = (params.get("tab") as Tab) || "work";
  const [kind, setKind] = useState<KindFilter>("all");
  const [q, setQ] = useState("");
  const [unscheduledOnly, setUnscheduledOnly] = useState(false);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [chainSheet, setChainSheet] = useState<{ id: string | null } | null>(null);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const [decide, setDecide] = useState<{ item: OpsItem; approve: boolean } | null>(null);

  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === "work") next.delete("tab");
    else next.set("tab", t);
    setParams(next, { replace: true });
  };
  const setSpace = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set("space", id);
    else next.delete("space");
    setParams(next, { replace: true });
  };

  const load = useCallback(async () => {
    if (!activeWorkspaceId) return;
    try {
      const out = await opsApi.overview(activeWorkspaceId, spaceId || null);
      setData(out);
      setError("");
    } catch (e: any) {
      setError(errorText(e, "Couldn't load what runs in this workspace."));
    }
  }, [activeWorkspaceId, spaceId]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    spacesApi.list(activeWorkspaceId).then(setSpaces).catch(() => setSpaces([]));
  }, [activeWorkspaceId]);

  // A just-saved automation that waits for an owner's/admin's OK.
  useEffect(() => {
    if (params.get("waiting")) {
      setNotice("Saved. It emails people outside the company, so it stays off until an owner or admin approves it - they've been told.");
      const next = new URLSearchParams(params);
      next.delete("waiting");
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While anything runs, follow it.
  const anyRunning = !!data?.items.some((i) => i.running) || busyKeys.size > 0;
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  const mark = (keys: string[], on: boolean) =>
    setBusyKeys((prev) => {
      const n = new Set(prev);
      keys.forEach((k) => (on ? n.add(k) : n.delete(k)));
      return n;
    });

  const runNow = async (item: OpsItem) => {
    mark([item.key], true);
    try {
      await opsApi.run(activeWorkspaceId, item.key);
      setNotice(`${item.name} started.`);
      setTimeout(load, 600);
    } catch (e: any) {
      setError(errorText(e, "Couldn't start it."));
    } finally {
      setTimeout(() => mark([item.key], false), 1500);
    }
  };

  const changeSchedule = async (item: OpsItem, interval: string) => {
    mark([item.key], true);
    try {
      await opsApi.schedule(activeWorkspaceId, [item.key], interval);
      await load();
    } catch (e: any) {
      setError(errorText(e, "Couldn't change how often it runs."));
    } finally {
      mark([item.key], false);
    }
  };

  const toggleAutomation = async (item: OpsItem, on: boolean) => {
    mark([item.key], true);
    try {
      await automationsApi.toggle(item.id, on);
      await load();
    } catch (e: any) {
      setError(errorText(e, "Couldn't change that."));
    } finally {
      mark([item.key], false);
    }
  };

  const doAttention = async (a: OpsAttention, action: string) => {
    const item = data?.items.find((i) => i.key === a.key);
    if (action === "approve" || action === "reject") {
      if (item) setDecide({ item, approve: action === "approve" });
      return;
    }
    if (action === "retry" && item) return runNow(item);
    if (action === "open" && item?.link) return navigate(item.link);
    if (action === "history" && a.key) return setDrawer(a.key);
    if (action === "open_source" && a.datasource_id) return navigate(`/workspace/${a.datasource_id}`);
    if ((action === "schedule_daily" || action === "refresh_all") && a.keys) {
      const editable = a.keys.filter((k) => data?.items.find((i) => i.key === k)?.can_edit);
      mark(editable, true);
      try {
        if (action === "schedule_daily") {
          const out = await opsApi.schedule(activeWorkspaceId, editable, "daily");
          setNotice(`${out.changed.length} dashboard${out.changed.length === 1 ? "" : "s"} now refresh once a day.`);
        } else {
          const out = await opsApi.refreshAll(activeWorkspaceId, editable);
          setNotice(`Refreshing ${out.started.length} dashboard${out.started.length === 1 ? "" : "s"} now.`);
        }
        await load();
      } catch (e: any) {
        setError(errorText(e, "Couldn't do that."));
      } finally {
        mark(editable, false);
      }
    }
  };

  const items = data?.items || [];
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    items.forEach((i) => (c[i.kind] = (c[i.kind] || 0) + 1));
    return c;
  }, [items]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter(
      (i) =>
        (kind === "all" || i.kind === kind) &&
        (!unscheduledOnly || (!i.enabled && (i.kind === "refresh" || i.kind === "chain"))) &&
        (!needle || `${i.name} ${i.detail} ${i.owner.name}`.toLowerCase().includes(needle))
    );
  }, [items, kind, q, unscheduledOnly]);
  const unscheduledCount = items.filter((i) => !i.enabled && (i.kind === "refresh" || i.kind === "chain")).length;
  const activeSpace = spaces.find((s) => s.id === spaceId);
  const wsName = data?.workspace.name || workspaces.find((w) => w.id === activeWorkspaceId)?.name || "";

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />
        <main className="px-4 sm:px-8 lg:px-10 py-7 sm:py-9 max-w-[1240px] mx-auto flex flex-col gap-6">
          {/* header */}
          <header className="flex items-end justify-between gap-4 flex-wrap">
            <div className="flex flex-col gap-2 min-w-0">
              <Eyebrow>
                {wsName}
                {activeSpace ? ` · ${activeSpace.name}` : ""}
              </Eyebrow>
              <h1 className="m-0 text-[28px] sm:text-[34px] font-bold tracking-tight text-text leading-none">Automations</h1>
              <p className="m-0 text-body text-secondary max-w-[64ch]">
                Everything that runs by itself here — automations, alerts, dashboard refreshes, chains and data syncs — and what needs you first.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {spaces.length > 0 && (
                <Select
                  size="sm"
                  aria-label="Space"
                  value={spaceId}
                  onChange={(e) => setSpace(e.target.value)}
                  options={[{ value: "", label: "All spaces" }, ...spaces.map((s) => ({ value: s.id, label: s.name }))]}
                  className="min-w-[150px]"
                />
              )}
              <NewMenu canEdit={data ? data.workspace.can_edit : true} onChain={() => setChainSheet({ id: null })} />
            </div>
          </header>

          {notice && (
            <Banner tone="good" action={<button type="button" className="text-caption text-muted hover:text-text" onClick={() => setNotice("")}>Dismiss</button>}>
              {notice}
            </Banner>
          )}
          {error && (
            <Banner tone="danger" action={<button type="button" className="text-caption text-muted hover:text-text" onClick={() => setError("")}>Dismiss</button>}>
              {error}
            </Banner>
          )}
          {data && !data.email_ready && items.some((i) => i.kind === "automation" || i.kind === "alert") && (
            <Banner tone="warning">
              Email isn't switched on for this GD360 server yet, so email deliveries are recorded but not sent. Slack and Teams work now.
              <span className="text-muted"> (The server needs RESEND_API_KEY or SMTP settings, plus EMAIL_FROM.)</span>
            </Banner>
          )}

          {/* tiles */}
          <Tiles data={data} />

          {/* attention + timeline */}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            <AttentionInbox data={data} busyKeys={busyKeys} onAction={doAttention} onOpen={(k) => setDrawer(k)} />
            <Timeline data={data} onOpen={(k) => setDrawer(k)} />
          </div>

          {/* tabs */}
          <section className="flex flex-col gap-4" aria-label="Everything that runs">
            <Tabs<Tab>
              label="Automations views"
              value={tab}
              onChange={setTab}
              tabs={[
                { value: "work", label: "Everything that runs", count: items.length || null },
                { value: "runs", label: "Run history" },
                { value: "freshness", label: "Data freshness" },
              ]}
            />

            {tab === "work" && (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Show">
                    {(["all", "automation", "alert", "refresh", "chain", "sync"] as KindFilter[]).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setKind(k)}
                        aria-pressed={kind === k}
                        className={`ui-focus h-8 px-3 rounded-full border text-caption font-medium inline-flex items-center gap-1.5 transition-colors ${
                          kind === k ? "border-tint-border bg-tint text-brand-ink" : "border-border text-secondary hover:text-text hover:border-border-strong"
                        }`}
                      >
                        {k !== "all" && <KindDot kind={k} />}
                        {k === "all" ? "All" : KIND_PLURAL[k]}
                        <span className="font-mono text-[10.5px] opacity-70">{counts[k] || 0}</span>
                      </button>
                    ))}
                  </div>
                  <div className="flex-1" />
                  {unscheduledCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setUnscheduledOnly((v) => !v)}
                      aria-pressed={unscheduledOnly}
                      className={`ui-focus h-8 px-3 rounded-full border text-caption font-medium transition-colors ${
                        unscheduledOnly ? "border-warning-border bg-warning-fill text-warning" : "border-border text-secondary hover:text-text"
                      }`}
                    >
                      Not scheduled · {unscheduledCount}
                    </button>
                  )}
                  <SearchInput value={q} onChange={setQ} placeholder="Search by name or owner" className="w-full sm:w-[240px]" aria-label="Search" />
                </div>
                <WorkTable
                  data={data}
                  items={shown}
                  busyKeys={busyKeys}
                  onOpen={setDrawer}
                  onRun={runNow}
                  onSchedule={changeSchedule}
                  onToggle={toggleAutomation}
                  onEditChain={(id) => setChainSheet({ id })}
                />
              </>
            )}
            {tab === "runs" && <RunFeed workspaceId={activeWorkspaceId} onOpen={(k) => setDrawer(k)} />}
            {tab === "freshness" && <Freshness />}
          </section>
        </main>
      </div>

      <ItemDrawer
        workspaceId={activeWorkspaceId}
        itemKey={drawer}
        admin={!!data?.workspace.admin}
        onClose={() => setDrawer(null)}
        onRun={runNow}
        onDecide={(item, approve) => setDecide({ item, approve })}
        onEditChain={(id) => {
          setDrawer(null);
          setChainSheet({ id });
        }}
        refreshKey={data?.generated_at}
      />
      {chainSheet && (
        <ChainSheet
          workspaceId={activeWorkspaceId}
          chainId={chainSheet.id}
          onClose={() => setChainSheet(null)}
          onSaved={(msg) => {
            setChainSheet(null);
            setNotice(msg);
            load();
          }}
        />
      )}
      {decide && (
        <DecideDialog
          item={decide.item}
          approve={decide.approve}
          onClose={() => setDecide(null)}
          onDone={(msg) => {
            setDecide(null);
            setNotice(msg);
            load();
          }}
        />
      )}
    </div>
  );
}

function NewMenu({ canEdit, onChain }: { canEdit: boolean; onChain: () => void }) {
  const navigate = useNavigate();
  if (!canEdit) return null;
  return (
    <Popover
      align="end"
      width={300}
      role="menu"
      haspopup="menu"
      ariaLabel="Create"
      trigger={(t) => (
        <Button variant="primary" {...t.props} leadingIcon={<PlusIcon size={15} />} trailingIcon={<ChevronDownIcon size={14} />}>
          New
        </Button>
      )}
    >
      {({ close }) => (
        <div className="py-1.5">
          {[
            { kind: "automation" as OpsKind, title: "Automation", text: "When → do → tell: refresh, summarise, deliver.", go: () => navigate("/automations/new") },
            { kind: "alert" as OpsKind, title: "Alert", text: "Watch a number and tell someone when it crosses a line.", go: () => navigate("/automations/new?alert=1") },
            { kind: "chain" as OpsKind, title: "Chain", text: "Steps in order: refresh a source, rebuild a dashboard, run checks.", go: onChain },
          ].map((o) => (
            <button
              key={o.title}
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                o.go();
              }}
              className="ui-focus-inset w-full text-left px-3.5 py-2.5 hover:bg-subtle flex gap-3 items-start"
            >
              <KindDot kind={o.kind} className="mt-1.5" />
              <span className="flex flex-col gap-0.5">
                <span className="text-ui font-medium text-text">{o.title}</span>
                <span className="text-caption text-muted leading-snug">{o.text}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

function Tiles({ data }: { data: OpsOverview | null }) {
  if (!data) {
    return (
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[112px] rounded-card" />
        ))}
      </div>
    );
  }
  const t = data.tiles;
  const kinds = (Object.keys(t.active_by_kind) as OpsKind[]).filter((k) => t.active_by_kind[k] > 0);
  const tile = "ops-tile rounded-card border border-border p-4 sm:p-5 flex flex-col gap-2 min-h-[112px]";
  return (
    <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
      <div className={tile}>
        <Eyebrow>Running on a schedule</Eyebrow>
        <div className="text-kpi font-semibold text-text tabular-nums leading-none">{t.active}</div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-muted">
          {kinds.length ? kinds.map((k) => (
            <span key={k} className="inline-flex items-center gap-1.5"><KindDot kind={k} />{t.active_by_kind[k]} {KIND_LABEL[k].toLowerCase()}{t.active_by_kind[k] === 1 ? "" : "s"}</span>
          )) : <span>of {t.total} items</span>}
        </div>
      </div>
      <div className={tile}>
        <Eyebrow>Running now</Eyebrow>
        <div className="text-kpi font-semibold text-text tabular-nums leading-none flex items-center gap-2">
          {t.running_now}
          {t.running_now > 0 && <span className="w-2 h-2 rounded-full bg-warning ops-pulse" aria-hidden="true" />}
        </div>
        <div className="text-caption text-muted truncate">{t.running_now ? t.running_names.join(", ") : "Nothing at the moment"}</div>
      </div>
      <div className={tile}>
        <Eyebrow>Next 24 hours</Eyebrow>
        <div className="text-kpi font-semibold text-text tabular-nums leading-none">{t.next_24h}</div>
        <div className="text-caption text-muted truncate">{t.next ? <>Next: <span className="text-secondary">{t.next.name}</span> {inFuture(t.next.at)}</> : "Nothing scheduled"}</div>
      </div>
      <div className={`${tile} ${t.failed_24h ? "border-danger-border" : ""}`}>
        <Eyebrow>Failed · 24 hours</Eyebrow>
        <div className={`text-kpi font-semibold tabular-nums leading-none ${t.failed_24h ? "text-danger" : "text-text"}`}>{t.failed_24h}</div>
        <div className="text-caption text-muted">
          {t.waiting ? <span className="text-warning">{t.waiting} waiting for an OK</span> : t.failed_24h ? "See what needs attention" : "All runs succeeded"}
        </div>
      </div>
    </div>
  );
}

const TONE: Record<OpsAttention["tone"], { label: string; cls: string; dot: string }> = {
  approval: { label: "Needs your OK", cls: "text-[rgb(var(--ops-automation))]", dot: "bg-[rgb(var(--ops-automation))]" },
  failed: { label: "Failed", cls: "text-danger", dot: "bg-danger" },
  stale: { label: "Out of date", cls: "text-warning", dot: "bg-warning" },
  quality: { label: "Data quality", cls: "text-warning", dot: "bg-warning" },
  info: { label: "Waiting", cls: "text-secondary", dot: "bg-border-strong" },
};
const ACTION_LABEL: Record<string, string> = {
  approve: "Approve", reject: "Turn down", open: "Open", retry: "Run again", history: "See runs",
  schedule_daily: "Refresh them daily", refresh_all: "Refresh now", open_source: "Open the source",
};

function AttentionInbox({ data, busyKeys, onAction, onOpen }: { data: OpsOverview | null; busyKeys: Set<string>; onAction: (a: OpsAttention, action: string) => void; onOpen: (key: string) => void }) {
  return (
    <section className="rounded-card border border-border bg-surface flex flex-col min-h-[220px]" aria-label="Needs attention">
      <div className="flex items-center justify-between gap-3 px-4 sm:px-5 pt-4 pb-3 border-b border-border">
        <h2 className="m-0 text-section font-semibold text-text">Needs attention</h2>
        {data && <span className="text-caption text-muted">{data.attention.length ? `${data.attention.length} item${data.attention.length === 1 ? "" : "s"}` : ""}</span>}
      </div>
      {!data && <div className="p-5 flex flex-col gap-3"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>}
      {data && data.attention.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 px-5 py-8 text-center">
          <span className="w-10 h-10 rounded-full bg-good-fill text-good flex items-center justify-center text-lg" aria-hidden="true">✓</span>
          <div className="text-ui font-medium text-text">All clear</div>
          <div className="text-caption text-muted max-w-[44ch]">No failures, nothing waiting for an OK and no shared dashboard showing old numbers.</div>
        </div>
      )}
      {data && data.attention.length > 0 && (
        <ul className="m-0 p-0 list-none divide-y divide-border max-h-[420px] overflow-y-auto">
          {data.attention.map((a) => {
            const t = TONE[a.tone];
            const busy = (a.key && busyKeys.has(a.key)) || (a.keys || []).some((k) => busyKeys.has(k));
            return (
              <li key={a.id} className="px-4 sm:px-5 py-3.5 flex flex-col gap-2">
                <div className="flex items-start gap-3">
                  <span className={`mt-[7px] w-2 h-2 rounded-full shrink-0 ${t.dot}`} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className={`font-mono text-[10.5px] uppercase tracking-[0.1em] ${t.cls}`}>{t.label}</div>
                    <button type="button" className="text-left text-ui font-medium text-text hover:underline" onClick={() => a.key && onOpen(a.key)} disabled={!a.key}>
                      {a.title}
                    </button>
                    <div className="text-caption text-muted leading-relaxed mt-0.5 break-words">{a.detail}</div>
                  </div>
                </div>
                {a.actions.length > 0 && (
                  <div className="flex flex-wrap gap-2 pl-5">
                    {a.actions.map((act, i) => (
                      <Button
                        key={act}
                        size="sm"
                        variant={i === 0 ? (act === "reject" ? "secondary" : "primary") : "secondary"}
                        disabled={!!busy}
                        loading={!!busy && i === 0}
                        onClick={() => onAction(a, act)}
                        className="!h-8"
                      >
                        {ACTION_LABEL[act] || act}
                      </Button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Timeline({ data, onOpen }: { data: OpsOverview | null; onOpen: (key: string) => void }) {
  const groups = useMemo(() => {
    const out: { hour: string; rows: OpsOverview["timeline"] }[] = [];
    (data?.timeline || []).slice(0, 40).forEach((r) => {
      const label = fmtWhen(r.at).split(" ").slice(0, -1).join(" ") || "Today";
      const last = out[out.length - 1];
      if (last && last.hour === label) last.rows.push(r);
      else out.push({ hour: label, rows: [r] });
    });
    return out;
  }, [data]);
  return (
    <section className="rounded-card border border-border bg-surface flex flex-col min-h-[220px]" aria-label="Next 24 hours">
      <div className="flex items-center justify-between gap-3 px-4 sm:px-5 pt-4 pb-3 border-b border-border">
        <h2 className="m-0 text-section font-semibold text-text">Next 24 hours</h2>
        {data && <span className="text-caption text-muted">{data.timeline.length} run{data.timeline.length === 1 ? "" : "s"}</span>}
      </div>
      {!data && <div className="p-5 flex flex-col gap-3"><Skeleton className="h-6" /><Skeleton className="h-6" /><Skeleton className="h-6" /></div>}
      {data && data.timeline.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center gap-1.5 px-5 py-8 text-center">
          <div className="text-ui font-medium text-text">Nothing scheduled</div>
          <div className="text-caption text-muted max-w-[40ch]">Give a dashboard a refresh schedule in the table below, or create an automation.</div>
        </div>
      )}
      {data && data.timeline.length > 0 && (
        <ol className="m-0 p-0 list-none max-h-[420px] overflow-y-auto px-4 sm:px-5 py-3 flex flex-col gap-3">
          {groups.map((g) => (
            <li key={g.hour} className="flex flex-col gap-1">
              <Eyebrow>{g.hour}</Eyebrow>
              <ol className="m-0 p-0 list-none border-l border-border ml-[3px]">
                {g.rows.map((r, i) => (
                  <li key={`${r.key}-${r.at}-${i}`} className="relative pl-4 py-1">
                    <span className={`ops-kind-${r.kind} ops-dot absolute -left-[4px] top-[11px] w-[7px] h-[7px] rounded-full`} aria-hidden="true" />
                    <button type="button" onClick={() => onOpen(r.key)} className="w-full text-left flex items-center gap-3 rounded-ctl px-1.5 py-1 hover:bg-subtle">
                      <span className="font-mono text-caption text-muted w-[62px] shrink-0 tabular-nums">{fmtTime(r.at)}</span>
                      <span className="text-ui text-text truncate flex-1">{r.name}</span>
                      <span className={`ops-kind-${r.kind} ops-ink text-[11px] hidden sm:inline`}>{KIND_LABEL[r.kind]}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function lastText(i: OpsItem): { text: string; tone: string } {
  if (i.running) return { text: "Running now…", tone: "text-warning" };
  const l = i.last_run;
  if (!l) return { text: i.kind === "refresh" && i.live_source ? "Live - always current" : "No runs yet", tone: "text-muted" };
  if (l.checked) return { text: `Checked ${ago(l.at)}${l.value ? ` · ${l.value}` : ""}`, tone: l.status === "failed" ? "text-danger" : "text-muted" };
  if (l.status === "failed") return { text: `Failed ${ago(l.at)}`, tone: "text-danger" };
  return { text: `${ago(l.at)}${l.seconds != null ? ` · ${secs(l.seconds)}` : ""}`, tone: "text-muted" };
}

function WorkTable({
  data, items, busyKeys, onOpen, onRun, onSchedule, onToggle, onEditChain,
}: {
  data: OpsOverview | null;
  items: OpsItem[];
  busyKeys: Set<string>;
  onOpen: (key: string) => void;
  onRun: (i: OpsItem) => void;
  onSchedule: (i: OpsItem, interval: string) => void;
  onToggle: (i: OpsItem, on: boolean) => void;
  onEditChain: (id: string) => void;
}) {
  if (!data) {
    return <div className="flex flex-col gap-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[64px] rounded-card" />)}</div>;
  }
  if (!data.items.length) {
    return (
      <EmptyNote title="Nothing runs by itself here yet">
        Create an automation or an alert, give a dashboard a refresh schedule, or connect an app that syncs. Everything that runs on its own will show up here.
      </EmptyNote>
    );
  }
  if (!items.length) return <EmptyNote title="Nothing matches">Try another filter or search.</EmptyNote>;
  return (
    <div className="rounded-card border border-border bg-surface overflow-hidden">
      <div className="hidden lg:grid grid-cols-[minmax(0,2.4fr)_minmax(150px,1.1fr)_120px_minmax(120px,0.9fr)_minmax(110px,0.8fr)_150px] gap-4 px-5 h-10 items-center border-b border-border bg-subtle/60">
        {["What", "How often", "Last 7", "Last run", "Next", ""].map((h) => (
          <span key={h} className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted">{h}</span>
        ))}
      </div>
      <ul className="m-0 p-0 list-none divide-y divide-border">
        {items.map((i) => {
          const last = lastText(i);
          const busy = busyKeys.has(i.key) || i.running;
          const pending = i.approval?.status === "pending";
          const rejected = i.approval?.status === "rejected";
          return (
            <li key={i.key} className={`ops-row ops-kind-${i.kind} ops-stripe`}>
              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2.4fr)_minmax(150px,1.1fr)_120px_minmax(120px,0.9fr)_minmax(110px,0.8fr)_150px] gap-x-4 gap-y-2.5 px-4 sm:px-5 py-3.5 items-center">
                {/* what */}
                <div className="min-w-0 flex flex-col gap-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <KindChip kind={i.kind} short />
                    {pending && <span className="h-[22px] px-2 rounded-full text-[11px] font-medium bg-warning-fill text-warning border border-warning-border inline-flex items-center">Waiting for OK</span>}
                    {rejected && <span className="h-[22px] px-2 rounded-full text-[11px] font-medium bg-danger-fill text-danger border border-danger-border inline-flex items-center">Turned down</span>}
                    {i.stale && <span className="h-[22px] px-2 rounded-full text-[11px] font-medium bg-warning-fill text-warning border border-warning-border inline-flex items-center">Data changed</span>}
                  </div>
                  <button type="button" onClick={() => onOpen(i.key)} className="text-left text-ui font-semibold text-text hover:underline truncate" title={i.name}>
                    {i.name}
                  </button>
                  <div className="text-caption text-muted truncate" title={i.detail}>
                    {i.detail}
                    <span className="text-faint"> · {i.owner.name}</span>
                  </div>
                </div>
                {/* how often */}
                <div className="min-w-0">
                  <span className="lg:hidden font-mono text-[10px] uppercase tracking-[0.1em] text-faint mr-2">How often</span>
                  {i.schedule.editable && (i.kind === "refresh" || i.kind === "chain" || i.kind === "sync") ? (
                    <Select
                      size="sm"
                      aria-label={`How often ${i.name} runs`}
                      value={i.schedule.interval || "off"}
                      disabled={busyKeys.has(i.key)}
                      onChange={(e) => onSchedule(i, e.target.value)}
                      options={i.kind === "sync" ? SYNC_OPTIONS : INTERVAL_OPTIONS}
                      className="w-full max-w-[200px] inline-flex"
                    />
                  ) : (
                    <span className={`text-ui ${i.enabled ? "text-text" : "text-muted"}`}>{i.schedule.text}</span>
                  )}
                  {!i.enabled && (i.kind === "refresh" || i.kind === "chain") && i.schedule.interval === "off" && (
                    <div className="text-[11px] text-warning mt-1">Not scheduled</div>
                  )}
                </div>
                {/* last 7 */}
                <div className="flex items-center gap-2">
                  <span className="lg:hidden font-mono text-[10px] uppercase tracking-[0.1em] text-faint">Last 7</span>
                  <RunBars runs={i.runs} label={i.name} />
                </div>
                {/* last run */}
                <div className={`text-caption ${last.tone} min-w-0 truncate`}>
                  <span className="lg:hidden font-mono text-[10px] uppercase tracking-[0.1em] text-faint mr-2">Last run</span>
                  <span className="inline-flex items-center gap-1.5">
                    {i.last_run && <StatusDot status={i.running ? "running" : i.last_run.status} />}
                    <span className="truncate" title={i.last_run?.error || last.text}>{last.text}</span>
                  </span>
                </div>
                {/* next */}
                <div className="text-caption text-secondary">
                  <span className="lg:hidden font-mono text-[10px] uppercase tracking-[0.1em] text-faint mr-2">Next</span>
                  {i.next_run_at ? fmtWhen(i.next_run_at) : <span className="text-faint">—</span>}
                </div>
                {/* actions */}
                <div className="flex items-center gap-2 lg:justify-end">
                  {(i.kind === "automation" || i.kind === "alert") && (
                    <Toggle on={i.enabled} disabled={!i.can_toggle || busyKeys.has(i.key) || pending} onChange={(v) => onToggle(i, v)} label={i.enabled ? `Turn off ${i.name}` : `Turn on ${i.name}`} />
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    className="!h-8"
                    disabled={!i.can_run || busy || pending}
                    loading={busy}
                    leadingIcon={busy ? undefined : i.kind === "refresh" || i.kind === "sync" ? <RefreshIcon size={14} /> : <PlayIcon size={14} />}
                    onClick={() => onRun(i)}
                    title={pending ? "Waiting for an owner's or admin's OK" : !i.can_run ? "You can't run this one" : undefined}
                  >
                    {i.kind === "alert" ? "Check" : i.kind === "sync" ? "Sync" : i.kind === "refresh" ? "Refresh" : "Run"}
                  </Button>
                  <RowMenu item={i} onOpen={() => onOpen(i.key)} onEditChain={() => onEditChain(i.id)} />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RowMenu({ item, onOpen, onEditChain }: { item: OpsItem; onOpen: () => void; onEditChain: () => void }) {
  const navigate = useNavigate();
  const entries: { label: string; go: () => void }[] = [{ label: "Run history", go: onOpen }];
  if ((item.kind === "automation" || item.kind === "alert") && item.can_edit) entries.push({ label: "Edit", go: () => navigate(`/automations/${item.id}`) });
  if (item.kind === "chain" && item.can_edit) entries.push({ label: "Edit chain", go: onEditChain });
  if (item.kind === "refresh" && item.link) entries.push({ label: "Open dashboard", go: () => navigate(item.link!) });
  if (item.kind === "sync" && item.link) entries.push({ label: "Open source", go: () => navigate(item.link!) });
  return (
    <Popover
      align="end"
      width={190}
      role="menu"
      haspopup="menu"
      ariaLabel={`More for ${item.name}`}
      portal
      trigger={(t) => (
        <button type="button" {...t.props} className="ui-focus w-8 h-8 rounded-ctl border border-border text-muted hover:text-text hover:border-border-strong inline-flex items-center justify-center" aria-label={`More for ${item.name}`}>
          <span aria-hidden="true" className="leading-none text-lg -mt-1">…</span>
        </button>
      )}
    >
      {({ close }) => (
        <div className="py-1">
          {entries.map((e) => (
            <button
              key={e.label}
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                e.go();
              }}
              className="ui-focus-inset w-full text-left px-3.5 py-2 text-ui text-text hover:bg-subtle"
            >
              {e.label}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

// ------------------------------------------------------------- drawer --

function ItemDrawer({
  workspaceId, itemKey, admin, onClose, onRun, onDecide, onEditChain, refreshKey,
}: {
  workspaceId: string;
  itemKey: string | null;
  admin: boolean;
  onClose: () => void;
  onRun: (i: OpsItem) => void;
  onDecide: (i: OpsItem, approve: boolean) => void;
  onEditChain: (id: string) => void;
  refreshKey?: string;
}) {
  const [data, setData] = useState<{ item: OpsItem; runs: OpsRun[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!itemKey) {
      setData(null);
      return;
    }
    let alive = true;
    opsApi
      .itemRuns(workspaceId, itemKey)
      .then((d) => alive && (setData(d), setError("")))
      .catch((e) => alive && setError(errorText(e, "Couldn't load its runs.")));
    return () => {
      alive = false;
    };
  }, [itemKey, workspaceId, refreshKey]);
  const item = data?.item;
  const ok = data ? data.runs.filter((r) => r.status === "success").length : 0;
  return (
    <Sheet
      open={!!itemKey}
      onClose={onClose}
      size="md"
      title={item ? item.name : "Loading…"}
      subtitle={item ? <span className="inline-flex items-center gap-2"><KindChip kind={item.kind} /> <span className="text-muted">{item.owner.name}</span></span> : undefined}
      footer={
        item ? (
          <div className="flex flex-wrap gap-2 justify-end w-full">
            {item.kind === "chain" && item.can_edit && <Button variant="secondary" onClick={() => onEditChain(item.id)}>Edit chain</Button>}
            {(item.kind === "automation" || item.kind === "alert") && item.can_edit && <Link className="btn-secondary text-sm" to={`/automations/${item.id}`}>Edit</Link>}
            {item.link && item.kind !== "automation" && item.kind !== "alert" && <Link className="btn-secondary text-sm" to={item.link}>Open</Link>}
            <Button variant="primary" disabled={!item.can_run || item.running || item.approval?.status === "pending"} loading={item.running} onClick={() => onRun(item)}>
              {item.kind === "alert" ? "Check now" : item.kind === "sync" ? "Sync now" : item.kind === "refresh" ? "Refresh now" : "Run now"}
            </Button>
          </div>
        ) : undefined
      }
    >
      {error && <Banner tone="danger">{error}</Banner>}
      {!data && !error && <div className="flex flex-col gap-3"><Skeleton className="h-16" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>}
      {item && data && (
        <div className="flex flex-col gap-5">
          {item.approval?.status === "pending" && (
            <div className="rounded-card border border-warning-border bg-warning-fill p-4 flex flex-col gap-2.5">
              <div className="text-ui font-semibold text-text">Waiting for an owner's or admin's OK</div>
              <div className="text-caption text-secondary leading-relaxed">
                {item.approval.requested_by || item.owner.name} built it to email people outside the company:
                <span className="block mt-1 font-mono text-[12px] text-text break-all">{item.approval.external.join(", ") || "—"}</span>
              </div>
              {admin && (
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" onClick={() => onDecide(item, true)}>Approve</Button>
                  <Button size="sm" variant="secondary" onClick={() => onDecide(item, false)}>Turn down</Button>
                </div>
              )}
            </div>
          )}
          {item.approval?.status === "rejected" && (
            <Banner tone="danger">Turned down{item.approval.note ? `: “${item.approval.note}”` : "."} Edit who it emails and save to ask again.</Banner>
          )}
          {item.sentence && (item.kind === "automation" || item.kind === "alert") && (
            <div className="flex flex-wrap items-center gap-2">
              <Chip part="when">{item.sentence.when}</Chip>
              <span className="text-muted" aria-hidden="true">→</span>
              <Chip part="do">{item.sentence.do}</Chip>
              <span className="text-muted" aria-hidden="true">→</span>
              <Chip part="tell">{item.sentence.tell}</Chip>
            </div>
          )}
          <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3">
            {[
              ["How often", item.schedule.text],
              ["Next run", item.next_run_at ? fmtWhen(item.next_run_at) : "—"],
              ["What it touches", item.detail || "—"],
              ["Who can change it", item.who_can_edit],
              ["Recent success", data.runs.length ? `${ok} of ${data.runs.length} runs` : "No runs yet"],
              ["Owner", item.owner.name],
            ].map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted">{k}</dt>
                <dd className="m-0 mt-0.5 text-ui text-text break-words">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-col gap-2">
            <Eyebrow>Runs</Eyebrow>
            {data.runs.length === 0 && <div className="text-ui text-muted">No runs yet.</div>}
            {data.runs.map((r) => <FeedRow key={r.id} r={r} compact />)}
          </div>
        </div>
      )}
    </Sheet>
  );
}

function FeedRow({ r, compact = false, onOpen }: { r: OpsRun; compact?: boolean; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const hasMore = !!(r.error || r.steps?.length || r.deliveries?.length || r.headline);
  return (
    <div className="rounded-ctl border border-border bg-base">
      <button type="button" onClick={() => (hasMore ? setOpen((v) => !v) : onOpen?.())} aria-expanded={hasMore ? open : undefined} className="w-full flex items-center gap-3 px-3 py-2.5 text-left">
        <StatusDot status={r.status} />
        {!compact && <KindChip kind={r.kind} short />}
        <span className="min-w-0 flex-1 flex flex-col sm:flex-row sm:items-center sm:gap-3">
          {!compact && <span className="text-ui text-text truncate">{r.name}</span>}
          <span className="text-caption text-muted">
            {REASON[r.reason] || r.reason} · {fmtWhen(r.started_at)}
            {r.seconds != null ? ` · ${secs(r.seconds)}` : ""}
            {r.rows != null ? ` · ${r.rows.toLocaleString()} rows` : ""}
          </span>
        </span>
        <span className={`text-caption shrink-0 ${r.status === "failed" ? "text-danger" : r.status === "running" ? "text-warning" : "text-good"}`}>
          {r.status === "failed" ? "Failed" : r.status === "running" ? "Running" : "Done"}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 flex flex-col gap-2">
          {r.headline && <p className="m-0 text-ui text-text">{r.headline}</p>}
          {r.error && <p className="m-0 text-caption text-danger break-words">{r.error}</p>}
          {!!r.steps?.length && (
            <ol className="m-0 p-0 list-none flex flex-col gap-1">
              {r.steps.map((s, i) => (
                <li key={i} className="flex gap-2 text-caption">
                  <span className={s.status === "done" || s.status === "success" ? "text-good" : s.status === "failed" ? "text-danger" : "text-muted"}>
                    {s.status === "done" || s.status === "success" ? "✓" : s.status === "failed" ? "✕" : "–"}
                  </span>
                  <span className="text-secondary">{s.label}</span>
                  {s.error && <span className="text-danger">— {s.error}</span>}
                </li>
              ))}
            </ol>
          )}
          {r.deliveries?.map((d, i) => (
            <div key={i} className="text-caption text-muted">
              {d.channel} → {d.to}: <span className={d.status === "sent" ? "text-good" : d.status === "failed" ? "text-danger" : "text-warning"}>{d.status === "not_configured" ? "not set up on the server yet" : d.status}</span>
            </div>
          ))}
          {onOpen && <button type="button" className="self-start text-caption text-primary hover:underline" onClick={onOpen}>Open its history</button>}
        </div>
      )}
    </div>
  );
}

function RunFeed({ workspaceId, onOpen }: { workspaceId: string; onOpen: (key: string) => void }) {
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [data, setData] = useState<{ runs: OpsRun[]; total: number; page_size: number } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setData(null);
    opsApi.runs(workspaceId, page, kind, status).then(setData).catch((e) => setError(errorText(e, "Couldn't load the runs.")));
  }, [workspaceId, page, kind, status]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 flex-wrap">
        <Select size="sm" aria-label="Kind" value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }}
          options={[{ value: "", label: "Every kind" }, ...(Object.keys(KIND_PLURAL) as OpsKind[]).map((k) => ({ value: k, label: KIND_PLURAL[k] }))]} className="min-w-[170px]" />
        <Select size="sm" aria-label="Result" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          options={[{ value: "", label: "Any result" }, { value: "failed", label: "Failed" }, { value: "success", label: "Succeeded" }, { value: "running", label: "Running" }]} className="min-w-[140px]" />
        {data && <span className="text-caption text-muted self-center ml-auto">{data.total.toLocaleString()} run{data.total === 1 ? "" : "s"}</span>}
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
      {!data && !error && <div className="flex flex-col gap-2">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-11" />)}</div>}
      {data && data.runs.length === 0 && <EmptyNote title="No runs yet">Runs appear here as soon as anything runs - on its schedule or by hand.</EmptyNote>}
      {data && data.runs.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {data.runs.map((r) => <FeedRow key={`${r.kind}-${r.id}`} r={r} onOpen={() => onOpen(`${r.kind}:${r.item_id}`)} />)}
        </div>
      )}
      {data && pages > 1 && (
        <div className="flex items-center justify-between gap-2">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Newer</Button>
          <span className="text-caption text-muted">Page {page} of {pages}</span>
          <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Older</Button>
        </div>
      )}
    </div>
  );
}

function Freshness() {
  const [rows, setRows] = useState<FreshnessRow[] | null>(null);
  useEffect(() => {
    automationsApi.freshness().then(setRows).catch(() => setRows([]));
  }, []);
  const sorted = useMemo(() => {
    const order: Record<string, number> = { LIVE: 0, SYNCED: 1, API: 2, STREAM: 3, FILE: 4 };
    return [...(rows || [])].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
  }, [rows]);
  return (
    <div className="rounded-card border border-border bg-surface p-5 sm:p-6 flex flex-col gap-4">
      <p className="m-0 text-ui text-secondary max-w-[80ch] leading-relaxed">
        Live sources are always current — nothing to schedule. Synced apps copy new records on the timing below. Dashboards on live sources show current numbers
        whenever they're opened; a schedule only matters for emails, reports and alerts — and for dashboards on uploaded files.
      </p>
      {!rows && <Skeleton className="h-24" />}
      {rows && rows.length === 0 && <div className="text-ui text-muted">No data sources yet. <Link to="/data" className="underline">Connect one</Link>.</div>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-ui border-collapse min-w-[560px]">
            <thead>
              <tr className="text-left">
                {["Source", "Type", "New data arrives", "Last updated"].map((h) => (
                  <th key={h} className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted font-medium px-1 pb-2.5 border-b border-border">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-b-0">
                  <td className="px-1 py-3 text-text">{r.name}</td>
                  <td className="px-1 py-3">
                    <span className={`font-mono text-[10.5px] px-1.5 py-0.5 rounded ${r.type === "LIVE" ? "bg-good-fill text-good" : r.type === "SYNCED" ? "bg-[rgb(var(--auto-tell-fill))] text-[rgb(var(--auto-tell))]" : "bg-subtle text-secondary"}`}>{r.type}</span>
                  </td>
                  <td className="px-1 py-3 text-text">{r.arrives}{r.error ? <span className="block text-caption text-danger">{r.error}</span> : null}</td>
                  <td className="px-1 py-3 font-mono text-caption text-muted">{r.type === "LIVE" ? "Now" : r.updated_at ? ago(r.updated_at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------- approve dialog --

function DecideDialog({ item, approve, onClose, onDone }: { item: OpsItem; approve: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      if (approve) await opsApi.approve(item.id, note);
      else await opsApi.reject(item.id, note);
      onDone(approve ? `“${item.name}” is approved and on.` : `“${item.name}” was turned down. Its owner can change it and ask again.`);
    } catch (e: any) {
      setError(errorText(e, "Couldn't save that."));
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      open
      title={approve ? `Approve “${item.name}”?` : `Turn down “${item.name}”?`}
      confirmLabel={approve ? "Approve and turn on" : "Turn down"}
      tone={approve ? "primary" : "danger"}
      busy={busy}
      error={error || undefined}
      onConfirm={go}
      onCancel={onClose}
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-ui text-secondary">
          {approve ? "It will start running on its schedule and email:" : "It stays off. It would have emailed:"}
          <span className="block mt-1 font-mono text-[12px] text-text break-all">{item.approval?.external.join(", ")}</span>
        </p>
        <label className="flex flex-col gap-1.5">
          <span className="text-caption text-muted">Note to {item.approval?.requested_by || item.owner.name} (optional)</span>
          <textarea className="input min-h-[72px] text-ui" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </label>
      </div>
    </ConfirmDialog>
  );
}

// --------------------------------------------------------- chain sheet --

type StepDraft = PipelineStep;
const STEP_LABEL: Record<PipelineStep["type"], string> = {
  refresh_datasource: "Refresh a data source",
  rebuild_dashboard: "Rebuild a dashboard",
  run_quality_checks: "Run quality checks",
};

function ChainSheet({ workspaceId, chainId, onClose, onSaved }: { workspaceId: string; chainId: string | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [interval, setInterval_] = useState<RefreshInterval>("off");
  const [sources, setSources] = useState<{ id: string; name: string }[]>([]);
  const [dashes, setDashes] = useState<{ id: string; name: string }[]>([]);
  const [loaded, setLoaded] = useState(!chainId);
  const [canDelete, setCanDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    datasourceApi.list(workspaceId).then((l: any[]) => setSources(l.map((d) => ({ id: d.id, name: d.name })))).catch(() => setSources([]));
    dashboardApi.list().then((l) => setDashes(l.map((d) => ({ id: d.id, name: d.name })))).catch(() => setDashes([]));
    if (chainId) {
      pipelinesApi
        .get(chainId)
        .then((p) => {
          setName(p.name);
          setDescription(p.description || "");
          setSteps(p.steps);
          setInterval_(p.schedule_interval);
          setCanDelete(p.can_delete);
          setLoaded(true);
        })
        .catch((e) => setError(errorText(e, "Couldn't open that chain.")));
    }
  }, [chainId, workspaceId]);

  const addStep = (type: PipelineStep["type"]) =>
    setSteps((s) => [...s, type === "rebuild_dashboard" ? { type, dashboard_id: "" } : ({ type, datasource_id: "" } as StepDraft)]);
  const move = (i: number, d: -1 | 1) =>
    setSteps((s) => {
      const n = [...s];
      const j = i + d;
      if (j < 0 || j >= n.length) return s;
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  const valid = name.trim() && steps.length > 0 && steps.every((s) => ("dashboard_id" in s ? s.dashboard_id : (s as any).datasource_id));

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const body = { name: name.trim(), description: description.trim() || null, steps, schedule_interval: interval, workspace_id: workspaceId || null };
      if (chainId) await pipelinesApi.update(chainId, body);
      else await pipelinesApi.create(body);
      onSaved(chainId ? `“${name.trim()}” saved.` : `Chain “${name.trim()}” created.`);
    } catch (e: any) {
      setError(errorText(e, "Couldn't save the chain."));
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!chainId) return;
    setBusy(true);
    try {
      await pipelinesApi.delete(chainId);
      onSaved(`“${name}” deleted.`);
    } catch (e: any) {
      setError(errorText(e, "Couldn't delete it."));
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      size="md"
      title={chainId ? "Edit chain" : "New chain"}
      subtitle="Steps run in order. If one fails, the rest wait."
      footer={
        <div className="flex items-center gap-2 w-full">
          {chainId && canDelete && (
            <Button variant="ghost" className="!text-danger" leadingIcon={<TrashIcon size={14} />} onClick={() => setConfirmDelete(true)} disabled={busy}>
              Delete
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid || busy} loading={busy} onClick={save}>{chainId ? "Save" : "Create chain"}</Button>
        </div>
      }
    >
      {!loaded && !error && <Skeleton className="h-40" />}
      {error && <Banner tone="danger">{error}</Banner>}
      {loaded && (
        <div className="flex flex-col gap-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-muted">Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning refresh" maxLength={120} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-muted">What it's for (optional)</span>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Fresh numbers before the 9:00 stand-up" maxLength={300} />
          </label>
          <div className="flex flex-col gap-2">
            <Eyebrow>Steps</Eyebrow>
            {steps.length === 0 && <div className="text-ui text-muted">Add the first step below.</div>}
            <ol className="m-0 p-0 list-none flex flex-col gap-2">
              {steps.map((s, i) => (
                <li key={i} className="rounded-ctl border border-border bg-base p-3 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-subtle text-caption font-mono text-secondary flex items-center justify-center shrink-0">{i + 1}</span>
                    <span className="text-ui font-medium text-text flex-1">{STEP_LABEL[s.type]}</span>
                    <button type="button" className="ui-focus w-7 h-7 rounded-ctl text-muted hover:text-text disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                    <button type="button" className="ui-focus w-7 h-7 rounded-ctl text-muted hover:text-text disabled:opacity-30" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                    <button type="button" className="ui-focus w-7 h-7 rounded-ctl text-muted hover:text-danger" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} aria-label="Remove step"><TrashIcon size={14} /></button>
                  </div>
                  <Select
                    size="sm"
                    aria-label="Target"
                    value={"dashboard_id" in s ? s.dashboard_id : (s as any).datasource_id}
                    onChange={(e) =>
                      setSteps((x) => x.map((st, j) => (j !== i ? st : "dashboard_id" in st ? { ...st, dashboard_id: e.target.value } : ({ ...st, datasource_id: e.target.value } as StepDraft))))
                    }
                    options={[
                      { value: "", label: s.type === "rebuild_dashboard" ? "Pick a dashboard…" : "Pick a data source…" },
                      ...(s.type === "rebuild_dashboard" ? dashes : sources).map((o) => ({ value: o.id, label: o.name })),
                    ]}
                  />
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(STEP_LABEL) as PipelineStep["type"][]).map((t) => (
                <Button key={t} size="sm" variant="secondary" leadingIcon={<PlusIcon size={13} />} onClick={() => addStep(t)} className="!h-8">
                  {STEP_LABEL[t]}
                </Button>
              ))}
            </div>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-muted">How often</span>
            <Select value={interval} onChange={(e) => setInterval_(e.target.value as RefreshInterval)} options={INTERVAL_OPTIONS} aria-label="How often" />
          </label>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${name}”?`}
        confirmLabel="Delete chain"
        tone="danger"
        busy={busy}
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      >
        Its run history goes with it. Anything it refreshed stays as it is.
      </ConfirmDialog>
    </Sheet>
  );
}

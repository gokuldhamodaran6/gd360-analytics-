// 2026-10-11 (Explain & Alerts, canvas B1-B4): Ask AI on a dashboard.
//
// A drawer beside the dashboard - nothing in the dashboard itself changes
// (editing, filters and the builder work exactly as before):
//   - Explain any chart or number on the page, from the rows it is showing
//     right now (with the page's filters); GD360 points at the chart it means.
//   - Ask about the page in words.
//   - Say what to watch ("alert me if profit margin goes below 20%"): GD360
//     drafts the alert - which number, the line, how it's checked, a back-test
//     on its history - and nothing is switched on until the person confirms
//     who gets it and where (components/AlertSetup.tsx).
//   - "Want me to watch this?" suggestions, the one thing GD360 noticed, and
//     the alerts already watching this dashboard.
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { DashboardBlock, DashboardBuilderDetail, DashboardBuilderPage } from "../api/client";
import {
  AlertDraft, AlertOp, BlockExplanation, BlockSnapshot, BoardAlert, dashboardAiApi, DraftResult, MetricChoice, WatchOut, WatchSuggestion,
} from "../api/alerts";
import { automationsApi } from "../api/automations";
import type { DashboardRun } from "../dashboard/useDashboardRun";
import { kpiDisplay, kpiValue, resultOk } from "../dashboard/blockData";
import { storedTable } from "../dashboard/fileData";
import { ArrowUpIcon, CloseIcon, GdMark, Spinner } from "../thread/parts";
import { SparkIcon } from "../thread/Explain";
import { AlertConfirmSheet, AlertDraftCard, BellSmall, DraftQuestion } from "./AlertSetup";

const DATA_TYPES = new Set(["chart", "table", "kpi", "gauge", "donut", "sparkline", "avatar_list"]);

// ---- what the page is showing ---------------------------------------------------

function blockTitle(b: DashboardBlock): string {
  return (b.title || b.config?.label || b.config?.title || "Untitled").toString();
}

export function snapshotBlock(b: DashboardBlock, run: DashboardRun, warehouse: boolean): BlockSnapshot | null {
  if (!DATA_TYPES.has(b.type)) return null;
  const base = { id: b.id, title: blockTitle(b), type: b.type, chart_type: b.config?.chart_type || null, currency: b.config?.currency || null };
  if (warehouse) {
    const r = run.results[b.id];
    if (!resultOk(r)) return null;
    const snap: BlockSnapshot = {
      ...base,
      columns: (r.columns || []).map((c: any) => ({ name: c.name, type: c.type })),
      rows: (r.rows || []).slice(0, 200),
      dimensions: [r.time_column, ...(r.dimensions || [])].filter(Boolean) as string[],
    };
    if (b.type === "kpi" || b.type === "gauge") {
      const d = kpiDisplay(r, b);
      // round 33: the trend line's own periods, grain and units travel with it, so an explanation says
      // "across 60 months (2021-01 to 2025-12)" in dollars - not "the last 36 periods" in bare numbers
      const m = r.measures?.[0];
      const srows = (r.sparkline?.rows || []).filter((row) => m && typeof row[m] === "number" && Number.isFinite(row[m]));
      const tcol = (r.sparkline?.columns || []).map((c) => c.name).find((n) => n !== m && srows.some((row) => typeof row[n] === "string" && /^\d{4}-\d{2}/.test(row[n])));
      snap.kpi = {
        value: kpiValue(r), display: d.value, delta: d.delta?.label || null, delta_caption: d.delta?.caption || null, sparkline: d.sparkline,
        format: d.format.format, grain: r.sparkline?.grain || null, spark_periods: tcol ? srows.map((row) => String(row[tcol])) : [],
      };
    }
    return snap;
  }
  const cfg = run.overrides[b.id]?.config || b.config || {};
  if (b.type === "kpi" || b.type === "gauge") {
    if (cfg.value === undefined || cfg.value === null) return null;
    const spark = Array.isArray(cfg.sparkline) ? cfg.sparkline : Array.isArray(cfg.sparkline_series) ? cfg.sparkline_series : [];
    return { ...base, columns: [], rows: [], kpi: { value: cfg.value, display: String(cfg.value), sparkline: spark } };
  }
  const t = storedTable(cfg);
  if (!t || !t.rows.length) return null;
  return { ...base, columns: t.columns.map((c: any) => ({ name: c.name })), rows: t.rows.slice(0, 200) };
}

export function snapshotPage(page: DashboardBuilderPage | null, run: DashboardRun, warehouse: boolean): BlockSnapshot[] {
  if (!page) return [];
  return [...page.blocks]
    .sort((a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0))
    .map((b) => snapshotBlock(b, run, warehouse))
    .filter(Boolean)
    .slice(0, 24) as BlockSnapshot[];
}

/** Scrolls to a tile and rings it for a moment - "this one". */
export function flashBlock(id: string | null | undefined) {
  if (!id) return;
  const el = (document.querySelector(`[data-kpi-block="${id}"]`) || document.querySelector(`[data-block-id="${id}"]`)) as HTMLElement | null;
  if (!el) return;
  const box = (el.closest(".gd-edit-card") as HTMLElement | null) || (el.closest("[data-kpi-block]") as HTMLElement | null) || el;
  box.scrollIntoView({ behavior: "smooth", block: "center" });
  const prev = { outline: box.style.outline, offset: box.style.outlineOffset, radius: box.style.borderRadius, transition: box.style.transition };
  box.style.transition = "outline-color 300ms ease";
  box.style.outline = "2px solid rgb(var(--color-kind-answer))";
  box.style.outlineOffset = "3px";
  if (!prev.radius) box.style.borderRadius = "14px";
  window.setTimeout(() => {
    box.style.outline = prev.outline;
    box.style.outlineOffset = prev.offset;
    box.style.borderRadius = prev.radius;
    box.style.transition = prev.transition;
  }, 1900);
}

// ---- the watch state, shared by the header button, the banner and the drawer ---

export function useBoardWatch(dashboardId: string, pageId: string | null | undefined, enabled: boolean) {
  const [data, setData] = useState<WatchOut | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      setData(await dashboardAiApi.watch(dashboardId, pageId));
    } catch {
      setData((cur) => cur || { suggestions: [], noticed: null, alerts: [], email_ready: false });
    } finally {
      setLoading(false);
    }
  }, [dashboardId, pageId, enabled]);
  useEffect(() => {
    if (!enabled) return;
    // after the page's own numbers have loaded, so they share the warehouse's cache
    const t = window.setTimeout(load, 1800);
    return () => window.clearTimeout(t);
  }, [load, enabled]);
  return { data, loading, reload: load };
}
export type BoardWatch = ReturnType<typeof useBoardWatch>;

// ---- header button and banner --------------------------------------------------

/** In the dashboard header from tablet width up; a round button at the
 *  bottom right on a phone (the header row has no room there). */
export function AskAIButton({ onClick, alerts }: { onClick: () => void; alerts: number }) {
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        aria-label="Ask AI"
        className="sm:hidden ui-focus fixed z-[45] right-4 bottom-5 w-14 h-14 rounded-full bg-kind-answer text-[rgb(var(--color-base))] shadow-[0_16px_40px_-12px_rgb(0_0_0/0.8)] grid place-items-center"
        data-ask-ai-fab=""
      >
        <SparkIcon size={20} />
        {alerts > 0 && <span className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-kind-alert text-[11px] font-bold grid place-items-center">{alerts}</span>}
      </button>
      <AskAIHeaderButton onClick={onClick} alerts={alerts} />
    </>
  );
}

function AskAIHeaderButton({ onClick, alerts }: { onClick: () => void; alerts: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hidden sm:inline-flex ui-focus items-center gap-2 h-10 px-3.5 rounded-ctl border border-kind-answer-border bg-kind-answer-fill text-kind-answer text-sm font-semibold"
      data-ask-ai=""
      title="Explain any chart, ask about this page, or tell GD360 what to watch"
    >
      <SparkIcon size={14} /> Ask AI
      {alerts > 0 && (
        <span className="inline-flex items-center gap-1 h-[20px] px-1.5 rounded-full bg-kind-alert-fill text-kind-alert text-[11px] font-semibold" title={`${alerts} alert${alerts === 1 ? "" : "s"} watching this dashboard`}>
          <BellSmall size={11} /> {alerts}
        </span>
      )}
    </button>
  );
}

const NOTICE_KEY = "gd360_noticed_dismissed";

export function NoticedBanner({ dashboardId, noticed, onWatch }: { dashboardId: string; noticed: WatchOut["noticed"]; onWatch: (s: WatchSuggestion) => void }) {
  const key = noticed ? `${dashboardId}:${noticed.block_id}:${noticed.text}` : "";
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    try {
      const list = JSON.parse(localStorage.getItem(NOTICE_KEY) || "[]");
      setHidden(Array.isArray(list) && list.includes(key));
    } catch {
      setHidden(false);
    }
  }, [key]);
  if (!noticed || hidden) return null;
  const dismiss = () => {
    setHidden(true);
    try {
      const list = JSON.parse(localStorage.getItem(NOTICE_KEY) || "[]");
      localStorage.setItem(NOTICE_KEY, JSON.stringify([...(Array.isArray(list) ? list : []), key].slice(-60)));
    } catch {
      /* private window - it just shows again next time */
    }
  };
  return (
    <div className="px-4 pt-4 sm:px-6" data-noticed-banner="">
      <div className="flex items-center gap-3 flex-wrap rounded-[14px] border border-kind-answer-border bg-kind-answer-fill/70 px-3.5 py-3">
        <span className="w-7 h-7 shrink-0 rounded-[8px] bg-kind-answer-fill text-kind-answer grid place-items-center"><SparkIcon size={13} /></span>
        <span className="flex-1 min-w-[220px] text-ui leading-5">
          <b className="text-text">GD360 noticed:</b> <span className="text-secondary">{noticed.text}</span>
        </span>
        <button type="button" onClick={() => onWatch(noticed)} className="ui-focus h-8 px-3 rounded-[10px] bg-primary text-on-primary text-[13px] font-semibold">
          Watch it
        </button>
        <button type="button" onClick={dismiss} className="ui-focus h-8 px-2.5 rounded-[10px] text-[13px] text-muted hover:text-text">
          Not now
        </button>
      </div>
    </div>
  );
}

// ---- the drawer -----------------------------------------------------------------

type Msg =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "gd"; kind: "thinking"; text: string }
  | { id: string; role: "gd"; kind: "explain"; explain: BlockExplanation; focus?: string | null; question: string; view?: string; viewLabel?: string }
  | { id: string; role: "gd"; kind: "draft"; draft: AlertDraft; choices: MetricChoice[]; done?: boolean }
  | { id: string; role: "gd"; kind: "question"; result: Extract<DraftResult, { status: "need_metric" | "need_line" }> }
  | { id: string; role: "gd"; kind: "done"; text: string; pending: boolean; automationId: string }
  | { id: string; role: "gd"; kind: "error"; text: string };

let seq = 0;
const nid = () => `m${++seq}`;

export type AskSeed = { kind: "watch"; suggestion: WatchSuggestion } | { kind: "explain"; blockId: string } | null;

export function DashboardAskAI({
  open, onClose, dash, page, run, warehouse, watch, seed, onSeedUsed,
}: {
  open: boolean;
  onClose: () => void;
  dash: DashboardBuilderDetail;
  page: DashboardBuilderPage | null;
  run: DashboardRun;
  warehouse: boolean;
  watch: BoardWatch;
  seed: AskSeed;
  onSeedUsed: () => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ msgId: string; draft: AlertDraft } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [msgs.length]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !confirm && onClose();
    document.addEventListener("keydown", onKey);
    window.setTimeout(() => input.current?.focus(), 60);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, confirm, onClose]);

  const push = (m: Msg) => setMsgs((cur) => [...cur, m]);
  const replace = (id: string, m: Msg) => setMsgs((cur) => cur.map((x) => (x.id === id ? m : x)));
  const errText = (e: any, f: string) => {
    const d = e?.response?.data?.detail;
    return typeof d === "string" && d ? d : f;
  };

  const blocks = () => snapshotPage(page, run, warehouse);
  // round 35: what the page was showing when an answer was written - if the person then switches
  // Month to Year (or filters), that answer says so and offers to explain the view now on screen
  const PERIOD_WORD: Record<string, string> = { day: "Day", week: "Week", month: "Month", quarter: "Quarter", year: "Year" };
  const viewKey = () => `${run.state.period}|${run.activeFilterCount}|${run.state.dateRange.from || ""}|${run.state.dateRange.to || ""}`;
  const viewLabel = () => {
    const p = PERIOD_WORD[run.state.period] || run.state.period;
    const f = run.activeFilterCount ? ` with ${run.activeFilterCount} filter${run.activeFilterCount === 1 ? "" : "s"}` : "";
    const d = run.state.dateRange.from || run.state.dateRange.to ? " in a date range" : "";
    return `${p} view${f}${d}`;
  };

  const ask = async (q: string, focus?: string | null) => {
    const question = q.trim();
    if (question.length < 2 || busy) return;
    push({ id: nid(), role: "user", text: question });
    const wait = nid();
    push({ id: wait, role: "gd", kind: "thinking", text: "Reading the numbers on this page…" });
    setBusy(true);
    try {
      const out = await dashboardAiApi.ask(dash.id, { question, page_id: page?.id, blocks: blocks(), focus_block_id: focus || null });
      if (out.kind === "explain") {
        replace(wait, { id: wait, role: "gd", kind: "explain", explain: out.explain, focus, question, view: viewKey(), viewLabel: viewLabel() });
        const first = focus || out.explain.points.find((p) => p.block_id)?.block_id;
        if (first) flashBlock(first);
      } else if (out.status === "ok") {
        replace(wait, { id: wait, role: "gd", kind: "draft", draft: out.draft, choices: out.choices });
        flashBlock(out.draft.target.block_id);
      } else {
        replace(wait, { id: wait, role: "gd", kind: "question", result: out });
      }
    } catch (e: any) {
      replace(wait, { id: wait, role: "gd", kind: "error", text: errText(e, "Couldn't answer that right now. Please try again.") });
    } finally {
      setBusy(false);
    }
  };

  const explainBlock = async (b: DashboardBlock) => {
    if (busy) return;
    const snap = snapshotBlock(b, run, warehouse);
    push({ id: nid(), role: "user", text: `Explain “${blockTitle(b)}”` });
    const wait = nid();
    push({ id: wait, role: "gd", kind: "thinking", text: "Reading the chart…" });
    flashBlock(b.id);
    if (!snap) {
      replace(wait, { id: wait, role: "gd", kind: "error", text: "This tile hasn't shown any numbers yet - give it a moment to load." });
      return;
    }
    setBusy(true);
    try {
      const ex = await dashboardAiApi.explain(dash.id, snap);
      replace(wait, { id: wait, role: "gd", kind: "explain", explain: ex, focus: b.id, question: "", view: viewKey(), viewLabel: viewLabel() });
    } catch (e: any) {
      replace(wait, { id: wait, role: "gd", kind: "error", text: errText(e, "Couldn't explain this chart right now.") });
    } finally {
      setBusy(false);
    }
  };

  const draftFrom = async (body: Parameters<typeof dashboardAiApi.draft>[1], userText: string | null, replaceId?: string) => {
    if (busy) return;
    if (userText) push({ id: nid(), role: "user", text: userText });
    const wait = replaceId || nid();
    if (!replaceId) push({ id: wait, role: "gd", kind: "thinking", text: "Drafting the alert and testing it on the history…" });
    setBusy(true);
    try {
      const out = await dashboardAiApi.draft(dash.id, { page_id: page?.id, ...body });
      if (out.status === "ok") {
        replace(wait, { id: wait, role: "gd", kind: "draft", draft: out.draft, choices: out.choices });
        flashBlock(out.draft.target.block_id);
      } else replace(wait, { id: wait, role: "gd", kind: "question", result: out });
    } catch (e: any) {
      replace(wait, { id: wait, role: "gd", kind: "error", text: errText(e, "Couldn't draft that alert.") });
    } finally {
      setBusy(false);
    }
  };

  // a "Watch it" / "Explain" handed over by the banner or a tile
  useEffect(() => {
    if (!open || !seed) return;
    if (seed.kind === "watch") {
      const s = seed.suggestion;
      draftFrom({ block_id: s.block_id, op: s.op, value: s.value, page_id: s.page_id }, `Watch ${s.label.toLowerCase()} - tell me if it goes ${s.op} ${s.line_display}`);
    } else {
      const b = page?.blocks.find((x) => x.id === seed.blockId);
      if (b) explainBlock(b);
    }
    onSeedUsed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seed]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const q = text;
    setText("");
    ask(q);
  };

  if (!open) return null;
  const charts = (page?.blocks || []).filter((b) => DATA_TYPES.has(b.type)).sort((a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0));
  const alerts = watch.data?.alerts || [];
  const sugg = watch.data?.suggestions || [];

  return (
    <>
      <aside
        aria-label="Ask AI"
        className="fixed z-[55] top-0 right-0 bottom-0 w-full sm:w-[460px] border-l border-border bg-[rgb(var(--color-base))] shadow-[-30px_0_80px_-40px_rgb(0_0_0/0.9)] flex flex-col"
        data-ask-ai-drawer=""
      >
        <div className="h-16 shrink-0 px-[18px] border-b border-border flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-[10px] bg-kind-answer-fill text-kind-answer grid place-items-center"><SparkIcon size={15} /></span>
          <div className="flex-1 min-w-0 flex flex-col">
            <b className="text-[15px] text-text">Ask AI</b>
            <span className="text-[12px] text-muted truncate">{dash.name}{page && (dash.pages || []).length > 1 ? ` · ${page.name}` : ""}</span>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="ui-focus w-8 h-8 rounded-[9px] grid place-items-center text-muted hover:text-text">
            <CloseIcon size={16} />
          </button>
        </div>

        <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto px-[18px] py-[18px] flex flex-col gap-4">
          {msgs.length === 0 && (
            <>
              <p className="m-0 text-ui text-secondary leading-relaxed">
                Ask about this page, or tell me what to watch - I'll explain from the numbers you're looking at, and nothing is switched on without you.
              </p>
              {charts.length > 0 && (
                <section className="flex flex-col gap-2">
                  <span className="font-mono text-[11px] tracking-[0.14em] text-muted">EXPLAIN A CHART</span>
                  <div className="flex flex-wrap gap-1.5">
                    {charts.slice(0, 10).map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => explainBlock(b)}
                        onMouseEnter={() => flashBlock(b.id)}
                        disabled={busy}
                        className="ui-focus h-8 px-3 rounded-full border border-border-strong text-[12.5px] text-secondary hover:text-text hover:border-kind-answer-border max-w-full truncate inline-flex items-center gap-1.5"
                        data-explain-chip={b.id}
                      >
                        <SparkIcon size={11} className="text-kind-answer" /> {blockTitle(b)}
                      </button>
                    ))}
                  </div>
                </section>
              )}
              <section className="flex flex-col gap-2" data-watch-suggestions="">
                <span className="font-mono text-[11px] tracking-[0.14em] text-kind-alert">WANT ME TO WATCH THIS?</span>
                {!watch.data && <span className="text-caption text-muted inline-flex items-center gap-2"><Spinner /> Looking at this page's history…</span>}
                {watch.data && sugg.length === 0 && (
                  <span className="text-caption text-muted">Type what to watch below - for example “alert me if revenue falls by more than 10%”.</span>
                )}
                {sugg.map((s) => (
                  <button
                    key={s.block_id}
                    type="button"
                    onClick={() => draftFrom({ block_id: s.block_id, op: s.op, value: s.value, page_id: s.page_id }, `Watch ${s.label.toLowerCase()} - tell me if it goes ${s.op} ${s.line_display}`)}
                    disabled={busy}
                    className="ui-focus text-left rounded-[14px] border border-kind-alert-border bg-kind-alert-fill p-3 flex items-center gap-3 hover:border-kind-alert"
                  >
                    <span className="w-8 h-8 shrink-0 rounded-[9px] bg-[rgb(var(--color-kind-alert)/0.16)] text-kind-alert grid place-items-center"><BellSmall size={15} /></span>
                    <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                      <span className="text-ui text-text font-medium">{s.text}</span>
                      <span className="text-[12px] text-secondary">{s.reason}</span>
                    </span>
                    <span className="text-[12px] text-kind-alert font-semibold shrink-0">Set it up</span>
                  </button>
                ))}
              </section>
            </>
          )}

          {alerts.length > 0 && msgs.length === 0 && <AlertsList alerts={alerts} onChanged={watch.reload} />}

          {msgs.map((m) => {
            if (m.role === "user")
              return (
                <div key={m.id} className="self-end max-w-[88%] px-3.5 py-2.5 rounded-[16px_16px_4px_16px] bg-surface2 text-ui text-text">{m.text}</div>
              );
            return (
              <div key={m.id} className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-[12px] text-muted">
                  <GdMark size={20} />
                  <b className="text-ui text-text">GD360</b>
                  <span>
                    {m.kind === "draft" ? "· here's the alert I'd set up" : m.kind === "explain" ? `· from the numbers on this page${m.explain.seconds != null ? ` · ${Math.max(0.1, m.explain.seconds).toFixed(1)} s` : ""}` : ""}
                  </span>
                </div>
                {m.kind === "thinking" && <div className="text-ui text-secondary inline-flex items-center gap-2"><Spinner className="text-kind-answer" /> {m.text}</div>}
                {m.kind === "error" && <div className="rounded-[12px] border border-danger-border bg-danger-fill px-3 py-2 text-ui text-danger">{m.text}</div>}
                {m.kind === "explain" && m.view && m.view !== viewKey() && (
                  <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-warning-border bg-warning-fill px-3 py-2 text-caption text-warning" data-explain-stale="">
                    <span>Written for the {m.viewLabel || "earlier view"} - the page now shows the {viewLabel()}.</span>
                    <button
                      type="button"
                      disabled={busy}
                      className="ui-focus ml-auto rounded font-semibold underline-offset-2 hover:underline disabled:opacity-50"
                      onClick={() => {
                        const b = m.focus ? page?.blocks.find((x) => x.id === m.focus) : null;
                        if (!m.question && b) explainBlock(b);
                        else ask(m.question || "Explain this page", m.focus);
                      }}
                    >
                      Explain again
                    </button>
                  </div>
                )}
                {m.kind === "explain" && (
                  <ExplainCard
                    e={m.explain}
                    page={page}
                    onFollowup={(q) => ask(q, m.focus)}
                    onWatch={m.focus && page?.blocks.find((b) => b.id === m.focus && (b.type === "kpi" || b.type === "gauge"))
                      ? () => draftFrom({ block_id: m.focus! }, `Watch “${blockTitle(page!.blocks.find((b) => b.id === m.focus)!)}”`)
                      : undefined}
                  />
                )}
                {m.kind === "question" && (
                  <DraftQuestion result={m.result} busy={busy} onPick={(p) => draftFrom(p, null, m.id)} />
                )}
                {m.kind === "draft" && (
                  <AlertDraftCard
                    draft={m.draft}
                    choices={m.choices}
                    busy={busy}
                    done={m.done}
                    onChange={(patch) => draftFrom({ ...patch }, null, m.id)}
                    onNext={() => setConfirm({ msgId: m.id, draft: m.draft })}
                  />
                )}
                {m.kind === "done" && (
                  <div className="rounded-[14px] border border-kind-alert-border bg-kind-alert-fill p-3.5 flex flex-col gap-1.5" data-alert-on="">
                    <span className="text-ui text-text font-semibold inline-flex items-center gap-2"><BellSmall size={15} /> {m.pending ? "Waiting for an OK" : "The alert is on"}</span>
                    <span className="text-[13px] text-secondary leading-snug">{m.text}</span>
                    <Link to={`/automations/${m.automationId}`} className="self-start text-[12.5px] text-kind-alert hover:underline">See it in Automations →</Link>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <form onSubmit={submit} className="m-3.5 mt-0 rounded-[18px] border border-border-strong bg-surface focus-within:border-kind-answer-border flex items-end gap-2 p-2.5">
          <label className="sr-only" htmlFor="ask-ai-input">Ask, or say what to watch</label>
          <textarea
            id="ask-ai-input"
            ref={input}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Ask, or say what to watch…"
            className="flex-1 min-h-[40px] max-h-[140px] resize-none bg-transparent border-0 outline-none px-1.5 py-2 text-[15px] leading-[22px] text-text placeholder:text-faint"
          />
          <button type="submit" aria-label="Send" disabled={busy || text.trim().length < 2} className="ui-focus w-9 h-9 rounded-full bg-primary text-on-primary grid place-items-center shrink-0 disabled:opacity-35">
            {busy ? <Spinner /> : <ArrowUpIcon size={16} />}
          </button>
        </form>
      </aside>
      {confirm && (
        <AlertConfirmSheet
          open
          onClose={() => setConfirm(null)}
          dashboardId={dash.id}
          draft={confirm.draft}
          workspaceId={(dash as any).workspace_id || null}
          onCreated={(out) => {
            const id = confirm.msgId;
            setMsgs((cur) => cur.map((x) => (x.id === id && x.role === "gd" && x.kind === "draft" ? { ...x, done: true } : x)));
            push({
              id: nid(), role: "gd", kind: "done", automationId: out.id, pending: out.pending,
              text: out.pending
                ? "It emails people outside your company, so an owner or admin of this workspace needs to OK it first - it switches on as soon as they do."
                : `I'll ${out.tell || "tell you"}. It's checked every hour, and if it's already past the line you'll hear within a minute.`,
            });
            setConfirm(null);
            watch.reload();
          }}
        />
      )}
    </>
  );
}

function ExplainCard({ e, page, onFollowup, onWatch }: { e: BlockExplanation; page: DashboardBuilderPage | null; onFollowup: (q: string) => void; onWatch?: () => void }) {
  const titleOf = (id?: string | null) => (id ? page?.blocks.find((b) => b.id === id)?.title : null);
  return (
    <section className="rounded-[16px] border border-border bg-surface p-4 flex flex-col gap-3" data-ai-explain="">
      <p className="m-0 text-[15px] leading-[22px] text-text font-medium">{e.headline}</p>
      <ol className="list-none m-0 p-0 flex flex-col gap-2.5">
        {e.points.map((p, i) => {
          // round 33: one "Show" link per tile - not the same link under every point
          const id = p.block_id || e.block_id;
          const firstForTile = e.points.findIndex((q) => (q.block_id || e.block_id) === id) === i;
          return (
          <li key={i} className="grid grid-cols-[22px_1fr] gap-2.5 items-start">
            <span className="mt-[1px] w-[22px] h-[22px] rounded-full bg-kind-answer-fill text-kind-answer grid place-items-center font-mono text-[11px]" aria-hidden="true">{i + 1}</span>
            <span className="flex flex-col gap-1">
              <span className="text-ui text-secondary leading-relaxed">{p.text}</span>
              {id && firstForTile && titleOf(id) && (
                <button type="button" onClick={() => flashBlock(p.block_id || e.block_id)} className="self-start text-[12px] text-kind-answer hover:underline">
                  Show “{titleOf(p.block_id || e.block_id)}”
                </button>
              )}
            </span>
          </li>
          );
        })}
      </ol>
      {e.takeaway && <p className="m-0 text-ui text-text leading-relaxed border-l-2 border-kind-answer pl-3">{e.takeaway}</p>}
      {e.needs_new_data && (
        <div className="rounded-[12px] border border-kind-analysis-border bg-kind-analysis-fill/60 px-3 py-2.5 text-[13px] text-text flex flex-col gap-1.5">
          <span>This page doesn't have the numbers for that.</span>
          <Link to={`/?q=${encodeURIComponent(e.new_question || e.question || "")}`} className="self-start text-kind-analysis font-medium hover:underline">
            Ask it as a new analysis →
          </Link>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {onWatch && (
          <button type="button" onClick={onWatch} className="ui-focus h-8 px-3 rounded-full border border-kind-alert-border text-[12.5px] text-kind-alert inline-flex items-center gap-1.5 hover:bg-kind-alert-fill">
            <BellSmall size={12} /> Watch this number
          </button>
        )}
        {e.followups.slice(0, 2).map((q) => (
          <button key={q} type="button" onClick={() => onFollowup(q)} className="ui-focus h-8 px-3 rounded-full bg-subtle text-[12.5px] text-secondary hover:text-text max-w-full truncate">
            {q}
          </button>
        ))}
      </div>
      <span className="text-[11.5px] text-faint">
        {e.written_by === "numbers" ? "Written from the page's numbers alone." : "Every number is one this page is showing - checked before it was shown."}
      </span>
    </section>
  );
}

function AlertsList({ alerts, onChanged }: { alerts: BoardAlert[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <section className="flex flex-col gap-2" data-board-alerts="">
      <span className="font-mono text-[11px] tracking-[0.14em] text-muted">WATCHING THIS DASHBOARD</span>
      {alerts.map((a) => (
        <div key={a.id} className="rounded-[14px] border border-border bg-surface p-3 flex items-start gap-3">
          <span className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${!a.enabled ? "bg-border-strong" : a.last_condition ? "bg-danger" : "bg-kind-answer"}`} aria-hidden="true" />
          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
            <span className="text-ui text-text font-medium truncate">{a.name}</span>
            <span className="text-[12px] text-muted">
              {a.waiting_for_ok ? "Waiting for an admin's OK" : !a.enabled ? "Paused" : a.last_condition ? `Past the line now${a.last_value ? ` · ${a.last_value}` : ""}` : a.last_value ? `Fine · ${a.last_value} now` : "Checking every hour"}
              {a.snoozed ? " · snoozed for you" : ""}
              {a.remind === "daily" ? " · daily reminder" : ""}
            </span>
          </div>
          {a.mine && !a.waiting_for_ok && (
            <button
              type="button"
              disabled={busy === a.id}
              onClick={async () => {
                setBusy(a.id);
                try {
                  await automationsApi.toggle(a.id, !a.enabled);
                  onChanged();
                } finally {
                  setBusy(null);
                }
              }}
              className="ui-focus h-7 px-2.5 rounded-[8px] border border-border-strong text-[12px] text-secondary hover:text-text shrink-0"
            >
              {a.enabled ? "Pause" : "Turn on"}
            </button>
          )}
          <Link to={`/automations/${a.id}`} className="text-[12px] text-muted hover:text-text shrink-0 self-center">Edit</Link>
        </div>
      ))}
    </section>
  );
}

export type { AlertOp };

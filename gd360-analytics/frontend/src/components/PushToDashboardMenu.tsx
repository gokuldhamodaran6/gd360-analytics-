import { useEffect, useRef, useState, type ReactNode } from "react";
import { dashboardBuilderApi, DashboardPickerEntry } from "../api/client";

// 2026-10-01 (chat-to-dashboard round): "i want chart turn my charts into
// dashboard feature and in which dashboard which page i want to push...
// deeper level customization when building is needed" (Gokul's own report,
// verbatim). This is that feature - a small, self-contained "Add to
// dashboard" popover that takes a chart/table result already on screen (in
// the chat panel, or the workspace's own current chart) and pushes it as a
// single new block onto an EXISTING Dashboard Builder (v2) dashboard, onto
// whichever page the person picks, or a brand new page named on the spot.
//
// Deliberately modeled on Workspace.tsx's own SaveChartMenu (the proven
// "pick a target, then save" popover already used for the older, flat v1
// chart-board feature) - same click-outside popover shell, same radio-then-
// select pattern - rather than inventing a new interaction style, but kept
// as its own standalone component (not a SaveChartMenu edit) so this new,
// less-tested path can never regress that already-working one. Rendered
// from two places: next to SaveChartMenu in Workspace.tsx (the chart
// currently showing in the main panel) and in ChatPanel.tsx's ResultCard
// (each card of a multi-result chat answer) - both already have everything
// this needs on hand, no extra network round-trip required to gather it.
//
// Nothing here is a second AI call or a guess: chartSpec/resultColumns/
// resultRows/chartType/sourceCode/sourcePrompt/insight are all exactly what
// the person already saw rendered - this just relocates that same real
// result onto a dashboard block (see backend CreateBlockRequest.config's
// own docstring for how that one-call create+fill works server-side).
export default function PushToDashboardMenu({
  chartSpec,
  chartType,
  resultColumns,
  resultRows,
  resultTruncated,
  title,
  insight,
  sourceCode,
  sourcePrompt,
  sourceTable,
  compact,
  preview,
}: {
  chartSpec?: any;
  chartType?: string | null;
  resultColumns?: { name: string }[] | null;
  resultRows?: Record<string, any>[] | null;
  resultTruncated?: boolean;
  title: string;
  insight?: string | null;
  // The real code that computed this result, when on hand (ChatTurn.code /
  // ResultEntry.code) - never fabricated, simply omitted when not
  // available to the caller. Lands on the new block's own
  // config["source_code"], read by DashboardCanvas.tsx's "How this was
  // built" panel - see backend _attach_source_lineage's own docstring.
  sourceCode?: string | null;
  // The question that was actually asked to produce this - the preceding
  // user turn's own text. Lands on config["ai_prompt"].
  sourcePrompt?: string | null;
  // Rare from the client side (today only a multi-table BigQuery/Snowflake/
  // multi-sheet source's block build knows this server-side) - included for
  // completeness/future use, honestly omitted otherwise.
  sourceTable?: string | null;
  // Smaller trigger button for a tight card header (ResultCard) vs the
  // workspace header's normal-sized button (next to "Save chart").
  compact?: boolean;
  // 2026-10-07 (chart-integrity round): a small drawing of exactly what is
  // about to be added (the caller's own chart component, so it is the same
  // picture the dashboard block will show). Optional.
  preview?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [dashboards, setDashboards] = useState<DashboardPickerEntry[] | null>(null);
  const [dashboardId, setDashboardId] = useState("");
  const [pageMode, setPageMode] = useState<"existing" | "new">("existing");
  const [pageId, setPageId] = useState("");
  const [newPageName, setNewPageName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // Nothing to push - no chart, and no tabular result either. Rendered as
  // nothing at all (same "simply doesn't get the button" convention
  // ResultCard's own "Use this table" button already uses) rather than a
  // disabled button nobody can explain.
  const hasTable = Array.isArray(resultColumns) && resultColumns.length > 0 && Array.isArray(resultRows);
  const canPush = Boolean(chartSpec) || hasTable;

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setDashboards(null);
    dashboardBuilderApi
      .listMine()
      .then((d) => {
        setDashboards(d);
        const editable = d.filter((x) => x.can_edit);
        const first = editable[0];
        setDashboardId(first?.id || "");
        if (first && first.pages.length > 0) {
          setPageMode("existing");
          setPageId(first.pages[0].id);
        } else {
          setPageMode("new");
        }
        setNewPageName("New page");
      })
      .catch(() => setDashboards([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const editableDashboards = (dashboards || []).filter((d) => d.can_edit);
  const selectedDashboard = editableDashboards.find((d) => d.id === dashboardId) || null;

  // Switching dashboards resets the page pick to that dashboard's own
  // first page (or "new page" if it has none yet) - never leaves a stale
  // page id from the previously-selected dashboard silently selected.
  const onPickDashboard = (id: string) => {
    setDashboardId(id);
    const d = editableDashboards.find((x) => x.id === id);
    if (d && d.pages.length > 0) {
      setPageMode("existing");
      setPageId(d.pages[0].id);
    } else {
      setPageMode("new");
    }
  };

  const buildConfig = (): { type: "chart" | "table"; config: Record<string, any> } => {
    const lineage: Record<string, any> = {};
    if (sourceCode && sourceCode.trim()) lineage.source_code = sourceCode.trim();
    if (sourcePrompt && sourcePrompt.trim()) lineage.ai_prompt = sourcePrompt.trim();
    if (sourceTable) lineage.source_table = sourceTable;
    if (insight && insight.trim()) lineage.ai_explanation = insight.trim();

    if (chartSpec) {
      const config: Record<string, any> = { chart_spec: chartSpec, ...lineage };
      if (hasTable) {
        config.result_columns = resultColumns;
        config.result_rows = resultRows;
      }
      if (chartType) config.chart_type = chartType;
      return { type: "chart", config };
    }
    // No chart - a plain table push, same shape _table_from_rows builds
    // server-side (columns/rows/truncated).
    return {
      type: "table",
      config: {
        columns: (resultColumns || []).map((c) => c.name),
        rows: resultRows || [],
        truncated: Boolean(resultTruncated),
        ...lineage,
      },
    };
  };

  const push = async () => {
    if (!selectedDashboard) return;
    setBusy(true);
    setResult(null);
    try {
      let targetPageId = pageId;
      let dashboardName = selectedDashboard.name;
      if (pageMode === "new") {
        const updated = await dashboardBuilderApi.createPage(selectedDashboard.id, newPageName.trim() || "New page");
        const createdPage = updated.pages[updated.pages.length - 1];
        targetPageId = createdPage.id;
      }
      if (!targetPageId) {
        setResult({ ok: false, message: "Pick a page to add this to." });
        setBusy(false);
        return;
      }
      const { type, config } = buildConfig();
      await dashboardBuilderApi.createBlock(selectedDashboard.id, targetPageId, type, title, undefined, config);
      const pageLabel =
        pageMode === "new" ? newPageName.trim() || "New page" : selectedDashboard.pages.find((p) => p.id === targetPageId)?.name;
      setResult({ ok: true, message: `Added to "${dashboardName}"${pageLabel ? ` → ${pageLabel}` : ""}.` });
      setTimeout(() => setOpen(false), 1400);
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setResult({ ok: false, message: typeof detail === "string" ? detail : "Could not add this to that dashboard." });
    } finally {
      setBusy(false);
    }
  };

  if (!canPush) return null;

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        className={compact ? "text-[10px] text-muted hover:text-fg font-medium" : "btn-secondary text-sm"}
        onClick={() => setOpen((o) => !o)}
        title="Add this to an existing dashboard, on whichever page you pick"
      >
        {compact ? "Add to dashboard" : "Add to dashboard"}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 dash-card bg-surface shadow-2xl border border-border p-3 z-30 text-xs">
          {dashboards === null ? (
            <div className="text-xs text-muted py-2">Loading your dashboards&hellip;</div>
          ) : editableDashboards.length === 0 ? (
            <div className="text-xs text-muted py-1">
              You don't have an editable dashboard yet - create one first with "Create dashboard", then come back here to
              push more charts onto it.
            </div>
          ) : (
            <>
              {preview && (
                <div className="mb-2.5 rounded-lg border border-border bg-surface p-2" data-testid="push-preview" style={{ height: 170 }}>
                  {preview}
                </div>
              )}
              <label className="block mb-2.5">
                <span className="block text-[11px] font-medium text-muted mb-1">Dashboard</span>
                <select className="input text-xs w-full" value={dashboardId} onChange={(e) => onPickDashboard(e.target.value)}>
                  {editableDashboards.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {d.datasource_name ? ` — ${d.datasource_name}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="mb-2.5">
                <span className="block text-[11px] font-medium text-muted mb-1">Page</span>
                {selectedDashboard && selectedDashboard.pages.length > 0 && (
                  <label className="flex items-center gap-2 mb-1.5 cursor-pointer">
                    <input type="radio" checked={pageMode === "existing"} onChange={() => setPageMode("existing")} />
                    <select
                      className="input text-xs flex-1"
                      disabled={pageMode !== "existing"}
                      value={pageId}
                      onChange={(e) => {
                        setPageMode("existing");
                        setPageId(e.target.value);
                      }}
                    >
                      {selectedDashboard.pages.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={pageMode === "new"} onChange={() => setPageMode("new")} />
                  <input
                    className="input text-xs flex-1"
                    placeholder="New page name"
                    maxLength={80}
                    value={newPageName}
                    onFocus={() => setPageMode("new")}
                    onChange={(e) => {
                      setPageMode("new");
                      setNewPageName(e.target.value);
                    }}
                  />
                </label>
              </div>
              {result && (
                <div className={`mb-2 text-[11px] ${result.ok ? "text-accent" : "text-red-500"}`}>{result.message}</div>
              )}
              <button
                type="button"
                className="btn-primary text-xs w-full"
                disabled={busy || !selectedDashboard || (pageMode === "new" && !newPageName.trim())}
                onClick={push}
              >
                {busy ? "Adding…" : "Add"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

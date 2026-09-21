import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, chatApi, conversationApi, datasourceApi, ConversationSummary, DatasetVersion, DataSourceSummary } from "../api/client";
import TopNav from "../components/TopNav";
import ChatPanel, { ChatTurn, CustomizeSeed, ORIGINAL_SOURCE_ID } from "../components/ChatPanel";
import { isMultiSheetExcel } from "../components/DataSourceForm";
import GokuChat from "../components/GokuChat";
import ChartCanvas from "../components/ChartCanvas";
import ConversationRow from "../components/ConversationRow";
import ChartStylePanel from "../components/ChartStylePanel";
import DataTable from "../components/DataTable";
import StepFlow, { WorkflowStep } from "../components/StepFlow";
import { applyChartStyle, defaultChartStyle, ChartStyle } from "../lib/chartStyle";

// One tab in the chart history strip. Every question (or corrected answer)
// that produces a chart gets its own entry here instead of overwriting
// whatever was on screen before - each keeps its own independent styling,
// so opening the Style panel on one tab never touches any other tab's
// chart. `messageId` is what lets a "Double-check this" correction find
// and update the SAME tab in place rather than creating a duplicate.
type ChartEntry = {
  id: string;
  spec: any;
  style: ChartStyle;
  title: string;
  label: string;
  messageId?: string | null;
};

const makeChartId = () => {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    // Fall through to the manual id below.
  }
  return `chart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

// A short, readable tab label derived from the question that produced the
// chart - trimmed so a long prompt does not blow out the tab strip. The
// person can always overwrite this with their own name via the rename icon.
const shortChartLabel = (text: string | null | undefined) => {
  const t = (text || "").trim().replace(/\s+/g, " ");
  if (!t) return "Chart";
  return t.length > 28 ? `${t.slice(0, 28)}…` : t;
};

export default function Workspace() {
  const { datasourceId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const resumeConversationId = searchParams.get("conversation");

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);

  // The full chart history for this session - every new question appends a
  // new tab here rather than replacing what is already on screen, exactly
  // like the Data tab's saved-table tabs never replace each other either.
  const [charts, setCharts] = useState<ChartEntry[]>([]);
  const [activeChartId, setActiveChartId] = useState<string | null>(null);
  const [renamingChartId, setRenamingChartId] = useState<string | null>(null);
  const [renameChartDraft, setRenameChartDraft] = useState("");

  const [lastInsight, setLastInsight] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dsName, setDsName] = useState("");
  // The full record for this datasource - kind + schema_cache, used to
  // detect a multi-sheet Excel workbook (see the sourceIds-defaulting
  // effect below and the ChatPanel props) - and every OTHER data source
  // this person has connected, for the chat panel's "+ Add more data"
  // picker. Both come from the same /datasources list fetch below.
  const [dsInfo, setDsInfo] = useState<DataSourceSummary | null>(null);
  const [allDataSources, setAllDataSources] = useState<DataSourceSummary[]>([]);
  const otherDataSources = useMemo(
    () => allDataSources.filter((d) => d.id !== datasourceId),
    [allDataSources, datasourceId]
  );
  const [saveMsg, setSaveMsg] = useState("");

  // Inline rename of the data source itself - the "Analyzing: <name>"
  // header, right next to the pencil icon. Mirrors the same
  // rename-icon/draft-input pattern already used for chart tabs and saved
  // table tabs below, so it feels like the same app rather than a
  // bolted-on feature.
  const [renamingDs, setRenamingDs] = useState(false);
  const [dsNameDraft, setDsNameDraft] = useState("");
  const [savingDsName, setSavingDsName] = useState(false);
  const [dsRenameFailed, setDsRenameFailed] = useState(false);

  // This data source's own recent conversations - replaces the old
  // "Ideas" panel, which kept repeating the same generic suggestions
  // regardless of what was actually being analyzed. Scoped to just this
  // data source (not every conversation the person has ever had) so it is
  // always relevant to what is on screen right now.
  const [recentConversations, setRecentConversations] = useState<ConversationSummary[]>([]);

  // Which saved tables were actually built during THIS visit to the
  // workspace, as opposed to ones that already existed from an earlier
  // session. A brand-new "Start new analysis" should not look like it is
  // already mid-way through old work just because earlier tables still
  // exist for this data source - they are not deleted, just not the first
  // thing shown; see `visibleVersions` and the reset effect below.
  const [sessionVersionIds, setSessionVersionIds] = useState<string[]>([]);
  const [olderVersionsRevealed, setOlderVersionsRevealed] = useState(!!resumeConversationId);

  const [centerTab, setCenterTab] = useState<"data" | "chart">("data");
  const [dataRefreshKey, setDataRefreshKey] = useState(0);
  const [guidedMode, setGuidedMode] = useState(true);
  const [activeStep, setActiveStep] = useState<WorkflowStep>("clean");
  const [resuming, setResuming] = useState(!!resumeConversationId);
  const [styleOpen, setStyleOpen] = useState(false);
  const [customizeSeed, setCustomizeSeed] = useState<CustomizeSeed | null>(null);
  const [verifyingIndex, setVerifyingIndex] = useState<number | null>(null);

  // The saved/named tables for this data source (created by cleaning/prep
  // prompts). `activeVersionId` is which single one - or the original data
  // (null) - the Data tab is currently showing. `sourceIds` is what the
  // NEXT chat prompt will run against, which can be one or several tables
  // at once (each id is either ORIGINAL_SOURCE_ID or a DatasetVersion.id).
  // Clicking a data tab points both at that one table by default; the
  // WORKING ON picker in the chat panel can then widen the selection for a
  // single prompt without changing which tab is on screen.
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);
  const [sourceIds, setSourceIds] = useState<string[]>([ORIGINAL_SOURCE_ID]);
  const versionsInitRef = useRef<string | null>(null);

  // How much control the person wants over an analysis question that needs
  // its own data-preparation step first (see ai_engine._run_analyze_with_prep):
  // "auto" explains the preparation and shows the result in one smooth
  // answer; "guided" pauses right after preparation with a "Continue" button
  // so they can see and confirm the prepared table first. Remembered per
  // data source (a per-viewer convenience only, never anything the server
  // needs to read back), so it does not reset every time they open this
  // data source again.
  const [analysisMode, setAnalysisModeState] = useState<"auto" | "guided">("auto");
  useEffect(() => {
    if (!datasourceId) return;
    try {
      const saved = localStorage.getItem(`gd360-analysis-mode-${datasourceId}`);
      if (saved === "auto" || saved === "guided") setAnalysisModeState(saved);
    } catch {
      // Private browsing / blocked storage - just keep the "auto" default.
    }
  }, [datasourceId]);
  const setAnalysisMode = (mode: "auto" | "guided") => {
    setAnalysisModeState(mode);
    try {
      if (datasourceId) localStorage.setItem(`gd360-analysis-mode-${datasourceId}`, mode);
    } catch {
      // Nothing to do - the choice just will not be remembered next time.
    }
  };

  const activeChart = charts.find((c) => c.id === activeChartId) || null;
  const chartSpec = activeChart?.spec ?? null;
  const chartStyle = activeChart?.style ?? defaultChartStyle();
  const chartTitle = activeChart?.title ?? "";

  const displaySpec = useMemo(
    () => (chartSpec ? applyChartStyle(chartSpec, chartStyle, chartTitle) : null),
    [chartSpec, chartStyle, chartTitle]
  );

  // Every style/chart-type edit from the Style panel touches only the
  // currently active tab's own style - every other tab's chart is
  // completely unaffected, exactly as asked.
  const updateStyle = (next: Partial<ChartStyle>) => {
    if (!activeChartId) return;
    setCharts((cs) => cs.map((c) => (c.id === activeChartId ? { ...c, style: { ...c.style, ...next } } : c)));
  };

  const resetActiveChartStyle = () => {
    if (!activeChartId) return;
    setCharts((cs) => cs.map((c) => (c.id === activeChartId ? { ...c, style: defaultChartStyle(c.spec) } : c)));
  };

  const startRenameChart = (c: ChartEntry) => {
    setRenamingChartId(c.id);
    setRenameChartDraft(c.label);
  };

  const commitRenameChart = (c: ChartEntry) => {
    const label = renameChartDraft.trim();
    setRenamingChartId(null);
    if (!label || label === c.label) return;
    setCharts((cs) => cs.map((x) => (x.id === c.id ? { ...x, label } : x)));
  };

  // Closing a tab only removes it from this view - it never deletes or
  // touches any other chart, and nothing is deleted on the server, so if
  // this same conversation is reopened later from Recent conversations,
  // every answer that had a chart is rebuilt into its own tab again (see
  // the resume effect below).
  const closeChart = (id: string) => {
    setCharts((cs) => {
      const idx = cs.findIndex((c) => c.id === id);
      const next = cs.filter((c) => c.id !== id);
      if (activeChartId === id) {
        const fallback = next[idx] || next[idx - 1] || null;
        setActiveChartId(fallback ? fallback.id : null);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!styleOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setStyleOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [styleOpen]);

  useEffect(() => {
    api.get("/datasources").then(({ data }) => {
      setAllDataSources(data);
      const ds = data.find((d: any) => d.id === datasourceId);
      if (ds) {
        setDsName(ds.name);
        setDsInfo(ds);
      }
    });
  }, [datasourceId]);

  // A brand-new "Original data" pick (the untouched default this page
  // starts on, and what "+ New" resets back to) means something different
  // once a datasource turns out to be a multi-sheet Excel workbook: there
  // is no longer one single "original data" table, so it defaults instead
  // to that workbook's first sheet - explicitly, the same way the WORKING
  // ON picker now shows one checkbox per sheet rather than a single
  // "Original data" row for a workbook like this. Only ever corrects the
  // untouched auto-picked default (never an explicit pick - a resumed
  // conversation's saved table, or anything the person has chosen in
  // WORKING ON already), and is a no-op the moment it has already run once
  // for the current selection.
  useEffect(() => {
    if (!dsInfo || dsInfo.id !== datasourceId) return;
    if (!isMultiSheetExcel(dsInfo.kind, dsInfo.schema_cache)) return;
    if (sourceIds.length !== 1 || sourceIds[0] !== ORIGINAL_SOURCE_ID) return;
    const firstSheet = Object.keys(dsInfo.schema_cache || {})[0];
    if (firstSheet) setSourceIds([`sheet:${firstSheet}`]);
  }, [dsInfo, datasourceId, sourceIds]);

  const startRenameDs = () => {
    setDsNameDraft(dsName);
    setDsRenameFailed(false);
    setRenamingDs(true);
  };

  const commitRenameDs = async () => {
    const name = dsNameDraft.trim();
    setRenamingDs(false);
    if (!datasourceId || !name || name === dsName) return;
    setSavingDsName(true);
    setDsRenameFailed(false);
    try {
      const updated = await datasourceApi.rename(datasourceId, name);
      setDsName(updated.name);
    } catch {
      setDsRenameFailed(true);
    } finally {
      setSavingDsName(false);
    }
  };

  // A new data source, or switching which conversation (if any) is being
  // resumed, is a genuinely new session - every bit of state carried over
  // from whatever was on screen a moment ago needs to start clean, exactly
  // once for that new (datasourceId, resumeConversationId) pair. This
  // covers a real full-page navigation here (Workspace unmounts and
  // remounts, which resets everything on its own anyway), and also an
  // in-place switch that keeps this same page mounted - clicking a
  // different "Recent conversation" below, or "+ New" next to it, both of
  // which change only the `conversation` query param without ever leaving
  // this route. Without this, that second case would leave old turns,
  // chart tabs and the saved-table tab selection on screen from whichever
  // conversation was open before.
  const sessionKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${datasourceId || ""}|${resumeConversationId || ""}`;
    if (sessionKeyRef.current === key) return;
    sessionKeyRef.current = key;
    setTurns([]);
    setConversationId(null);
    setCharts([]);
    setActiveChartId(null);
    setRenamingChartId(null);
    setLastInsight(null);
    setCenterTab("data");
    setError("");
    setSaveMsg("");
    setSessionVersionIds([]);
    setOlderVersionsRevealed(!!resumeConversationId);
    setGuidedMode(!resumeConversationId);
    // Forces the versions-loading effect below to re-pick a starting tab
    // for this "new" session instead of leaving whatever was active before.
    versionsInitRef.current = null;
  }, [datasourceId, resumeConversationId]);

  // This data source's own recent conversations, newest first - refetched
  // whenever the data source changes, and again once a brand new
  // conversation is actually created (conversationId flips from null to a
  // real id) so it shows up here right away rather than only after a
  // manual refresh.
  useEffect(() => {
    if (!datasourceId) return;
    conversationApi
      .list()
      .then((all) => setRecentConversations(all.filter((c) => c.datasource_id === datasourceId)))
      .catch(() => {});
  }, [datasourceId, conversationId]);

  const renameRecentConversation = (id: string, title: string) => {
    setRecentConversations((cs) => cs.map((c) => (c.id === id ? { ...c, title } : c)));
  };

  const pinRecentConversation = (id: string, pinned: boolean) => {
    setRecentConversations((cs) => {
      const next = cs.map((c) => (c.id === id ? { ...c, pinned } : c));
      next.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      next.sort((a, b) => Number(b.pinned) - Number(a.pinned));
      return next;
    });
  };

  // Deleting the conversation currently open on screen leaves nothing left
  // to show - land back on a fresh chat for this same data source, exactly
  // like clicking "+ New" above this list already does, rather than
  // showing a now-broken resumed session.
  const deleteRecentConversation = (id: string) => {
    setRecentConversations((cs) => cs.filter((c) => c.id !== id));
    if (id === resumeConversationId && datasourceId) {
      navigate(`/workspace/${datasourceId}`);
    }
  };

  // What the saved-table tab strip (and the chat's WORKING ON picker)
  // actually shows: every table on a resumed conversation (its full real
  // history), but only the ones built during this visit on a fresh start -
  // "Show N earlier tables" below reveals the rest without hiding anything
  // permanently or deleting it.
  const visibleVersions = useMemo(
    () => (olderVersionsRevealed ? versions : versions.filter((v) => sessionVersionIds.includes(v.id))),
    [versions, olderVersionsRevealed, sessionVersionIds]
  );
  const hiddenVersionsCount = versions.length - visibleVersions.length;

  // Loads the list of saved tables for this data source. The very first
  // time this runs for a given data source, it also picks a starting tab.
  // Resuming one specific past conversation from Recent conversations still
  // lands on whichever table was most recently built there, exactly as
  // before. A FRESH open (clicking straight into this data source, not via
  // Recent conversations) always starts clean on the original data instead
  // - the earlier tables are not hidden, they are still listed as tabs
  // above, just not auto-selected, so the workspace never looks like it is
  // already mid-way through an old session the moment it opens. After this
  // first pick, only an explicit tab click or a new cleaning result changes
  // which one is active.
  useEffect(() => {
    if (!datasourceId) return;
    datasourceApi
      .listVersions(datasourceId)
      .then((vs) => {
        setVersions(vs);
        if (versionsInitRef.current !== datasourceId) {
          versionsInitRef.current = datasourceId;
          const startId = resumeConversationId && vs.length ? vs[vs.length - 1].id : null;
          setActiveVersionId(startId);
          setSourceIds([startId ?? ORIGINAL_SOURCE_ID]);
        }
      })
      .catch(() => {});
  }, [datasourceId, dataRefreshKey, resumeConversationId]);

  // Restore a prior chat session in full - messages, the FULL chart
  // history (one tab per answer that had a chart, not just the last one),
  // last insight and suggestions - so clicking a "Recent conversation" from
  // the home page drops the person back exactly where they left off,
  // including every chart tab they had open.
  useEffect(() => {
    if (!resumeConversationId) {
      setResuming(false);
      return;
    }
    setResuming(true);
    conversationApi
      .getMessages(resumeConversationId)
      .then((data) => {
        setConversationId(data.id);
        setGuidedMode(false);

        const restored: ChatTurn[] = data.messages.map((m) => ({
          role: m.role === "user" ? "user" : "assistant",
          content: m.content,
          insight: m.insight,
          needsClarification: m.needs_clarification,
          action: (m.action as ChatTurn["action"]) || undefined,
          followUp: m.suggestions?.follow_up || null,
          messageId: m.id,
        }));
        setTurns(restored);

        const restoredCharts: ChartEntry[] = [];
        for (let i = 0; i < data.messages.length; i++) {
          const m = data.messages[i];
          if (m.role !== "assistant" || !m.chart_spec) continue;
          // The nearest preceding user turn is the question this chart
          // answers - used as its title and default tab label, the same
          // text a live turn's prompt would have used.
          let promptText = "";
          for (let j = i - 1; j >= 0; j--) {
            if (data.messages[j].role === "user") {
              promptText = data.messages[j].content;
              break;
            }
          }
          restoredCharts.push({
            id: m.id || makeChartId(),
            spec: m.chart_spec,
            style: defaultChartStyle(m.chart_spec),
            title: promptText,
            label: shortChartLabel(promptText),
            messageId: m.id,
          });
        }
        if (restoredCharts.length) {
          setCharts(restoredCharts);
          setActiveChartId(restoredCharts[restoredCharts.length - 1].id);
          setCenterTab("chart");
        }

        const lastWithInsight = [...data.messages].reverse().find((m) => m.insight);
        if (lastWithInsight?.insight) setLastInsight(lastWithInsight.insight);
      })
      .catch(() => setError("Could not load that conversation. Starting a new one instead."))
      .finally(() => setResuming(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeConversationId]);

  // Returns true on a genuinely successful run, false on failure - so a
  // caller that needs to know whether it is safe to move on (for example
  // Goku, which only follows up with a "Done - next step" message once the
  // main chat has actually finished) can await this instead of firing it
  // and hoping for the best.
  const runPrompt = async (
    prompt: string,
    chartOverride?: any,
    opts?: {
      // The follow-up call that continues a paused, step-by-step turn:
      // tells the backend this exact table was already prepared for this
      // exact question, so it analyzes it directly instead of preparing it
      // again (which would otherwise create a second, redundant version).
      skipPrep?: boolean;
      // Run this one call against a specific table (the one just prepared)
      // instead of whatever WORKING ON currently has selected - without
      // changing that selection for anything asked afterward.
      forceSourceIds?: string[];
    }
  ): Promise<boolean> => {
    setError("");
    setBusy(true);
    const requestSourceIds = opts?.forceSourceIds?.length
      ? opts.forceSourceIds
      : sourceIds.length ? sourceIds : [ORIGINAL_SOURCE_ID];
    const priorActiveVersionId = activeVersionId;
    setTurns((t) => [...t, { role: "user", content: prompt }]);
    try {
      const { data } = await api.post("/chat", {
        conversation_id: conversationId,
        datasource_id: datasourceId,
        prompt,
        chart_override: chartOverride,
        intent: guidedMode ? activeStep : null,
        source_version_ids: requestSourceIds,
        analysis_mode: analysisMode,
        skip_prep: !!opts?.skipPrep,
      });
      setConversationId(data.conversation_id);
      setTurns((t) => [...t, {
        role: "assistant",
        content: data.reply_text,
        insight: data.insight,
        needsClarification: data.needs_clarification,
        action: data.action,
        rowsBefore: data.rows_before,
        rowsAfter: data.rows_after,
        nullsBefore: data.nulls_before,
        nullsAfter: data.nulls_after,
        sourceIds: requestSourceIds,
        priorActiveVersionId,
        newVersionId: data.new_version_id || null,
        continueAction: data.continue_action || null,
        followUp: data.follow_up_suggestions || null,
        messageId: data.message_id,
      }]);

      if (data.action === "transform") {
        setDataRefreshKey((k) => k + 1);
        // A cleaning/prep prompt creates its own new table - switch to it,
        // and to it alone, so the person immediately sees the result it
        // just built and the next prompt starts fresh from that table.
        if (data.new_version_id) {
          setActiveVersionId(data.new_version_id);
          setSourceIds([data.new_version_id]);
          setSessionVersionIds((ids) => [...ids, data.new_version_id]);
        }
        setCenterTab("data");
      }
      if (data.chart_spec) {
        // An analyze answer now often builds its OWN small prepared table
        // first (see ai_engine._run_analyze_with_prep) - it shows up as a
        // new version in the Data tab for transparency, but - unlike a
        // "clean this data" transform - it is scoped to this one question
        // (often just the few columns it needed), so it deliberately does
        // NOT become the active working table for whatever gets asked
        // next; that stays whatever it already was.
        if (data.action === "analyze" && data.new_version_id) {
          setDataRefreshKey((k) => k + 1);
          setSessionVersionIds((ids) => [...ids, data.new_version_id]);
        }
        if (chartOverride && activeChartId) {
          // A chart-type/style redraw from the Style panel re-sends the
          // same question - it updates THIS chart's own tab in place and
          // keeps the current styling (colors, title, labels) intact,
          // rather than opening a new tab or touching any other chart.
          setCharts((cs) => cs.map((c) => (c.id === activeChartId ? { ...c, spec: data.chart_spec } : c)));
        } else {
          // A brand new question always opens its own new tab - it never
          // replaces whatever chart is already on screen, so switching
          // back to an earlier tab always shows exactly what it showed
          // before.
          const id = makeChartId();
          setCharts((cs) => [...cs, {
            id,
            spec: data.chart_spec,
            style: defaultChartStyle(data.chart_spec),
            title: prompt,
            label: shortChartLabel(prompt),
            messageId: data.message_id,
          }]);
          setActiveChartId(id);
        }
        setCenterTab("chart");
      }
      // Step-by-step mode stops right after preparation - land on the Data
      // tab so the person sees the prepared table (and the Continue button
      // in the chat) instead of the small before/after chart it also
      // carries.
      if (data.continue_action) {
        setCenterTab("data");
      }

      if (data.insight) setLastInsight(data.insight);
      return true;
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Something went wrong. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const applyChartOverride = (override: { chart_type?: string; title?: string }) => {
    const lastUserPrompt = [...turns].reverse().find((t) => t.role === "user")?.content || "Update the chart";
    runPrompt(lastUserPrompt, override);
  };

  const markTurnResolved = (index: number) => {
    setTurns((ts) => ts.map((t, i) => (i === index ? { ...t, resolved: true } : t)));
  };

  // Data-cleaning prompts already run and save immediately, so "Approve"
  // is simply the person confirming they are happy with it - no extra
  // backend call needed, it just dismisses the action row.
  const approveTransform = (index: number) => {
    markTurnResolved(index);
  };

  // "Reject" deletes the table that prompt just created and restores
  // exactly what was active/selected before it ran - whichever tab was
  // showing, and whichever table(s) were chosen in WORKING ON - so undoing
  // a step never touches anything else.
  const rejectTransform = async (index: number) => {
    const t = turns[index];
    if (!datasourceId || !t?.newVersionId) {
      markTurnResolved(index);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await datasourceApi.deleteVersion(datasourceId, t.newVersionId);
      markTurnResolved(index);
      setActiveVersionId(t.priorActiveVersionId ?? null);
      setSourceIds(t.sourceIds && t.sourceIds.length ? t.sourceIds : [ORIGINAL_SOURCE_ID]);
      setTurns((ts) => [...ts, { role: "assistant", content: "Done, that table has been removed." }]);
      setDataRefreshKey((k) => k + 1);
      setCenterTab("data");
    } catch {
      setError("Could not undo that. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  // "Continue -> run the analysis": the button on a paused, step-by-step
  // preparation turn. Re-sends the same original question, but pinned to
  // the table that was just prepared and saved, and flagged skip_prep so
  // the AI analyzes it directly instead of preparing it a second time.
  const continueAnalysis = async (index: number) => {
    const t = turns[index];
    if (!t?.continueAction || busy) return;
    setTurns((ts) => ts.map((turn, i) => (i === index ? { ...turn, continuedInto: true } : turn)));
    const ok = await runPrompt(t.continueAction.prompt, undefined, {
      skipPrep: true,
      forceSourceIds: [t.continueAction.version_id],
    });
    if (!ok) {
      // Let them try the button again rather than leaving it silently gone.
      setTurns((ts) => ts.map((turn, i) => (i === index ? { ...turn, continuedInto: false } : turn)));
    }
  };

  // "Customize further" leaves the current result in place and lets the
  // person type additional instructions, which run as a normal follow-up
  // prompt and build on top of the data as it stands right now.
  const customizeTransform = () => {
    setCustomizeSeed({ text: "Also, ", nonce: Date.now() });
  };

  // "Double-check this": re-verifies a previously computed answer on
  // demand rather than asking the person to just trust the first pass -
  // re-runs the exact code, then has a fresh AI review pass check it
  // against the real recomputed numbers, and corrects it in place if it
  // finds a genuine problem. See routers/chat.py verify_message.
  const verifyTurn = async (index: number) => {
    const t = turns[index];
    if (!t?.messageId || verifyingIndex != null) return;
    setVerifyingIndex(index);
    setError("");
    try {
      const data = await chatApi.verify(t.messageId, t.sourceIds && t.sourceIds.length ? t.sourceIds : sourceIds);
      setTurns((ts) => ts.map((turn, i) => {
        if (i !== index) return turn;
        if (data.status === "corrected") {
          return {
            ...turn,
            content: data.reply_text || turn.content,
            insight: data.insight ?? turn.insight,
            newVersionId: data.new_version_id || turn.newVersionId,
            resolved: turn.action === "transform" && data.new_version_id ? false : turn.resolved,
            verifyStatus: "corrected",
            verifyMessage: data.message,
          };
        }
        return { ...turn, verifyStatus: data.status, verifyMessage: data.message };
      }));

      if (data.status === "corrected") {
        if (data.chart_spec) {
          // Update the SAME chart tab this message originally produced,
          // matched by message id, rather than opening a duplicate tab or
          // touching any other chart. If it somehow is not tracked yet
          // (for example a conversation resumed before this feature
          // existed), add it as its own new tab instead of dropping it.
          setCharts((cs) => {
            const idx = cs.findIndex((c) => c.messageId === t.messageId);
            if (idx === -1) {
              const id = makeChartId();
              const label = shortChartLabel(t.content || "Corrected chart");
              setActiveChartId(id);
              return [...cs, {
                id,
                spec: data.chart_spec,
                style: defaultChartStyle(data.chart_spec),
                title: t.content || "Corrected chart",
                label,
                messageId: t.messageId,
              }];
            }
            const next = [...cs];
            next[idx] = { ...next[idx], spec: data.chart_spec, style: defaultChartStyle(data.chart_spec) };
            setActiveChartId(next[idx].id);
            return next;
          });
          setCenterTab(t.action === "transform" ? "data" : "chart");
        }
        if (data.insight) setLastInsight(data.insight);
        if (data.new_version_id) {
          setDataRefreshKey((k) => k + 1);
          setActiveVersionId(data.new_version_id);
          setSourceIds([data.new_version_id]);
          setSessionVersionIds((ids) => [...ids, data.new_version_id]);
        }
      }
    } catch (err: any) {
      setTurns((ts) => ts.map((turn, i) => (i === index ? {
        ...turn,
        verifyStatus: "unavailable",
        verifyMessage: err?.response?.data?.detail || "Could not verify this right now. Please try again.",
      } : turn)));
    } finally {
      setVerifyingIndex(null);
    }
  };

  const saveChart = async () => {
    if (!displaySpec) return;
    setSaveMsg("");
    try {
      await api.post("/dashboards/save-chart", {
        title: chartStyle.title || chartTitle || "Untitled chart",
        chart_spec: displaySpec,
        insight: lastInsight,
        dashboard_name: `${dsName || "My"} dashboard`,
      });
      setSaveMsg("Saved to dashboard, styling included");
    } catch {
      setSaveMsg("Could not save chart.");
    }
  };

  return (
    // min-h-screen (not a hard h-screen) below lg lets the page grow to fit
    // its real content and scroll normally on a phone - only at lg+ does
    // this lock to the exact viewport height for the fixed, non-scrolling
    // 3-pane desktop layout below. Without this, the 3 stacked panels'
    // combined minimum heights on mobile exceeded what a fixed-height,
    // overflow-hidden page had room for, and the bottom of the layout
    // (typically the Recent conversations panel) was simply clipped
    // off-screen with no way to scroll down to it.
    <div className="min-h-screen lg:h-screen flex flex-col">
      <TopNav />
      <div className="px-4 sm:px-6 py-3 border-b border-border flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted flex items-center gap-1.5 min-w-0">
          <span className="shrink-0">Analyzing:</span>
          {renamingDs ? (
            <input
              autoFocus
              className="input py-1 text-sm font-medium max-w-xs"
              value={dsNameDraft}
              onChange={(e) => setDsNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRenameDs();
                if (e.key === "Escape") setRenamingDs(false);
              }}
              onBlur={commitRenameDs}
              maxLength={120}
            />
          ) : (
            <span className="flex items-center gap-1 min-w-0">
              <span className="text-text font-medium truncate">{dsName}</span>
              <button
                type="button"
                className="opacity-60 hover:opacity-100 transition shrink-0"
                title="Rename this data source"
                onClick={startRenameDs}
              >
                &#9998;
              </button>
            </span>
          )}
          {savingDsName && <span className="text-xs text-accent shrink-0">Saving&hellip;</span>}
          {dsRenameFailed && <span className="text-xs text-red-400 shrink-0">Could not rename</span>}
          {resuming && <span className="ml-2 text-xs text-accent shrink-0">Loading conversation...</span>}
        </div>
        {chartSpec && centerTab === "chart" && (
          <div className="flex items-center gap-3">
            {saveMsg && <span className="text-xs text-accent">{saveMsg}</span>}
            <button className="btn-secondary text-sm" onClick={saveChart}>Save chart to dashboard</button>
          </div>
        )}
      </div>

      {error && <div className="mx-4 sm:mx-6 mt-3 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}

      <div className="px-4 pt-4">
        <StepFlow
          activeStep={activeStep}
          onStepChange={setActiveStep}
          guided={guidedMode}
          onToggleGuided={() => setGuidedMode((g) => !g)}
          onSend={(prompt) => runPrompt(prompt)}
          busy={busy}
        />
      </div>

      {/* overflow-visible below lg lets these 3 panels take their natural,
          possibly-tall content height and the page scroll to reach all of
          them; lg:overflow-hidden restores the original fixed, internally-
          scrolling 3-pane desktop behavior unchanged. */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[380px_1fr_340px] gap-4 px-4 pb-4 overflow-visible lg:overflow-hidden">
        <div className="min-h-[400px] lg:min-h-0">
          <ChatPanel
            turns={turns}
            onSend={(p) => runPrompt(p)}
            busy={busy}
            onApproveTransform={approveTransform}
            onRejectTransform={rejectTransform}
            onCustomizeTransform={customizeTransform}
            onContinueAnalysis={continueAnalysis}
            customizeSeed={customizeSeed}
            versions={visibleVersions}
            sourceIds={sourceIds}
            onSourceIdsChange={setSourceIds}
            onVerify={verifyTurn}
            verifyingIndex={verifyingIndex}
            analysisMode={analysisMode}
            onAnalysisModeChange={setAnalysisMode}
            datasourceKind={dsInfo?.kind}
            datasourceSchema={dsInfo?.schema_cache}
            otherDataSources={otherDataSources}
          />
        </div>
        <div className="min-h-[400px] flex flex-col gap-4 overflow-visible lg:overflow-hidden">
          <div className="flex items-center justify-between gap-1.5 shrink-0">
            <div className="flex gap-1.5">
              <button
                className={`text-sm px-4 py-2 rounded-lg font-medium transition ${centerTab === "data" ? "bg-primary text-white" : "btn-secondary"}`}
                onClick={() => setCenterTab("data")}
              >
                Data
              </button>
              <button
                className={`text-sm px-4 py-2 rounded-lg font-medium transition ${centerTab === "chart" ? "bg-primary text-white" : "btn-secondary"}`}
                onClick={() => setCenterTab("chart")}
              >
                Chart
              </button>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              {centerTab === "data" && hiddenVersionsCount > 0 && (
                <button
                  className="text-xs text-accent underline shrink-0"
                  onClick={() => setOlderVersionsRevealed(true)}
                >
                  Show {hiddenVersionsCount} earlier table{hiddenVersionsCount === 1 ? "" : "s"}
                </button>
              )}
              <button
                className="text-sm px-4 py-2 rounded-lg font-medium btn-secondary flex items-center gap-1.5"
                onClick={() => setStyleOpen(true)}
              >
                <span aria-hidden>🎨</span> Style
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-[350px] overflow-visible lg:overflow-hidden">
            {centerTab === "data" && datasourceId ? (
              <DataTable
                datasourceId={datasourceId}
                refreshKey={dataRefreshKey}
                versions={visibleVersions}
                activeVersionId={activeVersionId}
                onActiveVersionChange={(id) => {
                  // Clicking a tab points the next chat prompt at that one
                  // table by default; WORKING ON can still widen the
                  // selection afterward without changing which tab shows.
                  setActiveVersionId(id);
                  setSourceIds([id ?? ORIGINAL_SOURCE_ID]);
                }}
                onVersionsChanged={() => setDataRefreshKey((k) => k + 1)}
              />
            ) : (
              <div className="h-full flex flex-col gap-2 overflow-hidden">
                {charts.length > 0 && (
                  <div className="flex items-center gap-1.5 overflow-x-auto shrink-0 pb-0.5">
                    {charts.map((c) => (
                      <div
                        key={c.id}
                        className={`flex items-center gap-1 rounded-lg pl-3 pr-1.5 py-1.5 text-xs font-medium shrink-0 transition ${
                          activeChartId === c.id ? "bg-primary text-white" : "btn-secondary"
                        }`}
                      >
                        {renamingChartId === c.id ? (
                          <input
                            autoFocus
                            className="bg-transparent border-b border-current outline-none w-24 text-xs"
                            value={renameChartDraft}
                            onChange={(e) => setRenameChartDraft(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitRenameChart(c);
                              if (e.key === "Escape") setRenamingChartId(null);
                            }}
                            onBlur={() => commitRenameChart(c)}
                          />
                        ) : (
                          <span
                            className="cursor-pointer whitespace-nowrap"
                            onClick={() => setActiveChartId(c.id)}
                            title={c.title}
                          >
                            {c.label}
                          </span>
                        )}
                        <button
                          className="opacity-70 hover:opacity-100 px-0.5"
                          title="Rename this chart"
                          onClick={() => startRenameChart(c)}
                        >
                          &#9998;
                        </button>
                        <button
                          className="opacity-70 hover:opacity-100 px-0.5"
                          title="Close this chart tab"
                          onClick={() => closeChart(c.id)}
                        >
                          &times;
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex-1 min-h-0">
                  <ChartCanvas chartSpec={displaySpec} title={chartStyle.title || chartTitle} />
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="min-h-[200px] flex flex-col gap-3 overflow-visible lg:overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-1 shrink-0">
            <div className="text-sm font-semibold">Recent conversations</div>
            {(resumeConversationId || turns.length > 0) && datasourceId && (
              <button
                type="button"
                className="text-xs text-accent underline"
                onClick={() => navigate(`/workspace/${datasourceId}`)}
              >
                + New
              </button>
            )}
          </div>
          <div className="flex-1 overflow-visible lg:overflow-y-auto space-y-2">
            {recentConversations.length === 0 ? (
              <div className="card p-4 text-xs text-muted leading-relaxed">
                Your conversations about this data source will show up here once you ask GD360 a question.
              </div>
            ) : (
              recentConversations.map((c) => (
                <ConversationRow
                  key={c.id}
                  conversation={c}
                  variant="row"
                  active={c.id === resumeConversationId}
                  trailing={`${c.message_count}`}
                  onOpen={() => {
                    if (c.id !== resumeConversationId) navigate(`/workspace/${datasourceId}?conversation=${c.id}`);
                  }}
                  onRenamed={renameRecentConversation}
                  onPinned={pinRecentConversation}
                  onDeleted={deleteRecentConversation}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {styleOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60"
          onClick={() => setStyleOpen(false)}
        >
          <div
            className="relative w-full sm:w-[420px] max-h-[90vh] sm:max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="absolute top-3 right-3 z-10 text-muted hover:text-text text-xl leading-none w-8 h-8 flex items-center justify-center rounded-full bg-surface2 border border-border"
              onClick={() => setStyleOpen(false)}
            >
              &times;
            </button>
            <div className="flex-1 overflow-y-auto rounded-b-none sm:rounded-2xl">
              <ChartStylePanel
                chartSpec={chartSpec}
                style={chartStyle}
                onStyleChange={updateStyle}
                onChartTypeChange={(type) => applyChartOverride({ chart_type: type })}
                onReset={resetActiveChartStyle}
                disabled={busy || !chartSpec}
              />
            </div>
          </div>
        </div>
      )}

      {datasourceId && (
        <GokuChat
          datasourceId={datasourceId}
          sourceIds={sourceIds}
          busy={busy}
          onRunInMainChat={(prompt) => runPrompt(prompt)}
          analysisMode={analysisMode}
          onAnalysisModeChange={setAnalysisMode}
          startFresh={!resumeConversationId}
        />
      )}
    </div>
  );
}

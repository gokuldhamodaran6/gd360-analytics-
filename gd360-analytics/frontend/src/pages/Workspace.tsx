import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, chatApi, conversationApi, datasourceApi, DatasetVersion } from "../api/client";
import TopNav from "../components/TopNav";
import ChatPanel, { ChatTurn, CustomizeSeed, ORIGINAL_SOURCE_ID } from "../components/ChatPanel";
import GokuChat from "../components/GokuChat";
import ChartCanvas from "../components/ChartCanvas";
import SuggestionsPanel from "../components/SuggestionsPanel";
import ChartStylePanel from "../components/ChartStylePanel";
import DataTable from "../components/DataTable";
import StepFlow, { WorkflowStep } from "../components/StepFlow";
import { applyChartStyle, defaultChartStyle, ChartStyle } from "../lib/chartStyle";

export default function Workspace() {
  const { datasourceId } = useParams();
  const [searchParams] = useSearchParams();
  const resumeConversationId = searchParams.get("conversation");

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [chartSpec, setChartSpec] = useState<any>(null);
  const [chartTitle, setChartTitle] = useState<string>("");
  const [lastInsight, setLastInsight] = useState<string | null>(null);
  const [suggestedCharts, setSuggestedCharts] = useState<any[] | null>(null);
  const [suggestedStats, setSuggestedStats] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dsName, setDsName] = useState("");
  const [saveMsg, setSaveMsg] = useState("");

  const [centerTab, setCenterTab] = useState<"data" | "chart">("data");
  const [dataRefreshKey, setDataRefreshKey] = useState(0);
  const [guidedMode, setGuidedMode] = useState(true);
  const [activeStep, setActiveStep] = useState<WorkflowStep>("clean");
  const [resuming, setResuming] = useState(!!resumeConversationId);
  const [styleOpen, setStyleOpen] = useState(false);
  const [chartStyle, setChartStyle] = useState<ChartStyle>(defaultChartStyle());
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

  const displaySpec = useMemo(
    () => (chartSpec ? applyChartStyle(chartSpec, chartStyle, chartTitle) : null),
    [chartSpec, chartStyle, chartTitle]
  );

  const updateStyle = (next: Partial<ChartStyle>) => setChartStyle((s) => ({ ...s, ...next }));

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
      const ds = data.find((d: any) => d.id === datasourceId);
      if (ds) setDsName(ds.name);
    });
  }, [datasourceId]);

  // Loads the list of saved tables for this data source. The very first
  // time this runs for a given data source, it also picks a starting tab -
  // the most recently created table if one exists, otherwise the original
  // data - the same way the app used to default to showing cleaned data
  // when it existed. After that first pick, only an explicit tab click or
  // a new cleaning result changes which one is active.
  useEffect(() => {
    if (!datasourceId) return;
    datasourceApi
      .listVersions(datasourceId)
      .then((vs) => {
        setVersions(vs);
        if (versionsInitRef.current !== datasourceId) {
          versionsInitRef.current = datasourceId;
          const startId = vs.length ? vs[vs.length - 1].id : null;
          setActiveVersionId(startId);
          setSourceIds([startId ?? ORIGINAL_SOURCE_ID]);
        }
      })
      .catch(() => {});
  }, [datasourceId, dataRefreshKey]);

  // Restore a prior chat session in full - messages, last chart, last
  // insight and suggestions - so clicking a "Recent conversation" from the
  // home page drops the person back exactly where they left off.
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

        for (let i = data.messages.length - 1; i >= 0; i--) {
          const m = data.messages[i];
          if (m.chart_spec) {
            setChartSpec(m.chart_spec);
            setChartStyle(defaultChartStyle(m.chart_spec));
            const lastUserPrompt = [...data.messages].reverse().find((mm) => mm.role === "user")?.content;
            setChartTitle(lastUserPrompt || "");
            setCenterTab("chart");
            break;
          }
        }
        const lastWithInsight = [...data.messages].reverse().find((m) => m.insight);
        if (lastWithInsight?.insight) setLastInsight(lastWithInsight.insight);
        const lastWithSuggestions = [...data.messages].reverse().find((m) => m.suggestions);
        if (lastWithSuggestions?.suggestions) {
          setSuggestedCharts(lastWithSuggestions.suggestions.charts || null);
          setSuggestedStats(lastWithSuggestions.suggestions.stats || null);
        }
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
        }
        setChartSpec(data.chart_spec);
        // A chart-type change from the Style panel keeps the current user
        // styling (colors, title, labels) intact - only a brand new prompt
        // starts from a clean style, since it is effectively a new chart.
        if (!chartOverride) setChartStyle(defaultChartStyle(data.chart_spec));
        setChartTitle(prompt);
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
      if (data.suggested_charts) setSuggestedCharts(data.suggested_charts);
      if (data.suggested_stats) setSuggestedStats(data.suggested_stats);
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
          setChartSpec(data.chart_spec);
          setChartStyle(defaultChartStyle(data.chart_spec));
          setCenterTab(t.action === "transform" ? "data" : "chart");
        }
        if (data.insight) setLastInsight(data.insight);
        if (data.new_version_id) {
          setDataRefreshKey((k) => k + 1);
          setActiveVersionId(data.new_version_id);
          setSourceIds([data.new_version_id]);
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
    <div className="h-screen flex flex-col">
      <TopNav />
      <div className="px-6 py-3 border-b border-border flex items-center justify-between">
        <div className="text-sm text-muted">
          Analyzing: <span className="text-text font-medium">{dsName}</span>
          {resuming && <span className="ml-2 text-xs text-accent">Loading conversation...</span>}
        </div>
        {chartSpec && centerTab === "chart" && (
          <div className="flex items-center gap-3">
            {saveMsg && <span className="text-xs text-accent">{saveMsg}</span>}
            <button className="btn-secondary text-sm" onClick={saveChart}>Save chart to dashboard</button>
          </div>
        )}
      </div>

      {error && <div className="mx-6 mt-3 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}

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

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[380px_1fr_340px] gap-4 px-4 pb-4 overflow-hidden">
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
            versions={versions}
            sourceIds={sourceIds}
            onSourceIdsChange={setSourceIds}
            onVerify={verifyTurn}
            verifyingIndex={verifyingIndex}
            analysisMode={analysisMode}
            onAnalysisModeChange={setAnalysisMode}
          />
        </div>
        <div className="min-h-[400px] flex flex-col gap-4 overflow-hidden">
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
            <button
              className="text-sm px-4 py-2 rounded-lg font-medium btn-secondary flex items-center gap-1.5"
              onClick={() => setStyleOpen(true)}
            >
              <span aria-hidden>🎨</span> Style
            </button>
          </div>
          <div className="flex-1 min-h-[350px] overflow-hidden">
            {centerTab === "data" && datasourceId ? (
              <DataTable
                datasourceId={datasourceId}
                refreshKey={dataRefreshKey}
                versions={versions}
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
              <ChartCanvas chartSpec={displaySpec} title={chartStyle.title || chartTitle} />
            )}
          </div>
        </div>
        <div className="min-h-[200px] flex flex-col gap-3 overflow-hidden">
          <div className="text-sm font-semibold px-1 shrink-0">Ideas</div>
          <div className="flex-1 overflow-y-auto">
            <SuggestionsPanel charts={suggestedCharts} stats={suggestedStats} onPick={(p) => runPrompt(p)} />
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
                onReset={() => setChartStyle(defaultChartStyle(chartSpec))}
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
        />
      )}
    </div>
  );
}

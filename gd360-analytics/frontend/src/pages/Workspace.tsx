import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, conversationApi, datasourceApi, DatasetVersion } from "../api/client";
import TopNav from "../components/TopNav";
import ChatPanel, { ChatTurn, CustomizeSeed } from "../components/ChatPanel";
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
  const [rightTab, setRightTab] = useState<"ideas" | "style">("ideas");
  const [chartStyle, setChartStyle] = useState<ChartStyle>(defaultChartStyle());
  const [customizeSeed, setCustomizeSeed] = useState<CustomizeSeed | null>(null);

  // The saved/named tables for this data source (created by cleaning/prep
  // prompts), plus which one - or the original data (null) - is currently
  // selected. This is shared between the chat panel (which prompt to run
  // next) and the data table (which tab is showing), so they never disagree
  // about which table is "current".
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);
  const versionsInitRef = useRef<string | null>(null);

  const displaySpec = useMemo(
    () => (chartSpec ? applyChartStyle(chartSpec, chartStyle, chartTitle) : null),
    [chartSpec, chartStyle, chartTitle]
  );

  const updateStyle = (next: Partial<ChartStyle>) => setChartStyle((s) => ({ ...s, ...next }));

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
          setActiveVersionId(vs.length ? vs[vs.length - 1].id : null);
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

  const runPrompt = async (prompt: string, chartOverride?: any) => {
    setError("");
    setBusy(true);
    const sourceVersionId = activeVersionId;
    setTurns((t) => [...t, { role: "user", content: prompt }]);
    try {
      const { data } = await api.post("/chat", {
        conversation_id: conversationId,
        datasource_id: datasourceId,
        prompt,
        chart_override: chartOverride,
        intent: guidedMode ? activeStep : null,
        source_version_id: sourceVersionId,
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
        sourceVersionId,
        newVersionId: data.new_version_id || null,
      }]);

      if (data.action === "transform") {
        setDataRefreshKey((k) => k + 1);
        // A cleaning/prep prompt creates its own new table - switch to it
        // so the person immediately sees the result it just built.
        if (data.new_version_id) setActiveVersionId(data.new_version_id);
        setCenterTab("data");
      } else if (data.chart_spec) {
        setChartSpec(data.chart_spec);
        // A chart-type change from the Style panel keeps the current user
        // styling (colors, title, labels) intact - only a brand new prompt
        // starts from a clean style, since it is effectively a new chart.
        if (!chartOverride) setChartStyle(defaultChartStyle(data.chart_spec));
        setChartTitle(prompt);
        setCenterTab("chart");
      }

      if (data.insight) setLastInsight(data.insight);
      if (data.suggested_charts) setSuggestedCharts(data.suggested_charts);
      if (data.suggested_stats) setSuggestedStats(data.suggested_stats);
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Something went wrong. Please try again.");
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

  // "Reject" deletes the table that prompt just created and switches back
  // to exactly whichever table was active before it ran - original data or
  // another saved table - so undoing a step never touches anything else.
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
      setActiveVersionId(t.sourceVersionId ?? null);
      setTurns((ts) => [...ts, { role: "assistant", content: "Done, that table has been removed." }]);
      setDataRefreshKey((k) => k + 1);
      setCenterTab("data");
    } catch {
      setError("Could not undo that. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  // "Customize further" leaves the current result in place and lets the
  // person type additional instructions, which run as a normal follow-up
  // prompt and build on top of the data as it stands right now.
  const customizeTransform = () => {
    setCustomizeSeed({ text: "Also, ", nonce: Date.now() });
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
            customizeSeed={customizeSeed}
            versions={versions}
            activeVersionId={activeVersionId}
            onActiveVersionChange={setActiveVersionId}
          />
        </div>
        <div className="min-h-[400px] flex flex-col gap-4 overflow-hidden">
          <div className="flex gap-1.5 shrink-0">
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
          <div className="flex-1 min-h-[350px] overflow-hidden">
            {centerTab === "data" && datasourceId ? (
              <DataTable
                datasourceId={datasourceId}
                refreshKey={dataRefreshKey}
                versions={versions}
                activeVersionId={activeVersionId}
                onActiveVersionChange={setActiveVersionId}
                onVersionsChanged={() => setDataRefreshKey((k) => k + 1)}
              />
            ) : (
              <ChartCanvas chartSpec={displaySpec} title={chartStyle.title || chartTitle} />
            )}
          </div>
        </div>
        <div className="min-h-[200px] flex flex-col gap-3 overflow-hidden">
          <div className="flex gap-1.5 shrink-0">
            <button
              className={`text-sm px-4 py-2 rounded-lg font-medium transition ${rightTab === "ideas" ? "bg-primary text-white" : "btn-secondary"}`}
              onClick={() => setRightTab("ideas")}
            >
              Ideas
            </button>
            <button
              className={`text-sm px-4 py-2 rounded-lg font-medium transition ${rightTab === "style" ? "bg-primary text-white" : "btn-secondary"}`}
              onClick={() => setRightTab("style")}
            >
              Style
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {rightTab === "ideas" ? (
              <SuggestionsPanel charts={suggestedCharts} stats={suggestedStats} onPick={(p) => runPrompt(p)} />
            ) : (
              <ChartStylePanel
                chartSpec={chartSpec}
                style={chartStyle}
                onStyleChange={updateStyle}
                onChartTypeChange={(type) => applyChartOverride({ chart_type: type })}
                onReset={() => setChartStyle(defaultChartStyle(chartSpec))}
                disabled={busy || !chartSpec}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

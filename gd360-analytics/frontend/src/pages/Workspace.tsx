import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import TopNav from "../components/TopNav";
import ChatPanel, { ChatTurn } from "../components/ChatPanel";
import ChartCanvas from "../components/ChartCanvas";
import ChartCustomizer from "../components/ChartCustomizer";
import SuggestionsPanel from "../components/SuggestionsPanel";
import DataTable from "../components/DataTable";
import StepFlow, { WorkflowStep } from "../components/StepFlow";

export default function Workspace() {
  const { datasourceId } = useParams();
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

  useEffect(() => {
    api.get("/datasources").then(({ data }) => {
      const ds = data.find((d: any) => d.id === datasourceId);
      if (ds) setDsName(ds.name);
    });
  }, [datasourceId]);

  const runPrompt = async (prompt: string, chartOverride?: any) => {
    setError("");
    setBusy(true);
    setTurns((t) => [...t, { role: "user", content: prompt }]);
    try {
      const { data } = await api.post("/chat", {
        conversation_id: conversationId,
        datasource_id: datasourceId,
        prompt,
        chart_override: chartOverride,
        intent: guidedMode ? activeStep : null,
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
      }]);

      if (data.action === "transform") {
        setDataRefreshKey((k) => k + 1);
        setCenterTab("data");
      } else if (data.chart_spec) {
        setChartSpec(data.chart_spec);
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

  const saveChart = async () => {
    if (!chartSpec) return;
    setSaveMsg("");
    try {
      await api.post("/dashboards/save-chart", {
        title: chartTitle || "Untitled chart",
        chart_spec: chartSpec,
        insight: lastInsight,
        dashboard_name: `${dsName || "My"} dashboard`,
      });
      setSaveMsg("Saved to dashboard ✓");
    } catch {
      setSaveMsg("Could not save chart.");
    }
  };

  return (
    <div className="h-screen flex flex-col">
      <TopNav />
      <div className="px-6 py-3 border-b border-border flex items-center justify-between">
        <div className="text-sm text-muted">Analyzing: <span className="text-text font-medium">{dsName}</span></div>
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

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[380px_1fr_300px] gap-4 px-4 pb-4 overflow-hidden">
        <div className="min-h-[400px] lg:min-h-0">
          <ChatPanel turns={turns} onSend={(p) => runPrompt(p)} busy={busy} />
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
              <DataTable datasourceId={datasourceId} refreshKey={dataRefreshKey} onDataChanged={() => setDataRefreshKey((k) => k + 1)} />
            ) : (
              <ChartCanvas chartSpec={chartSpec} title={chartTitle} />
            )}
          </div>
          {centerTab === "chart" && <ChartCustomizer onApply={applyChartOverride} disabled={busy || !chartSpec} />}
        </div>
        <div className="min-h-[200px] overflow-y-auto">
          <SuggestionsPanel charts={suggestedCharts} stats={suggestedStats} onPick={(p) => runPrompt(p)} />
        </div>
      </div>
    </div>
  );
}

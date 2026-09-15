import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import TopNav from "../components/TopNav";
import ChartCanvas from "../components/ChartCanvas";

type SavedChart = { id: string; title: string; chart_spec: any; insight?: string | null };

export default function DashboardView() {
  const { dashboardId } = useParams();
  const [name, setName] = useState("");
  const [charts, setCharts] = useState<SavedChart[]>([]);

  useEffect(() => {
    api.get(`/dashboards/${dashboardId}`).then(({ data }) => {
      setName(data.name);
      setCharts(data.charts);
    });
  }, [dashboardId]);

  return (
    <div>
      <TopNav />
      <div className="max-w-6xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-6">{name}</h1>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {charts.map((c) => (
            <div key={c.id} className="space-y-2">
              <div className="h-[380px]">
                <ChartCanvas chartSpec={c.chart_spec} title={c.title} />
              </div>
              {c.insight && (
                <div className="text-sm bg-accent/10 border border-accent/30 rounded-xl px-4 py-2.5">
                  <span className="font-semibold text-accent">Insight: </span>{c.insight}
                </div>
              )}
            </div>
          ))}
          {charts.length === 0 && <div className="text-muted">No charts saved to this dashboard yet.</div>}
        </div>
      </div>
    </div>
  );
}

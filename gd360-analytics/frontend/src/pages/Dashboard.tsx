import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import TopNav from "../components/TopNav";
import DataSourceForm from "../components/DataSourceForm";

type DataSource = { id: string; name: string; kind: string; created_at: string };
type DashboardSummary = { id: string; name: string; chart_count: number; created_at: string };

const KIND_ICON: Record<string, string> = {
  postgres: "🐘", mysql: "🐬", mongodb: "🍃", csv: "📄", excel: "📊",
};

export default function Dashboard() {
  const navigate = useNavigate();
  const [datasources, setDatasources] = useState<DataSource[]>([]);
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [removeError, setRemoveError] = useState("");

  const load = async () => {
    setLoading(true);
    const [ds, db] = await Promise.all([api.get("/datasources"), api.get("/dashboards")]);
    setDatasources(ds.data);
    setDashboards(db.data);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const removeDatasource = async (id: string) => {
    if (!confirm("Remove this datasource? This does not affect your original database or files.")) return;
    setRemoveError("");
    try {
      await api.delete(`/datasources/${id}`);
      load();
    } catch (err: any) {
      setRemoveError(err?.response?.data?.detail || "Could not remove this data source. Please try again.");
    }
  };

  return (
    <div>
      <TopNav />
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Your data sources</h1>
            <p className="text-muted mt-1">Connect a database or upload a file, then ask GD360 anything about it.</p>
          </div>
          <button className="btn-primary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Close" : "+ Add data source"}
          </button>
        </div>

        {removeError && (
          <div className="mb-6 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{removeError}</div>
        )}

        {showForm && (
          <div className="mb-8">
            <DataSourceForm onCreated={() => { setShowForm(false); load(); }} />
          </div>
        )}

        {!loading && datasources.length === 0 && !showForm && (
          <div className="card p-10 text-center text-muted">
            No data sources yet. Click <span className="text-text font-medium">"+ Add data source"</span> to connect a
            database or upload a spreadsheet and start analyzing.
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
          {datasources.map((ds) => (
            <div key={ds.id} className="card p-5 hover:shadow-glow transition cursor-pointer group" onClick={() => navigate(`/workspace/${ds.id}`)}>
              <div className="flex items-start justify-between">
                <div className="text-3xl mb-3">{KIND_ICON[ds.kind] || "🗂️"}</div>
                <button
                  className="text-muted hover:text-red-400 text-sm opacity-0 group-hover:opacity-100 transition"
                  onClick={(e) => { e.stopPropagation(); removeDatasource(ds.id); }}
                >
                  Remove
                </button>
              </div>
              <div className="font-semibold">{ds.name}</div>
              <div className="text-sm text-muted uppercase tracking-wide mt-1">{ds.kind}</div>
              <div className="text-primary text-sm font-medium mt-4 group-hover:underline">Open analysis workspace →</div>
            </div>
          ))}
        </div>

        {dashboards.length > 0 && (
          <>
            <h2 className="text-xl font-bold mb-4">Saved dashboards</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {dashboards.map((d) => (
                <div key={d.id} className="card p-5 hover:shadow-glow transition cursor-pointer" onClick={() => navigate(`/dashboards/${d.id}`)}>
                  <div className="font-semibold">{d.name}</div>
                  <div className="text-sm text-muted mt-1">{d.chart_count} chart{d.chart_count === 1 ? "" : "s"}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

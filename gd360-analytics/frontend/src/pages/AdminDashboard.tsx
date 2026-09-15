import { useEffect, useState } from "react";
import Plot from "../lib/plotly";
import TopNav from "../components/TopNav";
import { adminApi, AdminStats, AdminUserRow, AdminUsagePoint } from "../api/client";

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="card p-5">
      <div className="text-sm text-muted">{label}</div>
      <div className="text-3xl font-extrabold mt-1">{value}</div>
      {sub && <div className="text-xs text-muted mt-1">{sub}</div>}
    </div>
  );
}

function formatDate(value: string | null): string {
  if (!value) return "Never";
  const d = new Date(value + (value.endsWith("Z") ? "" : "Z"));
  return d.toLocaleString();
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [usage, setUsage] = useState<AdminUsagePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, u, t] = await Promise.all([
          adminApi.getStats(),
          adminApi.getUsers(),
          adminApi.getUsageTimeseries(14),
        ]);
        if (cancelled) return;
        setStats(s);
        setUsers(u);
        setUsage(t);
      } catch (e: any) {
        if (cancelled) return;
        if (e?.response?.status === 403) {
          setError("This dashboard is only visible to the app owner account.");
        } else {
          setError("Could not load admin data right now. Please try again in a moment.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <TopNav />
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Admin dashboard</h1>
          <p className="text-muted mt-1">Your app usage at a glance — signups and AI prompts, owner-only.</p>
        </div>

        {loading && <div className="text-muted">Loading...</div>}

        {error && !loading && (
          <div className="card p-6 text-center text-muted">{error}</div>
        )}

        {!loading && !error && stats && (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
              <StatCard label="Total users" value={stats.total_users} sub={`+${stats.new_users_today} today, +${stats.new_users_7d} this week`} />
              <StatCard label="Total prompts used" value={stats.total_prompts} sub={`${stats.prompts_today} today, ${stats.prompts_7d} this week`} />
              <StatCard label="Data sources connected" value={stats.total_datasources} />
              <StatCard label="Saved dashboards" value={stats.total_dashboards} />
            </div>

            <div className="card p-4 mb-8">
              <div className="font-semibold mb-2">Prompts per day (last 14 days)</div>
              {usage.length === 0 ? (
                <div className="text-muted text-sm py-6 text-center">No AI prompts sent yet.</div>
              ) : (
                <Plot
                  data={[
                    {
                      x: usage.map((p) => p.day),
                      y: usage.map((p) => p.count),
                      type: "bar",
                      marker: { color: "#6366f1" },
                    },
                  ]}
                  layout={{
                    autosize: true,
                    margin: { l: 40, r: 10, t: 10, b: 40 },
                    paper_bgcolor: "transparent",
                    plot_bgcolor: "transparent",
                    font: { color: "#9ca3af" },
                    xaxis: { gridcolor: "#27272a" },
                    yaxis: { gridcolor: "#27272a" },
                  }}
                  style={{ width: "100%", height: "100%", minHeight: 300 }}
                  useResizeHandler
                  config={{ displaylogo: false, responsive: true }}
                />
              )}
            </div>

            <div className="font-semibold mb-3">All users ({users.length})</div>
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted border-b border-border">
                    <th className="p-3">Email</th>
                    <th className="p-3">Name</th>
                    <th className="p-3">Company</th>
                    <th className="p-3">Signed up</th>
                    <th className="p-3">Prompts used</th>
                    <th className="p-3">Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-b border-border last:border-0">
                      <td className="p-3">{u.email}</td>
                      <td className="p-3">{u.full_name || "—"}</td>
                      <td className="p-3">{u.company || "—"}</td>
                      <td className="p-3">{formatDate(u.created_at)}</td>
                      <td className="p-3 font-semibold">{u.prompt_count}</td>
                      <td className="p-3">{formatDate(u.last_prompt_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

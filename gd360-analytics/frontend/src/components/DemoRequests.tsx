// 2026-10-09: Enterprise demo requests sent from the public Pricing page
// (POST /site/demo-request), shown to the owner on the admin page.
import { useEffect, useState } from "react";
import { api } from "../api/client";

type DemoRequest = {
  id: string;
  name: string;
  email: string;
  company: string | null;
  team_size: string | null;
  question: string | null;
  status: "new" | "contacted" | "closed";
  created_at: string;
};

const STATUS: DemoRequest["status"][] = ["new", "contacted", "closed"];

export default function DemoRequests() {
  const [rows, setRows] = useState<DemoRequest[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .get<DemoRequest[]>("/site/demo-requests")
      .then((r) => setRows(r.data))
      .catch(() => {
        setRows([]);
        setError("Couldn't load demo requests.");
      });
  }, []);

  const setStatus = async (id: string, status: DemoRequest["status"]) => {
    setRows((rs) => (rs || []).map((r) => (r.id === id ? { ...r, status } : r)));
    try {
      await api.patch(`/site/demo-requests/${id}`, { status });
    } catch {
      setError("Couldn't save that change.");
    }
  };

  const fresh = (rows || []).filter((r) => r.status === "new").length;
  return (
    <div className="card p-5 mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="font-semibold">
          Enterprise demo requests {rows ? `(${rows.length}${fresh ? ` · ${fresh} new` : ""})` : ""}
        </div>
        <span className="text-xs text-muted">From the Book a demo form on the public Pricing page</span>
      </div>
      {error && <div className="text-sm text-danger mb-2">{error}</div>}
      {rows === null ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted">No requests yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead>
              <tr className="text-left text-muted border-b border-border">
                <th className="p-2 font-medium">Received</th>
                <th className="p-2 font-medium">Name</th>
                <th className="p-2 font-medium">Company</th>
                <th className="p-2 font-medium">Team size</th>
                <th className="p-2 font-medium">Their question</th>
                <th className="p-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border align-top">
                  <td className="p-2 whitespace-nowrap text-muted">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="p-2">
                    <div className="font-medium">{r.name}</div>
                    <a className="text-primary hover:underline" href={`mailto:${r.email}`}>{r.email}</a>
                  </td>
                  <td className="p-2">{r.company || "—"}</td>
                  <td className="p-2 whitespace-nowrap">{r.team_size || "—"}</td>
                  <td className="p-2 max-w-[360px]">{r.question || "—"}</td>
                  <td className="p-2">
                    <label className="sr-only" htmlFor={`demo-${r.id}`}>Status</label>
                    <select
                      id={`demo-${r.id}`}
                      className="h-8 rounded-ctl border border-border bg-base px-2 text-sm"
                      value={r.status}
                      onChange={(e) => setStatus(r.id, e.target.value as DemoRequest["status"])}
                    >
                      {STATUS.map((s) => (
                        <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

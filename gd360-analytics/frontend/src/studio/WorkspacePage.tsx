// 2026-10-19 (R56, list board "Workspace"): everything the team has asked, built and shared in one table - answers,
// dashboards, pipelines, models, reports and initiatives - with its Space, owner, status and proof, filtered and
// sorted in place. Read from GET /v2/workspace/items (each type with its own access rules).
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { Ic } from "./icons";
import { fmtWhen, ListPage, PageHead, Proof, Status, Tabs } from "./Page";

type Item = {
  id: string; type: "answer" | "dashboard" | "pipeline" | "model" | "report" | "initiative"; name: string; subtitle?: string; link: string;
  space?: string | null; owner: string; owner_id?: string | null; status: { text: string; tone: string }; proof?: { text: string; tone: string } | null;
  updated_at?: string | null; views?: number | null; mine?: boolean;
};
type Tab = "all" | Item["type"];
const TYPES: { id: Item["type"]; label: string; one: string; icon: string }[] = [
  { id: "answer", label: "Answers", one: "Answer", icon: "chat" }, { id: "dashboard", label: "Dashboards", one: "Dashboard", icon: "grid" },
  { id: "pipeline", label: "Pipelines", one: "Pipeline", icon: "flow" }, { id: "model", label: "Models", one: "Model", icon: "chip" },
  { id: "report", label: "Reports", one: "Report", icon: "doc" }, { id: "initiative", label: "Initiatives", one: "Initiative", icon: "flag" },
];
const PAGE = 25;

export default function WorkspacePage() {
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId } = useWorkspaceNav();
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<{ items: Item[]; counts: Record<string, number>; total: number } | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [space, setSpace] = useState("all");
  const [owner, setOwner] = useState("anyone");
  const [status, setStatus] = useState("any");
  const [sort, setSort] = useState<"updated" | "name" | "type">("updated");
  const [page, setPage] = useState(0);
  const tab = (params.get("type") as Tab) || "all";
  const setTab = (t: Tab) => { const n = new URLSearchParams(params); if (t === "all") n.delete("type"); else n.set("type", t); setParams(n, { replace: true }); setPage(0); };

  useEffect(() => {
    if (!activeWorkspaceId) return;
    setData(null); setErr("");
    api.get("/v2/workspace/items", { params: { workspace_id: activeWorkspaceId } })
      .then((r) => setData(r.data)).catch((e) => { setErr(e?.response?.data?.detail || "Couldn't load the workspace."); setData({ items: [], counts: {}, total: 0 }); });
  }, [activeWorkspaceId]);

  const items = data?.items || [];
  const spaces = useMemo(() => Array.from(new Set(items.map((i) => i.space).filter(Boolean))) as string[], [items]);
  const owners = useMemo(() => Array.from(new Set(items.map((i) => i.owner).filter((o) => o && o !== "—"))), [items]);
  const statuses = useMemo(() => Array.from(new Set(items.filter((i) => tab === "all" || i.type === tab).map((i) => i.status.text))), [items, tab]);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    let r = items.filter((i) => (tab === "all" || i.type === tab)
      && (space === "all" || i.space === space) && (owner === "anyone" || i.owner === owner) && (status === "any" || i.status.text === status)
      && (!t || [i.name, i.subtitle, i.owner, i.space, i.proof?.text].some((x) => (x || "").toLowerCase().includes(t))));
    if (sort === "name") r = [...r].sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "type") r = [...r].sort((a, b) => a.type.localeCompare(b.type) || (b.updated_at || "").localeCompare(a.updated_at || ""));
    return r;
  }, [items, tab, space, owner, status, q, sort]);
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);
  const tabs = [{ id: "all" as Tab, label: "All", n: data?.total ?? null }, ...TYPES.map((t) => ({ id: t.id as Tab, label: t.label, n: data ? data.counts[t.id] || 0 : null }))];
  const one = (t: Item["type"]) => TYPES.find((x) => x.id === t)!;

  return (
    <ListPage data="workspace" crumbs={[{ label: "Library" }]}>
      <PageHead title="Library" sub={data ? `Everything your team has asked, built and shared. ${data.total.toLocaleString()} item${data.total === 1 ? "" : "s"}${spaces.length ? ` across ${spaces.length} Space${spaces.length === 1 ? "" : "s"}` : ""}.` : "Reading everything in this workspace…"}
        actions={<>
          <Link to="/library/folders" className="sd-pill"><Ic n="folder" />Folders</Link>
          <Link to="/data?tab=catalog" className="sd-pill">Import</Link>
          <Link to="/chat" className="sd-btnp" data-ws-new="">New</Link>
        </>} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <div className="sdp-filters">
        <input className="sd-in" placeholder="Filter by name, owner or source" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} aria-label="Filter" data-ws-filter="" />
        <select className="sdp-sel" value={space} onChange={(e) => { setSpace(e.target.value); setPage(0); }} aria-label="Space"><option value="all">Space: All</option>{spaces.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <select className="sdp-sel" value={owner} onChange={(e) => { setOwner(e.target.value); setPage(0); }} aria-label="Owner"><option value="anyone">Owner: Anyone</option>{owners.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <select className="sdp-sel" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }} aria-label="Status"><option value="any">Status: Any</option>{statuses.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <span className="sd-sp" />
        <select className="sdp-sel" value={sort} onChange={(e) => setSort(e.target.value as any)} aria-label="Sort"><option value="updated">View: Recently updated</option><option value="name">View: By name</option><option value="type">View: By type</option></select>
      </div>
      {err && <div className="sd-err">{err}</div>}
      <div className="sd-card" style={{ overflow: "hidden" }} data-ws-table="">
        <div className="sd-tw">
          <table className="sd-t">
            <thead><tr><th>Name</th><th>Type</th><th>Space</th><th>Owner</th><th>Status</th><th>Proof</th><th className="r">Updated</th></tr></thead>
            <tbody>
              {!data && Array.from({ length: 6 }).map((_, i) => <tr key={i}><td colSpan={7}><span className="c2-working" style={{ opacity: .5 }}>…</span></td></tr>)}
              {shown.map((i) => (
                <tr key={`${i.type}:${i.id}`} className="click" onClick={() => navigate(i.link)} data-ws-row={i.type}>
                  <td style={{ maxWidth: 420 }}><Link to={i.link} onClick={(e) => e.stopPropagation()} title={i.subtitle || i.name} style={{ fontWeight: 500 }}>{i.name}</Link>{i.subtitle && i.subtitle !== i.name && <span className="sd-sub" style={{ display: "block", fontSize: 12 }}>{i.subtitle}</span>}</td>
                  <td><span className="sdp-type"><i><Ic n={one(i.type).icon} s={12} /></i>{one(i.type).one}</span></td>
                  <td className="sd-sub" style={{ fontSize: 13.5 }}>{i.space || "—"}</td>
                  <td>{i.owner}</td>
                  <td><Status text={i.status.text} tone={i.status.tone} /></td>
                  <td>{i.proof ? <Proof text={i.proof.text} tone={i.proof.tone} /> : <span className="sd-sub">—</span>}</td>
                  <td className="r sd-sub" style={{ fontSize: 13.5 }}>{fmtWhen(i.updated_at)}</td>
                </tr>
              ))}
              {data && rows.length === 0 && <tr><td colSpan={7}><div className="sd-empty">{items.length ? "Nothing matches these filters." : "Nothing here yet. Ask a question to make the first answer."}{!items.length && <Link to="/chat" className="sd-btnp">Ask a question</Link>}</div></td></tr>}
            </tbody>
          </table>
        </div>
        <div className="sdp-tfoot">
          <span>Click a row to open it. Status and proof come from each item’s own checks.</span>
          <span className="sd-sp" />
          {rows.length > 0 && <span>{page * PAGE + 1}–{Math.min(rows.length, page * PAGE + PAGE)} of {rows.length.toLocaleString()}</span>}
          {page > 0 && <button type="button" className="sd-tool sm" onClick={() => setPage(page - 1)}>Previous</button>}
          {(page + 1) * PAGE < rows.length && <button type="button" className="sd-tool sm" style={{ color: "rgb(var(--color-primary))" }} onClick={() => setPage(page + 1)} data-ws-next="">Next</button>}
        </div>
      </div>
    </ListPage>
  );
}

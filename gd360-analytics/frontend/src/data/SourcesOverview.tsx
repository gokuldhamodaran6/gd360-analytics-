// 2026-10-19 (R56, list board "Data · Sources"): every connected source in one table - tables, rows, how it syncs,
// when it last did, whether it is fresh, who owns it - with the four numbers that matter above and the selected
// source on the right: its state in words, the last syncs, where it lands, what uses it, its personal data.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { appsApi } from "../api/projects";
import { Ic } from "../studio/icons";
import { compact, fmtWhen, Kpi } from "../studio/Page";

export type SrcRow = {
  id: string; name: string; kind: string; label: string; mode: string; tables: number | null; rows: number | null; sync: string;
  last_sync: string | null; next_sync: string | null; freshness: string; state: "live" | "fresh" | "static" | "bad"; error: string | null; note: string;
  owner: string; syncs: { status: string; at: string; rows: number | null; error: string | null }[]; used_by: { dashboards: number; pipelines: number; models: number };
  personal: string[]; group: "warehouse" | "database" | "app" | "file";
};
export type Overview = { sources: SrcRow[]; kpis: { tables: number; rows: number; fresh_hour: number; total: number; issues: number }; groups: Record<string, number> };

const KIND_ICON: Record<string, string> = { warehouse: "db", database: "db", app: "plug", file: "doc" };
const GROUPS: { id: "all" | SrcRow["group"]; label: string }[] = [
  { id: "all", label: "All" }, { id: "warehouse", label: "Warehouses" }, { id: "database", label: "Databases" }, { id: "app", label: "Apps" }, { id: "file", label: "Files" },
];

function Fresh({ r }: { r: SrcRow }) {
  if (r.state === "bad") return <span className="sd-chip bad"><span className="sd-dot bad" />{/sign|auth|token|permission|401|403/i.test(r.error || "") ? "Needs sign-in" : "Sync failed"}</span>;
  if (r.state === "live") return <span className="sd-chip good"><span className="sd-dot good" />Live</span>;
  if (r.state === "fresh") return <span className="sd-chip good"><span className="sd-dot good" />Fresh</span>;
  return <span className="sd-chip"><span className="sd-dot muted" />Static</span>;
}

export function useDataOverview(workspaceId: string | null | undefined, bump = 0) {
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!workspaceId) return;
    setErr("");
    api.get<Overview>("/v2/data/overview", { params: { workspace_id: workspaceId } }).then((r) => setData(r.data))
      .catch((e) => { setErr(e?.response?.data?.detail || "Couldn't read your sources."); setData({ sources: [], kpis: { tables: 0, rows: 0, fresh_hour: 0, total: 0, issues: 0 }, groups: {} }); });
  }, [workspaceId, bump]);
  return { data, err };
}

export function SourcesKpis({ data }: { data: Overview | null }) {
  const k = data?.kpis;
  return (
    <div className="sd-kpis" data-data-kpis="">
      <Kpi label="Tables" value={k ? k.tables.toLocaleString() : "–"} />
      <Kpi label="Rows Euliv knows of" value={k ? compact(k.rows) : "–"} note={k ? "counted at import or sync; live tables are counted when read" : undefined} />
      <Kpi label="Fresh in the last hour" value={k ? `${k.fresh_hour} of ${k.total}` : "–"} note="live sources count as fresh" />
      <Kpi label="Issues" value={k ? k.issues : "–"} tone={k && k.issues ? "warn" : undefined} note={k?.issues ? "a sync failed or needs a sign-in" : "none"} />
    </div>
  );
}

export function SourcesTable({ data, selected, onSelect }: { data: Overview | null; selected: string | null; onSelect: (id: string) => void }) {
  const [group, setGroup] = useState<(typeof GROUPS)[number]["id"]>("all");
  const rows = useMemo(() => (data?.sources || []).filter((r) => group === "all" || r.group === group), [data, group]);
  return (
    <>
      <div className="sdp-tabs" role="tablist" style={{ marginTop: 4 }}>
        {GROUPS.map((g) => {
          const n = g.id === "all" ? data?.sources.length : data?.groups[g.id] || 0;
          return <button key={g.id} type="button" role="tab" aria-selected={group === g.id} className={`sdp-tab${group === g.id ? " on" : ""}`} onClick={() => setGroup(g.id)} data-src-group={g.id}>{g.label}{n != null && <small>{n}</small>}</button>;
        })}
      </div>
      <div className="sd-card" style={{ overflow: "hidden" }} data-sources-table="">
        <div className="sd-tw">
          <table className="sd-t">
            <thead><tr><th>Source</th><th>Kind</th><th className="r">Tables</th><th className="r">Rows</th><th>Sync</th><th>Last sync</th><th>Freshness</th><th>Owner</th></tr></thead>
            <tbody>
              {!data && <tr><td colSpan={8}><span className="c2-working"><span className="c2-spin" /> Reading your sources…</span></td></tr>}
              {rows.map((r) => (
                <tr key={r.id} className={`click${selected === r.id ? " sel" : ""}`} onClick={() => onSelect(r.id)} data-source-row={r.id}>
                  <td><span className="sdp-type"><i><Ic n={KIND_ICON[r.group] || "db"} s={12} /></i><span style={{ fontWeight: 500 }}>{r.name}</span></span></td>
                  <td className="sd-sub" style={{ fontSize: 13.5 }}>{r.label}</td>
                  <td className="num">{r.tables ?? "–"}</td>
                  <td className="num">{compact(r.rows)}</td>
                  <td className="sd-sub" style={{ fontSize: 13.5 }}>{r.sync}</td>
                  <td className="sd-sub" style={{ fontSize: 13.5 }}>{r.mode === "live" ? "Live" : fmtWhen(r.last_sync)}</td>
                  <td><Fresh r={r} /></td>
                  <td>{r.owner}</td>
                </tr>
              ))}
              {data && rows.length === 0 && <tr><td colSpan={8}><div className="sd-empty">No sources here yet.<Link to="/data?tab=catalog" className="sd-btnp">Connect a source</Link></div></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export function SourcePanel({ r, onClose, onChanged, onManage }: { r: SrcRow; onClose: () => void; onChanged: () => void; onManage: () => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const app = r.mode === "synced";
  const sync = async () => { setBusy("sync"); setMsg(""); try { await appsApi.syncNow(r.id); setMsg("Syncing now. This page updates when it finishes."); onChanged(); } catch (e: any) { setMsg(e?.response?.data?.detail || "Couldn't start a sync."); } finally { setBusy(""); } };
  const slower = async () => { setBusy("slow"); setMsg(""); try { await appsApi.update(r.id, "6h"); setMsg("It now syncs every 6 hours."); onChanged(); } catch (e: any) { setMsg(e?.response?.data?.detail || "Couldn't change the schedule."); } finally { setBusy(""); } };
  const uses = [r.used_by.pipelines && `${r.used_by.pipelines} pipeline${r.used_by.pipelines === 1 ? "" : "s"}`, r.used_by.dashboards && `${r.used_by.dashboards} dashboard${r.used_by.dashboards === 1 ? "" : "s"}`,
    r.used_by.models && `${r.used_by.models} model${r.used_by.models === 1 ? "" : "s"}`].filter(Boolean) as string[];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }} data-source-panel={r.id}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <b style={{ fontSize: 15, flex: 1, minWidth: 0, wordBreak: "break-word" }}>{r.name}</b>
        <button type="button" className="sd-ib" onClick={onClose} aria-label="Close"><Ic n="x" s={15} /></button>
      </div>
      <div><Fresh r={r} /></div>
      <div className="sd-sub" style={{ fontSize: 13.5, color: "rgb(var(--color-secondary))", lineHeight: 1.55 }}>
        {r.error ? r.error : r.note || (r.mode === "live" ? "Queried in place: every question reads it live, nothing is copied." : r.mode === "file" ? "An uploaded file. Replace it in Data to update the numbers." : r.freshness || "Synced on a schedule.")}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {app && <button type="button" className="sd-btnp" onClick={() => void sync()} disabled={!!busy} data-source-sync="">{busy === "sync" ? "Starting…" : r.state === "bad" ? "Retry now" : "Sync now"}</button>}
        {app && r.state === "bad" && <button type="button" className="sd-pill" onClick={() => void slower()} disabled={!!busy}>Lower frequency</button>}
        {!app && <button type="button" className="sd-btnp" onClick={() => navigate(`/?source=${encodeURIComponent(r.id)}`)}>Ask about it</button>}
        <button type="button" className="sd-pill" onClick={() => navigate(`/workspace/${r.id}`)}>Open</button>
      </div>
      {msg && <div className="sd-note">{msg}</div>}
      {app && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="sd-lbl">Last {r.syncs.length || ""} syncs</span>
          {r.syncs.length ? <div className="sdp-syncs">{r.syncs.map((s, i) => <i key={i} className={s.status === "success" ? "" : s.status === "running" ? "warn" : "bad"} title={`${s.status} · ${fmtWhen(s.at)}${s.rows != null ? ` · ${s.rows} rows` : ""}${s.error ? ` · ${s.error}` : ""}`} />)}</div>
            : <span className="sd-note">No syncs recorded yet.</span>}
        </div>
      )}
      <div className="sdp-grid2">
        <div className="sdp-kv"><span>Mode</span><span>{r.mode === "live" ? "Queried in place" : r.mode === "synced" ? "Synced copy" : "Uploaded file"}</span></div>
        <div className="sdp-kv"><span>Tables</span><span className="sd-mono">{r.tables ?? "–"}{r.rows != null ? ` · ${compact(r.rows)} rows` : ""}</span></div>
        <div className="sdp-kv"><span>Used by</span><span>{uses.length ? uses.join(", ") : "Nothing yet"}</span></div>
        <div className="sdp-kv"><span>Personal data</span><span>{r.personal.length ? `${r.personal.join(", ")} flagged` : "None flagged"}</span></div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Link to="/trust" className="sd-tool sm" style={{ color: "rgb(var(--color-primary))", alignSelf: "flex-start", padding: 0 }}>Data rules and personal data</Link>
        <button type="button" className="sd-tool sm" style={{ color: "rgb(var(--color-primary))", alignSelf: "flex-start", padding: 0 }} onClick={onManage} data-source-manage="">Rename, move to a Space or remove</button>
      </div>
    </div>
  );
}

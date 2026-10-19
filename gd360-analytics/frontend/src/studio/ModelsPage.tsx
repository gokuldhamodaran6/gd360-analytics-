// 2026-10-19 (R56, list board "Models"): every model trained on the workspace's data - what it predicts, how well on
// rows it never saw, how many rows it has scored - and the model page (/models/:id) with the Studio's model view.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { mlStudioApi, type StudioProject } from "../api/mlStudio";
import { Ic } from "./icons";
import { ModelStudio } from "./ModelStudio";
import { compact, fmtWhen, Kpi, ListPage, PageHead, Proof, Status, Tabs } from "./Page";

const score = (m: StudioProject): { label: string; value: number } | null => {
  const x = m.metrics || {};
  if (typeof x.roc_auc === "number") return { label: "AUC", value: x.roc_auc };
  if (typeof x.r2 === "number") return { label: "R²", value: x.r2 };
  if (typeof x.accuracy === "number") return { label: "Accuracy", value: x.accuracy };
  if (typeof x.f1_macro === "number") return { label: "F1", value: x.f1_macro };
  return null;
};
const KIND: Record<string, string> = { will_it_happen: "Yes / no", which_category: "A category", how_much: "A number", forecast: "Forecast", time_to_event: "Time to event", segments: "Segments", anomalies: "Anomalies" };

export default function ModelsPage() {
  const navigate = useNavigate();
  const [list, setList] = useState<StudioProject[] | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<"all" | "ready" | "training" | "failed">("all");
  useEffect(() => { mlStudioApi.list().then(setList).catch((e) => { setErr(e?.response?.data?.detail || "Couldn't load your models."); setList([]); }); }, []);
  useEffect(() => {
    if (!list?.some((m) => m.status === "training")) return;
    const t = window.setInterval(() => { mlStudioApi.list().then(setList).catch(() => undefined); }, 4000);
    return () => window.clearInterval(t);
  }, [list]);
  const rows = useMemo(() => (list || []).filter((m) => tab === "all" || m.status === tab), [list, tab]);
  const ready = (list || []).filter((m) => m.status === "ready");
  const scored = (list || []).reduce((n, m) => n + (m.predictions || 0), 0);
  const best = ready.map(score).filter(Boolean).sort((a, b) => b!.value - a!.value)[0];
  return (
    <ListPage data="models" crumbs={[{ label: "Models" }]}>
      <PageHead title="Models" sub={list ? `${list.length} model${list.length === 1 ? "" : "s"} trained on your data, each tested on rows it never saw before you use it.` : "Reading your models…"}
        actions={<><Link to="/chat" className="sd-pill"><Ic n="chat" />Ask for one</Link><Link to="/ml-studio/new" className="sd-btnp" data-models-new="">New model</Link></>} />
      <div className="sd-kpis">
        <Kpi label="Ready to use" value={list ? ready.length : "–"} note={list ? `${(list || []).filter((m) => m.status === "training").length} training now` : undefined} />
        <Kpi label="Rows scored" value={list ? compact(scored) : "–"} note="predictions written back to your data" />
        <Kpi label="Best held-out score" value={best ? `${best.label} ${best.value.toFixed(2)}` : "–"} note="on rows the model never saw" />
        <Kpi label="Failed" value={list ? (list || []).filter((m) => m.status === "failed").length : "–"} tone={(list || []).some((m) => m.status === "failed") ? "warn" : undefined} />
      </div>
      <Tabs<"all" | "ready" | "training" | "failed"> tabs={[{ id: "all", label: "All", n: list?.length ?? null }, { id: "ready", label: "Ready", n: ready.length }, { id: "training", label: "Training", n: (list || []).filter((m) => m.status === "training").length }, { id: "failed", label: "Failed", n: (list || []).filter((m) => m.status === "failed").length }]} value={tab} onChange={setTab} />
      {err && <div className="sd-err">{err}</div>}
      <div className="sd-card" style={{ overflow: "hidden" }} data-models-table="">
        <div className="sd-tw">
          <table className="sd-t">
            <thead><tr><th>Model</th><th>Predicts</th><th>Kind</th><th>Held-out score</th><th>Data</th><th className="r">Rows learned</th><th className="r">Scored</th><th>Status</th><th className="r">Trained</th></tr></thead>
            <tbody>
              {!list && <tr><td colSpan={9}><span className="c2-working"><span className="c2-spin" /> Reading your models…</span></td></tr>}
              {rows.map((m) => {
                const s = score(m);
                return (
                  <tr key={m.id} className="click" onClick={() => navigate(m.status === "ready" ? `/models/${m.id}` : `/ml-studio/${m.id}`)} data-model-row={m.id}>
                    <td style={{ maxWidth: 300 }}><Link to={m.status === "ready" ? `/models/${m.id}` : `/ml-studio/${m.id}`} onClick={(e) => e.stopPropagation()} style={{ fontWeight: 500 }}>{m.name}</Link></td>
                    <td className="sd-mono" style={{ fontSize: 13 }}>{m.target}</td>
                    <td className="sd-sub" style={{ fontSize: 13.5 }}>{KIND[m.problem_type || ""] || m.task_type || "–"}</td>
                    <td>{s ? <Proof text={`${s.label} ${s.value.toFixed(3)}`} tone="violet" /> : <span className="sd-sub">–</span>}</td>
                    <td className="sd-sub" style={{ fontSize: 13.5 }}>{m.source || "–"}</td>
                    <td className="num">{m.rows != null ? m.rows.toLocaleString() : "–"}</td>
                    <td className="num">{m.predictions ? compact(m.predictions) : "–"}</td>
                    <td><Status text={m.status === "ready" ? "Ready" : m.status === "failed" ? "Failed" : "Training"} tone={m.status === "ready" ? "good" : m.status === "failed" ? "bad" : "blue"} /></td>
                    <td className="r sd-sub" style={{ fontSize: 13.5 }}>{fmtWhen(m.trained_at || m.created_at)}</td>
                  </tr>
                );
              })}
              {list && rows.length === 0 && <tr><td colSpan={9}><div className="sd-empty">No models here yet. Ask “which customers will leave?” or start one in the model builder.<Link to="/ml-studio/new" className="sd-btnp">New model</Link></div></td></tr>}
            </tbody>
          </table>
        </div>
        <div className="sdp-tfoot">A score is measured once, on rows held back from training. A model that does not beat its simple baseline says so on its page.</div>
      </div>
    </ListPage>
  );
}

export function ModelPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  return <ModelStudio id={id} page busy={false} onAsk={(q) => navigate(`/chat?ask=${encodeURIComponent(q)}`)} onPrefill={(q) => navigate(`/chat?ask=${encodeURIComponent(q)}`)} />;
}

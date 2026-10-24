// R54: Automate data - describe a data job in one sentence; every flow you have.
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { errorText } from "../api/initiatives";
import { FlowItem, flowsApi, RUN_WORD, SourceOption, STATUS_WORD, whenOf } from "../api/flows";
import { I } from "../flows/icons";
import "../flows/flows.css";
import { Kpi, ListPage, PageHead } from "../studio/Page";

const EXAMPLES = [
  "Every morning, combine Shopify orders with the refunds sheet so the dashboard shows real net sales. Flag anything odd.",
  "Every day at 7, join the sales file with the store list and flag stores with no sales.",
  "Clean the supplier invoices sheet every morning: fix amounts typed as text and set aside rows with no invoice number.",
];

export default function Flows() {
  const { workspaces, activeWorkspaceId: ws, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const navigate = useNavigate();
  const [items, setItems] = useState<FlowItem[] | null>(null);
  const [params] = useSearchParams();
  const [text, setText] = useState(() => params.get("q") || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [picker, setPicker] = useState<{ message: string; options: SourceOption[] } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [showPick, setShowPick] = useState(false);
  const [options, setOptions] = useState<SourceOption[]>([]);

  useEffect(() => {
    setItems(null);
    flowsApi.list(ws).then(setItems).catch((e) => { setItems([]); setErr(errorText(e)); });
    flowsApi.sources(ws).then(setOptions).catch(() => setOptions([]));
  }, [ws]);

  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "UTC"; } })();
  const start = async (ids?: string[]) => {
    const t = text.trim();
    if (t.length < 6 || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await flowsApi.draft({ text: t, workspace_id: ws || null, source_ids: ids && ids.length ? ids : undefined, timezone: tz });
      if ("needs_sources" in r) {
        setPicker({ message: r.message, options: r.options });
        setPicked([]);
      } else {
        navigate(`/automate/${r.id}`);
      }
    } catch (e) {
      setErr(errorText(e, "Euliv couldn’t read those sources. Check they still connect, then try again."));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(0, 5)));
  const pickFrom = picker?.options || options;

  const live = (items || []).filter((f) => f.status === "live").length;
  const fixes = (items || []).filter((f) => f.needs_fix).length;
  const odd = (items || []).reduce((n, f) => n + (f.last_flagged || 0), 0);
  const saved = (items || []).reduce((n, f) => n + (f.last_rows || 0), 0);
  void AppSidebar; void TopNav; void workspaces; void switchWorkspace; void handleWorkspaceCreated;
  return (
    <ListPage data="pipelines" crumbs={[{ label: "Automate", to: "/automations" }, { label: "Pipelines" }]}>
      <div className="fl fl-list" data-flows-list="" style={{ padding: 0, maxWidth: "none", gap: 20 }}>
        <PageHead title="Pipelines" sub="Describe a data job you do by hand - combining files, fixing typing mistakes, working out totals. Euliv reads the data, shows a plan, tests it on real rows and then runs it on schedule with checks that hold back bad data."
          actions={<>
            <Link to="/automations" className="sd-pill">Alerts and reports</Link>
            <button type="button" className="sd-btnp" onClick={() => document.getElementById("fl-ask")?.focus()} data-new-pipeline="">New pipeline</button>
          </>} />
        <div className="sd-kpis">
          <Kpi label="On" value={items ? live : "–"} note={items ? `${items.length} in all` : undefined} />
          <Kpi label="Waiting for a fix" value={items ? fixes : "–"} tone={fixes ? "bad" : undefined} note={fixes ? "held runs kept the last good table" : "none"} />
          <Kpi label="Rows saved, last runs" value={items ? saved.toLocaleString() : "–"} />
          <Kpi label="Odd rows flagged" value={items ? odd.toLocaleString() : "–"} tone={odd ? "warn" : undefined} note="sent to the people you chose" />
        </div>

        <form className="fl-compose" onSubmit={(e) => { e.preventDefault(); start(picked); }} data-flow-compose="">
          <label className="vh" htmlFor="fl-ask" style={{ position: "absolute", left: -9999 }}>Describe the job</label>
          <textarea id="fl-ask" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Every morning, combine Shopify orders with the refunds sheet and flag anything odd"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); start(picked); } }} />
          <div className="bar">
            <button type="button" className={`fl-pill${showPick || picked.length ? " on" : ""}`} onClick={() => setShowPick((v) => !v)} aria-expanded={showPick} data-flow-pick-toggle="">
              {I.db && <span style={{ width: 15, height: 15, display: "inline-flex" }}>{I.db}</span>}
              {picked.length ? `${picked.length} source${picked.length > 1 ? "s" : ""} picked` : "Euliv picks the sources"}
            </button>
            <span style={{ flex: 1 }} />
            <span className="fl-lbl hide-sm">Ctrl ↵</span>
            <button type="submit" className="fl-send" disabled={busy || text.trim().length < 6} aria-label="Start">{busy ? <span className="fl-typing"><span /><span /><span /></span> : I.up}</button>
          </div>
          {(showPick || picker) && (
            <div style={{ borderTop: "1px solid var(--fl-line)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }} data-flow-picker="">
              <span className="fl-sub">{picker?.message || "Pick the sources to use, or leave it to Euliv."}</span>
              {pickFrom.length === 0 ? (
                <span className="fl-sub">No data yet. <Link to="/data" style={{ color: "var(--fl-brand)" }}>Connect or upload a source</Link> first.</span>
              ) : (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", maxHeight: 180, overflowY: "auto" }}>
                  {pickFrom.filter((o) => !o.managed).slice(0, 60).map((o) => (
                    <button type="button" key={o.id} className={`fl-pill${picked.includes(o.id) ? " on" : ""}`} onClick={() => toggle(o.id)} aria-pressed={picked.includes(o.id)}>
                      {o.name}<span className="fl-lbl">{o.kind.replace("_", " ")}</span>
                    </button>
                  ))}
                </div>
              )}
              {picker && <div><button type="button" className="fl-btn pri sm" disabled={!picked.length || busy} onClick={() => start(picked)}>Use these</button></div>}
            </div>
          )}
        </form>
        {err && <div className="fl-banner bad" role="alert">{err}</div>}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className="fl-lbl">Try one</span>
          {EXAMPLES.map((x) => <button key={x} type="button" className="fl-pill" onClick={() => setText(x)} title={x}>{x.length > 70 ? `${x.slice(0, 68)}…` : x}</button>)}
        </div>

        <section className="fl-steps4" aria-label="How it works">
          <div><b><span className="fl-num">1</span>You ask</b>In plain words: where from, what out, how often.</div>
          <div><b><span className="fl-num">2</span>Check the plan</b>Euliv reads the real data and lists every fix and check.</div>
          <div><b><span className="fl-num">3</span>Test it</b>On today’s real rows. Nothing is saved.</div>
          <div><b><span className="fl-num">4</span>Turn it on</b>It runs on schedule and holds back bad data.</div>
        </section>

        <div className="sd-card" style={{ overflow: "hidden" }} data-flows="">
          <div className="sd-tw">
            <table className="sd-t">
              <thead><tr><th>Output table</th><th>From</th><th>Schedule</th><th>Last run</th><th>Status</th></tr></thead>
              <tbody>
                {items === null && <tr><td colSpan={5}><span className="c2-working"><span className="c2-spin" /> Loading…</span></td></tr>}
                {items && items.length === 0 && <tr><td colSpan={5}><div className="sd-empty">No pipelines yet. Describe a job above to make the first one.</div></td></tr>}
                {(items || []).map((f) => (
                  <tr key={f.id} className="click" onClick={() => navigate(`/automate/${f.id}`)} data-flow-row={f.id}>
                    <td style={{ maxWidth: 300 }}><Link to={`/automate/${f.id}`} onClick={(e) => e.stopPropagation()} className="sd-mono" style={{ fontWeight: 500, fontSize: 13.5 }}>{f.output || f.name}</Link><span className="sd-sub" style={{ display: "block", fontSize: 12 }}>{f.name}</span></td>
                    <td className="sd-sub" style={{ fontSize: 13, maxWidth: 280 }} title={f.sources.join(" + ")}>{f.sources.join(" + ")}</td>
                    <td className="sd-sub" style={{ fontSize: 13.5 }}>{f.enabled ? f.schedule : "Not scheduled"}</td>
                    <td>{f.last_status ? <span className={`sd-chip ${f.last_status === "success" ? "good" : f.last_status === "running" ? "" : "bad"}`}><span className={`sd-dot ${f.last_status === "success" ? "good" : f.last_status === "running" ? "blue" : "bad"}`} />{RUN_WORD[f.last_status]} · {whenOf(f.last_run_at)}</span> : <span className="sd-sub">No runs yet</span>}</td>
                    <td><span style={{ display: "inline-flex", gap: 6 }}>{f.needs_fix && <span className="sd-chip bad"><span className="sd-dot bad" />Fix waiting</span>}<span className={`sd-chip ${f.status === "live" ? "good" : ""}`}><span className={`sd-dot ${f.status === "live" ? "good" : "muted"}`} />{STATUS_WORD[f.status]}</span></span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </ListPage>
  );
}

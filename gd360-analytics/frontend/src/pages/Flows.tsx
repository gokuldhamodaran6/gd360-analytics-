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
      setErr(errorText(e, "GD360 couldn’t read those sources. Check they still connect, then try again."));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(0, 5)));
  const pickFrom = picker?.options || options;

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={ws} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0 flex flex-col fl">
        <TopNav breadcrumb={[{ label: "Automate", to: "/automations" }, { label: "Automate data" }]} />
        <div className="fl-list" data-flows-list="">
          <section className="fl-hero">
            <h1>Automate your data</h1>
            <p>Describe a job you do by hand - combining files, fixing typing mistakes, working out totals. GD360 reads the data, shows a plan, tests it on real rows and then runs it every day with safety checks.</p>
          </section>

          <form className="fl-compose" onSubmit={(e) => { e.preventDefault(); start(picked); }} data-flow-compose="">
            <label className="vh" htmlFor="fl-ask" style={{ position: "absolute", left: -9999 }}>Describe the job</label>
            <textarea id="fl-ask" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Every morning, combine Shopify orders with the refunds sheet and flag anything odd"
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); start(picked); } }} />
            <div className="bar">
              <button type="button" className={`fl-pill${showPick || picked.length ? " on" : ""}`} onClick={() => setShowPick((v) => !v)} aria-expanded={showPick} data-flow-pick-toggle="">
                {I.db && <span style={{ width: 15, height: 15, display: "inline-flex" }}>{I.db}</span>}
                {picked.length ? `${picked.length} source${picked.length > 1 ? "s" : ""} picked` : "GD360 picks the sources"}
              </button>
              <span style={{ flex: 1 }} />
              <span className="fl-lbl hide-sm">Ctrl ↵</span>
              <button type="submit" className="fl-send" disabled={busy || text.trim().length < 6} aria-label="Start">{busy ? <span className="fl-typing"><span /><span /><span /></span> : I.up}</button>
            </div>
            {(showPick || picker) && (
              <div style={{ borderTop: "1px solid var(--fl-line)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }} data-flow-picker="">
                <span className="fl-sub">{picker?.message || "Pick the sources to use, or leave it to GD360."}</span>
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

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="fl-lbl">Try one</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {EXAMPLES.map((x) => <button key={x} type="button" className="fl-pill" onClick={() => setText(x)}>{x}</button>)}
            </div>
          </div>

          <section className="fl-steps4" aria-label="How it works">
            <div><b><span className="fl-num">1</span>You ask</b>In plain words: where from, what out, how often.</div>
            <div><b><span className="fl-num">2</span>Check the plan</b>GD360 reads the real data and lists every fix and check.</div>
            <div><b><span className="fl-num">3</span>Test it</b>On today’s real rows. Nothing is saved.</div>
            <div><b><span className="fl-num">4</span>Turn it on</b>It runs on schedule and holds back bad data.</div>
          </section>

          <section className="fl-card" style={{ overflow: "hidden" }} data-flows="">
            <div className="fl-hd"><h2 className="fl-h2">Your flows</h2><span className="sp" /><Link to="/automations" className="fl-btn ghost sm">Alerts and reports</Link></div>
            {items === null ? (
              <div className="fl-empty">Loading…</div>
            ) : items.length === 0 ? (
              <div className="fl-empty">{I.flow && <span style={{ width: 28, height: 28, display: "inline-flex" }}>{I.flow}</span>}No flows yet. Describe a job above to make the first one.</div>
            ) : (
              <div className="fl-rows">
                {items.map((f) => (
                  <Link key={f.id} to={`/automate/${f.id}`} className="fl-row" data-flow-row={f.id}>
                    <span style={{ minWidth: 0 }}><span className="t">{f.name}</span><span className="s" style={{ display: "block" }}>{f.sources.join(" + ")} → {f.output}</span></span>
                    <span className="s hide-sm">{f.enabled ? f.schedule : "Not scheduled"}</span>
                    <span className="hide-sm">{f.last_status ? (
                      <span className={`fl-chip ${f.last_status === "success" ? "good" : f.last_status === "running" ? "muted" : "bad"}`}><i />{RUN_WORD[f.last_status]} · {whenOf(f.last_run_at)}</span>
                    ) : <span className="s">No runs yet</span>}</span>
                    <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      {f.needs_fix && <span className="fl-chip bad"><i />Fix waiting</span>}
                      <span className={`fl-chip ${f.status === "live" ? "brand" : "muted"}`}><i />{STATUS_WORD[f.status]}</span>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

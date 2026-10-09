// Mission Control · System health — scheduled runs, failing connectors,
// warehouse queries, storage and incidents, with one-click retries.
import { useState } from "react";
import { mcPatch, mcPost, useMC } from "../api";
import {
  ActionButton, ago, bytes, Card, dateTime, Empty, ErrorBox, fmtN, HBars, Kpi, Loading, Modal, PageHead, Pill, useCan,
} from "../ui";

const NO = "Your role can't do this";
const SEV: [string, string][] = [["SEV-1", "SEV-1 · product down for many customers"], ["SEV-2", "SEV-2 · a major feature broken"], ["SEV-3", "SEV-3 · degraded for some customers"], ["SEV-4", "SEV-4 · minor, cosmetic or internal"]];
const sevTone = (s: string) => (s === "SEV-1" || s === "SEV-2" ? "r" : s === "SEV-3" ? "a" : "b") as "r" | "a" | "b";
const KIND_LABEL: Record<string, string> = { source: "Connector", dashboard: "Refresh", automation: "Automation", pipeline: "Pipeline", ml: "ML" };

function HourStrip({ hours }: { hours: { total: number; failed: number }[] }) {
  const max = Math.max(1, ...hours.map((h) => h.total));
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(24,minmax(0,1fr))", gap: 2, alignItems: "end", height: 40 }} role="img"
        aria-label={`Runs per hour, last 24 hours: ${hours.reduce((a, h) => a + h.total, 0)} total, ${hours.reduce((a, h) => a + h.failed, 0)} failed`}>
        {hours.map((h, i) => {
          const H = h.total ? Math.max(4, (h.total / max) * 40) : 2;
          const fH = h.total ? (h.failed / h.total) * H : 0;
          return (
            <div key={i} title={`${24 - i}h ago: ${h.total} run(s), ${h.failed} failed`}
              style={{ height: H, borderRadius: 2, background: h.total ? "var(--g)" : "var(--line0)", display: "flex", flexDirection: "column", overflow: "hidden", opacity: h.total ? 0.9 : 1 }}>
              {fH > 0 && <div style={{ height: Math.max(2, fH), background: "var(--red)" }} />}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        <span className="mc-mono" style={{ fontSize: 10, color: "var(--ink4)" }}>24h ago</span>
        <span className="mc-mono" style={{ fontSize: 10, color: "var(--ink4)" }}>now</span>
      </div>
    </div>
  );
}

export default function Health() {
  const { data, error, loading, reload } = useMC<any>("/health");
  const can = useCan()("health.write");
  const tip = can ? undefined : NO;
  const [newInc, setNewInc] = useState(false);
  const [inc, setInc] = useState({ title: "", severity: "SEV-3", update: "" });
  const [upd, setUpd] = useState<{ id: string; title: string; text: string } | null>(null);

  const openIncidents = (data?.incidents || []).filter((i: any) => i.status !== "resolved");
  const storageTotal = (data?.storage || []).reduce((a: number, s: any) => a + (s.bytes || 0), 0);

  return (
    <div className="mc-page">
      <PageHead eyebrow="Platform · last 24 hours" title="System health"
        sub={data ? `Every scheduled run, connector and warehouse query · updated ${ago(data.generated_at)}.` : "Every scheduled run, connector and warehouse query."}>
        <button type="button" className="mc-btn" onClick={reload}>Refresh</button>
        <button type="button" className="mc-btn p" disabled={!can} title={tip} onClick={() => { setInc({ title: "", severity: "SEV-3", update: "" }); setNewInc(true); }}>Open incident</button>
      </PageHead>

      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Loading rows={8} />}
      {data && (
        <>
          {openIncidents.map((i: any) => {
            const last = i.updates[i.updates.length - 1];
            const c = sevTone(i.severity) === "r" ? "#FF7A6B" : sevTone(i.severity) === "a" ? "#F2B84B" : "#7AA7FF";
            return (
              <div key={i.id} className="mc-alert" role="alert" style={{ borderColor: c + "55", background: c + "0D", flexWrap: "wrap" }}>
                <span className="mc-dot" style={{ background: c }} />
                <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 300px", minWidth: 0 }}>
                  <span className="mc-lbl" style={{ color: c }}>{i.severity} · OPEN {ago(i.started_at).toUpperCase()}</span>
                  <span style={{ fontSize: 14.5, fontWeight: 700 }}>{i.title}</span>
                  {last && <span style={{ fontSize: 13, color: "var(--ink2)", lineHeight: 1.45 }}>{last.text} <span className="mc-mono" style={{ fontSize: 11, color: "var(--ink3)" }}>· {ago(last.t)}</span></span>}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button type="button" className="mc-btn sm" disabled={!can} title={tip} onClick={() => setUpd({ id: i.id, title: i.title, text: "" })}>Post update</button>
                  <ActionButton className="mc-btn sm" disabled={!can} title={tip} confirm="Resolve it?" done="Incident resolved"
                    run={() => mcPatch(`/incidents/${i.id}`, { status: "resolved" }).then(reload)}>Resolve</ActionButton>
                </div>
              </div>
            );
          })}

          <section aria-label="Scheduled runs" className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))" }}>
            {data.runs.map((r: any) => (
              <div key={r.key} className="mc-card mc-kpi">
                <span className="mc-lbl">{r.label}</span>
                <span className="mc-kpi-v mc-num" style={{ color: r.success == null ? "var(--ink3)" : r.success < 95 ? "var(--amber)" : undefined }}>
                  {r.success == null ? "—" : `${r.success}%`}
                </span>
                <span className="mc-sub">{r.total ? `${fmtN(r.total)} run(s) · ` : "No runs in 24h"}{r.total ? <b style={{ color: r.failed ? "var(--red)" : "var(--g)" }}>{r.failed} failed</b> : null}</span>
                <HourStrip hours={r.hours} />
              </div>
            ))}
          </section>

          <section aria-label="Other checks" className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" }}>
            <Kpi label="CONNECTORS FAILING" value={fmtN(data.failing_sources)} sub="sources whose last sync errored" tone={data.failing_sources ? "warn" : undefined} />
            <Kpi label="QUALITY CHECKS FAILING" value={fmtN(data.quality_failing)} sub="data-quality rules on their last run" tone={data.quality_failing ? "warn" : undefined} />
            <Kpi label="ML TRAININGS FAILED" value={fmtN(data.ml_failed)} sub="models that couldn't train" tone={data.ml_failed ? "warn" : undefined} />
            <Kpi label="CUSTOM DOMAINS PENDING" value={fmtN(data.domains_pending)} sub="published dashboards waiting on DNS" tone={data.domains_pending ? "warn" : undefined} />
          </section>

          <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))" }}>
            <Card title={`FAILING CONNECTORS · ${data.failing_sources}`}>
              {data.failing_by_kind.length === 0
                ? <Empty>Every connector synced on its last try.</Empty>
                : <HBars items={data.failing_by_kind.map((k: any) => ({ k: k.kind, v: k.n }))} color="#FF7A6B" />}
            </Card>
            <Card title={`STORAGE · ${bytes(storageTotal)}`}>
              <HBars items={data.storage.map((s: any) => ({ k: s.k, v: s.bytes || 0, sub: s.bytes == null ? "couldn't measure" : undefined }))} fmt={(v) => bytes(v)} color="#7AA7FF" />
            </Card>
          </div>

          <Card title="FAILURES · NEWEST FIRST" right={<span className="mc-tip">Retry queues a re-run; the scheduler picks it up within a minute.</span>}>
            {data.failures.length === 0 ? <Empty>No failures in the last 3 days.</Empty> : (
              <div className="mc-tablewrap">
                <table className="mc-table" style={{ minWidth: 880 }}>
                  <thead><tr><th>WHAT</th><th>WHO</th><th>ERROR</th><th>SINCE</th><th></th></tr></thead>
                  <tbody>
                    {data.failures.map((f: any, idx: number) => (
                      <tr key={`${f.kind}-${f.id}-${idx}`}>
                        <td style={{ minWidth: 200 }}>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <span style={{ fontWeight: 600 }}>{f.what}</span>
                            <span><Pill tone={f.kind === "source" ? "r" : f.kind === "ml" ? "b" : "a"}>{KIND_LABEL[f.kind] || f.kind}</Pill></span>
                          </div>
                        </td>
                        <td style={{ color: "var(--ink2)" }}>{f.who || "—"}</td>
                        <td className="mc-mono" style={{ fontSize: 12, color: "#FFC2B8", lineHeight: 1.5, maxWidth: 380 }}>{f.error || "—"}</td>
                        <td className="mc-mono" style={{ fontSize: 12, color: "var(--ink3)", whiteSpace: "nowrap" }} title={dateTime(f.since)}>{ago(f.since)}</td>
                        <td style={{ textAlign: "right" }}>
                          {f.retry && f.id && f.kind !== "ml" ? (
                            <ActionButton className="mc-btn sm" disabled={!can} title={tip} done="Re-run queued"
                              run={() => mcPost("/health/retry", { kind: f.kind, id: f.id })}>Retry now</ActionButton>
                          ) : <span className="mc-tip">{f.kind === "ml" ? "Fix the data, then retrain" : "Can't retry"}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="WAREHOUSE QUERIES · 24H">
            {data.warehouse.length === 0 ? <Empty>No queries were pushed down to a customer warehouse in the last 24 hours.</Empty> : (
              <div className="mc-tablewrap">
                <table className="mc-table" style={{ minWidth: 520 }}>
                  <thead><tr><th>PROVIDER</th><th>QUERIES</th><th>ERRORS</th><th>ERROR RATE</th><th>DATA SCANNED</th></tr></thead>
                  <tbody>
                    {data.warehouse.map((w: any) => (
                      <tr key={w.provider}>
                        <td style={{ fontWeight: 600 }}>{w.provider}</td>
                        <td className="mc-mono mc-num">{fmtN(w.queries)}</td>
                        <td className="mc-mono mc-num" style={{ color: w.errors ? "var(--red)" : undefined }}>{fmtN(w.errors)}</td>
                        <td className="mc-mono mc-num">{w.queries ? `${((w.errors / w.queries) * 100).toFixed(1)}%` : "—"}</td>
                        <td className="mc-mono mc-num">{bytes(w.bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="INCIDENTS">
            {data.incidents.length === 0 ? <Empty>No incidents logged. Open one when customers are affected so everyone sees the same updates.</Empty> : (
              data.incidents.map((i: any) => (
                <div key={i.id} style={{ display: "flex", flexDirection: "column", gap: 10, paddingBottom: 14, borderBottom: "1px solid var(--line0)" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <Pill tone={sevTone(i.severity)}>{i.severity}</Pill>
                    <Pill tone={i.status === "resolved" ? "g" : "r"}>{i.status}</Pill>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{i.title}</span>
                    <span style={{ flex: 1 }} />
                    <span className="mc-tip">{i.owner_email || "—"} · opened {dateTime(i.started_at)}{i.resolved_at ? ` · resolved ${dateTime(i.resolved_at)}` : ""}</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 6, borderLeft: "2px solid var(--line)", marginLeft: 4 }}>
                    {i.updates.map((u: any, k: number) => (
                      <div key={k} style={{ display: "flex", gap: 10, fontSize: 13, lineHeight: 1.45, paddingLeft: 8 }}>
                        <span className="mc-mono" style={{ fontSize: 11, color: "var(--ink3)", width: 96, flex: "none", paddingTop: 2 }}>{dateTime(u.t)}</span>
                        <span style={{ color: "#D5DEDB", minWidth: 0 }}>{u.text} <span className="mc-tip">· {(u.by || "").split("@")[0]}</span></span>
                      </div>
                    ))}
                  </div>
                  {i.status !== "resolved" && (
                    <div style={{ display: "flex", gap: 6 }}>
                      <button type="button" className="mc-btn sm" disabled={!can} title={tip} onClick={() => setUpd({ id: i.id, title: i.title, text: "" })}>Post update</button>
                      <ActionButton className="mc-btn sm" disabled={!can} title={tip} confirm="Resolve it?" done="Incident resolved"
                        run={() => mcPatch(`/incidents/${i.id}`, { status: "resolved" }).then(reload)}>Resolve</ActionButton>
                    </div>
                  )}
                </div>
              ))
            )}
          </Card>
        </>
      )}

      <Modal open={newInc} onClose={() => setNewInc(false)} title="Open incident">
        <label className="mc-field">What's wrong<input className="mc-input" value={inc.title} onChange={(e) => setInc({ ...inc, title: e.target.value })} placeholder="Snowflake syncs failing for several workspaces" /></label>
        <label className="mc-field">Severity
          <select className="mc-select" value={inc.severity} onChange={(e) => setInc({ ...inc, severity: e.target.value })}>
            {SEV.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="mc-field">First update (optional)<textarea className="mc-textarea" rows={3} value={inc.update} onChange={(e) => setInc({ ...inc, update: e.target.value })} placeholder="What we know, who's on it, when the next update is." /></label>
        <ActionButton className="mc-btn p" disabled={inc.title.trim().length < 3} done="Incident opened" run={async () => {
          await mcPost("/incidents", { title: inc.title.trim(), severity: inc.severity, update: inc.update.trim() || null });
          setNewInc(false);
          reload();
        }}>Open incident</ActionButton>
        <span className="mc-tip">You're the owner. Every update is timestamped and written to the audit log.</span>
      </Modal>

      <Modal open={!!upd} onClose={() => setUpd(null)} title="Post update">
        <span className="mc-tip">{upd?.title}</span>
        <textarea className="mc-textarea" rows={4} aria-label="Update" value={upd?.text || ""} onChange={(e) => setUpd(upd && { ...upd, text: e.target.value })} placeholder="What changed, and when the next update is due." />
        <ActionButton className="mc-btn p" disabled={!upd?.text.trim()} done="Update posted" run={async () => {
          await mcPatch(`/incidents/${upd!.id}`, { update: upd!.text.trim() });
          setUpd(null);
          reload();
        }}>Post update</ActionButton>
      </Modal>
    </div>
  );
}

// Mission Control · Command center — the 30-second read on the business.
import { FormEvent, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { errText, mcPost, mcPut, useMC } from "../api";
import {
  ActionButton, ago, bandTone, Card, Empty, ErrorBox, fmtN, Icon, Kpi, LineChart, Loading, Modal, PageHead, Pill, Seg, useCan, useToast,
} from "../ui";

const QUESTIONS = [
  "Which accounts should we call this week, and why?",
  "Where do new sign-ups drop off before their first answer?",
  "Which early-access workspaces fit a team plan?",
  "What changed in usage this week compared with last?",
];

function AskAdmin({ autoFocus }: { autoFocus: boolean }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState("");
  const [asked, setAsked] = useState("");
  const [err, setErr] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  const ask = async (question: string) => {
    if (question.trim().length < 3) return;
    setBusy(true);
    setErr("");
    setAsked(question);
    try {
      const r = await mcPost("/ask", { question });
      setAnswer(r.answer);
    } catch (e) {
      setErr(errText(e, "Ask Admin couldn't answer that."));
      setAnswer("");
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    ask(q);
  };
  const lines = answer.split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    <Card style={{ borderColor: "var(--g-bd)" }}>
      <form onSubmit={submit} style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span style={{ width: 36, height: 36, borderRadius: 11, background: "var(--g)", color: "var(--g-ink)", display: "grid", placeItems: "center", flex: "none" }}>
          <Icon d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" size={18} />
        </span>
        <label htmlFor="ask-admin" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Ask a question about the business</label>
        <input id="ask-admin" ref={ref} className="mc-input" style={{ flex: 1, height: 46, fontSize: 15 }} value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Ask Admin anything about customers, usage, support or cost…" />
        <button type="submit" className="mc-btn p" style={{ height: 46, padding: "0 18px" }} disabled={busy || q.trim().length < 3}>{busy ? "Thinking…" : "Ask"}</button>
      </form>
      <div className="mc-chips">
        {QUESTIONS.map((x) => (
          <button key={x} type="button" className="mc-chip" onClick={() => { setQ(x); ask(x); }}>{x}</button>
        ))}
      </div>
      {err && <ErrorBox text={err} />}
      {busy && <div className="mc-skel" style={{ height: 70 }} />}
      {!busy && answer && (
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="mc-lbl" style={{ color: "var(--g)" }}>ANSWER · FROM LIVE ADMIN DATA</span>
          <span className="mc-tip">“{asked}”</span>
          {lines.map((l, i) =>
            l.startsWith("- ") || l.startsWith("• ") ? (
              <div key={i} style={{ display: "flex", gap: 8, fontSize: 14, lineHeight: 1.55 }}><span style={{ color: "var(--g)" }}>•</span><span>{l.slice(2)}</span></div>
            ) : (
              <p key={i} style={{ margin: 0, fontSize: 15.5, lineHeight: 1.6 }}>{l}</p>
            )
          )}
        </div>
      )}
    </Card>
  );
}

function GoalsEditor({ goals, onSaved }: { goals: any[]; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<any[]>(goals);
  const toast = useToast();
  useEffect(() => setRows(goals), [goals]);
  return (
    <>
      <button type="button" className="mc-btn sm" onClick={() => setOpen(true)}>Edit targets</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Quarterly targets">
        {rows.map((g, i) => (
          <label key={g.key} className="mc-field">{g.label}
            <input className="mc-input" type="number" min={0} value={g.target}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, target: Number(e.target.value) } : r)))} />
          </label>
        ))}
        <ActionButton className="mc-btn p" run={async () => {
          await mcPut("/goals", { goals: rows });
          setOpen(false);
          onSaved();
        }} done="Targets saved">Save targets</ActionButton>
        <span className="mc-tip">Saved targets are written to the audit log.</span>
      </Modal>
    </>
  );
}

const FEED_COLOR: Record<string, string> = { signup: "#7AA7FF", source: "#43E5A0", publish: "#43E5A0", demo: "#F2B84B" };

export default function Overview() {
  const [range, setRange] = useState<"7d" | "30d" | "90d">("30d");
  const [params] = useSearchParams();
  const { data, error, loading, reload } = useMC<any>(`/overview?range=${range}`);
  const can = useCan();

  const series = data?.series || [];
  const spark = (k: string) => series.map((s: any) => s[k]);
  const sparkFor: Record<string, number[] | undefined> = { users: spark("signups"), wau: spark("active"), chats: spark("chats") };
  const lbl = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  return (
    <div className="mc-page">
      <PageHead eyebrow="Overview" title="Command center" sub={data ? `Live from GD360's own tables · updated ${ago(data.generated_at)}. Paid plans aren't live yet — every account is on early access.` : "The business at a glance."}>
        <Seg<"7d" | "30d" | "90d"> label="Period" value={range} onChange={setRange} options={[["7d", "7D"], ["30d", "30D"], ["90d", "90D"]]} />
        <button type="button" className="mc-btn" onClick={reload}>Refresh</button>
      </PageHead>

      <AskAdmin autoFocus={params.get("ask") === "1"} />

      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Loading rows={8} />}
      {data && (
        <>
          {data.alerts.length > 0 && (
            <section aria-label="Alerts" className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))" }}>
              {data.alerts.map((a: any, i: number) => {
                const c = a.level === "danger" ? "#FF7A6B" : a.level === "info" ? "#7AA7FF" : "#F2B84B";
                return (
                  <div key={i} className="mc-alert" style={{ borderColor: c + "55", background: c + "0D" }}>
                    <span className="mc-dot" style={{ background: c }} />
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                      <span className="mc-lbl" style={{ color: c }}>{a.kind}</span>
                      <span style={{ fontSize: 13.5, lineHeight: 1.45 }}>{a.text}</span>
                      <Link to={`/admin/${a.href}`} style={{ fontSize: 12.5, fontWeight: 600 }}>{a.cta} →</Link>
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          <section aria-label="Key metrics" className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))" }}>
            {data.kpis.map((k: any) => (
              <Kpi key={k.key} label={k.label} value={k.value} sub={k.sub} delta={k.delta} to={`/admin/${k.href}`} tone={k.warn ? "warn" : undefined}
                spark={sparkFor[k.key]} estimate={k.estimate} />
            ))}
          </section>

          <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(420px,1fr))" }}>
            <Card title="QUESTIONS ASKED PER DAY">
              <LineChart label="Questions asked per day" points={series.map((s: any) => ({ label: lbl(s.date), value: s.chats }))} />
            </Card>
            <Card title="SIGN-UPS AND ACTIVE PEOPLE PER DAY">
              <LineChart label="Sign-ups per day" color="#7AA7FF" height={95} points={series.map((s: any) => ({ label: lbl(s.date), value: s.signups }))} />
              <LineChart label="Active people per day" color="#43E5A0" height={95} points={series.map((s: any) => ({ label: lbl(s.date), value: s.active }))} />
              <span className="mc-tip"><b style={{ color: "#7AA7FF" }}>Blue</b> sign-ups · <b style={{ color: "#43E5A0" }}>green</b> people who asked at least one question</span>
            </Card>
          </div>

          <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(360px,1fr))" }}>
            <Card title={`QUARTER TARGETS · ${data.quarter_elapsed}% OF QUARTER GONE`} right={(can("staff.manage") || can("plans.write")) && <GoalsEditor goals={data.goals} onSaved={reload} />}>
              {data.goals.map((g: any) => (
                <div key={g.key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
                    <span>{g.label}</span>
                    <span className="mc-mono mc-num" style={{ color: "var(--ink2)" }}>
                      {fmtN(g.current, 2)} / {fmtN(g.target)} <span style={{ color: g.status === "behind" ? "var(--amber)" : "var(--g)" }}>· {g.status}</span>
                    </span>
                  </div>
                  <div style={{ position: "relative" }}>
                    <div className="mc-bar"><div style={{ width: `${g.pct}%`, background: g.status === "behind" ? "var(--amber)" : "var(--g)" }} /></div>
                    <span aria-hidden="true" style={{ position: "absolute", top: -3, left: `${data.quarter_elapsed}%`, width: 2, height: 14, background: "var(--ink)", opacity: 0.45 }} />
                  </div>
                </div>
              ))}
            </Card>
            <Card title="LIVE ACTIVITY" right={<span className="mc-mono" style={{ fontSize: 11, color: "var(--g)" }}>● LIVE</span>}>
              {data.feed.length === 0 && <Empty>No activity yet.</Empty>}
              {data.feed.map((f: any, i: number) => (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13, lineHeight: 1.45 }}>
                  <span className="mc-mono" style={{ fontSize: 11, color: "var(--ink3)", width: 58, flex: "none", paddingTop: 2 }}>{ago(f.t)}</span>
                  <span className="mc-dot" style={{ background: FEED_COLOR[f.kind] || "#7F8C88", width: 8, height: 8 }} />
                  <span style={{ color: "#D5DEDB" }}>{f.text}</span>
                </div>
              ))}
            </Card>
          </div>

          <Card title="ACCOUNTS TO CALL THIS WEEK" right={<Link to="/admin/accounts" className="mc-btn sm">All accounts</Link>}>
            <span className="mc-tip">Ranked by people at stake. Risk = falling usage, open tickets or few active people. Expansion = usage that already fits a team plan.</span>
            {data.accounts_to_call.length === 0 ? <Empty>Nobody needs a call right now.</Empty> : (
              <div className="mc-tablewrap">
                <table className="mc-table" style={{ minWidth: 760 }}>
                  <thead><tr><th>ACCOUNT</th><th>PEOPLE</th><th>QUESTIONS 30D</th><th>HEALTH</th><th>FITS</th><th>SIGNAL</th><th>NEXT STEP</th></tr></thead>
                  <tbody>
                    {data.accounts_to_call.map((a: any) => (
                      <tr key={a.key}>
                        <td><Link to={`/admin/accounts/${encodeURIComponent(a.key)}`} style={{ fontWeight: 700, color: "var(--ink)" }}>{a.name}</Link></td>
                        <td className="mc-mono mc-num">{a.users}</td>
                        <td className="mc-mono mc-num">{fmtN(a.chats_30d)}</td>
                        <td><Pill tone={bandTone(a.band)}>{a.health} · {a.band}</Pill></td>
                        <td>{a.fit}</td>
                        <td style={{ color: "#D5DEDB" }}>{a.signal}</td>
                        <td style={{ color: a.tone === "risk" ? "var(--red)" : "var(--g)", fontWeight: 600 }}>{a.action}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))" }}>
            <Link to="/admin/health" className="mc-card mc-kpi">
              <span className="mc-lbl">PLATFORM · 24H</span>
              <span className="mc-kpi-v mc-num">{data.platform.success == null ? "—" : `${data.platform.success}%`}</span>
              <span className="mc-sub">{fmtN(data.platform.runs_total)} scheduled runs · {data.platform.runs_failed} failed · {data.platform.failing_sources} source(s) failing to sync</span>
            </Link>
            <Link to="/admin/support" className="mc-card mc-kpi">
              <span className="mc-lbl">SUPPORT QUEUE</span>
              <div style={{ display: "flex", gap: 6 }}>
                {(["P1", "P2", "P3", "P4"] as const).map((p) => (
                  <Pill key={p} tone={p === "P1" ? "r" : p === "P2" ? "a" : p === "P3" ? "b" : undefined}>{p} · {data.support.by_priority[p]}</Pill>
                ))}
              </div>
              <span className="mc-sub">{data.support.open} open · {data.support.breaching} near SLA{data.support.csat ? ` · CSAT ${data.support.csat}` : ""}</span>
            </Link>
            <Link to="/admin/crm" className="mc-card mc-kpi">
              <span className="mc-lbl">ENTERPRISE DEMAND</span>
              <span className="mc-kpi-v mc-num">{data.crm.demo_new}</span>
              <span className="mc-sub">new demo request(s) · {data.crm.open_deals} open deal(s) · ${fmtN(data.crm.weighted)} weighted</span>
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

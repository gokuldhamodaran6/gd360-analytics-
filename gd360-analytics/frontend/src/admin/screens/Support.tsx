// Mission Control · Inbox & SLAs — every ticket with its SLA clock, the
// customer's workspace context and an AI-drafted reply.
import { FormEvent, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { mcPatch, mcPost, useMC } from "../api";
import {
  ActionButton, ago, bandTone, Card, Chips, dateTime, Empty, ErrorBox, fmtN, fmtPct, Kpi, Loading, minsLabel, Modal, PageHead, Pill, prioTone, useCan, useMe, useToast,
} from "../ui";

type View = "open" | "mine" | "unassigned" | "breaching" | "auto" | "solved" | "all";
const NO = "Your role can't do this";
const VIEWS: [View, string][] = [["open", "Open"], ["mine", "Mine"], ["unassigned", "Unassigned"], ["breaching", "Near breach"], ["auto", "Auto-tickets"], ["solved", "Solved"], ["all", "All"]];
const CHANNEL: Record<string, string> = { email: "Email", phone: "Phone", in_app: "In-app", chat: "Chat", auto: "Auto-ticket" };
const dur = (m: number | null | undefined) => (m == null ? "—" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${(m / 1440).toFixed(1)}d`);
const slaColor = (m: number | null) => (m == null ? "var(--ink3)" : m < 0 ? "var(--red)" : m <= 60 ? "var(--amber)" : "var(--ink2)");
const short = (e?: string | null) => (e ? e.split("@")[0] : "Unassigned");

/* ------------------------------------------------------------ new ticket */
function NewTicket({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const blank = { subject: "", requester_email: "", body: "", priority: "P3", channel: "email" };
  const [f, setF] = useState(blank);
  const set = (k: keyof typeof blank) => (e: any) => setF({ ...f, [k]: e.target.value });
  const ok = f.subject.trim().length >= 3 && f.requester_email.includes("@") && f.body.trim().length > 0;
  return (
    <Modal open={open} onClose={onClose} title="New ticket">
      <label className="mc-field">Subject<input className="mc-input" value={f.subject} onChange={set("subject")} placeholder="Can't connect Snowflake" /></label>
      <label className="mc-field">Customer email<input className="mc-input" type="email" value={f.requester_email} onChange={set("requester_email")} placeholder="name@company.com" /></label>
      <div className="mc-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <label className="mc-field">Priority
          <select className="mc-select" value={f.priority} onChange={set("priority")}>
            <option value="P1">P1 · urgent (1h first reply)</option><option value="P2">P2 · high (4h)</option>
            <option value="P3">P3 · normal (8h)</option><option value="P4">P4 · low (24h)</option>
          </select>
        </label>
        <label className="mc-field">Came in by
          <select className="mc-select" value={f.channel} onChange={set("channel")}>
            {["email", "phone", "in_app", "chat"].map((c) => <option key={c} value={c}>{CHANNEL[c]}</option>)}
          </select>
        </label>
      </div>
      <label className="mc-field">What they said<textarea className="mc-textarea" rows={5} value={f.body} onChange={set("body")} /></label>
      <ActionButton className="mc-btn p" disabled={!ok} done="Ticket opened" run={async () => {
        const r = await mcPost("/support/tickets", { ...f, subject: f.subject.trim(), requester_email: f.requester_email.trim(), body: f.body.trim() });
        setF(blank);
        onCreated(r.id);
      }}>Open ticket</ActionButton>
      <span className="mc-tip">The ticket is assigned to you and its SLA clock starts now.</span>
    </Modal>
  );
}

/* ------------------------------------------------------------ detail */
function Msg({ m }: { m: any }) {
  if (m.kind === "system") {
    return <div className="mc-mono" style={{ fontSize: 11.5, color: "var(--ink3)", textAlign: "center", padding: "2px 0" }}>{m.body} · {short(m.author)} · {dateTime(m.t)}</div>;
  }
  const st = m.kind === "internal"
    ? { bg: "rgba(242,184,75,.07)", bd: "rgba(242,184,75,.35)", label: "INTERNAL NOTE", c: "var(--amber)" }
    : m.kind === "staff"
      ? { bg: "var(--g-tint)", bd: "var(--g-bd)", label: "GD360", c: "var(--g)" }
      : { bg: "var(--s2)", bd: "var(--line)", label: "CUSTOMER", c: "var(--ink3)" };
  return (
    <div style={{ padding: "12px 14px", borderRadius: 14, background: st.bg, border: `1px solid ${st.bd}`, display: "flex", flexDirection: "column", gap: 6, marginLeft: m.kind === "customer" ? 0 : 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}><span className="mc-lbl" style={{ color: st.c, marginRight: 8 }}>{st.label}</span>{m.author || "—"}</span>
        <span className="mc-mono" style={{ fontSize: 11, color: "var(--ink3)" }}>{dateTime(m.t)}</span>
      </div>
      <span style={{ fontSize: 13.5, lineHeight: 1.55, whiteSpace: "pre-wrap", color: "#D5DEDB" }}>{m.body}</span>
    </div>
  );
}

function TicketDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { data, error, loading, reload } = useMC<any>(`/support/tickets/${id}`);
  const can = useCan()("tickets.write");
  const me = useMe();
  const toast = useToast();
  const [text, setText] = useState("");
  useEffect(() => setText(""), [id]);
  const after = async () => { await reload(); onChanged(); };
  const patch = async (body: any, msg: string) => {
    try {
      await mcPatch(`/support/tickets/${id}`, body);
      toast(msg);
      await after();
    } catch (e: any) {
      const d = e?.response?.data?.detail;
      toast(typeof d === "string" ? d : "That didn't work.", true);
    }
  };

  if (error) return <Card><ErrorBox text={error} retry={reload} /></Card>;
  if (loading && !data) return <Card><Loading rows={3} h={80} /></Card>;
  if (!data) return null;
  const t = data.ticket, cx = data.context;
  const solved = t.status === "solved" || t.status === "closed";
  const tip = can ? undefined : NO;

  return (
    <Card style={{ borderColor: "var(--g-bd)", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <select className="mc-select" style={{ height: 32 }} aria-label="Priority" value={t.priority} disabled={!can} title={tip}
          onChange={(e) => patch({ priority: e.target.value }, `Priority set to ${e.target.value}`)}>
          {["P1", "P2", "P3", "P4"].map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <span className="mc-mono" style={{ fontSize: 12.5, color: "var(--ink2)" }}>#{t.number} · {CHANNEL[t.channel] || t.channel} · opened {ago(t.created_at)}</span>
        <select className="mc-select" style={{ height: 32 }} aria-label="Status" value={t.status} disabled={!can} title={tip}
          onChange={(e) => patch({ status: e.target.value }, `Status set to ${e.target.value}`)}>
          {["open", "pending", "solved", "closed"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <span className="mc-tip">{t.assignee_email ? `Assigned to ${t.assignee_email === me?.email ? "you" : t.assignee_email}` : "Unassigned"}</span>
        {t.assignee_email !== me?.email && (
          <ActionButton className="mc-btn sm" disabled={!can || !me} title={tip} done="Assigned to you" run={async () => {
            await mcPatch(`/support/tickets/${id}`, { assignee_email: me!.email });
            await after();
          }}>Assign to me</ActionButton>
        )}
      </div>
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.3 }}>{t.subject}</h2>
      {t.sla_minutes_left != null && (
        <span className="mc-mono" style={{ fontSize: 12, color: slaColor(t.sla_minutes_left), marginTop: -8 }}>{t.sla_kind} SLA · {minsLabel(t.sla_minutes_left)}</span>
      )}

      <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 8 }}>
        <div style={{ padding: 12, borderRadius: 12, background: "var(--s2)", display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <span className="mc-lbl">PERSON</span>
          {cx.user ? (
            <>
              <span style={{ fontWeight: 700, fontSize: 13.5 }}>{cx.user.name || cx.user.email}</span>
              <span className="mc-tip">{cx.user.email}</span>
              <span className="mc-mono mc-num" style={{ fontSize: 12, color: "var(--ink2)" }}>{cx.user.lifecycle || "—"} · {fmtN(cx.user.chats_30d)} questions 30d · {cx.user.sources} source(s)</span>
            </>
          ) : <span className="mc-tip">{t.requester_email || "No requester"} · no GD360 account with this email.</span>}
        </div>
        <div style={{ padding: 12, borderRadius: 12, background: "var(--s2)", display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <span className="mc-lbl">ACCOUNT</span>
          {cx.account ? (
            <>
              <Link to={`/admin/accounts/${encodeURIComponent(cx.account.key)}`} style={{ fontWeight: 700, fontSize: 13.5, color: "var(--ink)" }}>{cx.account.name} →</Link>
              <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Pill tone={bandTone(cx.account.band)}>{cx.account.health} · {cx.account.band}</Pill>
                <Pill>{cx.account.plan}</Pill>
                <Pill tone="b">fits {cx.account.fit}</Pill>
              </span>
              <span className="mc-tip">{cx.account.users} people</span>
            </>
          ) : <span className="mc-tip">No account linked.</span>}
        </div>
      </div>
      {cx.signals.length > 0 && (
        <div style={{ padding: "12px 14px", borderRadius: 12, border: "1px solid rgba(255,122,107,.35)", background: "rgba(255,122,107,.06)", display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="mc-lbl" style={{ color: "var(--red)" }}>SIGNALS FROM THEIR WORKSPACE</span>
          {cx.signals.map((s: string, i: number) => <span key={i} className="mc-mono" style={{ fontSize: 12, lineHeight: 1.5, color: "#FFC2B8" }}>{s}</span>)}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {data.messages.map((m: any) => <Msg key={m.id} m={m} />)}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <label htmlFor="reply" className="mc-lbl">REPLY TO {(cx.user?.name || t.requester_email || "customer").toUpperCase()}</label>
          <ActionButton className="mc-btn sm" disabled={!can} title={can ? "Uses the thread and their workspace signals" : NO} done="Draft ready — read it before sending" run={async () => {
            const r = await mcPost(`/support/tickets/${id}/draft`);
            setText(r.draft);
          }}>Draft with AI</ActionButton>
        </div>
        <textarea id="reply" className="mc-textarea" rows={5} value={text} onChange={(e) => setText(e.target.value)} disabled={!can}
          placeholder={can ? "Write a reply, or draft one with AI…" : "Your role can read tickets but not reply."} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <ActionButton className="mc-btn p" disabled={!can || !text.trim()} title={tip} done="Reply sent" run={async () => {
            await mcPost(`/support/tickets/${id}/messages`, { body: text.trim(), internal: false });
            setText("");
            await after();
          }}>Send reply</ActionButton>
          <ActionButton className="mc-btn" disabled={!can || !text.trim()} title={tip} done="Internal note added" run={async () => {
            await mcPost(`/support/tickets/${id}/messages`, { body: text.trim(), internal: true });
            setText("");
            await after();
          }}>Add internal note</ActionButton>
          <span style={{ flex: 1 }} />
          {!solved ? (
            <ActionButton className="mc-btn" disabled={!can} title={tip} done="Marked solved" run={async () => {
              await mcPatch(`/support/tickets/${id}`, { status: "solved" });
              await after();
            }}>Mark solved</ActionButton>
          ) : (
            <label className="mc-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>CSAT
              <select className="mc-select" style={{ height: 32 }} value={t.csat || ""} disabled={!can} title={tip}
                onChange={(e) => e.target.value && patch({ csat: Number(e.target.value) }, `CSAT recorded: ${e.target.value}/5`)}>
                <option value="">Not rated</option>
                {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} / 5</option>)}
              </select>
            </label>
          )}
        </div>
        <span className="mc-tip">Sending a reply sets the ticket to pending and stops the first-response clock. Internal notes are only seen by the team.</span>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ screen */
export default function Support() {
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>(params.get("q") || params.get("t") ? "all" : "open");
  const q = params.get("q") || "";
  const [qIn, setQIn] = useState(q);
  useEffect(() => setQIn(q), [q]);
  const sel = params.get("t");
  const { data, error, loading, reload } = useMC<any>(`/support?view=${view}&q=${encodeURIComponent(q)}`);
  const can = useCan()("tickets.write");
  const toast = useToast();
  const [newOpen, setNewOpen] = useState(false);

  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    setParams(p, { replace: true });
  };
  const pick = (id: string) => setParam("t", id);
  // Preselect the first ticket when nothing is chosen yet.
  useEffect(() => {
    if (!sel && data?.tickets?.length) setParam("t", data.tickets[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, sel]);
  const search = (e: FormEvent) => { e.preventDefault(); setParam("q", qIn.trim() || null); };

  const st = data?.stats;
  const counts = st?.counts || {};
  const opts: [View, string][] = VIEWS.map(([k, l]) => [k, counts[k] != null ? `${l} · ${counts[k]}` : l]);

  return (
    <div className="mc-page">
      <PageHead eyebrow="Support" title="Inbox & SLAs" sub="Email, in-app, chat and auto-tickets from failing syncs and automations — with each customer's workspace context.">
        <button type="button" className="mc-btn" onClick={reload}>Refresh</button>
        <ActionButton disabled={!can} title={can ? "Open a ticket for each failing source or automation that doesn't have one" : NO} run={async () => {
          const r = await mcPost("/support/scan");
          toast(r.created ? `${r.created} auto-ticket(s) opened` : "No new problems found");
          reload();
        }}>Scan for problems</ActionButton>
        <button type="button" className="mc-btn p" disabled={!can} title={can ? undefined : NO} onClick={() => setNewOpen(true)}>New ticket</button>
      </PageHead>

      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Loading rows={5} />}
      {st && (
        <section aria-label="Support metrics" className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
          <Kpi label="OPEN" value={fmtN(st.open)} sub={(["P1", "P2", "P3", "P4"] as const).map((p) => `${p} ${st.by_priority[p]}`).join(" · ")} tone={st.by_priority.P1 ? "warn" : undefined} />
          <Kpi label="NEAR BREACH" value={fmtN(counts.breaching)} sub="due within the hour or overdue" tone={counts.breaching ? "warn" : undefined} />
          <Kpi label="FIRST REPLY · 30D" value={dur(st.first_response_median_min)} sub="median" />
          <Kpi label="RESOLUTION · 30D" value={dur(st.resolution_median_min)} sub="median" />
          <Kpi label="SLA MET · 30D" value={fmtPct(st.sla_pct, 0)} sub="first replies on time" tone={st.sla_pct != null && st.sla_pct < 90 ? "warn" : undefined} />
          <Kpi label="CSAT · 30D" value={st.csat == null ? "—" : `${st.csat}/5`} sub={`${st.csat_n} rating(s)`} />
        </section>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
        <Chips label="Ticket view" value={view} onChange={(v) => setView(v)} options={opts} />
        <form onSubmit={search} role="search" style={{ display: "flex", gap: 6, flex: "0 1 320px", minWidth: 0 }}>
          <input className="mc-input" style={{ flex: 1 }} aria-label="Search tickets" placeholder="Subject, email or ticket number" value={qIn} onChange={(e) => setQIn(e.target.value)} />
          <button type="submit" className="mc-btn">Search</button>
          {q && <button type="button" className="mc-btn" onClick={() => setParam("q", null)}>Clear</button>}
        </form>
      </div>

      {data && (
        <div className="mc-row">
          <Card pad={false} style={{ flex: "1 1 340px", padding: 8, gap: 2, maxHeight: "calc(100vh - 140px)", overflowY: "auto" }}>
            {data.tickets.length === 0 && (
              <Empty>{q ? `No tickets match "${q}" in this view.` : view === "open" || view === "all" ? "No tickets yet. Customers can write in from the app, or open one here." : "Nothing in this view."}</Empty>
            )}
            {data.tickets.map((t: any) => {
              const on = t.id === sel;
              return (
                <button key={t.id} type="button" onClick={() => pick(t.id)} aria-current={on}
                  style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", display: "flex", flexDirection: "column", gap: 6, padding: "12px 14px", borderRadius: 14, width: "100%",
                    border: `1px solid ${on ? "var(--g-bd)" : "transparent"}`, background: on ? "var(--g-tint)" : "transparent" }}>
                  <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <Pill tone={prioTone(t.priority)}>{t.priority}</Pill>
                    <span className="mc-mono" style={{ fontSize: 12, color: "var(--ink3)" }}>#{t.number}</span>
                    {t.channel === "auto" && <Pill tone="a">auto</Pill>}
                    <span style={{ flex: 1 }} />
                    <span className="mc-mono mc-num" style={{ fontSize: 11.5, color: slaColor(t.sla_minutes_left), fontWeight: t.sla_minutes_left != null && t.sla_minutes_left < 0 ? 700 : 400 }}>
                      {t.sla_minutes_left != null ? minsLabel(t.sla_minutes_left) : t.status}
                    </span>
                  </span>
                  <span style={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.35 }}>{t.subject}</span>
                  <span style={{ fontSize: 12, color: "var(--ink3)" }}>{t.requester_email || "—"} · {short(t.assignee_email)} · {ago(t.updated_at)}</span>
                </button>
              );
            })}
          </Card>
          <div style={{ flex: "999 1 480px", minWidth: 0 }}>
            {sel ? <TicketDetail key={sel} id={sel} onChanged={reload} /> : <Card><Empty>Pick a ticket to read the thread and reply.</Empty></Card>}
          </div>
        </div>
      )}

      <NewTicket open={newOpen} onClose={() => setNewOpen(false)} onCreated={(id) => { setNewOpen(false); setView("open"); setParam("t", id); reload(); }} />
    </div>
  );
}

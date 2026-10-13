// People: every ticket - who registered, who came, who walked in, how
// likely the rest are to come. Check in at the desk, undo, add a person.
import { useEffect, useRef, useState } from "react";
import { Initiative } from "../api/initiatives";
import { API_URL } from "../api/client";
import { eventApi, errText, Ticket } from "../api/eventos";
import { Banner, Field, Sheet } from "../initiatives/ui";
import { C } from "./charts";
import { Eyebrow, Seg, Skel } from "./kit";

const PAGE = 60;
const FILTERS = [{ k: "", l: "Everyone" }, { k: "registered", l: "Not in yet" }, { k: "checked_in", l: "Checked in" }, { k: "walk_in", l: "Walk-ins" }];

function Prob({ p }: { p: number | null }) {
  if (p === null || p === undefined) return <span className="text-muted">–</span>;
  const v = Math.round(p * 100);
  const col = v >= 65 ? C.good : v >= 40 ? C.warning : C.danger;
  return (
    <span className="inline-flex items-center gap-2 tabular-nums" title="Chance of showing up, from the show-up model">
      <span className="w-12 h-1.5 rounded-full bg-border/60 overflow-hidden"><span className="block h-full rounded-full" style={{ width: `${v}%`, background: col }} /></span>
      <span className="text-caption" style={{ color: col }}>{v}%</span>
    </span>
  );
}

function initials(n: string | null, e: string | null) {
  const s = (n || e || "?").replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((s[0]?.[0] || "?") + (s[1]?.[0] || "")).toUpperCase();
}

export default function PeopleTab({ i }: { i: Initiative }) {
  const [rows, setRows] = useState<Ticket[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [add, setAdd] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", company: "", title: "", tier: "free" });
  const [open, setOpen] = useState<Ticket | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const can = i.can_edit;
  const load = (more = false) => {
    eventApi.tickets(i.id, { q: q || undefined, status: status || undefined, limit: PAGE, offset: more ? rows.length : 0 })
      .then((r) => { setTotal(r.total); setRows(more ? [...rows, ...r.tickets] : r.tickets); }).catch((e) => setErr(errText(e)));
  };
  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => load(false), q ? 250 : 0);
    return () => window.clearTimeout(timer.current);
  }, [q, status, i.id]);
  const op = async (t: Ticket, o: "checkin" | "undo" | "cancel" | "confirm") => {
    setBusy(t.id + o); setErr("");
    try {
      const n = await eventApi.ticketOp(i.id, t.id, o);
      setRows((rs) => rs.map((x) => (x.id === t.id ? n : x)));
      if (open?.id === t.id) setOpen(n);
    } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  };
  const save = async () => {
    setErr("");
    try { const t = await eventApi.addTicket(i.id, form); setAdd(false); setForm({ name: "", email: "", company: "", title: "", tier: "free" }); setRows((rs) => [t, ...rs]); setTotal((n) => (n ?? 0) + 1); setOpen(t); }
    catch (e) { setErr(errText(e)); }
  };
  return (
    <div className="flex flex-col gap-5" data-screen="people">
      {err && <Banner kind="error" onClose={() => setErr("")}>{err}</Banner>}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1"><Eyebrow>People · {total === null ? "…" : total.toLocaleString()} {status ? FILTERS.find((f) => f.k === status)?.l.toLowerCase() : "tickets"}</Eyebrow>
          <h2 className="m-0 text-[20px] font-semibold text-text">Everyone with a ticket - and who actually came</h2></div>
        {can && <button type="button" className="btn-primary text-sm" onClick={() => setAdd(true)}>Add a person</button>}
      </div>
      <div className="flex gap-3 flex-wrap items-center">
        <input className="input !w-[320px] max-w-full" placeholder="Search name, email, company or ticket code" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
        <Seg label="Filter people" value={status} onChange={setStatus} items={FILTERS.map((f) => ({ id: f.k, label: f.l }))} />
      </div>
      <div className="rounded-card border border-border bg-surface overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-ui min-w-[860px]">
            <thead><tr className="text-left text-caption text-muted border-b border-border bg-surface2/50">
              <th className="font-normal px-4 py-2.5">Person</th><th className="font-normal px-3">Company</th><th className="font-normal px-3">Ticket</th>
              <th className="font-normal px-3">Came from</th><th className="font-normal px-3">Show-up chance</th><th className="font-normal px-3">Status</th><th className="px-3" /></tr></thead>
            <tbody>
              {total === null && <tr><td colSpan={7} className="p-4"><Skel h={220} /></td></tr>}
              {rows.map((t) => (
                <tr key={t.id} className="border-b border-border last:border-b-0 hover:bg-surface2/40 cursor-pointer" onClick={() => setOpen(t)} data-ticket={t.code}>
                  <td className="px-4 py-2.5"><div className="flex items-center gap-2.5 min-w-0">
                    <span className="w-8 h-8 shrink-0 rounded-full grid place-items-center text-[11px] font-semibold" style={{ background: "rgb(var(--color-primary) / 0.14)", color: C.primary }}>{initials(t.name, t.email)}</span>
                    <span className="min-w-0"><span className="block truncate text-text">{t.name || t.email || "Guest"}{t.icp ? <span className="ml-1.5 text-[10.5px] px-1.5 py-[1px] rounded-full border border-tint-border bg-tint text-brand-ink">ICP</span> : null}</span>
                      <span className="block truncate text-caption text-muted">{t.title || t.email || ""}</span></span></div></td>
                  <td className="px-3 truncate max-w-[180px] text-secondary">{t.company || "–"}</td>
                  <td className="px-3"><span className="font-mono text-caption text-muted">{t.code}</span><span className="ml-2 text-caption capitalize text-secondary">{t.tier}</span></td>
                  <td className="px-3 text-caption text-secondary capitalize">{t.walk_in ? "walk-in" : (t.source || "direct").replace(/_/g, " ")}</td>
                  <td className="px-3">{t.status === "checked_in" ? <span className="text-caption text-muted">came</span> : <Prob p={t.show_prob} />}</td>
                  <td className="px-3"><StatusPill t={t} /></td>
                  <td className="px-3 text-right" onClick={(e) => e.stopPropagation()}>
                    {can && t.status === "registered" && <button type="button" className="btn-secondary !py-1 !px-2.5 text-[12px]" disabled={busy === t.id + "checkin"} onClick={() => op(t, "checkin")}>Check in</button>}
                    {can && t.status === "checked_in" && <button type="button" className="text-caption text-muted hover:text-text" disabled={busy === t.id + "undo"} onClick={() => op(t, "undo")}>Undo</button>}
                  </td>
                </tr>
              ))}
              {total === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-caption text-muted">{q || status ? "Nobody matches." : "No tickets yet - share the registration link, or add people here."}</td></tr>}
            </tbody>
          </table>
        </div>
        {total !== null && rows.length < total && (
          <div className="border-t border-border px-4 py-2.5 flex items-center justify-between text-caption text-muted">
            <span>Showing {rows.length.toLocaleString()} of {total.toLocaleString()}</span>
            <button type="button" className="btn-secondary !py-1 text-[12px]" onClick={() => load(true)}>Show more</button>
          </div>
        )}
      </div>

      <Sheet open={!!open} onClose={() => setOpen(null)} title={open ? open.name || open.email || "Ticket" : ""}
        footer={open && can ? <>
          {open.status !== "cancelled" && <button type="button" className="btn-secondary text-sm !text-danger mr-auto" onClick={() => op(open, "cancel")}>Cancel ticket</button>}
          {open.status === "registered" && !open.confirmed && <button type="button" className="btn-secondary text-sm" onClick={() => op(open, "confirm")}>Mark confirmed</button>}
          {open.status === "registered" && <button type="button" className="btn-primary text-sm" onClick={() => op(open, "checkin")}>Check in</button>}
          {open.status === "checked_in" && <button type="button" className="btn-secondary text-sm" onClick={() => op(open, "undo")}>Undo check-in</button>}
        </> : undefined}>
        {open && (
          <div className="flex flex-col gap-4">
            <div className="flex gap-4 items-start">
              <img src={`${API_URL}/public/eventos/ticket/${open.code}/qr.svg`} alt={`Ticket QR ${open.code}`} className="w-[118px] h-[118px] rounded-ctl border border-border bg-white p-1.5" />
              <div className="flex flex-col gap-1 min-w-0">
                <span className="font-mono text-[18px] tracking-wider text-text">{open.code}</span>
                <span className="text-caption text-secondary">{[open.title, open.company].filter(Boolean).join(" · ") || "–"}</span>
                <span className="text-caption text-muted">{open.email || "no email"}</span>
                <StatusPill t={open} />
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-ui m-0">
              {[["Tier", open.tier], ["Came from", open.walk_in ? "walk-in" : open.source || "direct"], ["Registered", open.registered_at ? new Date(open.registered_at).toLocaleString() : "–"],
                ["Checked in", open.checked_in_at ? `${new Date(open.checked_in_at).toLocaleString()}${open.gate ? ` · ${open.gate}` : ""}` : "–"],
                ["Confirmed", open.confirmed ? "yes" : "not yet"], ["Show-up chance", open.show_prob !== null ? `${Math.round(open.show_prob * 100)}%` : "–"],
                ["Watched online", open.online_minutes ? `${Math.round(open.online_minutes)} min` : "–"], ["Engagement", open.engagement !== null ? String(Math.round(open.engagement)) : "–"]].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-0.5"><dt className="text-caption text-muted">{k}</dt><dd className="m-0 text-text capitalize">{v}</dd></div>
              ))}
            </dl>
            <a className="text-caption text-brand-ink" href={`${window.location.origin}/t/${open.code}`} target="_blank" rel="noreferrer">Open their ticket page ↗</a>
          </div>
        )}
      </Sheet>

      <Sheet open={add} onClose={() => setAdd(false)} title="Add a person"
        footer={<><button type="button" className="btn-secondary text-sm" onClick={() => setAdd(false)}>Cancel</button>
          <button type="button" className="btn-primary text-sm" disabled={!form.name.trim() && !form.email.trim()} onClick={save}>Add ticket</button></>}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email"><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Company"><input className="input" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} /></Field>
          <Field label="Title"><input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        </div>
        <Field label="Ticket"><select className="input" value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })}>
          {["free", "paid", "vip", "speaker", "sponsor", "press", "staff"].map((t) => <option key={t} value={t}>{t}</option>)}</select></Field>
        <div className="text-caption text-muted">They're added to your people too, and get a ticket QR they can show at the door.</div>
      </Sheet>
    </div>
  );
}

function StatusPill({ t }: { t: Ticket }) {
  const m: Record<string, [string, string]> = { checked_in: ["Checked in", C.good], registered: [t.confirmed ? "Confirmed" : "Registered", t.confirmed ? C.blue : C.muted], cancelled: ["Cancelled", C.danger] };
  const [l, c] = m[t.status] || [t.status, C.muted];
  return <span className="inline-flex items-center gap-1.5 text-caption" style={{ color: c }}><span className="w-1.5 h-1.5 rounded-full" style={{ background: c }} />{l}</span>;
}

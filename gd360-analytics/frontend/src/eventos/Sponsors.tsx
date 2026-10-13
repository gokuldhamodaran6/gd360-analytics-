// Sponsors: each sponsor's leads against their own goal, booth traffic,
// renewal - and a private live report link for each of them.
import { useEffect, useState } from "react";
import { Initiative } from "../api/initiatives";
import { eventApi, errText, SponsorRow, Sponsors } from "../api/eventos";
import { Banner, CopyField, Field, Sheet } from "../initiatives/ui";
import { C, HBar } from "./charts";
import { Card, Eyebrow, money, Skel } from "./kit";
import { SponsorReportView } from "./SponsorReportView";

const RENEW: Record<string, { label: string; color: string }> = {
  signed: { label: "renewed", color: C.good }, verbal: { label: "likely", color: C.blue }, declined: { label: "not renewing", color: C.danger }, none: { label: "–", color: C.muted },
};

export default function SponsorsTab({ i }: { i: Initiative }) {
  const [d, setD] = useState<Sponsors | null>(null);
  const [err, setErr] = useState("");
  const [add, setAdd] = useState(false);
  const [form, setForm] = useState({ name: "", tier: "", booth: "", goal_leads: "", amount: "", contact_email: "" });
  const [open, setOpen] = useState<SponsorRow | null>(null);
  const [rep, setRep] = useState<any>(null);
  const load = () => { eventApi.sponsors(i.id).then(setD).catch((e) => setErr(errText(e))); };
  useEffect(load, [i.id]);
  useEffect(() => {
    if (!open) { setRep(null); return; }
    eventApi.sponsorReport(i.id, open.id).then(setRep).catch((e) => setErr(errText(e)));
  }, [open, i.id]);
  const save = async () => {
    try {
      await eventApi.addSponsor(i.id, { ...form, goal_leads: form.goal_leads ? Number(form.goal_leads) : null, amount: form.amount ? Number(form.amount) : null });
      setAdd(false); setForm({ name: "", tier: "", booth: "", goal_leads: "", amount: "", contact_email: "" }); load();
    } catch (e) { setErr(errText(e)); }
  };
  if (!d) return <div className="grid gap-4"><Skel h={110} /><Skel h={360} /></div>;
  const cur = d.event.currency;
  const maxLeads = Math.max(1, ...d.sponsors.map((s) => Math.max(s.leads, s.goal || 0)));
  return (
    <div className="flex flex-col gap-5" data-screen="sponsors">
      {err && <Banner kind="error" onClose={() => setErr("")}>{err}</Banner>}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1"><Eyebrow>Sponsors and exhibitors</Eyebrow>
          <h2 className="m-0 text-[20px] font-semibold text-text">Every sponsor against their own goal - and a report they can open themselves</h2></div>
        {d.can_edit && <button type="button" className="btn-primary text-sm" onClick={() => setAdd(true)}>Add a sponsor</button>}
      </div>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        {[["Sponsors", String(d.sponsors.length)], ["Leads scanned", d.total_leads.toLocaleString()], ["Average per sponsor", d.avg !== null ? String(Math.round(d.avg)) : "–"],
          ["Renewing", `${d.renewing} of ${d.sponsors.length}`]].map(([l, v]) => (
          <div key={l} className="rounded-card border border-border bg-surface px-4 py-3.5 flex flex-col gap-1"><span className="text-caption text-muted">{l}</span>
            <span className="text-[24px] font-semibold tabular-nums leading-tight">{v}</span></div>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Card title="Leads against each sponsor's goal" sub="Tick = their goal · tap a sponsor for their report">
          {d.sponsors.length ? (
            <div className="flex flex-col">
              {d.sponsors.map((s) => {
                const pct = s.goal ? s.leads / s.goal : null;
                const col = pct === null ? C.primary : pct >= 1 ? C.good : pct >= 0.75 ? C.warning : C.danger;
                return (
                  <button key={s.id} type="button" onClick={() => setOpen(s)} className="ui-focus text-left grid grid-cols-[minmax(0,170px)_1fr_auto] gap-3 items-center py-2.5 border-t border-border first:border-t-0 hover:bg-surface2/60 rounded-[6px] px-1" data-sponsor={s.name}>
                    <div className="min-w-0"><div className="text-ui text-text truncate">{s.name}</div><div className="text-caption text-muted">{s.tier || "–"}{s.booth ? ` · booth ${s.booth}` : ""}</div></div>
                    <div className="relative h-2.5 rounded-full bg-border/60">
                      <div className="h-full rounded-full" style={{ width: `${(100 * s.leads) / maxLeads}%`, background: col }} />
                      {s.goal ? <span className="absolute -top-1 w-[2px] h-[18px] bg-text/70" style={{ left: `${(100 * s.goal) / maxLeads}%` }} /> : null}
                    </div>
                    <div className="text-right min-w-[120px]"><span className="text-ui tabular-nums text-text">{s.leads}</span><span className="text-caption text-muted"> / {s.goal ?? "–"}</span>
                      <div className="text-[11px]" style={{ color: RENEW[s.renewal]?.color }}>{RENEW[s.renewal]?.label}</div></div>
                  </button>
                );
              })}
            </div>
          ) : <div className="text-caption text-muted">No sponsors yet. Add them with their lead goal; each gets a lead-scan link for their booth staff and a live report.</div>}
        </Card>
        <Card title="Who sponsors met" sub="Seniority of all scanned leads">
          <div className="flex flex-col gap-2">{d.seniority.map((x) => <HBar key={x.label} label={x.label} value={x.n} max={Math.max(...d.seniority.map((y) => y.n), 1)} />)}</div>
          {!d.seniority.length && <div className="text-caption text-muted">Leads appear as booths scan badges.</div>}
        </Card>
      </div>

      <Sheet open={!!open} onClose={() => setOpen(null)} title={open ? `${open.name} - their report` : ""} wide
        footer={open && d.can_edit ? <>
          <select className="input !w-auto text-caption mr-auto" value={open.renewal} aria-label="Renewal"
            onChange={async (e) => { await eventApi.patchSponsor(i.id, open.id, { renewal: e.target.value }); setOpen({ ...open, renewal: e.target.value }); load(); }}>
            <option value="none">Renewal: not asked</option><option value="verbal">Renewal: likely</option><option value="signed">Renewal: signed</option><option value="declined">Renewal: not renewing</option>
          </select>
          <button type="button" className="btn-secondary text-sm !text-danger" onClick={async () => { await eventApi.deleteSponsor(i.id, open.id); setOpen(null); load(); }}>Remove</button>
        </> : undefined}>
        {open && (<>
          <div className="flex flex-col gap-2">
            <div className="text-caption text-muted">Their private report (no login) - send it to {open.contact_email || "them"}:</div>
            <CopyField value={open.report_link} label="Report link" testId="sp-report" />
            <div className="text-caption text-muted mt-1">Lead-scan link for their booth staff (works offline, counts only for {open.name}):</div>
            <CopyField value={open.scan_link} label="Lead scan link" testId="sp-scan" />
          </div>
          {rep ? <SponsorReportView r={rep} currency={cur} /> : <Skel h={300} />}
        </>)}
      </Sheet>
      <Sheet open={add} onClose={() => setAdd(false)} title="Add a sponsor"
        footer={<><button type="button" className="btn-secondary text-sm" onClick={() => setAdd(false)}>Cancel</button>
          <button type="button" className="btn-primary text-sm" disabled={!form.name.trim()} onClick={save}>Add</button></>}>
        <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tier"><input className="input" value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })} placeholder="Gold" /></Field>
          <Field label="Booth"><input className="input" value={form.booth} onChange={(e) => setForm({ ...form, booth: e.target.value })} /></Field>
          <Field label="Lead goal"><input className="input" inputMode="numeric" value={form.goal_leads} onChange={(e) => setForm({ ...form, goal_leads: e.target.value })} /></Field>
          <Field label={`Paid (${cur})`}><input className="input" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
        </div>
        <Field label="Their email (for the report)"><input className="input" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} /></Field>
        <div className="text-caption text-muted">Income from sponsors counts on the P&amp;L: {money(d.sponsors.reduce((s, x) => s + (x.amount || 0), 0), cur)} so far.</div>
      </Sheet>
    </div>
  );
}

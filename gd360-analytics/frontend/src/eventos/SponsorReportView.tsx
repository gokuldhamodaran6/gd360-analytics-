// One sponsor's report - shown inside GD360 and on the sponsor's own
// private link (no login).
import { C, HBar } from "./charts";
import { money } from "./kit";

export function SponsorReportView({ r, currency = "INR" }: { r: any; currency?: string }) {
  const sp = r.sponsor;
  const hours: number[] = r.by_hour?.hours || [];
  const days: string[] = r.by_hour?.days || [];
  const rows: number[][] = r.by_hour?.rows || [];
  const maxH = Math.max(1, ...rows.flat());
  const dayCol = [C.primary, C.blue, C.violet];
  const pct = sp.goal ? Math.round((100 * r.leads) / sp.goal) : null;
  return (
    <div className="flex flex-col gap-4" data-sponsor-report="">
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        {[["Leads", String(r.leads), sp.goal ? `goal ${sp.goal} · ${pct}%` : "", pct !== null && pct >= 100 ? C.good : undefined],
          ["Hot leads", String(r.hot), "rated 4 or 5 by your staff", undefined],
          ["Booth visits", r.visits.toLocaleString(), r.dwell_min ? `average stay ${r.dwell_min} min` : "", undefined],
          ["Renewal", sp.renewal === "signed" ? "Renewed" : sp.renewal === "verbal" ? "Likely" : sp.renewal === "declined" ? "No" : "–", sp.renewal_at ? new Date(sp.renewal_at).toLocaleDateString() : "", sp.renewal === "signed" ? C.good : undefined],
        ].map(([l, v, s, c]) => (
          <div key={l as string} className="rounded-card border border-border bg-surface px-4 py-3 flex flex-col gap-0.5"><span className="text-caption text-muted">{l}</span>
            <span className="text-[22px] font-semibold tabular-nums" style={{ color: c as string | undefined }}>{v}</span><span className="text-caption text-secondary">{s}</span></div>
        ))}
      </div>
      {hours.length > 0 && (
        <div className="rounded-card border border-border bg-surface p-4 flex flex-col gap-3">
          <div className="text-ui font-medium text-text">Booth visits by hour</div>
          <div className="flex items-end gap-1.5 h-[150px]" role="img" aria-label="Booth visits by hour and day">
            {hours.map((h, hi) => (
              <div key={h} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                <div className="flex items-end gap-[3px] h-[128px] w-full justify-center">
                  {days.map((d, di) => (
                    <div key={d} title={`${d} ${h}:00 - ${rows[di][hi]} visits`} className="w-full max-w-[16px] rounded-t-[3px]"
                      style={{ height: `${(100 * rows[di][hi]) / maxH}%`, background: dayCol[di % 3] }} />
                  ))}
                </div>
                <span className="font-mono text-[10px] text-muted">{h}:00</span>
              </div>
            ))}
          </div>
          <div className="flex gap-4">{days.map((d, k) => <span key={d} className="inline-flex items-center gap-1.5 text-caption text-secondary"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: dayCol[k % 3] }} />Day {k + 1}</span>)}</div>
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-card border border-border bg-surface p-4 flex flex-col gap-2">
          <div className="text-ui font-medium text-text">Who you met</div>
          {(r.seniority || []).map((x: any) => <HBar key={x.label} label={x.label} value={x.n} max={Math.max(...r.seniority.map((y: any) => y.n), 1)} right={`${Math.round((100 * x.n) / Math.max(r.leads, 1))}%`} />)}
          {!r.seniority?.length && <div className="text-caption text-muted">Leads show here as your staff scan badges.</div>}
        </div>
        <div className="rounded-card border border-border bg-surface p-4 flex flex-col gap-2">
          <div className="text-ui font-medium text-text">What they asked about</div>
          <div className="flex flex-wrap gap-1.5">{(r.interests || []).map(([k, n]: [string, number]) => (
            <span key={k} className="h-6 px-2 rounded-full border border-tint-border bg-tint text-caption inline-flex items-center gap-1.5">{k}<b className="tabular-nums">{n}</b></span>))}</div>
          {r.crm && (
            <div className="mt-2 grid grid-cols-2 gap-3 border-t border-border pt-3">
              <div><div className="text-caption text-muted">Pipeline from your leads (your CRM)</div><div className="text-[18px] font-semibold text-good">{money(r.crm.pipeline, currency)}</div></div>
              <div><div className="text-caption text-muted">Cost per qualified lead</div><div className="text-[18px] font-semibold">{money(r.crm.cost_per_lead, currency, true)}</div></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

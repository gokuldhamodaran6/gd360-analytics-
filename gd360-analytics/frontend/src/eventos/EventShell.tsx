// 2026-10-13 (round 42): Event OS - the page for an event or webinar
// initiative. Every screen of the event in one place, before, during and
// after: Event 360, the success contract, growth, buzz, demand, live,
// sponsors and the A-to-Z report - plus the plan, people, team and setup.
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Initiative, initiativesApi, errorText } from "../api/initiatives";
import { api } from "../api/client";
import { eventApi, Overview } from "../api/eventos";
import { Banner, CopyField, Sheet, Tabs } from "../initiatives/ui";
import PlanTab from "../initiatives/PlanTab";
import TeamTab from "../initiatives/TeamTab";
import TrackingTab from "../initiatives/TrackingTab";
import CampaignsPanel from "../initiatives/CampaignsPanel";
import UpdatesTab from "../initiatives/UpdatesTab";
import Assistant from "../initiatives/Assistant";
import { Ring } from "./charts";
import { LiveDot, PhaseStepper, localWhen } from "./kit";
import Overview360 from "./Overview360";
import Expectations from "./Expectations";
import GrowthTab from "./Growth";
import BuzzTab from "./Buzz";
import DemandTab from "./Demand";
import LiveTab from "./Live";
import SponsorsTab from "./Sponsors";
import ReportTab from "./Report";
import SetupTab from "./Setup";
import PeopleTab from "./People";

export type EvTab = "overview" | "success" | "growth" | "buzz" | "demand" | "live" | "sponsors" | "report" | "plan" | "people" | "team"
  | "campaigns" | "links" | "log" | "setup";

export default function EventShell({ i, reload, onError }: { i: Initiative; reload: () => void; onError: (s: string) => void }) {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const tab = (params.get("tab") as EvTab) || "overview";
  const [ov, setOv] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  const [share, setShare] = useState(false);
  const [assistant, setAssistant] = useState(false);

  const loadOv = useCallback(() => {
    eventApi.overview(i.id).then(setOv).catch((e) => setErr(errorText(e, "Couldn't load the event.")));
  }, [i.id]);
  useEffect(loadOv, [loadOv]);
  useEffect(() => {
    if (ov?.event.phase_now !== "during") return;
    const t = window.setInterval(loadOv, 60000);
    return () => window.clearInterval(t);
  }, [ov?.event.phase_now, loadOv]);

  const setTab = (t: EvTab) => {
    const p = new URLSearchParams(params);
    if (t === "overview") p.delete("tab");
    else p.set("tab", t);
    setParams(p, { replace: true });
    window.scrollTo({ top: 0 });
  };
  const ev = ov?.event;
  const sc = ov?.score;
  const live = ev?.phase_now === "during";
  const scoreVal = sc ? (sc.now.score ?? sc.predicted?.median ?? null) : null;
  const predicted = sc ? sc.now.score === null : false;
  const tabs: { id: EvTab; label: string; badge?: number | string | null }[] = [
    { id: "overview", label: "Event 360" },
    { id: "success", label: "Success", badge: sc && sc.total > sc.signed ? `${sc.total - sc.signed} to sign` : null },
    { id: "growth", label: "Growth" },
    { id: "buzz", label: "Buzz", badge: ov?.values.review_queue || null },
    { id: "demand", label: "Demand" },
    { id: "live", label: live ? "● Live" : "Live" },
    ...(ev?.physical !== false ? [{ id: "sponsors" as EvTab, label: "Sponsors" }] : []),
    { id: "report", label: "Report" },
    { id: "plan", label: "Plan", badge: i.overdue || null },
    { id: "people", label: "People" },
    { id: "team", label: "Team" },
    { id: "campaigns", label: "Emails" },
    { id: "links", label: "Links" },
    { id: "log", label: "Log" },
    { id: "setup", label: "Setup", badge: ov && !ev?.sample && ov.setup.ready < 100 ? `${ov.setup.ready}%` : null },
  ];
  const current = tabs.some((t) => t.id === tab) ? tab : "overview";

  return (
    <>
      <header className="px-4 sm:px-8 pt-16 lg:pt-6 border-b border-border flex flex-col gap-4 relative overflow-hidden" data-event-header="">
        <div className="pointer-events-none absolute -top-24 right-0 w-[640px] h-[260px] opacity-70"
          style={{ background: "radial-gradient(closest-side, rgb(var(--color-primary) / 0.10), transparent)" }} />
        <div className="flex flex-wrap justify-between items-start gap-5 relative">
          <div className="flex flex-col gap-2 min-w-0 flex-[1_1_480px]">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
              <Link to="/initiatives" className="hover:text-text">Initiatives</Link> / Event OS{ev ? ` · ${ev.format_label}` : ""}
            </span>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="m-0 text-[22px] sm:text-[26px] font-semibold tracking-tight text-text text-balance">{i.title}</h1>
              {live && <LiveDot />}
              {ev?.sample && <span className="h-6 px-2.5 rounded-full border border-warning-border bg-warning-fill text-warning text-[11.5px] inline-flex items-center">sample data</span>}
            </div>
            <div className="flex items-center gap-x-4 gap-y-2 flex-wrap text-ui text-secondary">
              {ev && <PhaseStepper now={ev.phase_now} />}
              {ev?.windows.start_local && <span>{localWhen(ev.windows.start_local)}</span>}
              {ev?.days_to_go !== null && ev?.days_to_go !== undefined && ev.days_to_go > 0 && <span className="text-muted">{ev.days_to_go} days to go</span>}
              {i.location && <span className="text-muted truncate max-w-[360px]">{i.location}</span>}
            </div>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            {sc && (
              <button type="button" onClick={() => setTab("success")} className="ui-focus flex items-center gap-3 rounded-card border border-border bg-surface/80 backdrop-blur pl-2 pr-4 py-2 hover:border-border-strong text-left" data-score-chip="">
                <Ring value={scoreVal} size={58} stroke={6} color={predicted ? "rgb(var(--color-kind-analysis))" : "rgb(var(--color-primary))"} />
                <span className="flex flex-col">
                  <span className="text-caption text-muted">{predicted ? "Predicted success" : "Event success score"}</span>
                  <span className="text-ui text-text">{predicted ? (sc.predicted?.p10 !== null && sc.predicted?.p10 !== undefined ? `range ${sc.predicted.p10}–${sc.predicted.p90}` : "add the goals") : `${sc.now.confidence}% backed by counted numbers`}</span>
                </span>
              </button>
            )}
            <div className="flex gap-2 flex-wrap">
              <button type="button" className="btn-secondary text-sm" onClick={() => setAssistant(true)}>Ask about this</button>
              {ov && <a className="btn-secondary text-sm" href={ov.links.staff} target="_blank" rel="noreferrer" data-open-staff="">Staff app ↗</a>}
              <button type="button" className="btn-secondary text-sm" onClick={() => setShare(true)}>Share</button>
              <button type="button" className="btn-primary text-sm" onClick={() => setTab("report")}>Export A–Z</button>
            </div>
          </div>
        </div>
        <Tabs tabs={tabs} value={current} onChange={setTab} label="Event sections" />
      </header>

      <main className="px-4 sm:px-8 py-6 pb-24 flex flex-col gap-5 min-w-0">
        {err && <Banner kind="error" onClose={() => setErr("")}>{err}</Banner>}
        {ev?.sample && current === "overview" && (
          <Banner kind="warning">This is a sample event with made-up people, posts and deals, so you can explore every screen. Nothing here touches your CRM. Delete it from Setup when you're done.</Banner>
        )}
        {current === "overview" && <Overview360 i={i} ov={ov} reload={loadOv} goto={setTab} />}
        {current === "success" && <Expectations i={i} onChanged={loadOv} />}
        {current === "growth" && <GrowthTab i={i} />}
        {current === "buzz" && <BuzzTab i={i} onChanged={loadOv} />}
        {current === "demand" && <DemandTab i={i} />}
        {current === "live" && <LiveTab i={i} />}
        {current === "sponsors" && <SponsorsTab i={i} />}
        {current === "report" && <ReportTab i={i} />}
        {current === "plan" && <PlanTab i={i} reload={reload} onError={onError} />}
        {current === "people" && <PeopleTab i={i} />}
        {current === "team" && <TeamTab i={i} onError={onError} />}
        {current === "campaigns" && <CampaignsPanel workspaceId={i.workspace_id} initiative={i} onChanged={reload} onError={onError} />}
        {current === "links" && <TrackingTab i={i} reload={reload} onError={onError} />}
        {current === "log" && <UpdatesTab i={i} reload={reload} onError={onError} />}
        {current === "setup" && <SetupTab i={i} onChanged={() => { loadOv(); reload(); }} onDeleted={() => nav("/initiatives")} />}
      </main>
      <Assistant open={assistant} onClose={() => setAssistant(false)} i={i} onActed={reload} />
      <ShareSheet open={share} onClose={() => setShare(false)} i={i} ov={ov} onChanged={loadOv} />
    </>
  );
}

function ShareSheet({ open, onClose, i, ov, onChanged }: { open: boolean; onClose: () => void; i: Initiative; ov: Overview | null; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!open) return;
    for (const w of ["registration", "staff", "survey"]) {
      api.get(`/initiatives/${i.id}/eventos/qr.svg`, { params: { what: w }, responseType: "blob" })
        .then((r) => setQr((x) => ({ ...x, [w]: URL.createObjectURL(r.data as Blob) }))).catch(() => undefined);
    }
  }, [open, i.id]);
  if (!ov) return null;
  const toggle = async () => {
    setBusy(true); setErr("");
    try { await eventApi.patchConfig(i.id, { share_enabled: !ov.links.share_enabled }); onChanged(); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  const rows: { key: string; label: string; help: string; url: string | null }[] = [
    { key: "registration", label: "Registration page", help: "Every sign-up gets a ticket with a QR for the door.", url: ov.links.registration },
    { key: "staff", label: "Staff phone app", help: "Check-in, walk-ins in 8 seconds, session doors, queue counts. Works offline.", url: ov.links.staff },
    { key: "survey", label: "Two-question survey", help: "NPS and one line. Answers land on the report.", url: ov.links.survey },
  ];
  return (
    <Sheet open={open} onClose={onClose} title="Share and links" wide>
      {err && <Banner kind="error">{err}</Banner>}
      <div className="rounded-card border border-border p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div><div className="text-ui font-medium text-text">Live Event 360 link</div>
            <div className="text-caption text-muted">Read-only, no login - for the CEO or a sponsor. Always current. Turn it off any time.</div></div>
          <button type="button" className={ov.links.share_enabled ? "btn-secondary text-sm" : "btn-primary text-sm"} onClick={toggle} disabled={busy || !ov.can_edit}>
            {ov.links.share_enabled ? "Turn off" : "Turn on"}</button>
        </div>
        {ov.links.share && <CopyField value={ov.links.share} label="Share link" testId="share" />}
      </div>
      {rows.map((r) => (
        <div key={r.key} className="rounded-card border border-border p-4 flex gap-4 items-start">
          {qr[r.key] ? <img src={qr[r.key]} alt={`QR code for the ${r.label}`} className="w-[92px] h-[92px] rounded-[8px] bg-white p-1 shrink-0" /> : <div className="w-[92px] h-[92px] rounded-[8px] bg-surface2 shrink-0" />}
          <div className="min-w-0 flex-1 flex flex-col gap-2">
            <div><div className="text-ui font-medium text-text">{r.label}</div><div className="text-caption text-muted">{r.help}</div></div>
            {r.url && <CopyField value={r.url} label={r.label} testId={r.key} />}
            {qr[r.key] && <a href={qr[r.key]} download={`${r.key}-qr.svg`} className="text-caption text-brand-ink hover:underline">Download QR (SVG, prints sharp)</a>}
          </div>
        </div>
      ))}
    </Sheet>
  );
}

export function useInitiativeStatus(i: Initiative, onChanged: () => void) {
  return async (status: string) => { await initiativesApi.patch(i.id, { status }); onChanged(); };
}

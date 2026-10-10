// 2026-10-10: Accounts - the account-based marketing centre. Your ideal
// customer profile, every target account scored and tiered, their people,
// every signal (website, email, events, meetings, outreach), campaigns, and
// the sources that feed it: CSV exports from ZoomInfo / Apollo / Salesforce /
// LinkedIn / Luma, Apollo and HubSpot connections, IPinfo, and the website
// snippet - none of them required.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { AccountRow, downloadBlob, errorText, gtmApi, Icp, ImportPreview, Overview, Profile } from "../api/initiatives";
import { Banner, CopyField, Empty, Field, fmt, fmtDate, Funnel, Heat, Section, Sheet, StackBars, Stat, Tabs, Tier } from "../initiatives/ui";
import AccountDrawer from "../initiatives/AccountDrawer";
import CampaignsPanel from "../initiatives/CampaignsPanel";

type TabId = "overview" | "accounts" | "people" | "campaigns" | "sources" | "icp";

export default function Accounts() {
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as TabId) || "overview";
  const account = params.get("account");
  const [error, setError] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const loadProfile = useCallback(() => { if (activeWorkspaceId) gtmApi.profile(activeWorkspaceId).then(setProfile).catch((e) => setError(errorText(e))); }, [activeWorkspaceId]);
  useEffect(loadProfile, [loadProfile]);

  const set = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    setParams(p, { replace: k === "account" ? false : true });
  };
  const ws = activeWorkspaceId || "";

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="px-4 sm:px-8 pt-16 lg:pt-6 border-b border-border flex flex-col gap-4">
          <div className="flex flex-wrap justify-between items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted"><Link to="/initiatives" className="hover:text-text">Initiatives</Link> / Accounts</span>
              <h1 className="m-0 text-[24px] font-semibold tracking-tight text-text">Accounts</h1>
              <p className="m-0 text-ui text-secondary max-w-[680px]">Your target accounts scored against your ideal customer profile, the people at each one, and every signal they send - website visits, email, events, meetings and your team's outreach.</p>
            </div>
            {profile && !profile.icp_set && <button type="button" className="btn-primary text-sm" onClick={() => set("tab", "icp")}>Define your ideal customer</button>}
          </div>
          <Tabs<TabId> label="Accounts sections" value={tab} onChange={(t) => set("tab", t === "overview" ? null : t)}
            tabs={[{ id: "overview", label: "Overview" }, { id: "accounts", label: "Accounts" }, { id: "people", label: "People" }, { id: "campaigns", label: "Campaigns" },
              { id: "sources", label: "Sources" }, { id: "icp", label: "ICP & sender" }]} />
        </header>
        <main className="px-4 sm:px-8 py-6 pb-20 flex flex-col gap-5 min-w-0">
          {error && <Banner kind="error" onClose={() => setError("")}>{error}</Banner>}
          {!ws ? <div className="h-40 rounded-card bg-surface2 animate-pulse" /> : (
            <>
              {tab === "overview" && <OverviewView ws={ws} open={(id) => set("account", id)} goto={(t) => set("tab", t)} onError={setError} />}
              {tab === "accounts" && <AccountsView ws={ws} open={(id) => set("account", id)} onError={setError} />}
              {tab === "people" && <PeopleView ws={ws} open={(id) => set("account", id)} onError={setError} />}
              {tab === "campaigns" && <CampaignsPanel workspaceId={ws} onError={setError} />}
              {tab === "sources" && <SourcesView ws={ws} profile={profile} reload={loadProfile} onError={setError} />}
              {tab === "icp" && <IcpView ws={ws} profile={profile} reload={loadProfile} onError={setError} />}
            </>
          )}
        </main>
      </div>
      {account && <AccountDrawer id={account} ws={ws} onClose={() => set("account", null)} onError={setError} />}
    </div>
  );
}

// ------------------------------------------------------------- overview --
function OverviewView({ ws, open, goto, onError }: { ws: string; open: (id: string) => void; goto: (t: TabId) => void; onError: (s: string) => void }) {
  const [o, setO] = useState<Overview | null>(null);
  useEffect(() => { setO(null); gtmApi.overview(ws).then(setO).catch((e) => onError(errorText(e))); }, [ws, onError]);
  if (!o) return <div className="grid gap-4">{[120, 260].map((h, k) => <div key={k} className="rounded-card bg-surface2 animate-pulse" style={{ height: h }} />)}</div>;
  if (o.accounts === 0) return (
    <Empty title="No target accounts yet" body="Import the list from ZoomInfo, Apollo, Salesforce, HubSpot or a spreadsheet - or connect Apollo to pull accounts that match your ideal customer profile. Registrations, walk-ins and website visits also add accounts on their own."
      action={<button type="button" className="btn-primary text-sm" onClick={() => goto("sources")}>Bring accounts in</button>} />
  );
  const keys = ["Website", "Email", "Events", "Meetings", "Other"].filter((k) => o.weeks.some((w) => w[k]));
  return (
    <div className="flex flex-col gap-5">
      <Section>
        <div className="grid gap-5 grid-cols-[repeat(auto-fill,minmax(140px,1fr))]" data-abm-kpis="">
          <Stat label="Target accounts" value={o.accounts.toLocaleString()} hint={`${(o.tiers.A || 0).toLocaleString()} Tier A · ${(o.tiers.B || 0).toLocaleString()} Tier B`} />
          <Stat label="Engaged, 30 days" value={o.engaged_30d.toLocaleString()} hint={o.engaged_by_tier.A ? `${o.engaged_by_tier.A} Tier A` : undefined} />
          <Stat label="Website visits, 30 days" value={fmt(o.visits_30d)} />
          <Stat label="Meetings, 30 days" value={fmt(o.meetings_30d)} />
          <Stat label="Email open rate" value={o.emails_30d.open_rate !== null ? `${o.emails_30d.open_rate}%` : "—"} hint={o.emails_30d.sent ? `${o.emails_30d.sent.toLocaleString()} sent` : "No sends yet"} />
          <Stat label="Newsletter list" value={o.subscribers.toLocaleString()} hint={`${o.people.toLocaleString()} people known`} />
        </div>
      </Section>
      <div className="flex gap-5 flex-wrap items-start">
        <Section title="Signals by week" sub="Everything your accounts did, last 12 weeks." className="flex-[2_1_480px]">
          {keys.length ? <StackBars rows={o.weeks} keys={keys} labelKey="week" height={160} /> : <p className="m-0 text-ui text-muted">No signals yet.</p>}
        </Section>
        <Section title="From list to pipeline" className="flex-[1_1_300px]"><Funnel rows={o.funnel} /></Section>
      </div>
      <div className="flex gap-5 flex-wrap items-start">
        <Section title="Surging this week" sub="Most signal points in the last 7 days - the accounts to call now." className="flex-[1_1_380px]">
          <AccountList rows={o.surging} open={open} metric={(a) => `${fmt(a.engagement_7d)} pts this week`} empty="Quiet week so far." />
        </Section>
        <Section title="New companies on your website" sub="Named from visits (IPinfo) and form fills, scored on your ICP." className="flex-[1_1_380px]">
          <AccountList rows={o.new_visitors} open={open} metric={(a) => a.icp_score !== null ? `ICP ${a.icp_score}` : ""} empty="None yet. Connect IPinfo under Sources to name anonymous visitors." />
        </Section>
      </div>
      <Section title="Live activity">
        <ul className="m-0 p-0 list-none flex flex-col divide-y divide-border" data-feed="">
          {o.feed.map((f) => (
            <li key={f.id} className="py-2.5 flex items-center gap-3 min-w-0">
              <Tier tier={f.tier} />
              <div className="min-w-0 flex-1">
                <div className="text-ui text-text truncate">{f.account ? <button type="button" className="hover:underline" onClick={() => f.account_id && open(f.account_id)}>{f.account}</button> : "Unknown visitor"}{f.contact ? <span className="text-secondary"> · {f.contact}</span> : null}</div>
                <div className="text-caption text-muted truncate">{f.label}{f.detail?.page ? ` · ${f.detail.page}` : ""}{f.detail?.campaign ? ` · ${f.detail.campaign}` : ""}</div>
              </div>
              <span className="text-caption text-muted shrink-0">{fmtDate(f.occurred_at)}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function AccountList({ rows, open, metric, empty }: { rows: AccountRow[]; open: (id: string) => void; metric: (a: AccountRow) => string; empty: string }) {
  if (!rows.length) return <p className="m-0 text-ui text-muted">{empty}</p>;
  return (
    <ul className="m-0 p-0 list-none flex flex-col divide-y divide-border">
      {rows.map((a) => (
        <li key={a.id}><button type="button" className="ui-focus w-full py-2.5 flex items-center gap-3 text-left" onClick={() => open(a.id)}>
          <Tier tier={a.icp_tier} />
          <span className="min-w-0 flex-1"><span className="block text-ui text-text truncate">{a.name}</span><span className="block text-caption text-muted truncate">{[a.industry, a.country].filter(Boolean).join(" · ")}</span></span>
          <span className="text-caption text-secondary tabular-nums shrink-0">{metric(a)}</span>
        </button></li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------- accounts --
function AccountsView({ ws, open, onError }: { ws: string; open: (id: string) => void; onError: (s: string) => void }) {
  const [f, setF] = useState({ q: "", tier: "", heat: "", country: "", segment: "", list_name: "", source: "", sort: "icp", page: 1 });
  const [data, setData] = useState<Awaited<ReturnType<typeof gtmApi.accounts>> | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [bulk, setBulk] = useState(false);
  const [adding, setAdding] = useState(false);
  const params = useMemo(() => ({ workspace_id: ws, ...f, size: 50 }), [ws, f]);
  const load = useCallback(() => { gtmApi.accounts(params).then(setData).catch((e) => onError(errorText(e))); }, [params, onError]);
  useEffect(() => { const t = window.setTimeout(load, f.q ? 250 : 0); return () => window.clearTimeout(t); }, [load, f.q]);
  const upd = (patch: Partial<typeof f>) => { setF({ ...f, page: 1, ...patch }); setSel([]); };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2 flex-wrap items-center">
        <input className="input !py-2 text-ui flex-[1_1_240px]" value={f.q} onChange={(e) => upd({ q: e.target.value })} placeholder="Search name, domain or industry" aria-label="Search accounts" data-account-search="" />
        <div className="inline-flex p-[3px] rounded-full border border-border bg-base">
          {[["", "All tiers"], ["A", "A"], ["B", "B"], ["C", "C"]].map(([k, l]) => (
            <button key={k} type="button" aria-pressed={f.tier === k} onClick={() => upd({ tier: k })}
              className={`ui-focus h-8 px-3 rounded-full text-caption ${f.tier === k ? "bg-surface2 text-text font-medium" : "text-muted hover:text-text"}`}>{l}</button>
          ))}
        </div>
        <select className="input !w-auto !py-2 text-caption" value={f.heat} onChange={(e) => upd({ heat: e.target.value })} aria-label="Engagement"><option value="">Any engagement</option><option value="hot">Hot</option><option value="warm">Warm</option><option value="cold">Cold</option></select>
        {data?.facets.countries.length ? <select className="input !w-auto !py-2 text-caption" value={f.country} onChange={(e) => upd({ country: e.target.value })} aria-label="Country"><option value="">All countries</option>{data.facets.countries.map((c) => <option key={c.value} value={c.value}>{c.value} ({c.n})</option>)}</select> : null}
        {data?.facets.lists.length ? <select className="input !w-auto !py-2 text-caption" value={f.list_name} onChange={(e) => upd({ list_name: e.target.value })} aria-label="List"><option value="">All lists</option>{data.facets.lists.map((c) => <option key={c.value} value={c.value}>{c.value} ({c.n})</option>)}</select> : null}
        {data?.facets.segments.length ? <select className="input !w-auto !py-2 text-caption" value={f.segment} onChange={(e) => upd({ segment: e.target.value })} aria-label="Segment"><option value="">All segments</option>{data.facets.segments.map((c) => <option key={c.value} value={c.value}>{c.value} ({c.n})</option>)}</select> : null}
        <select className="input !w-auto !py-2 text-caption" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} aria-label="Sort">
          <option value="icp">Best ICP fit</option><option value="engagement">Most engaged</option><option value="surging">Surging this week</option><option value="recent">Recently active</option><option value="employees">Largest</option><option value="name">Name</option></select>
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="text-ui text-secondary">{data ? `${data.total.toLocaleString()} accounts` : "…"}{sel.length ? ` · ${sel.length} selected` : ""}</span>
        <div className="flex gap-2 flex-wrap">
          {sel.length > 0 && <button type="button" className="btn-secondary text-sm" onClick={() => setBulk(true)}>Update {sel.length}</button>}
          <button type="button" className="btn-secondary text-sm" onClick={async () => { try { downloadBlob(await gtmApi.accountsCsv(params), "accounts.csv"); } catch (e) { onError(errorText(e)); } }}>Export CSV</button>
          <button type="button" className="btn-primary text-sm" onClick={() => setAdding(true)}>Add account</button>
        </div>
      </div>
      {!data ? <div className="h-64 rounded-card bg-surface2 animate-pulse" /> : data.rows.length === 0 ? <Empty title="No accounts match" body="Try fewer filters, or bring accounts in from Sources." /> : (
        <div className="rounded-card border border-border bg-surface overflow-x-auto">
          <table className="w-full min-w-[920px] text-ui" data-accounts-table="">
            <thead><tr className="text-left text-caption text-muted border-b border-border">
              <th className="py-2.5 pl-4 w-8"><input type="checkbox" aria-label="Select all" checked={sel.length === data.rows.length} onChange={(e) => setSel(e.target.checked ? data.rows.map((r) => r.id) : [])} /></th>
              <th className="font-medium">Account</th><th className="font-medium">Tier</th><th className="font-medium text-right px-2">ICP</th><th className="font-medium">Industry</th><th className="font-medium text-right px-2">People</th>
              <th className="font-medium text-right px-2">Size</th><th className="font-medium">Country</th><th className="font-medium">Engagement</th><th className="font-medium pr-4">Last activity</th>
            </tr></thead>
            <tbody>{data.rows.map((a) => (
              <tr key={a.id} className="border-b border-border last:border-0 hover:bg-surface2/60 cursor-pointer" onClick={() => open(a.id)} data-account-row={a.name}>
                <td className="pl-4" onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${a.name}`} checked={sel.includes(a.id)} onChange={(e) => setSel(e.target.checked ? [...sel, a.id] : sel.filter((x) => x !== a.id))} /></td>
                <td className="py-2.5 pr-2"><div className="text-text font-medium">{a.name}</div><div className="text-caption text-muted">{a.domain || "—"}{a.list_name ? ` · ${a.list_name}` : ""}</div></td>
                <td><Tier tier={a.icp_tier} /></td>
                <td className="text-right px-2 tabular-nums">{a.icp_score ?? "—"}</td>
                <td className="text-secondary truncate max-w-[180px]">{a.industry || "—"}</td>
                <td className="text-right px-2 tabular-nums">{a.people || 0}</td>
                <td className="text-right px-2 tabular-nums text-secondary">{a.employees ? fmt(a.employees) : "—"}</td>
                <td className="text-secondary">{a.country || "—"}</td>
                <td><Heat heat={a.heat} score={a.engagement_score} /></td>
                <td className="text-caption text-muted pr-4">{a.last_engaged_at ? fmtDate(a.last_engaged_at) : "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {data && pages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button type="button" className="btn-secondary text-sm" disabled={f.page <= 1} onClick={() => setF({ ...f, page: f.page - 1 })}>Previous</button>
          <span className="text-caption text-muted tabular-nums">Page {f.page} of {pages}</span>
          <button type="button" className="btn-secondary text-sm" disabled={f.page >= pages} onClick={() => setF({ ...f, page: f.page + 1 })}>Next</button>
        </div>
      )}
      {bulk && <BulkSheet ws={ws} ids={sel} onClose={() => setBulk(false)} onDone={() => { setBulk(false); setSel([]); load(); }} onError={onError} />}
      {adding && <AddAccount ws={ws} onClose={() => setAdding(false)} onDone={(id) => { setAdding(false); load(); open(id); }} onError={onError} />}
    </div>
  );
}

function BulkSheet({ ws, ids, onClose, onDone, onError }: { ws: string; ids: string[]; onClose: () => void; onDone: () => void; onError: (s: string) => void }) {
  const [f, setF] = useState({ list_name: "", segment: "", owner_name: "" });
  const [confirm, setConfirm] = useState(false);
  const go = async (del = false) => {
    try {
      const body: Record<string, any> = { workspace_id: ws, ids, delete: del };
      if (!del) Object.entries(f).forEach(([k, v]) => { if (v.trim()) body[k] = v.trim(); });
      await gtmApi.bulk(body); onDone();
    } catch (e) { onError(errorText(e)); }
  };
  return (
    <Sheet open onClose={onClose} title={`Update ${ids.length} accounts`} footer={<button type="button" className="btn-primary text-sm" onClick={() => go(false)}>Apply</button>}>
      <Field label="Put on list"><input className="input" value={f.list_name} onChange={(e) => setF({ ...f, list_name: e.target.value })} placeholder="e.g. Austin showcase" /></Field>
      <Field label="Segment"><input className="input" value={f.segment} onChange={(e) => setF({ ...f, segment: e.target.value })} placeholder="e.g. Enterprise, Customer" /></Field>
      <Field label="Account owner"><input className="input" value={f.owner_name} onChange={(e) => setF({ ...f, owner_name: e.target.value })} /></Field>
      <div className="border-t border-border pt-4">
        {!confirm ? <button type="button" className="text-caption text-danger underline" onClick={() => setConfirm(true)}>Delete these accounts…</button> : (
          <div className="flex items-center gap-3 flex-wrap"><span className="text-ui text-danger">Deletes the accounts and their signals. People stay, unlinked.</span>
            <button type="button" className="btn-secondary text-sm !text-danger" onClick={() => go(true)}>Delete {ids.length}</button></div>
        )}
      </div>
    </Sheet>
  );
}

function AddAccount({ ws, onClose, onDone, onError }: { ws: string; onClose: () => void; onDone: (id: string) => void; onError: (s: string) => void }) {
  const [f, setF] = useState({ name: "", domain: "", industry: "", employees: "", country: "", segment: "", list_name: "", owner_name: "" });
  return (
    <Sheet open onClose={onClose} title="Add an account" footer={<button type="button" className="btn-primary text-sm" disabled={!f.name.trim() && !f.domain.trim()} onClick={async () => {
      try { const r: any = await gtmApi.addAccount({ ...f, employees: f.employees ? Number(f.employees) : null, workspace_id: ws }); onDone(r.id); } catch (e) { onError(errorText(e)); }
    }}>Add</button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {([["name", "Company"], ["domain", "Website"], ["industry", "Industry"], ["employees", "Employees"], ["country", "Country"], ["segment", "Segment"], ["list_name", "List"], ["owner_name", "Owner"]] as const).map(([k, l]) => (
          <Field key={k} label={l}><input className="input" value={(f as any)[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
        ))}
      </div>
    </Sheet>
  );
}

// --------------------------------------------------------------- people --
function PeopleView({ ws, open, onError }: { ws: string; open: (id: string) => void; onError: (s: string) => void }) {
  const [q, setQ] = useState("");
  const [subs, setSubs] = useState<"" | "true">("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; rows: any[] } | null>(null);
  const [erase, setErase] = useState<any>(null);
  const load = useCallback(() => { gtmApi.contacts({ workspace_id: ws, q, subscribed: subs || undefined, page, size: 50 }).then(setData).catch((e) => onError(errorText(e))); }, [ws, q, subs, page, onError]);
  useEffect(() => { const t = window.setTimeout(load, q ? 250 : 0); return () => window.clearTimeout(t); }, [load, q]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2 flex-wrap items-center">
        <input className="input !py-2 text-ui flex-[1_1_240px]" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search name, email or title" aria-label="Search people" />
        <div className="inline-flex p-[3px] rounded-full border border-border bg-base">
          {[["", "Everyone"], ["true", "Newsletter list"]].map(([k, l]) => <button key={k} type="button" aria-pressed={subs === k} onClick={() => { setSubs(k as any); setPage(1); }}
            className={`ui-focus h-8 px-3 rounded-full text-caption ${subs === k ? "bg-surface2 text-text font-medium" : "text-muted hover:text-text"}`}>{l}</button>)}
        </div>
        <span className="text-ui text-secondary ml-auto">{data ? `${data.total.toLocaleString()} people` : ""}</span>
      </div>
      {!data ? <div className="h-64 rounded-card bg-surface2 animate-pulse" /> : data.rows.length === 0 ? <Empty title="No people yet" body="People arrive from imports, Apollo, HubSpot, registrations, walk-ins, website forms and your team's outreach." /> : (
        <div className="rounded-card border border-border bg-surface overflow-x-auto">
          <table className="w-full min-w-[820px] text-ui" data-people="">
            <thead><tr className="text-left text-caption text-muted border-b border-border"><th className="py-2.5 pl-4 font-medium">Person</th><th className="font-medium">Company</th><th className="font-medium">Seniority</th><th className="font-medium">Email status</th><th className="font-medium">Source</th><th className="pr-4" /></tr></thead>
            <tbody>{data.rows.map((c) => (
              <tr key={c.id} className="border-b border-border last:border-0">
                <td className="py-2.5 pl-4"><div className="text-text">{c.name || c.email}</div><div className="text-caption text-muted">{[c.title, c.name ? c.email : null].filter(Boolean).join(" · ")}</div></td>
                <td>{c.account_id ? <button type="button" className="inline-flex items-center gap-2 hover:underline" onClick={() => open(c.account_id)}><Tier tier={c.tier} />{c.company}</button> : <span className="text-muted">—</span>}</td>
                <td className="text-secondary">{c.seniority || "—"}</td>
                <td className="text-caption">{c.unsubscribed ? <span className="text-danger">Unsubscribed</span> : c.subscribed ? <span className="text-good">Opted in</span> : <span className="text-muted">Not opted in</span>}</td>
                <td className="text-caption text-secondary">{c.source || "—"}</td>
                <td className="pr-4 text-right whitespace-nowrap">
                  <button type="button" className="text-caption text-primary hover:underline" onClick={async () => { try { const d = await gtmApi.exportContact(c.id); downloadBlob(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }), `${c.email || c.id}.json`); } catch (e) { onError(errorText(e)); } }}>Export data</button>
                  <button type="button" className="text-caption text-muted hover:text-danger ml-3" onClick={() => setErase(c)}>Erase</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {data && data.total > 50 && (
        <div className="flex items-center justify-center gap-3">
          <button type="button" className="btn-secondary text-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="text-caption text-muted">Page {page} of {Math.ceil(data.total / 50)}</span>
          <button type="button" className="btn-secondary text-sm" disabled={page * 50 >= data.total} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
      {erase && (
        <Sheet open onClose={() => setErase(null)} title="Erase this person?" footer={<button type="button" className="btn-secondary text-sm !text-danger" onClick={async () => { try { await gtmApi.eraseContact(erase.id); setErase(null); load(); } catch (e) { onError(errorText(e)); } }}>Erase permanently</button>}>
          <p className="m-0 text-ui text-secondary">{erase.name || erase.email} and every signal tied to them are deleted for good (a right-to-erasure request). Their account stays, with its scores recalculated. This is recorded in the audit log.</p>
        </Sheet>
      )}
    </div>
  );
}

// -------------------------------------------------------------- sources --
const OTHER = [
  ["ZoomInfo", "Export accounts or contacts (Advanced Search → Export) and import the CSV here. Columns are matched automatically."],
  ["LinkedIn Sales Navigator", "Export a lead or account list (or copy it into a sheet) and import it. Log InMails from each rep's My invites page."],
  ["Salesforce", "Run an Accounts or Contacts report, export as CSV, import here."],
  ["Luma / Eventbrite / Zoom", "Import guest and attendee lists on the initiative's People tab - check-ins become attendance."],
  ["LinkedIn company engagement", "Import Campaign Manager's company report as “social” signals to see which accounts engaged."],
  ["Mailchimp / Klaviyo", "Import an audience export as newsletter subscribers (only people who opted in)."],
];

function SourcesView({ ws, profile, reload, onError }: { ws: string; profile: Profile | null; reload: () => void; onError: (s: string) => void }) {
  const [importing, setImporting] = useState(false);
  const conn = (p: string) => profile?.connections.find((c) => c.provider === p);
  useEffect(() => {
    if (!profile?.connections.some((c) => c.status === "syncing")) return;
    const t = window.setInterval(reload, 3000);
    return () => window.clearInterval(t);
  }, [profile, reload]);
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
        <Section title="Import a CSV" sub="Accounts, contacts, or signals (attendee lists, LinkedIn engagement, newsletter lists) from any tool.">
          <button type="button" className="btn-primary text-sm self-start" onClick={() => setImporting(true)} data-open-import="">Import a file</button>
          <p className="m-0 text-caption text-muted">Up to 25,000 rows. Re-importing updates existing accounts instead of duplicating them.</p>
        </Section>
        <Connector ws={ws} provider="apollo" title="Apollo" c={conn("apollo")} reload={reload} onError={onError}
          sub="Pull companies that match your ICP and find the right people at each account. Uses your own Apollo API key (Settings → Integrations → API)." pull />
        <Connector ws={ws} provider="hubspot" title="HubSpot" c={conn("hubspot")} reload={reload} onError={onError}
          sub="Bring companies and contacts in. Needs a private app token with crm.objects.companies.read and crm.objects.contacts.read." pull />
        <Connector ws={ws} provider="ipinfo" title="IPinfo" c={conn("ipinfo")} reload={reload} onError={onError}
          sub="Names the company behind anonymous website visits so target-account visits show up before anyone fills a form. Company names need an IPinfo plan with company data." />
        <Section title="Website snippet" sub="One line in your site's <head>.">
          {profile ? <><CopyField value={profile.snippet} testId="sources-snippet" /><span className={`text-caption ${profile.tracking.live ? "text-good" : "text-muted"}`}>{profile.tracking.live ? `Reporting · last visit ${fmtDate(profile.tracking.last_visit_at)}` : "Waiting for the first visit"}</span></> : null}
        </Section>
      </div>
      <Section title="Using another tool?" sub="Keep it. Everything comes in as a CSV export, and GD360 matches columns, companies and people for you.">
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
          {OTHER.map(([t, d]) => <div key={t} className="rounded-ctl border border-border p-3"><div className="text-ui font-medium text-text">{t}</div><div className="text-caption text-secondary mt-0.5">{d}</div></div>)}
        </div>
      </Section>
      {importing && <ImportWizard ws={ws} onClose={() => setImporting(false)} onError={onError} />}
    </div>
  );
}

function Connector({ ws, provider, title, sub, c, reload, onError, pull = false }: { ws: string; provider: string; title: string; sub: string; c?: Profile["connections"][number]; reload: () => void; onError: (s: string) => void; pull?: boolean }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [limit, setLimit] = useState(500);
  const [list, setList] = useState(`${title} ICP pull`);
  return (
    <Section title={title} sub={sub} actions={c ? <span className={`text-caption ${c.status === "error" ? "text-danger" : c.status === "syncing" ? "text-primary" : "text-good"}`}>{c.status === "syncing" ? "Syncing…" : c.status === "error" ? "Error" : `Connected ${c.masked || ""}`}</span> : undefined}>
      {msg && <span className="text-caption text-good">{msg}</span>}
      {c?.last_error && <span className="text-caption text-danger">{c.last_error}</span>}
      {c?.last_result && <span className="text-caption text-secondary">Last sync {fmtDate(c.last_sync_at)}: {Object.entries(c.last_result).map(([k, v]) => `${v} ${k}`).join(", ")}</span>}
      {!c ? (
        <form className="flex gap-2" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setMsg("");
          try { const r = await gtmApi.connect(provider, ws, key.trim()); setMsg(r.message); setKey(""); reload(); } catch (er) { onError(errorText(er)); } finally { setBusy(false); }
        }}>
          <input className="input !py-2 text-ui" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={provider === "hubspot" ? "Private app token" : "API key"} aria-label={`${title} key`} autoComplete="off" />
          <button type="submit" className="btn-secondary text-sm shrink-0" disabled={busy || key.trim().length < 6}>{busy ? "Checking…" : "Connect"}</button>
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          {pull && provider === "apollo" && (
            <div className="grid grid-cols-[1fr_100px] gap-2">
              <input className="input !py-1.5 text-caption" value={list} onChange={(e) => setList(e.target.value)} aria-label="List name" />
              <input className="input !py-1.5 text-caption" type="number" min={1} max={2000} value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="How many" />
            </div>
          )}
          <div className="flex gap-2 flex-wrap">
            {pull && <button type="button" className="btn-primary text-sm" disabled={busy || c.status === "syncing"} onClick={async () => {
              setBusy(true);
              try { await gtmApi.sync(provider, { workspace_id: ws, limit, list_name: list }); setMsg("Started - accounts appear as they arrive."); reload(); } catch (e) { onError(errorText(e)); } finally { setBusy(false); }
            }}>{provider === "apollo" ? `Pull ${limit} ICP accounts` : "Sync now"}</button>}
            <button type="button" className="btn-secondary text-sm" onClick={async () => { try { await gtmApi.disconnect(provider, ws); reload(); } catch (e) { onError(errorText(e)); } }}>Disconnect</button>
          </div>
        </div>
      )}
    </Section>
  );
}

const FIELDS: [string, string][] = [["name", "Company"], ["domain", "Website"], ["industry", "Industry"], ["employees", "Employees"], ["revenue", "Revenue"], ["country", "Country"], ["region", "State / region"],
  ["city", "City"], ["segment", "Segment"], ["list_name", "List"], ["email", "Email"], ["first_name", "First name"], ["last_name", "Last name"], ["full_name", "Full name"], ["title", "Job title"],
  ["phone", "Phone"], ["person_linkedin", "LinkedIn profile"], ["linkedin_url", "Company LinkedIn"], ["date", "Date"], ["attended", "Attended (yes/no)"], ["owner_name", "Owner"]];

function ImportWizard({ ws, onClose, onError }: { ws: string; onClose: () => void; onError: (s: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [p, setP] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [o, setO] = useState({ kind: "auto", source: "zoominfo", list_name: "", segment: "", signal: "registered", subscribe: false });
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (f: File | null) => {
    setFile(f); setP(null); setRes(null);
    if (!f) return;
    setBusy(true);
    try { const r = await gtmApi.importCsv(f, { workspace_id: ws }); setP(r); setMapping(r.mapping); setO((x) => ({ ...x, kind: r.kind })); } catch (e) { onError(errorText(e)); } finally { setBusy(false); }
  };
  const commit = async () => {
    if (!file) return;
    setBusy(true);
    try { setRes(await gtmApi.importCsv(file, { workspace_id: ws, commit: true, mapping: JSON.stringify(mapping), ...o })); } catch (e) { onError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title="Import a CSV" wide
      footer={res ? <button type="button" className="btn-primary text-sm" onClick={onClose}>Done</button> : <button type="button" className="btn-primary text-sm" disabled={!p || busy} onClick={commit} data-import-commit="">{busy ? "Importing…" : `Import ${p?.rows.toLocaleString() || ""} rows`}</button>}>
      {res ? (
        <Banner kind="good">Done: {Object.entries(res).filter(([k]) => !["ok", "kind"].includes(k)).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(", ") || "nothing new"}. Every account was scored on your ICP.</Banner>
      ) : (
        <>
          <input type="file" accept=".csv,text/csv,.tsv,.txt" onChange={(e) => pick(e.target.files?.[0] || null)} aria-label="CSV file" data-import-file="" />
          {p && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="These rows are"><select className="input" value={o.kind} onChange={(e) => setO({ ...o, kind: e.target.value })}><option value="accounts">Accounts</option><option value="contacts">People (with their companies)</option><option value="signals">Signals (attendance, engagement…)</option></select></Field>
                <Field label="From"><select className="input" value={o.source} onChange={(e) => setO({ ...o, source: e.target.value })}>{["zoominfo", "apollo", "salesforce", "hubspot", "linkedin", "sales_navigator", "luma", "eventbrite", "zoom", "mailchimp", "spreadsheet"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></Field>
                <Field label="Put on list"><input className="input" value={o.list_name} onChange={(e) => setO({ ...o, list_name: e.target.value })} placeholder="e.g. ABM 500" /></Field>
                {o.kind === "signals" && <Field label="Each row is"><select className="input" value={o.signal} onChange={(e) => setO({ ...o, signal: e.target.value })}>
                  {[["registered", "Registered"], ["attended", "Attended"], ["webinar_attended", "Attended a webinar"], ["social", "Social engagement"], ["newsletter_signup", "Newsletter sign-up"], ["meeting", "Meeting"], ["visit", "Website visit"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>}
                <Field label="Segment"><input className="input" value={o.segment} onChange={(e) => setO({ ...o, segment: e.target.value })} placeholder="e.g. Enterprise, Customer" /></Field>
              </div>
              {o.kind !== "accounts" && <label className="flex items-center gap-2 text-ui"><input type="checkbox" checked={o.subscribe} onChange={(e) => setO({ ...o, subscribe: e.target.checked })} /> These people opted in to marketing email</label>}
              <div className="flex flex-col gap-2">
                <span className="text-ui font-medium text-text">Columns ({p.rows.toLocaleString()} rows{p.capped ? ", first 25,000" : ""})</span>
                <div className="grid gap-2 sm:grid-cols-2">
                  {FIELDS.map(([k, l]) => (
                    <label key={k} className="flex items-center gap-2 text-caption">
                      <span className="w-[120px] shrink-0 text-secondary">{l}</span>
                      <select className="input !py-1 text-caption" value={mapping[k] || ""} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value })}>
                        <option value="">—</option>{p.headers.map((h) => <option key={h} value={h}>{h}</option>)}</select>
                    </label>
                  ))}
                </div>
              </div>
              <div className="overflow-x-auto"><table className="text-caption min-w-full"><thead><tr>{p.headers.slice(0, 8).map((h) => <th key={h} className="text-left font-medium text-muted pr-4 py-1">{h}</th>)}</tr></thead>
                <tbody>{p.sample.slice(0, 4).map((r, k) => <tr key={k} className="border-t border-border">{p.headers.slice(0, 8).map((h) => <td key={h} className="pr-4 py-1 text-secondary truncate max-w-[160px]">{r[h]}</td>)}</tr>)}</tbody></table></div>
            </>
          )}
          {busy && !p && <span className="text-caption text-muted">Reading the file…</span>}
        </>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ ICP --
function IcpView({ ws, profile, reload, onError }: { ws: string; profile: Profile | null; reload: () => void; onError: (s: string) => void }) {
  const [icp, setIcp] = useState<Icp>({});
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (profile) setIcp(profile.icp || {}); }, [profile]);
  const list = (k: keyof Icp) => ((icp[k] as string[] | undefined) || []).join(", ");
  const setList = (k: keyof Icp, v: string) => setIcp({ ...icp, [k]: v.split(",").map((x) => x.trim()).filter(Boolean) });
  const num = (k: keyof Icp) => (icp[k] as number | null | undefined) ?? "";
  return (
    <div className="flex gap-5 flex-wrap items-start">
      <Section title="Ideal customer profile" sub="Every account is scored 0-100 on this: industry 35, size 25, region 20, revenue 10, keywords 10. Tier A is 75+, Tier B 50+." className="flex-[2_1_520px]"
        actions={<button type="button" className="btn-secondary text-sm" onClick={async () => { try { const s = await gtmApi.suggestIcp(ws); if (s.basis) { setIcp({ ...icp, ...s.icp }); setMsg(`Suggested from ${s.basis} - review and save.`); } else setMsg("Import some accounts first."); } catch (e) { onError(errorText(e)); } }}>Suggest from my accounts</button>}>
        {msg && <Banner kind="good" onClose={() => setMsg("")}>{msg}</Banner>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Industries" hint="Comma-separated"><input className="input" value={list("industries")} onChange={(e) => setList("industries", e.target.value)} data-icp-industries="" /></Field>
          <Field label="Countries / regions"><input className="input" value={list("countries")} onChange={(e) => setList("countries", e.target.value)} /></Field>
          <Field label="Employees from"><input type="number" className="input" value={num("min_employees")} onChange={(e) => setIcp({ ...icp, min_employees: e.target.value ? Number(e.target.value) : null })} /></Field>
          <Field label="Employees to"><input type="number" className="input" value={num("max_employees")} onChange={(e) => setIcp({ ...icp, max_employees: e.target.value ? Number(e.target.value) : null })} /></Field>
          <Field label="Minimum revenue (USD)"><input type="number" className="input" value={num("min_revenue")} onChange={(e) => setIcp({ ...icp, min_revenue: e.target.value ? Number(e.target.value) : null })} /></Field>
          <Field label="Keywords" hint="Matched in name, industry, segment"><input className="input" value={list("keywords")} onChange={(e) => setList("keywords", e.target.value)} /></Field>
          <Field label="Buyer titles" hint="Who to look for at each account"><input className="input" value={list("titles")} onChange={(e) => setList("titles", e.target.value)} /></Field>
          <Field label="Exclude" hint="Competitors, partners"><input className="input" value={list("exclude")} onChange={(e) => setList("exclude", e.target.value)} /></Field>
        </div>
      </Section>
      <Section title="Sender details" sub="Used in campaigns and on public pages." className="flex-[1_1_320px]">
        <Field label="Company name"><input className="input" value={icp.company_name || ""} onChange={(e) => setIcp({ ...icp, company_name: e.target.value })} /></Field>
        <Field label="Signed by"><input className="input" value={icp.sender_name || ""} onChange={(e) => setIcp({ ...icp, sender_name: e.target.value })} placeholder="Gokul, Lumen Home" /></Field>
        <Field label="Postal address" hint="Required in marketing email footers (CAN-SPAM)."><input className="input" value={icp.postal_address || ""} onChange={(e) => setIcp({ ...icp, postal_address: e.target.value })} /></Field>
        <Field label="Meeting booking link"><input className="input" value={icp.booking_link || ""} onChange={(e) => setIcp({ ...icp, booking_link: e.target.value })} placeholder="https://cal.com/…" /></Field>
      </Section>
      <div className="w-full flex justify-end">
        <button type="button" className="btn-primary text-sm" disabled={busy} data-save-icp="" onClick={async () => {
          setBusy(true);
          try { const r = await gtmApi.saveIcp(ws, icp); setMsg(`Saved - ${r.rescored.toLocaleString()} accounts re-scored.`); reload(); } catch (e) { onError(errorText(e)); } finally { setBusy(false); }
        }}>Save and re-score</button>
      </div>
    </div>
  );
}

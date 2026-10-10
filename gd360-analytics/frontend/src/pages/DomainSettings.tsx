// 2026-10-10 (round 19): Settings › Company domain (approved board E2).
// A workspace connects one address of its own (data.acmeretail.com):
//   1. add it, 2. add the two DNS records shown (copy buttons, a tick as each
//   one is found), 3. "Check now" until it's live - HTTPS is automatic;
// then who may open it (people at the company / invited / anyone), how it
// looks (title, logo, "Powered by GD360"), whether members must ask, the
// dashboards published on it, publish requests and access requests.
// Owners and admins change it; members see what's live and their requests.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { domainsApi, errorText, type CompanyDomain, type DomainPage, type Publication } from "../api/ops";
import { Button, ConfirmDialog, Sheet, Skeleton, Switch, ExternalIcon, RefreshIcon, CheckIcon, TrashIcon } from "../ui";
import { ago, Banner, ChoiceCards, CopyButton, EmptyNote, Eyebrow, fmtWhen } from "../components/OpsParts";

const AUDIENCE_TEXT = {
  company: "People at the company",
  invited: "Invited people",
  public: "Anyone",
} as const;

export default function DomainSettings() {
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [data, setData] = useState<DomainPage | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    if (!activeWorkspaceId) return;
    try {
      setData(await domainsApi.get(activeWorkspaceId));
      setError("");
    } catch (e: any) {
      setError(errorText(e, "Couldn't load the company domain."));
    }
  }, [activeWorkspaceId]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />
        <main className="px-4 sm:px-8 lg:px-10 py-7 sm:py-9 max-w-[1100px] mx-auto flex flex-col gap-6">
          <header className="flex flex-col gap-2">
            <Eyebrow>Settings · {data?.workspace.name || ""}</Eyebrow>
            <h1 className="m-0 text-[28px] sm:text-[34px] font-bold tracking-tight text-text leading-none">Company domain</h1>
            <p className="m-0 text-body text-secondary max-w-[70ch]">
              Publish dashboards on your own address. They look exactly like they do here, and people sign in with their GD360 account — no other app, no redirect.
            </p>
          </header>
          {notice && <Banner tone="good" action={<button type="button" className="text-caption text-muted hover:text-text" onClick={() => setNotice("")}>Dismiss</button>}>{notice}</Banner>}
          {error && <Banner tone="danger" action={<button type="button" className="text-caption text-muted hover:text-text" onClick={() => setError("")}>Dismiss</button>}>{error}</Banner>}
          {!data && !error && <Skeleton className="h-[320px] rounded-card" />}
          {data && !data.domain && <ConnectCard data={data} onAdded={(m) => { setNotice(m); load(); }} onError={setError} />}
          {data && data.domain && (
            <>
              <StatusCard data={data} dom={data.domain} onChanged={load} onError={setError} onNotice={setNotice} />
              <Requests data={data} onChanged={load} onError={setError} onNotice={setNotice} />
              <Publications data={data} onChanged={load} onError={setError} onNotice={setNotice} />
              {data.can_manage && <AccessSettings dom={data.domain} data={data} onSaved={(d) => { setData({ ...data, domain: d }); setNotice("Saved."); }} onError={setError} />}
              {data.can_manage && <LookSettings dom={data.domain} onSaved={(d) => setData({ ...data, domain: d })} onError={setError} />}
              {data.can_manage && <DangerZone dom={data.domain} count={data.publications.length} onRemoved={() => { setNotice("The domain was removed."); load(); }} onError={setError} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- connect --

function ConnectCard({ data, onAdded, onError }: { data: DomainPage; onAdded: (m: string) => void; onError: (m: string) => void }) {
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const example = data.suggested_email_domains[0] ? `data.${data.suggested_email_domains[0]}` : "data.yourcompany.com";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await domainsApi.add(data.workspace.id, host.trim());
      onAdded("Domain added. Now add the two DNS records below.");
    } catch (err: any) {
      onError(errorText(err, "Couldn't add that domain."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-card border border-border bg-surface overflow-hidden">
      <div className="grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="p-6 sm:p-8 flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <h2 className="m-0 text-title font-semibold text-text">Connect your address</h2>
            <p className="m-0 text-ui text-secondary leading-relaxed">
              Use a subdomain of your company's domain, like <span className="font-mono text-text">{example}</span>. Your website stays exactly where it is.
            </p>
          </div>
          {data.can_manage ? (
            <form onSubmit={submit} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-caption text-muted">Address</span>
                <div className="flex items-center rounded-ctl border border-border bg-base focus-within:border-primary">
                  <span className="pl-3 text-ui text-muted font-mono">https://</span>
                  <input className="flex-1 bg-transparent h-10 px-1 text-ui font-mono text-text outline-none" placeholder={example} value={host} onChange={(e) => setHost(e.target.value)} aria-label="Address" autoFocus />
                </div>
              </label>
              <Button type="submit" variant="primary" disabled={!host.trim() || busy} loading={busy} className="self-start">Continue</Button>
            </form>
          ) : (
            <Banner>Only the workspace's owner and admins can connect a domain. Ask them - you'll be able to publish here once it's live.</Banner>
          )}
        </div>
        <div className="bg-subtle/60 border-t lg:border-t-0 lg:border-l border-border p-6 sm:p-8 flex flex-col gap-4">
          <Eyebrow>How it works</Eyebrow>
          {[
            ["1", "Add two DNS records", "A CNAME sends visitors here; a TXT record proves the domain is yours. Your IT team or DNS provider can do it in two minutes."],
            ["2", "HTTPS is automatic", "Once the records are found, the certificate is issued for you. Usually a few minutes."],
            ["3", "Publish and share", "Pick a path like /sales for each dashboard. People at your company sign in with their work email."],
          ].map(([n, t, d]) => (
            <div key={n} className="flex gap-3">
              <span className="w-7 h-7 rounded-full bg-tint text-brand-ink text-caption font-mono flex items-center justify-center shrink-0">{n}</span>
              <div>
                <div className="text-ui font-medium text-text">{t}</div>
                <div className="text-caption text-muted leading-relaxed">{d}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ----------------------------------------------------------------- status --

const STEPS = [
  { key: "added", label: "Added" },
  { key: "dns", label: "DNS records" },
  { key: "https", label: "HTTPS" },
  { key: "live", label: "Live" },
];

function stepIndex(d: CompanyDomain) {
  if (d.status === "live") return 4;
  if (d.status === "pending_ssl") return 2;
  return 1;
}

function StatusCard({ data, dom, onChanged, onError, onNotice }: { data: DomainPage; dom: CompanyDomain; onChanged: () => void; onError: (m: string) => void; onNotice: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<CompanyDomain["dns_seen"]>();
  const idx = stepIndex(dom);
  const live = dom.status === "live";
  const check = async () => {
    setBusy(true);
    try {
      const d = await domainsApi.check(dom.id);
      setSeen(d.dns_seen);
      if (d.status === "live") onNotice(`${d.hostname} is live.`);
      onChanged();
    } catch (e: any) {
      onError(errorText(e, "Couldn't check it."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-card border border-border bg-surface" aria-label="Domain status">
      <div className="p-5 sm:p-6 flex flex-col gap-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className={`w-2.5 h-2.5 rounded-full ${live ? "bg-good" : dom.status === "error" ? "bg-danger" : "bg-warning ops-pulse"}`} aria-hidden="true" />
              <span className="font-mono text-[18px] sm:text-[20px] text-text break-all">{dom.hostname}</span>
            </div>
            <div className="text-caption text-muted mt-1">
              {live ? `Live since ${fmtWhen(dom.live_at)} · ${AUDIENCE_TEXT[dom.audience]} can open it` : dom.status === "pending_ssl" ? "Records found - the HTTPS certificate is being issued" : dom.status === "error" ? "Something went wrong - see below" : "Waiting for the DNS records"}
              {dom.last_checked_at && ` · checked ${ago(dom.last_checked_at)}`}
            </div>
          </div>
          <div className="flex gap-2">
            {live && <a href={dom.url} target="_blank" rel="noreferrer" className="btn-secondary text-sm inline-flex items-center gap-1.5">Open <ExternalIcon size={13} /></a>}
            {data.can_manage && !live && (
              <Button variant="primary" leadingIcon={<RefreshIcon size={14} />} loading={busy} disabled={busy} onClick={check}>Check now</Button>
            )}
            {data.can_manage && live && (
              <Button variant="secondary" leadingIcon={<RefreshIcon size={14} />} loading={busy} disabled={busy} onClick={check}>Check again</Button>
            )}
          </div>
        </div>

        <ol className="m-0 p-0 list-none grid grid-cols-4 gap-2" aria-label="Progress">
          {STEPS.map((s, i) => {
            const done = i < idx || (live && i === 3);
            const current = i === idx && !live;
            return (
              <li key={s.key} className="flex flex-col gap-2">
                <div className={`h-1.5 rounded-full ${done ? "bg-good" : current ? "bg-warning" : "bg-subtle"}`} aria-hidden="true" />
                <span className={`text-caption ${done ? "text-text" : current ? "text-warning" : "text-muted"}`}>
                  {done && <CheckIcon size={12} className="inline -mt-0.5 mr-1 text-good" />}
                  {s.label}
                </span>
              </li>
            );
          })}
        </ol>

        {dom.last_error && !live && <Banner tone={dom.status === "error" ? "danger" : "warning"}>{dom.last_error}</Banner>}

        {!live && (
          <div className="flex flex-col gap-2">
            <Eyebrow>Add these at your DNS provider</Eyebrow>
            <div className="rounded-ctl border border-border overflow-x-auto">
              <table className="w-full text-ui border-collapse min-w-[640px]">
                <thead>
                  <tr className="text-left bg-subtle/60">
                    {["", "Type", "Name / host", "Value", ""].map((h, i) => (
                      <th key={i} className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted font-medium px-3 py-2 border-b border-border">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dom.records.map((r) => (
                    <tr key={r.type} className="border-b border-border last:border-b-0">
                      <td className="px-3 py-3 w-8">
                        {r.ok ? <span className="w-5 h-5 rounded-full bg-good-fill text-good inline-flex items-center justify-center" title="Found"><CheckIcon size={12} /></span>
                          : <span className="w-5 h-5 rounded-full border border-border-strong inline-block" title="Not found yet" />}
                      </td>
                      <td className="px-3 py-3 font-mono text-[12.5px] text-text">{r.type}</td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2"><span className="font-mono text-[12.5px] text-text">{r.host}</span><CopyButton text={r.host} /></div>
                        <div className="text-[11px] text-faint mt-0.5 font-mono">{r.name}</div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2"><span className="font-mono text-[12.5px] text-text break-all">{r.value}</span><CopyButton text={r.value} /></div>
                        <div className="text-[11px] text-faint mt-0.5">{r.purpose}</div>
                      </td>
                      <td className="px-3 py-3 text-caption text-muted whitespace-nowrap">TTL: auto</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {seen && (seen.cname.length > 0 || seen.txt.length > 0) && (
              <div className="text-caption text-muted">
                We see: {seen.cname.length ? `CNAME → ${seen.cname.join(", ")}` : "no CNAME"} · {seen.txt.length ? `TXT ${seen.txt.slice(0, 2).join(", ")}` : "no TXT"}
              </div>
            )}
            <div className="text-caption text-muted leading-relaxed">
              Using Cloudflare? Set the CNAME to “DNS only” (grey cloud) until the domain is live. New records can take up to an hour to show; GD360 keeps the setup until you remove it.
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// --------------------------------------------------------------- requests --

function Requests({ data, onChanged, onError, onNotice }: { data: DomainPage; onChanged: () => void; onError: (m: string) => void; onNotice: (m: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ pub: Publication; approve: boolean } | null>(null);
  const [text, setText] = useState("");
  const pending = data.requests.filter((r) => r.status === "pending");
  const declined = data.requests.filter((r) => r.status === "rejected");
  if (!pending.length && !data.access_requests.length && !declined.length) return null;
  const decideAccess = async (id: string, d: "approve" | "decline", email: string) => {
    setBusy(id);
    try {
      await domainsApi.decideAccess(id, d);
      onNotice(d === "approve" ? `${email} can open it now - they've been told.` : `Declined - ${email} has been told.`);
      onChanged();
    } catch (e: any) {
      onError(errorText(e, "Couldn't save that."));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="rounded-card border border-warning-border bg-surface" aria-label="Requests">
      <div className="px-5 pt-4 pb-3 border-b border-border">
        <h2 className="m-0 text-section font-semibold text-text">Waiting for a decision</h2>
      </div>
      <ul className="m-0 p-0 list-none divide-y divide-border">
        {pending.map((p) => (
          <li key={p.id} className="px-5 py-4 flex items-center gap-4 flex-wrap">
            <div className="flex-1 min-w-[240px]">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-[rgb(var(--ops-automation))]">Publish request</div>
              <div className="text-ui font-medium text-text">{p.requested_by} wants to publish “{p.dashboard}”</div>
              <div className="text-caption text-muted">
                at <span className="font-mono">{p.url.replace("https://", "")}</span> · {p.audience === "members" ? "team only" : p.audience === "invited" ? `${p.invited_emails.length} invited` : "everyone the domain allows"}
                {p.row_rule_text ? ` · ${p.row_rule_text}` : ""} · {ago(p.requested_at)}
              </div>
              {p.request_note && <div className="text-caption text-secondary mt-1">“{p.request_note}”</div>}
            </div>
            {data.can_manage ? (
              <div className="flex gap-2">
                <Button size="sm" variant="primary" className="!h-8" onClick={() => { setText(""); setNote({ pub: p, approve: true }); }}>Approve</Button>
                <Button size="sm" variant="secondary" className="!h-8" onClick={() => { setText(""); setNote({ pub: p, approve: false }); }}>Decline</Button>
              </div>
            ) : (
              <WithdrawButton pub={p} onDone={() => { onNotice("Request withdrawn."); onChanged(); }} onError={onError} />
            )}
          </li>
        ))}
        {data.access_requests.map((a) => (
          <li key={a.id} className="px-5 py-4 flex items-center gap-4 flex-wrap">
            <div className="flex-1 min-w-[240px]">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-[rgb(var(--ops-refresh))]">Access request</div>
              <div className="text-ui font-medium text-text">{a.name} asked to open “{a.title || a.path}”</div>
              <div className="text-caption text-muted">{a.email} · {ago(a.created_at)}</div>
              {a.note && <div className="text-caption text-secondary mt-1">“{a.note}”</div>}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="primary" className="!h-8" loading={busy === a.id} disabled={!!busy} onClick={() => decideAccess(a.id, "approve", a.email)}>Give access</Button>
              <Button size="sm" variant="secondary" className="!h-8" disabled={!!busy} onClick={() => decideAccess(a.id, "decline", a.email)}>Decline</Button>
            </div>
          </li>
        ))}
        {declined.map((p) => (
          <li key={p.id} className="px-5 py-3.5 flex items-center gap-4 flex-wrap">
            <div className="flex-1 min-w-[240px]">
              <div className="text-ui text-text">“{p.dashboard}” wasn't approved{p.decided_by ? ` by ${p.decided_by}` : ""}</div>
              {p.decision_note && <div className="text-caption text-secondary">“{p.decision_note}”</div>}
            </div>
            <WithdrawButton pub={p} label="Dismiss" onDone={onChanged} onError={onError} />
          </li>
        ))}
      </ul>
      {note && (
        <ConfirmDialog
          open
          title={note.approve ? `Publish “${note.pub.dashboard}”?` : `Decline “${note.pub.dashboard}”?`}
          confirmLabel={note.approve ? "Approve and publish" : "Decline"}
          tone={note.approve ? "primary" : "danger"}
          busy={busy === note.pub.id}
          onCancel={() => setNote(null)}
          onConfirm={async () => {
            setBusy(note.pub.id);
            try {
              if (note.approve) await domainsApi.approve(note.pub.id, text);
              else await domainsApi.decline(note.pub.id, text);
              onNotice(note.approve ? `“${note.pub.dashboard}” is live at ${note.pub.url.replace("https://", "")}.` : "Declined - they've been told.");
              setNote(null);
              onChanged();
            } catch (e: any) {
              onError(errorText(e, "Couldn't save that."));
            } finally {
              setBusy(null);
            }
          }}
        >
          <div className="flex flex-col gap-2">
            <p className="m-0 text-ui text-secondary">{note.approve ? `It goes live at ${note.pub.url.replace("https://", "")} right away.` : "It stays private. Tell them why, so they can change it."}</p>
            <textarea className="input min-h-[70px] text-ui" placeholder={`Note to ${note.pub.requested_by} (optional)`} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
          </div>
        </ConfirmDialog>
      )}
    </section>
  );
}

function WithdrawButton({ pub, label = "Withdraw", onDone, onError }: { pub: Publication; label?: string; onDone: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button size="sm" variant="secondary" className="!h-8" loading={busy} disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await domainsApi.unpublish(pub.id);
          onDone();
        } catch (e: any) {
          onError(errorText(e, "Couldn't do that."));
          setBusy(false);
        }
      }}>
      {label}
    </Button>
  );
}

// ------------------------------------------------------------ publications --

function Publications({ data, onChanged, onError, onNotice }: { data: DomainPage; onChanged: () => void; onError: (m: string) => void; onNotice: (m: string) => void }) {
  const [viewers, setViewers] = useState<Publication | null>(null);
  const [remove, setRemove] = useState<Publication | null>(null);
  const [busy, setBusy] = useState(false);
  const dom = data.domain!;
  return (
    <section className="flex flex-col gap-3" aria-label="Published dashboards">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="m-0 text-section font-semibold text-text">Published here</h2>
          <p className="m-0 mt-1 text-caption text-muted">Publish from any dashboard: <span className="text-secondary">Share → Publish to {dom.hostname}</span>.</p>
        </div>
        <Link to="/dashboards" className="btn-secondary text-sm">Go to dashboards</Link>
      </div>
      {data.publications.length === 0 ? (
        <EmptyNote title="Nothing published yet">Open a dashboard and choose “Publish to company domain”. It appears at {dom.hostname}/your-path.</EmptyNote>
      ) : (
        <div className="rounded-card border border-border bg-surface overflow-x-auto">
          <table className="w-full text-ui border-collapse min-w-[820px]">
            <thead>
              <tr className="text-left">
                {["Dashboard", "Address", "Who can open it", "People · 30 days", ""].map((h) => (
                  <th key={h} className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted font-medium px-4 py-2.5 border-b border-border">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.publications.map((p) => (
                <tr key={p.id} className="border-b border-border last:border-b-0 align-top">
                  <td className="px-4 py-3">
                    <Link to={`/dashboard-builder/${p.dashboard_id}`} className="text-text font-medium hover:underline">{p.title}</Link>
                    <div className="text-caption text-muted">{p.title !== p.dashboard ? `${p.dashboard} · ` : ""}published {ago(p.published_at)}{p.decided_by ? ` by ${p.decided_by}` : ""}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <a href={dom.status === "live" ? p.url : undefined} target="_blank" rel="noreferrer" className="font-mono text-[12.5px] text-secondary hover:text-text whitespace-nowrap">/{p.path}</a>
                      <CopyButton text={p.url} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-text">{p.audience === "members" ? "Team only" : p.audience === "invited" ? `${p.invited_emails.length} invited` : AUDIENCE_TEXT[dom.audience]}</div>
                    {p.row_rule_text && <div className="text-caption text-[rgb(var(--ops-refresh))] mt-0.5">{p.row_rule_text}</div>}
                    {p.subscribers > 0 && <div className="text-caption text-muted">{p.subscribers} get it every Monday</div>}
                  </td>
                  <td className="px-4 py-3">
                    <button type="button" className="text-text tabular-nums hover:underline" onClick={() => setViewers(p)} disabled={!data.can_manage}>{p.viewers_30d}</button>
                    <div className="text-caption text-muted">{p.views.toLocaleString()} opens{p.last_viewed_at ? ` · last ${ago(p.last_viewed_at)}` : ""}</div>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <Link to={`/dashboard-builder/${p.dashboard_id}?publish=domain`} className="btn-secondary text-sm mr-2">Edit</Link>
                    {data.can_manage && (
                      <button type="button" className="ui-focus w-8 h-8 rounded-ctl border border-border text-muted hover:text-danger inline-flex items-center justify-center align-middle" aria-label={`Take ${p.title} off the domain`} onClick={() => setRemove(p)}>
                        <TrashIcon size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {viewers && <ViewersSheet pub={viewers} onClose={() => setViewers(null)} />}
      {remove && (
        <ConfirmDialog
          open
          title={`Take “${remove.title}” off ${dom.hostname}?`}
          confirmLabel="Take it off"
          tone="danger"
          busy={busy}
          onCancel={() => setRemove(null)}
          onConfirm={async () => {
            setBusy(true);
            try {
              await domainsApi.unpublish(remove.id);
              onNotice(`${dom.hostname}/${remove.path} no longer opens.`);
              setRemove(null);
              onChanged();
            } catch (e: any) {
              onError(errorText(e, "Couldn't take it off."));
            } finally {
              setBusy(false);
            }
          }}
        >
          The address stops working at once and Monday emails for it stop. The dashboard itself stays in GD360.
        </ConfirmDialog>
      )}
    </section>
  );
}

function ViewersSheet({ pub, onClose }: { pub: Publication; onClose: () => void }) {
  const [rows, setRows] = useState<{ email: string | null; views: number; last_viewed_at: string | null }[] | null>(null);
  useEffect(() => {
    domainsApi.viewers(pub.id).then((d) => setRows(d.viewers)).catch(() => setRows([]));
  }, [pub.id]);
  return (
    <Sheet open onClose={onClose} title={`Who opened “${pub.title}”`} subtitle="The last 30 days">
      {!rows && <Skeleton className="h-24" />}
      {rows && rows.length === 0 && <div className="text-ui text-muted">Nobody has opened it yet.</div>}
      {rows && rows.length > 0 && (
        <ul className="m-0 p-0 list-none divide-y divide-border">
          {rows.map((r, i) => (
            <li key={i} className="py-2.5 flex items-center justify-between gap-3">
              <span className="text-ui text-text truncate">{r.email || "Signed-out visitor"}</span>
              <span className="text-caption text-muted shrink-0">{r.views} visit{r.views === 1 ? "" : "s"} · {ago(r.last_viewed_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------- who can open --

function AccessSettings({ dom, data, onSaved, onError }: { dom: CompanyDomain; data: DomainPage; onSaved: (d: CompanyDomain) => void; onError: (m: string) => void }) {
  const [audience, setAudience] = useState(dom.audience);
  const [domainsText, setDomainsText] = useState(dom.allowed_email_domains.join(", "));
  const [invited, setInvited] = useState(dom.invited_emails.join("\n"));
  const [needsOk, setNeedsOk] = useState(dom.publish_needs_approval);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setAudience(dom.audience);
    setDomainsText(dom.allowed_email_domains.join(", "));
    setInvited(dom.invited_emails.join("\n"));
    setNeedsOk(dom.publish_needs_approval);
  }, [dom]);
  const dirty =
    audience !== dom.audience || domainsText.split(/[\s,;]+/).filter(Boolean).join(",") !== dom.allowed_email_domains.join(",") ||
    invited.split(/[\s,;]+/).filter(Boolean).join(",") !== dom.invited_emails.join(",") || needsOk !== dom.publish_needs_approval;
  const save = async () => {
    setBusy(true);
    try {
      const d = await domainsApi.update(dom.id, {
        audience,
        allowed_email_domains: domainsText.split(/[\s,;]+/).filter(Boolean),
        invited_emails: invited.split(/[\s,;]+/).filter(Boolean),
        publish_needs_approval: needsOk,
      });
      onSaved(d);
    } catch (e: any) {
      onError(errorText(e, "Couldn't save that."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-card border border-border bg-surface" aria-label="Who can open it">
      <div className="px-5 pt-4 pb-3 border-b border-border">
        <h2 className="m-0 text-section font-semibold text-text">Who can open it</h2>
        <p className="m-0 mt-1 text-caption text-muted">The default for every dashboard here. Each dashboard can be stricter (invited people, or the team only), never more open.</p>
      </div>
      <div className="p-5 flex flex-col gap-5">
        <ChoiceCards
          label="Who can open it"
          value={audience}
          onChange={(v) => setAudience(v)}
          options={[
            { value: "company", title: "People at the company", text: "Anyone with a proven address at your email domains." },
            { value: "invited", title: "Invited people", text: "Only the emails you list, plus the team." },
            { value: "public", title: "Anyone", text: "No sign-in. For numbers you'd put on your website." },
          ]}
        />
        {audience === "company" && (
          <label className="flex flex-col gap-1.5 max-w-[560px]">
            <span className="text-ui text-text">Company email domains</span>
            <input className="input font-mono" value={domainsText} onChange={(e) => setDomainsText(e.target.value)} placeholder="acmeretail.com, acme.co.uk" />
            <span className="text-caption text-muted">
              Anyone who proves an address at these domains can sign in - with their password or an emailed code. Free mail (gmail.com, outlook.com…) can't be used here.
              {data.suggested_email_domains.length > 0 && <> Your team uses: <span className="font-mono">{data.suggested_email_domains.join(", ")}</span>.</>}
            </span>
          </label>
        )}
        {audience === "invited" && (
          <label className="flex flex-col gap-1.5 max-w-[560px]">
            <span className="text-ui text-text">Invited people</span>
            <textarea className="input font-mono min-h-[110px]" value={invited} onChange={(e) => setInvited(e.target.value)} placeholder={"dana@acmeretail.com\npartner@agency.com"} />
            <span className="text-caption text-muted">One email per line. Members of the workspace can always open everything.</span>
          </label>
        )}
        {audience === "public" && (
          <Banner tone="warning">Anyone with an address on this domain can open its dashboards without signing in. Use it only for numbers you'd put on your website. Dashboards that show each person their own rows can't be open to anyone.</Banner>
        )}
        <Switch
          checked={needsOk}
          onChange={setNeedsOk}
          label="Members ask before publishing here"
          description="Owners and admins approve each request. Owners and admins always publish right away. (Same rule as in Trust Center › Rules.)"
        />
        <div className="flex gap-2">
          <Button variant="primary" disabled={!dirty || busy} loading={busy} onClick={save}>Save</Button>
          {dirty && <Button variant="ghost" onClick={() => { setAudience(dom.audience); setDomainsText(dom.allowed_email_domains.join(", ")); setInvited(dom.invited_emails.join("\n")); setNeedsOk(dom.publish_needs_approval); }}>Undo</Button>}
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------- look & feel --

function LookSettings({ dom, onSaved, onError }: { dom: CompanyDomain; onSaved: (d: CompanyDomain) => void; onError: (m: string) => void }) {
  const [title, setTitle] = useState(dom.site_title);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => setTitle(dom.site_title), [dom.site_title]);
  useEffect(() => {
    let url: string | null = null;
    if (dom.has_logo) domainsApi.logoBlobUrl(dom.id).then((u) => { url = u; setLogoUrl(u); }).catch(() => setLogoUrl(null));
    else setLogoUrl(null);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [dom.id, dom.has_logo]);
  const run = async (key: string, fn: () => Promise<CompanyDomain>) => {
    setBusy(key);
    try {
      onSaved(await fn());
    } catch (e: any) {
      onError(errorText(e, "Couldn't save that."));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="rounded-card border border-border bg-surface" aria-label="How it looks">
      <div className="px-5 pt-4 pb-3 border-b border-border">
        <h2 className="m-0 text-section font-semibold text-text">How it looks</h2>
      </div>
      <div className="p-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-ui text-text">Site name</span>
            <div className="flex gap-2">
              <input className="input flex-1" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={dom.default_title} maxLength={80} />
              <Button variant="secondary" disabled={title === dom.site_title || busy === "title"} loading={busy === "title"} onClick={() => run("title", () => domainsApi.update(dom.id, { site_title: title }))}>Save</Button>
            </div>
            <span className="text-caption text-muted">Shown at the top of every page and in the browser tab.</span>
          </label>
          <div className="flex flex-col gap-2">
            <span className="text-ui text-text">Logo</span>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="h-12 min-w-[120px] px-3 rounded-ctl border border-border bg-base flex items-center justify-center">
                {logoUrl ? <img src={logoUrl} alt="Your logo" className="max-h-8 max-w-[160px] object-contain" /> : <span className="text-caption text-faint">No logo</span>}
              </div>
              <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) run("logo", () => domainsApi.uploadLogo(dom.id, f)); e.target.value = ""; }} />
              <Button variant="secondary" loading={busy === "logo"} onClick={() => file.current?.click()}>{dom.has_logo ? "Replace" : "Upload"}</Button>
              {dom.has_logo && <Button variant="ghost" onClick={() => run("rmlogo", () => domainsApi.removeLogo(dom.id))}>Remove</Button>}
            </div>
            <span className="text-caption text-muted">PNG, JPEG or WEBP, up to 2 MB. A wide logo on a transparent background looks best.</span>
          </div>
          <Switch
            checked={dom.show_powered_by}
            disabled={busy === "pb"}
            onChange={(v) => run("pb", () => domainsApi.update(dom.id, { show_powered_by: v }))}
            label="Show “Powered by GD360” at the bottom"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Eyebrow>Preview</Eyebrow>
          <div className="rounded-card border border-border bg-base overflow-hidden">
            <div className="h-12 px-4 flex items-center gap-3 border-b border-border bg-surface">
              {logoUrl ? <img src={logoUrl} alt="" className="max-h-6 max-w-[120px] object-contain" /> : <span className="w-6 h-6 rounded-[6px] bg-primary text-on-primary text-[11px] font-bold flex items-center justify-center">{(title || dom.default_title).charAt(0)}</span>}
              <span className="text-ui font-semibold text-text truncate">{title || dom.default_title}</span>
              <span className="ml-auto w-6 h-6 rounded-full bg-subtle" aria-hidden="true" />
            </div>
            <div className="p-4 grid grid-cols-3 gap-2">
              {[0, 1, 2].map((i) => <div key={i} className="h-12 rounded-ctl bg-surface border border-border" />)}
              <div className="col-span-3 h-20 rounded-ctl bg-surface border border-border" />
            </div>
            {dom.show_powered_by && <div className="px-4 pb-3 text-[11px] text-faint">Powered by GD360</div>}
          </div>
        </div>
      </div>
    </section>
  );
}

function DangerZone({ dom, count, onRemoved, onError }: { dom: CompanyDomain; count: number; onRemoved: () => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <section className="rounded-card border border-danger-border bg-surface p-5 flex items-center gap-4 flex-wrap" aria-label="Remove the domain">
      <div className="flex-1 min-w-[240px]">
        <div className="text-ui font-semibold text-text">Remove {dom.hostname}</div>
        <div className="text-caption text-muted">Every dashboard on it stops opening{count ? ` (${count} published)` : ""}. Remove the DNS records afterwards.</div>
      </div>
      <Button variant="danger" onClick={() => setOpen(true)}>Remove domain</Button>
      <ConfirmDialog
        open={open}
        title={`Remove ${dom.hostname}?`}
        confirmLabel="Remove for good"
        tone="danger"
        busy={busy}
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          setBusy(true);
          try {
            await domainsApi.remove(dom.id);
            setOpen(false);
            onRemoved();
          } catch (e: any) {
            onError(errorText(e, "Couldn't remove it."));
          } finally {
            setBusy(false);
          }
        }}
      >
        {count ? `${count} dashboard${count === 1 ? "" : "s"} stop opening at once, and their view history and Monday emails are deleted.` : "Nothing is published on it."} The dashboards themselves stay in GD360.
      </ConfirmDialog>
    </section>
  );
}

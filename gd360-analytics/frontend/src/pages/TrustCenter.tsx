// 2026-10-10 (round 19): the Trust Center (approved board, Option A) - it
// replaces the Governance page. For the active workspace, from real records:
// a posture score in six parts and the risks behind it, each with its fix
// one click away; who can see what (people, roles, access reviews, rules);
// personal data found in sources; everything shared outside the team
// (links and the company domain); data quality; the audit log; privacy
// requests; and the company's rules. Owners and admins only.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import AccessRulesPanel from "../components/AccessRulesPanel";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import {
  errorText, trustApi, type AuditEvent, type Policies, type TrustOverview, type TrustRisk, type TrustSensitive, type TrustShare, type TrustSource,
} from "../api/ops";
import { Button, ConfirmDialog, SearchInput, Select, Skeleton, Switch, DownloadIcon, ShieldCheckIcon, ExternalIcon } from "../ui";
import { ago, Banner, CopyButton, EmptyNote, Eyebrow, fmtWhen, Tabs } from "../components/OpsParts";

type Tab = "overview" | "access" | "sensitive" | "sharing" | "quality" | "audit" | "privacy" | "policies";
const TABS: Tab[] = ["overview", "access", "sensitive", "sharing", "quality", "audit", "privacy", "policies"];

export default function TrustCenter() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [data, setData] = useState<TrustOverview | null>(null);
  const [denied, setDenied] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; run: () => Promise<void> } | null>(null);
  const tabParam = params.get("tab") as Tab | null;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : "overview";
  const setTab = (t: Tab) => {
    const n = new URLSearchParams(params);
    if (t === "overview") n.delete("tab");
    else n.set("tab", t);
    setParams(n, { replace: true });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const load = useCallback(async () => {
    if (!activeWorkspaceId) return;
    try {
      setData(await trustApi.overview(activeWorkspaceId));
      setDenied("");
      setError("");
    } catch (e: any) {
      if (e?.response?.status === 403) setDenied(errorText(e, "Only owners and admins can open the Trust Center."));
      else setError(errorText(e, "Couldn't load the Trust Center."));
    }
  }, [activeWorkspaceId]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const fix = async (key: string, body: Record<string, unknown>, done: string) => {
    setBusy(key);
    setError("");
    try {
      await trustApi.fix(activeWorkspaceId, body);
      setNotice(done);
      await load();
    } catch (e: any) {
      setError(errorText(e, "Couldn't do that."));
    } finally {
      setBusy(null);
    }
  };

  const riskAction = (r: TrustRisk, a: TrustRisk["actions"][number]) => {
    if (a.type === "open_dashboard" && a.dashboard_id) return navigate(`/dashboard-builder/${a.dashboard_id}`);
    if (a.type === "tab" && a.tab) return setTab(a.tab as Tab);
    if (a.type === "unpublish" && a.dashboard_id)
      return setConfirm({
        title: "Stop publishing it?",
        body: "Its link stops working at once for everyone who has it. You can publish it again later with the same link.",
        label: "Stop publishing",
        run: () => fix(r.id, { type: "unpublish", dashboard_id: a.dashboard_id }, "It's no longer published."),
      });
    if (a.type === "hide_columns") return fix(r.id, { type: "hide_columns", datasource_id: a.datasource_id, columns: a.columns }, "Hidden from members and viewers. Owners and admins still see them.");
    if (a.type === "set_policy") return fix(r.id, { type: "set_policy", policy: a.policy, value: a.value }, "Rule saved.");
  };

  const counts = data
    ? {
        access: data.access.filter((a) => a.shared && a.status !== "ok").length,
        sensitive: data.sensitive.filter((s) => !s.protected).length,
        sharing: data.sharing.filter((s) => s.level === "public" || s.level === "domain_public").length,
        quality: data.quality.failing,
      }
    : null;

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />
        <main className="px-4 sm:px-8 lg:px-10 py-7 sm:py-9 max-w-[1240px] mx-auto flex flex-col gap-6">
          <header className="flex items-end justify-between gap-4 flex-wrap">
            <div className="flex flex-col gap-2">
              <Eyebrow>{data?.workspace.name || workspaces.find((w) => w.id === activeWorkspaceId)?.name || ""}</Eyebrow>
              <h1 className="m-0 text-[28px] sm:text-[34px] font-bold tracking-tight text-text leading-none inline-flex items-center gap-3">
                <ShieldCheckIcon size={28} className="text-primary" /> Trust Center
              </h1>
              <p className="m-0 text-body text-secondary max-w-[66ch]">
                Who can see what, what's shared outside the team, where personal data is, and every change — with the fix one click away.
              </p>
            </div>
            {data && (
              <div className="flex gap-2 flex-wrap">
                <Button variant="secondary" leadingIcon={<DownloadIcon size={15} />} onClick={() => trustApi.download(activeWorkspaceId, "evidence.zip").catch((e) => setError(errorText(e, "Couldn't build the evidence pack.")))}>
                  Evidence pack
                </Button>
              </div>
            )}
          </header>

          {denied && (
            <EmptyNote title="Owners and admins only">
              {denied} Ask the workspace owner to make you an admin, or switch to a workspace you manage.
            </EmptyNote>
          )}
          {notice && <Banner tone="good" action={<button type="button" className="text-caption text-muted hover:text-text" onClick={() => setNotice("")}>Dismiss</button>}>{notice}</Banner>}
          {error && <Banner tone="danger" action={<button type="button" className="text-caption text-muted hover:text-text" onClick={() => setError("")}>Dismiss</button>}>{error}</Banner>}

          {!denied && (
            <>
              <Tabs<Tab>
                label="Trust Center sections"
                value={tab}
                onChange={setTab}
                tabs={[
                  { value: "overview", label: "Overview", count: data ? data.counts.high : null, tone: "danger" },
                  { value: "access", label: "Access", count: counts?.access ?? null, tone: "warning" },
                  { value: "sensitive", label: "Personal data", count: counts?.sensitive ?? null, tone: "danger" },
                  { value: "sharing", label: "Sharing", count: counts?.sharing ?? null, tone: "warning" },
                  { value: "quality", label: "Data quality", count: counts?.quality ?? null, tone: "warning" },
                  { value: "audit", label: "Audit log" },
                  { value: "privacy", label: "Privacy" },
                  { value: "policies", label: "Rules" },
                ]}
              />
              {!data && !error && (
                <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
                  <Skeleton className="h-[360px] rounded-card" />
                  <Skeleton className="h-[360px] rounded-card" />
                </div>
              )}
              {data && tab === "overview" && <Overview data={data} busy={busy} onAction={riskAction} onTab={setTab} />}
              {data && tab === "access" && <AccessTab data={data} workspaceId={activeWorkspaceId} busy={busy} fix={fix} reload={load} onError={setError} onNotice={setNotice} />}
              {data && tab === "sensitive" && <SensitiveTab data={data} busy={busy} fix={fix} />}
              {data && tab === "sharing" && <SharingTab data={data} busy={busy} onUnpublish={(s) => setConfirm({
                title: `Stop publishing “${s.dashboard}”?`,
                body: "Its link stops working at once for everyone who has it.",
                label: "Stop publishing",
                run: () => fix(`unpub:${s.dashboard_id}`, { type: "unpublish", dashboard_id: s.dashboard_id }, `“${s.dashboard}” is no longer published.`),
              })} />}
              {data && tab === "quality" && <QualityTab data={data} />}
              {data && tab === "audit" && <AuditTab workspaceId={activeWorkspaceId} people={data.people} onError={setError} />}
              {data && tab === "privacy" && <PrivacyTab workspaceId={activeWorkspaceId} onError={setError} onNotice={setNotice} />}
              {data && tab === "policies" && <PoliciesTab data={data} workspaceId={activeWorkspaceId} onSaved={(p) => setData({ ...data, policies: p })} onError={setError} />}
            </>
          )}
        </main>
      </div>
      {confirm && (
        <ConfirmDialog
          open
          title={confirm.title}
          confirmLabel={confirm.label}
          tone="danger"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const c = confirm;
            setConfirm(null);
            await c.run();
          }}
        >
          {confirm.body}
        </ConfirmDialog>
      )}
    </div>
  );
}

// -------------------------------------------------------------- overview --

function scoreTone(n: number) {
  return n >= 85 ? "text-good" : n >= 70 ? "text-[rgb(var(--ops-refresh))]" : n >= 50 ? "text-warning" : "text-danger";
}
function barTone(n: number) {
  return n >= 85 ? "bg-good" : n >= 70 ? "bg-[rgb(var(--ops-refresh))]" : n >= 50 ? "bg-warning" : "bg-danger";
}

function ScoreRing({ score, grade }: { score: number; grade: string }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(100, score)) / 100) * c;
  return (
    <div className="relative w-[148px] h-[148px] shrink-0" role="img" aria-label={`Posture score ${score} out of 100, ${grade}`}>
      <svg viewBox="0 0 128 128" className="w-full h-full -rotate-90">
        <circle cx="64" cy="64" r={r} fill="none" strokeWidth="10" className="trust-ring-track" />
        <circle cx="64" cy="64" r={r} fill="none" strokeWidth="10" strokeLinecap="round" stroke="currentColor" className={scoreTone(score)} strokeDasharray={`${dash} ${c}`} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[38px] font-semibold text-text tabular-nums leading-none">{score}</span>
        <span className={`text-caption font-medium mt-1 ${scoreTone(score)}`}>{grade}</span>
      </div>
    </div>
  );
}

const SEV: Record<TrustRisk["severity"], { label: string; cls: string }> = {
  high: { label: "High", cls: "bg-danger-fill text-danger border-danger-border" },
  medium: { label: "Medium", cls: "bg-warning-fill text-warning border-warning-border" },
  low: { label: "Low", cls: "bg-subtle text-secondary border-border" },
};

const DIM_TAB: Record<string, Tab> = { access: "access", sensitive: "sensitive", sharing: "sharing", signin: "access", quality: "quality", people: "access" };

function Overview({ data, busy, onAction, onTab }: { data: TrustOverview; busy: string | null; onAction: (r: TrustRisk, a: TrustRisk["actions"][number]) => void; onTab: (t: Tab) => void }) {
  const p = data.posture;
  return (
    <div className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)] items-start">
      <section className="rounded-card border border-border bg-surface p-5 sm:p-6 flex flex-col gap-5" aria-label="Posture">
        <div className="flex items-center gap-5">
          <ScoreRing score={p.score} grade={p.grade} />
          <div className="flex flex-col gap-1.5">
            <Eyebrow>Posture</Eyebrow>
            <div className="text-ui text-secondary leading-relaxed">Six checks, weighted by how much each one protects the team's data.</div>
            <div className="text-caption text-muted">Updated {ago(data.generated_at)}</div>
          </div>
        </div>
        <ul className="m-0 p-0 list-none flex flex-col gap-3.5">
          {p.dimensions.map((d) => (
            <li key={d.key}>
              <button type="button" onClick={() => onTab(DIM_TAB[d.key] || "overview")} className="w-full text-left group">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-ui font-medium text-text group-hover:underline">{d.label}</span>
                  <span className={`font-mono text-caption tabular-nums ${scoreTone(d.score)}`}>{d.score}</span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-subtle overflow-hidden" aria-hidden="true">
                  <div className={`h-full rounded-full ${barTone(d.score)}`} style={{ width: `${Math.max(3, d.score)}%` }} />
                </div>
                <div className="text-caption text-muted mt-1">{d.detail}</div>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <div className="flex flex-col gap-4 min-w-0">
        <section className="rounded-card border border-border bg-surface" aria-label="Risks">
          <div className="flex items-center justify-between gap-3 px-4 sm:px-5 pt-4 pb-3 border-b border-border">
            <h2 className="m-0 text-section font-semibold text-text">What to fix first</h2>
            <span className="text-caption text-muted">
              {data.counts.high} high · {data.counts.medium} medium · {data.counts.low} low
            </span>
          </div>
          {data.risks.length === 0 ? (
            <div className="px-5 py-10 text-center flex flex-col items-center gap-2">
              <span className="w-10 h-10 rounded-full bg-good-fill text-good flex items-center justify-center text-lg" aria-hidden="true">✓</span>
              <div className="text-ui font-medium text-text">Nothing to fix</div>
              <div className="text-caption text-muted">Every check passes. Keep confirming access on schedule.</div>
            </div>
          ) : (
            <ul className="m-0 p-0 list-none divide-y divide-border">
              {data.risks.map((r) => (
                <li key={r.id} className="px-4 sm:px-5 py-4 flex flex-col gap-2.5">
                  <div className="flex items-start gap-3">
                    <span className="shrink-0 w-[64px]"><span className={`h-[22px] px-2 rounded-full border text-[11px] font-medium inline-flex items-center ${SEV[r.severity].cls}`}>{SEV[r.severity].label}</span></span>
                    <div className="min-w-0">
                      <div className="text-ui font-medium text-text leading-snug">{r.title}</div>
                      <div className="text-caption text-muted leading-relaxed mt-1">{r.detail}</div>
                    </div>
                  </div>
                  {r.actions.length > 0 && (
                    <div className="flex flex-wrap gap-2 sm:pl-[76px]">
                      {r.actions.map((a, i) => (
                        <Button key={i} size="sm" className="!h-8" variant={i === 0 ? "primary" : "secondary"} disabled={busy === r.id} loading={busy === r.id && i === 0} onClick={() => onAction(r, a)}>
                          {a.label}
                        </Button>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="grid gap-3 sm:grid-cols-3">
          <MiniStat label="Company domain" value={data.domain ? data.domain.hostname : "Not connected"} sub={data.domain ? (data.domain.status === "live" ? "Live" : "Setting up") : "Publish on your own address"} to="/settings/domains" />
          <MiniStat label="2-step sign-in" value={`${data.people.filter((x) => x.mfa).length} of ${data.people.length}`} sub={data.policies.require_mfa ? "Required" : "Optional"} onClick={() => onTab("policies")} />
          <MiniStat label="Audit log" value={data.counts.audit_events.toLocaleString()} sub="events recorded" onClick={() => onTab("audit")} />
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, sub, to, onClick }: { label: string; value: string; sub: string; to?: string; onClick?: () => void }) {
  const inner = (
    <>
      <Eyebrow>{label}</Eyebrow>
      <div className="text-section font-semibold text-text truncate">{value}</div>
      <div className="text-caption text-muted">{sub}</div>
    </>
  );
  const cls = "rounded-card border border-border bg-surface p-4 flex flex-col gap-1 text-left hover:border-border-strong transition-colors min-w-0";
  return to ? <Link to={to} className={cls}>{inner}</Link> : <button type="button" className={cls} onClick={onClick}>{inner}</button>;
}

// ---------------------------------------------------------------- access --

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };

function AccessTab({
  data, workspaceId, busy, fix, reload, onError, onNotice,
}: {
  data: TrustOverview; workspaceId: string; busy: string | null;
  fix: (key: string, body: Record<string, unknown>, done: string) => Promise<void>;
  reload: () => Promise<void>; onError: (m: string) => void; onNotice: (m: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const iAmOwner = data.workspace.role === "owner";
  const due = data.access.filter((a) => a.shared && a.status !== "ok");
  const setRole = async (userId: string, role: string) => {
    setSaving(userId);
    try {
      await trustApi.setRole(workspaceId, userId, role);
      onNotice(`Role changed to ${ROLE_LABEL[role]}.`);
      await reload();
    } catch (e: any) {
      onError(errorText(e, "Couldn't change the role."));
    } finally {
      setSaving(null);
    }
  };
  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-card border border-border bg-surface" aria-label="People and roles">
        <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-border flex items-baseline justify-between gap-3 flex-wrap">
          <h2 className="m-0 text-section font-semibold text-text">People & roles</h2>
          <span className="text-caption text-muted">Owners and admins manage people, the domain and these rules. Members build. Viewers look.</span>
        </div>
        {data.workspace.personal ? (
          <div className="px-5 py-6 text-ui text-muted">Your personal workspace is just you. Create a team workspace to invite people.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-ui border-collapse min-w-[640px]">
              <thead>
                <tr className="text-left">
                  {["Person", "Role", "2-step", "Last active", "Joined"].map((h) => (
                    <th key={h} className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted font-medium px-4 sm:px-5 py-2.5 border-b border-border">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => {
                  const canChange = p.role !== "owner" && !p.is_me && (iAmOwner || (p.role !== "admin"));
                  return (
                    <tr key={p.user_id} className="border-b border-border last:border-b-0">
                      <td className="px-4 sm:px-5 py-3">
                        <div className="text-text font-medium">{p.name}{p.is_me && <span className="text-muted font-normal"> (you)</span>}</div>
                        <div className="text-caption text-muted">{p.email}</div>
                      </td>
                      <td className="px-4 sm:px-5 py-3">
                        {canChange ? (
                          <Select
                            size="sm"
                            aria-label={`Role for ${p.name}`}
                            value={p.role}
                            disabled={saving === p.user_id}
                            onChange={(e) => setRole(p.user_id, e.target.value)}
                            options={[...(iAmOwner ? [{ value: "admin", label: "Admin" }] : []), { value: "member", label: "Member" }, { value: "viewer", label: "Viewer" }]}
                            className="w-[130px]"
                          />
                        ) : (
                          <span className="text-secondary">{ROLE_LABEL[p.role] || p.role}</span>
                        )}
                      </td>
                      <td className="px-4 sm:px-5 py-3">{p.mfa ? <span className="text-good">✓ On</span> : <span className={data.policies.require_mfa ? "text-warning" : "text-muted"}>Off</span>}</td>
                      <td className="px-4 sm:px-5 py-3 text-secondary">{p.last_active ? ago(p.last_active) : "Never"}</td>
                      <td className="px-4 sm:px-5 py-3 text-muted">{p.joined_at ? fmtWhen(p.joined_at).replace(/ \d+:\d\d.*$/, "") : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-label="Who can see each source">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h2 className="m-0 text-section font-semibold text-text">Who can see each source</h2>
            <p className="m-0 mt-1 text-caption text-muted">Confirm each shared source every {data.policies.review_every_days} days: check the people and the rules, then mark it reviewed.</p>
          </div>
          {due.length > 1 && (
            <Button variant="primary" disabled={busy === "review-all"} loading={busy === "review-all"} onClick={() => fix("review-all", { type: "mark_reviewed", datasource_ids: due.map((d) => d.id) }, `${due.length} sources confirmed.`)}>
              Confirm all {due.length}
            </Button>
          )}
        </div>
        {data.access.length === 0 && <EmptyNote title="No sources yet">Connect a data source and it appears here.</EmptyNote>}
        <div className="flex flex-col gap-2">
          {data.access.map((s) => (
            <SourceRow key={s.id} s={s} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} busy={busy === `review:${s.id}`}
              onReview={() => fix(`review:${s.id}`, { type: "mark_reviewed", datasource_id: s.id }, `${s.name}: access confirmed.`)} />
          ))}
        </div>
      </section>
    </div>
  );
}

function SourceRow({ s, open, onToggle, onReview, busy }: { s: TrustSource; open: boolean; onToggle: () => void; onReview: () => void; busy: boolean }) {
  const status =
    !s.shared ? { text: "Only its owner", cls: "bg-subtle text-secondary border-border" } :
    s.status === "ok" ? { text: `Confirmed ${ago(s.reviewed_at)}`, cls: "bg-good-fill text-good border-good-border" } :
    s.status === "overdue" ? { text: "Review overdue", cls: "bg-warning-fill text-warning border-warning-border" } :
    { text: "Never confirmed", cls: "bg-danger-fill text-danger border-danger-border" };
  return (
    <div className="rounded-card border border-border bg-surface">
      <div className="px-4 sm:px-5 py-3.5 flex items-center gap-3 flex-wrap">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex-1 min-w-[220px] text-left">
          <div className="text-ui font-semibold text-text">{s.name}</div>
          <div className="text-caption text-muted">
            {s.kind} · {s.mode} · owner {s.owner} · {s.who.length} {s.who.length === 1 ? "person" : "people"} can see it
            {s.sensitive.length ? ` · ${s.sensitive.length} personal-data column${s.sensitive.length === 1 ? "" : "s"}` : ""}
            {s.rules.length ? ` · ${s.rules.length} rule${s.rules.length === 1 ? "" : "s"}` : ""}
          </div>
        </button>
        <span className={`h-[24px] px-2.5 rounded-full border text-[11.5px] font-medium inline-flex items-center ${status.cls}`}>{status.text}</span>
        {s.shared && (
          <Button size="sm" className="!h-8" variant={s.status === "ok" ? "secondary" : "primary"} loading={busy} disabled={busy} onClick={onReview}>
            {s.status === "ok" ? "Confirm again" : "Mark reviewed"}
          </Button>
        )}
      </div>
      {open && (
        <div className="border-t border-border px-4 sm:px-5 py-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <div className="flex flex-col gap-2">
            <Eyebrow>Who can see it</Eyebrow>
            <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
              {s.who.map((w) => (
                <li key={w.user_id} className="flex items-center justify-between gap-3 text-ui">
                  <span className="text-text truncate">{w.name} <span className="text-muted text-caption">{w.email}</span></span>
                  <span className="text-caption text-muted shrink-0">{ROLE_LABEL[w.role] || w.role}</span>
                </li>
              ))}
            </ul>
            {s.reviewed_by && <div className="text-caption text-muted mt-1">Last confirmed by {s.reviewed_by}{s.due_at ? ` · due again ${fmtWhen(s.due_at).replace(/ \d+:\d\d.*$/, "")}` : ""}</div>}
          </div>
          <div className="min-w-0">
            <Eyebrow className="mb-2">Rules for members and viewers</Eyebrow>
            <AccessRulesPanel datasourceId={s.id} />
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- sensitive --

const STATE: Record<TrustSensitive["state"], { text: string; cls: string }> = {
  visible: { text: "Visible to everyone", cls: "bg-danger-fill text-danger border-danger-border" },
  hidden_viewers: { text: "Hidden from viewers", cls: "bg-warning-fill text-warning border-warning-border" },
  hidden: { text: "Hidden", cls: "bg-good-fill text-good border-good-border" },
  private: { text: "Only its owner", cls: "bg-subtle text-secondary border-border" },
  dismissed: { text: "Not sensitive", cls: "bg-subtle text-muted border-border" },
};
const CATEGORIES = [
  ["email", "Email"], ["phone", "Phone"], ["name", "Person's name"], ["address", "Address"], ["birth_date", "Date of birth"], ["salary", "Pay"],
  ["government_id", "Government ID"], ["payment", "Payment details"], ["ip_address", "IP address"], ["health", "Health"], ["other", "Other"],
];

function SensitiveTab({ data, busy, fix }: { data: TrustOverview; busy: string | null; fix: (key: string, body: Record<string, unknown>, done: string) => Promise<void> }) {
  const [showDismissed, setShowDismissed] = useState(false);
  const [addSrc, setAddSrc] = useState("");
  const [addCol, setAddCol] = useState("");
  const [addCat, setAddCat] = useState("other");
  const groups = useMemo(() => {
    const m = new Map<string, TrustSensitive[]>();
    data.sensitive.filter((s) => showDismissed || s.state !== "dismissed").forEach((s) => m.set(s.datasource_id, [...(m.get(s.datasource_id) || []), s]));
    return Array.from(m.entries());
  }, [data, showDismissed]);
  const dismissedCount = data.sensitive.filter((s) => s.state === "dismissed").length;
  return (
    <div className="flex flex-col gap-4">
      <Banner>
        GD360 finds personal data by column name in every source, and by sampling values in uploaded files. Live databases and warehouses are never queried for this.
        Hiding a column adds a rule for members and viewers - owners and admins still see it.
      </Banner>
      {groups.length === 0 && <EmptyNote title="No personal data found">Nothing that looks like emails, phone numbers, names, addresses, pay or IDs. Add one by hand below if GD360 missed it.</EmptyNote>}
      {groups.map(([dsId, cols]) => {
        const visible = cols.filter((c) => c.state === "visible" || c.state === "hidden_viewers");
        return (
          <section key={dsId} className="rounded-card border border-border bg-surface">
            <div className="px-4 sm:px-5 py-3.5 border-b border-border flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-ui font-semibold text-text">{cols[0].datasource}</div>
                <div className="text-caption text-muted">{cols.length} column{cols.length === 1 ? "" : "s"} · {visible.length} not hidden</div>
              </div>
              {visible.length > 0 && (
                <Button size="sm" className="!h-8" variant="primary" disabled={busy === `hide:${dsId}`} loading={busy === `hide:${dsId}`}
                  onClick={() => fix(`hide:${dsId}`, { type: "hide_columns", datasource_id: dsId, columns: visible.map((c) => c.column) }, "Hidden from members and viewers.")}>
                  Hide all {visible.length} from members and viewers
                </Button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-ui border-collapse min-w-[680px]">
                <tbody>
                  {cols.map((c) => (
                    <tr key={c.id} className="border-b border-border last:border-b-0">
                      <td className="px-4 sm:px-5 py-3">
                        <div className="font-mono text-[12.5px] text-text">{c.table ? `${c.table}.` : ""}{c.column}</div>
                        <div className="text-caption text-muted">{c.category_label} · {c.reason || "Found by GD360"}</div>
                      </td>
                      <td className="px-3 py-3">
                        <span className={`h-[22px] px-2 rounded-full border text-[11px] font-medium inline-flex items-center whitespace-nowrap ${STATE[c.state].cls}`}>{STATE[c.state].text}</span>
                      </td>
                      <td className="px-4 sm:px-5 py-3">
                        <div className="flex gap-2 justify-end flex-wrap">
                          {(c.state === "visible" || c.state === "hidden_viewers") && (
                            <Button size="sm" className="!h-8" variant="secondary" disabled={busy === `hide1:${c.id}`} loading={busy === `hide1:${c.id}`}
                              onClick={() => fix(`hide1:${c.id}`, { type: "hide_columns", datasource_id: c.datasource_id, columns: [c.column] }, `${c.column} is hidden from members and viewers.`)}>
                              Hide
                            </Button>
                          )}
                          {c.state !== "dismissed" && c.status !== "confirmed" && (
                            <Button size="sm" className="!h-8" variant="ghost" disabled={busy === `dis:${c.id}`}
                              onClick={() => fix(`dis:${c.id}`, { type: "dismiss_column", sensitive_id: c.id }, `${c.column} marked as not sensitive.`)}>
                              Not sensitive
                            </Button>
                          )}
                          {c.state === "dismissed" && (
                            <Button size="sm" className="!h-8" variant="ghost" onClick={() => fix(`res:${c.id}`, { type: "restore_column", sensitive_id: c.id }, `${c.column} is flagged again.`)}>
                              Flag again
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      {dismissedCount > 0 && (
        <button type="button" className="self-start text-caption text-muted hover:text-text underline" onClick={() => setShowDismissed((v) => !v)}>
          {showDismissed ? "Hide" : "Show"} {dismissedCount} marked not sensitive
        </button>
      )}
      <section className="rounded-card border border-border bg-surface p-4 sm:p-5 flex flex-col gap-3" aria-label="Mark a column as sensitive">
        <div className="text-ui font-semibold text-text">GD360 missed one?</div>
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_180px_auto] items-end">
          <Select aria-label="Source" value={addSrc} onChange={(e) => setAddSrc(e.target.value)} options={[{ value: "", label: "Pick a source…" }, ...data.access.map((a) => ({ value: a.id, label: a.name }))]} />
          <input className="input" placeholder="Column name, e.g. customer_mobile" value={addCol} onChange={(e) => setAddCol(e.target.value)} aria-label="Column name" />
          <Select aria-label="Kind of data" value={addCat} onChange={(e) => setAddCat(e.target.value)} options={CATEGORIES.map(([v, l]) => ({ value: v, label: l }))} />
          <Button variant="secondary" disabled={!addSrc || !addCol.trim() || busy === "add"} loading={busy === "add"}
            onClick={async () => {
              await fix("add", { type: "add_sensitive", datasource_id: addSrc, columns: [addCol.trim()], value: addCat }, `${addCol.trim()} marked as sensitive.`);
              setAddCol("");
            }}>
            Mark sensitive
          </Button>
        </div>
      </section>
    </div>
  );
}

// --------------------------------------------------------------- sharing --

const LEVEL: Record<string, { text: string; cls: string }> = {
  public: { text: "Anyone with the link", cls: "bg-danger-fill text-danger border-danger-border" },
  domain_public: { text: "Company domain · anyone", cls: "bg-danger-fill text-danger border-danger-border" },
  domain_company: { text: "Company domain · people at the company", cls: "bg-good-fill text-good border-good-border" },
  domain_invited: { text: "Company domain · invited people", cls: "bg-good-fill text-good border-good-border" },
  domain_members: { text: "Company domain · team only", cls: "bg-good-fill text-good border-good-border" },
  private: { text: "Named people", cls: "bg-subtle text-secondary border-border" },
};

function SharingTab({ data, busy, onUnpublish }: { data: TrustOverview; busy: string | null; onUnpublish: (s: TrustShare) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-card border border-border bg-surface p-4 sm:p-5 flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <Eyebrow>Company domain</Eyebrow>
          <div className="text-section font-semibold text-text mt-1">{data.domain ? data.domain.hostname : "Not connected"}</div>
          <div className="text-caption text-muted mt-0.5">
            {data.domain
              ? data.domain.status === "live"
                ? `Live · ${data.domain.audience === "company" ? "people at the company sign in" : data.domain.audience === "invited" ? "invited people only" : "open to anyone"}`
                : "Being set up - DNS and HTTPS"
              : "Publish dashboards on your own address - viewers sign in with their work email."}
          </div>
        </div>
        <Link to="/settings/domains" className="btn-secondary text-sm">{data.domain ? "Manage domain" : "Connect a domain"}</Link>
      </div>
      {data.sharing.length === 0 && <EmptyNote title="Nothing is shared outside the team">Published links and dashboards on the company domain will be listed here.</EmptyNote>}
      {data.sharing.length > 0 && (
        <div className="rounded-card border border-border bg-surface overflow-x-auto">
          <table className="w-full text-ui border-collapse min-w-[860px]">
            <thead>
              <tr className="text-left">
                {["Dashboard", "Who can open it", "Address", "Views", ""].map((h) => (
                  <th key={h} className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted font-medium px-4 py-2.5 border-b border-border">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.sharing.map((s, i) => {
                const lv = LEVEL[s.level] || { text: s.level, cls: "bg-subtle text-secondary border-border" };
                const full = s.kind === "domain" ? `https://${s.address}` : `${window.location.origin}${s.address}`;
                return (
                  <tr key={`${s.kind}-${s.dashboard_id}-${i}`} className="border-b border-border last:border-b-0 align-top">
                    <td className="px-4 py-3">
                      <Link to={`/dashboard-builder/${s.dashboard_id}`} className="text-text font-medium hover:underline">{s.dashboard}</Link>
                      <div className="text-caption text-muted">by {s.owner}{s.published_at ? ` · ${ago(s.published_at)}` : ""}</div>
                      {s.sensitive_source && <div className="text-caption text-warning mt-0.5">Built on a source with personal data</div>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`h-[22px] px-2 rounded-full border text-[11px] font-medium inline-flex items-center whitespace-nowrap ${lv.cls}`}>{lv.text}</span>
                      <div className="text-caption text-muted mt-1">
                        {s.kind === "link" && s.level === "private" && `${s.emails} ${s.emails === 1 ? "person" : "people"}${s.password ? " · password" : ""}`}
                        {s.kind === "domain" && (s.row_rule ? "Each person sees their own rows" : s.emails ? `${s.emails} invited` : "")}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[12px] text-secondary break-all">{s.kind === "domain" ? s.address : s.custom_domain || s.address}</span>
                        <CopyButton text={s.custom_domain ? `https://${s.custom_domain}` : full} label="Copy" />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-secondary tabular-nums">
                      {s.views.toLocaleString()}
                      <div className="text-caption text-muted">{s.kind === "domain" ? "people · 30 days" : s.last_viewed_at ? `last ${ago(s.last_viewed_at)}` : "not opened yet"}</div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {s.kind === "link" ? (
                        <Button size="sm" className="!h-8" variant="secondary" disabled={busy === `unpub:${s.dashboard_id}`} onClick={() => onUnpublish(s)}>Stop publishing</Button>
                      ) : (
                        <Link to="/settings/domains" className="btn-secondary text-sm inline-flex items-center gap-1.5">Manage <ExternalIcon size={13} /></Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------- quality --

function QualityTab({ data }: { data: TrustOverview }) {
  const [open, setOpen] = useState<string | null>(null);
  const q = data.quality;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        {[
          ["Checks", q.total_rules],
          ["Failing", q.failing],
          ["Sources with checks", q.sources.filter((s) => s.rules > 0).length],
          ["Sources without", q.sources.filter((s) => s.rules === 0).length],
        ].map(([k, v]) => (
          <div key={k as string} className="rounded-card border border-border bg-surface p-4">
            <Eyebrow>{k}</Eyebrow>
            <div className={`text-title font-semibold tabular-nums mt-1 ${k === "Failing" && (v as number) > 0 ? "text-danger" : "text-text"}`}>{v as number}</div>
          </div>
        ))}
      </div>
      {q.sources.length === 0 && <EmptyNote title="No sources yet" />}
      {q.sources.map((s) => (
        <div key={s.id} className="rounded-card border border-border bg-surface">
          <div className="px-4 sm:px-5 py-3.5 flex items-center gap-3 flex-wrap">
            <button type="button" className="flex-1 min-w-[220px] text-left" onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id} disabled={!s.rules}>
              <div className="text-ui font-semibold text-text">{s.name}</div>
              <div className="text-caption text-muted">
                {s.rules ? `${s.rules} check${s.rules === 1 ? "" : "s"} · ${s.passing} passing${s.last_run_at ? ` · last run ${ago(s.last_run_at)}` : ""}` : "No checks yet"}
              </div>
            </button>
            {s.failing > 0 && <span className="h-[24px] px-2.5 rounded-full border text-[11.5px] font-medium inline-flex items-center bg-danger-fill text-danger border-danger-border">{s.failing} failing</span>}
            {s.errors > 0 && <span className="h-[24px] px-2.5 rounded-full border text-[11.5px] font-medium inline-flex items-center bg-warning-fill text-warning border-warning-border">{s.errors} couldn't run</span>}
            {s.rules > 0 && s.failing === 0 && s.errors === 0 && <span className="h-[24px] px-2.5 rounded-full border text-[11.5px] font-medium inline-flex items-center bg-good-fill text-good border-good-border">All passing</span>}
            <Link to={`/workspace/${s.id}`} className="btn-secondary text-sm">{s.rules ? "Open" : "Add checks"}</Link>
          </div>
          {open === s.id && s.details.length > 0 && (
            <ul className="m-0 p-0 list-none border-t border-border divide-y divide-border">
              {s.details.map((d) => (
                <li key={d.id} className="px-4 sm:px-5 py-2.5 flex items-center gap-3 text-ui">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${d.status === "pass" ? "bg-good" : d.status === "fail" ? "bg-danger" : d.status === "error" ? "bg-warning" : "bg-border-strong"}`} aria-hidden="true" />
                  <span className="font-mono text-[12px] text-text">{d.column || "table"}</span>
                  <span className="text-secondary">{d.type.replace(/_/g, " ")}</span>
                  <span className="ml-auto text-caption text-muted truncate max-w-[50%]">{d.message || (d.status ? d.status : "Not run yet")}{d.failing_rows ? ` · ${d.failing_rows.toLocaleString()} rows` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ audit --

function AuditTab({ workspaceId, people, onError }: { workspaceId: string; people: TrustOverview["people"]; onError: (m: string) => void }) {
  const [page, setPage] = useState(1);
  const [category, setCategory] = useState("");
  const [actor, setActor] = useState("");
  const [days, setDays] = useState("30");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [data, setData] = useState<{ events: AuditEvent[]; total: number; page_size: number; categories: string[] } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), 350);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    setData(null);
    trustApi
      .audit(workspaceId, { page, category, actor_id: actor, q: qDebounced, days: days ? Number(days) : undefined })
      .then(setData)
      .catch((e) => onError(errorText(e, "Couldn't load the audit log.")));
  }, [workspaceId, page, category, actor, qDebounced, days, onError]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 flex-wrap items-center">
        <Select size="sm" aria-label="Category" value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }}
          options={[{ value: "", label: "Every kind of change" }, ...(data?.categories || []).map((c) => ({ value: c, label: c }))]} className="min-w-[180px]" />
        <Select size="sm" aria-label="Who" value={actor} onChange={(e) => { setActor(e.target.value); setPage(1); }}
          options={[{ value: "", label: "Anyone" }, ...people.map((p) => ({ value: p.user_id, label: p.name }))]} className="min-w-[150px]" />
        <Select size="sm" aria-label="When" value={days} onChange={(e) => { setDays(e.target.value); setPage(1); }}
          options={[{ value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }, { value: "90", label: "Last 90 days" }, { value: "365", label: "Last year" }, { value: "", label: "All time" }]} className="min-w-[140px]" />
        <SearchInput size="sm" value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search" className="w-full sm:w-[200px]" aria-label="Search the audit log" />
        <div className="flex-1" />
        <Button size="sm" variant="secondary" leadingIcon={<DownloadIcon size={14} />}
          onClick={() => trustApi.download(workspaceId, "audit.csv", { category: category || undefined, actor_id: actor || undefined, q: qDebounced || undefined, days: days || 3650 }).catch((e) => onError(errorText(e, "Couldn't download it.")))}>
          Download CSV
        </Button>
      </div>
      {!data && <div className="flex flex-col gap-2">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-11" />)}</div>}
      {data && data.events.length === 0 && <EmptyNote title="No changes match">Try a longer time range or another filter.</EmptyNote>}
      {data && data.events.length > 0 && (
        <div className="rounded-card border border-border bg-surface overflow-x-auto">
          <table className="w-full text-ui border-collapse min-w-[720px]">
            <thead>
              <tr className="text-left">
                {["When", "Who", "What", "Detail"].map((h) => (
                  <th key={h} className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted font-medium px-4 py-2.5 border-b border-border">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.id} className="border-b border-border last:border-b-0 align-top">
                  <td className="px-4 py-2.5 text-secondary whitespace-nowrap tabular-nums" title={e.at}>{fmtWhen(e.at)}</td>
                  <td className="px-4 py-2.5 text-text">{e.actor}</td>
                  <td className="px-4 py-2.5">
                    <div className="text-text">{e.label}</div>
                    <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-faint">{e.category}</div>
                  </td>
                  <td className="px-4 py-2.5 text-caption text-muted break-words max-w-[420px]">{e.what || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-caption text-muted">{data.total.toLocaleString()} change{data.total === 1 ? "" : "s"}</span>
          {pages > 1 && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Newer</Button>
              <span className="text-caption text-muted">{page} / {pages}</span>
              <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Older</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- privacy --

function PrivacyTab({ workspaceId, onError, onNotice }: { workspaceId: string; onError: (m: string) => void; onNotice: (m: string) => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof trustApi.privacyLookup>> | null>(null);
  const [history, setHistory] = useState<{ requests: AuditEvent[]; consent_records: number } | null>(null);
  const [erase, setErase] = useState<{ id: string; email: string } | null>(null);
  const loadHistory = useCallback(() => {
    trustApi.privacyHistory(workspaceId).then(setHistory).catch(() => setHistory({ requests: [], consent_records: 0 }));
  }, [workspaceId]);
  useEffect(loadHistory, [loadHistory]);
  const lookup = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    try {
      setResult(await trustApi.privacyLookup(workspaceId, email.trim()));
    } catch (err: any) {
      onError(errorText(err, "Couldn't look that up."));
    } finally {
      setBusy(false);
    }
  };
  const exportOne = async (id: string, mail: string) => {
    try {
      const data = await trustApi.exportContact(id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gd360-data-${mail.replace(/[^a-z0-9]+/gi, "-")}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      onNotice(`Exported everything held about ${mail}.`);
      loadHistory();
    } catch (err: any) {
      onError(errorText(err, "Couldn't export it."));
    }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] items-start">
      <section className="rounded-card border border-border bg-surface p-4 sm:p-5 flex flex-col gap-4" aria-label="Find a person's data">
        <div>
          <h2 className="m-0 text-section font-semibold text-text">Find everything about one person</h2>
          <p className="m-0 mt-1 text-caption text-muted">For an access or deletion request: their contact record from Initiatives, what they did, whether they're a member, and their visits to the company domain.</p>
        </div>
        <form onSubmit={lookup} className="flex gap-2 flex-wrap">
          <input className="input flex-1 min-w-[220px]" type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email address" />
          <Button type="submit" variant="primary" loading={busy} disabled={busy || !email.trim()}>Look up</Button>
        </form>
        {result && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2 text-caption">
              <span className="px-2 py-1 rounded-ctl bg-subtle text-secondary">{result.is_member ? "Member of this workspace" : "Not a member"}</span>
              <span className="px-2 py-1 rounded-ctl bg-subtle text-secondary">{result.domain_views} visit{result.domain_views === 1 ? "" : "s"} to the company domain</span>
              <span className="px-2 py-1 rounded-ctl bg-subtle text-secondary">{result.contacts.length} contact record{result.contacts.length === 1 ? "" : "s"}</span>
            </div>
            {result.contacts.length === 0 && <div className="text-ui text-muted">No contact records for {result.email}.</div>}
            {result.contacts.map((c) => (
              <div key={c.id} className="rounded-ctl border border-border bg-base p-3 flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <div className="text-ui font-medium text-text">{c.name || c.email}</div>
                  <div className="text-caption text-muted">
                    {[c.title, `${c.engagements} interactions`, c.consent_records ? `${c.consent_records} consent records` : null, c.phone ? "phone on file" : null, c.unsubscribed ? "unsubscribed" : c.subscribed ? "subscribed" : null].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <Button size="sm" className="!h-8" variant="secondary" leadingIcon={<DownloadIcon size={13} />} onClick={() => exportOne(c.id, c.email)}>Export</Button>
                <Button size="sm" className="!h-8" variant="danger" onClick={() => setErase({ id: c.id, email: c.email })}>Erase</Button>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="rounded-card border border-border bg-surface p-4 sm:p-5 flex flex-col gap-3" aria-label="Privacy requests">
        <h2 className="m-0 text-section font-semibold text-text">Requests handled</h2>
        <div className="text-caption text-muted">{history ? `${history.consent_records} consent records kept` : ""}</div>
        {!history && <Skeleton className="h-20" />}
        {history && history.requests.length === 0 && <div className="text-ui text-muted">No exports or erasures yet.</div>}
        {history?.requests.map((r) => (
          <div key={r.id} className="flex items-baseline justify-between gap-3 text-ui border-b border-border last:border-b-0 pb-2">
            <span className="text-text">{r.label}<span className="text-caption text-muted"> · {r.what}</span></span>
            <span className="text-caption text-muted shrink-0">{ago(r.at)} · {r.actor}</span>
          </div>
        ))}
      </section>
      {erase && (
        <ConfirmDialog
          open
          title={`Erase everything about ${erase.email}?`}
          confirmLabel="Erase for good"
          tone="danger"
          onCancel={() => setErase(null)}
          onConfirm={async () => {
            const e = erase;
            setErase(null);
            try {
              await trustApi.eraseContact(e.id);
              onNotice(`Erased ${e.email}. The audit log keeps that it happened, not what was erased.`);
              loadHistory();
              lookup();
            } catch (err: any) {
              onError(errorText(err, "Couldn't erase it."));
            }
          }}
        >
          Their contact record, interactions and consent history are deleted and can't be brought back.
        </ConfirmDialog>
      )}
    </div>
  );
}

// --------------------------------------------------------------- policies --

const POLICY_HELP: Record<string, string> = {
  require_mfa: "Everyone in the workspace is asked to set up an authenticator app the next time they open GD360, and anyone without it shows as a risk.",
  block_public_links: "Publishing a dashboard to \"anyone with the link\" is refused. Named-people links and the company domain still work.",
  external_email_needs_approval: "A member's automation that emails someone outside the company stays off until an owner or admin approves it.",
  domain_publish_needs_approval: "Members ask; owners and admins publish to the company domain right away.",
};

function PoliciesTab({ data, workspaceId, onSaved, onError }: { data: TrustOverview; workspaceId: string; onSaved: (p: Policies) => void; onError: (m: string) => void }) {
  const [saving, setSaving] = useState<string | null>(null);
  const save = async (patch: Partial<Policies>, key: string) => {
    setSaving(key);
    try {
      const out = await trustApi.setPolicies(workspaceId, patch);
      onSaved(out.rules);
    } catch (e: any) {
      onError(errorText(e, "Couldn't save that rule."));
    } finally {
      setSaving(null);
    }
  };
  const bools: (keyof Policies)[] = ["require_mfa", "block_public_links", "external_email_needs_approval", "domain_publish_needs_approval"];
  return (
    <section className="rounded-card border border-border bg-surface divide-y divide-border" aria-label="Company rules">
      {bools.map((k) => (
        <div key={k} className="px-4 sm:px-5 py-4 flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <div className="text-ui font-medium text-text">{data.policy_labels[k]}</div>
            <div className="text-caption text-muted mt-1 leading-relaxed max-w-[70ch]">{POLICY_HELP[k]}</div>
          </div>
          <Switch checked={!!data.policies[k]} disabled={saving === k} onChange={(v) => save({ [k]: v } as Partial<Policies>, k)} aria-label={data.policy_labels[k]} />
        </div>
      ))}
      <div className="px-4 sm:px-5 py-4 flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <div className="text-ui font-medium text-text">{data.policy_labels.review_every_days}…</div>
          <div className="text-caption text-muted mt-1">A shared source not confirmed in this time shows as overdue.</div>
        </div>
        <Select
          aria-label="Review every"
          value={String(data.policies.review_every_days)}
          disabled={saving === "review"}
          onChange={(e) => save({ review_every_days: Number(e.target.value) }, "review")}
          options={data.review_choices.map((d) => ({ value: String(d), label: `${d} days` }))}
          className="w-[140px]"
        />
      </div>
      <div className="px-4 sm:px-5 py-3 text-caption text-muted">Every change here is written to the audit log.</div>
    </section>
  );
}

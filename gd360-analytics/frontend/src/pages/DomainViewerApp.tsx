// 2026-10-10 (round 19): the company-domain viewer (approved boards H2/H3).
// This same app, opened at a company's own address (data.acmeretail.com):
//   /          the company's dashboards this person can open
//   /:path     one dashboard - the SAME DashboardShell the app uses
// People sign in with their GD360 account (password, or a code emailed to
// them; 2-step when they use it). Company audience = an address at the
// company's email domains, proven once. No other app, no redirect.
// Someone who can't open a dashboard asks for access in one click.
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import ThemeToggle from "../components/ThemeToggle";
import MfaStep from "../components/MfaStep";
import { DataFreshnessBadge } from "../components/DashboardBlocks";
import { DashboardShell, useDashboardRun, useDashboardViewMode, type RunSource } from "../dashboard";
import { useTransientTheme } from "../api/ThemeContext";
import { brandingBackgroundImageStyle, brandingStyleVars } from "../lib/branding";
import type { PublicDashboard } from "../api/client";
import { CheckIcon, Popover, Skeleton } from "../ui";
import { getToken, setToken, viewerApi, type DashOut, type HomeOut, type Me, type Site, type TokenOut } from "../api/viewerApi";

function err(e: any, fallback: string) {
  const s = e?.response?.status;
  if (s === 429) return "Too many tries - wait a minute and try again.";
  const d = e?.response?.data?.detail;
  return typeof d === "string" && d.trim() ? d : fallback;
}

function ago(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)} d ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export default function DomainViewerApp({ site: initialSite }: { site: Site }) {
  const host = typeof window !== "undefined" ? window.location.hostname : "";
  const [site] = useState<Site>(initialSite);
  const [version, setVersion] = useState(0); // bump to refetch after sign-in / sign-out
  const [me, setMe] = useState<Me | null>(null);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    document.title = site.title;
  }, [site.title]);

  const signOut = () => {
    setToken(null);
    setMe(null);
    refresh();
  };

  return (
    <div className="dash-shell min-h-screen bg-base text-text flex flex-col">
      <header className="sticky top-0 z-30 backdrop-blur-md bg-base/85 border-b border-border">
        <div className="max-w-[1320px] mx-auto px-4 sm:px-6 h-14 flex items-center gap-3">
          <Link to="/" className="flex items-center gap-2.5 min-w-0" aria-label={`${site.title} home`}>
            {site.has_logo ? (
              <img src={viewerApi.logoUrl(host)} alt="" className="h-7 w-auto max-w-[150px] object-contain" />
            ) : (
              <span className="w-7 h-7 rounded-[7px] bg-primary text-on-primary text-[13px] font-bold flex items-center justify-center shrink-0">{site.title.charAt(0).toUpperCase()}</span>
            )}
            <span className="text-[15px] font-semibold tracking-tight text-text truncate">{site.title}</span>
          </Link>
          <div className="flex-1" />
          <ThemeToggle />
          {me && <UserMenu me={me} onSignOut={signOut} />}
        </div>
      </header>

      <div className="flex-1">
        <Routes>
          <Route path="/" element={<HomePage host={host} site={site} version={version} onMe={setMe} onSignedIn={refresh} />} />
          <Route path="/:path" element={<DashboardPage host={host} site={site} version={version} onMe={setMe} onSignedIn={refresh} />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>

      {site.show_powered_by && (
        <footer className="border-t border-border">
          <div className="max-w-[1320px] mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-3 text-caption text-muted flex-wrap">
            <span>{site.title}</span>
            <span>Powered by GD360</span>
          </div>
        </footer>
      )}
    </div>
  );
}

function UserMenu({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  return (
    <Popover
      align="end"
      width={260}
      role="menu"
      haspopup="menu"
      ariaLabel="Account"
      trigger={(t) => (
        <button type="button" {...t.props} className="ui-focus w-8 h-8 rounded-full bg-tint text-brand-ink text-[12px] font-semibold flex items-center justify-center" aria-label={`Signed in as ${me.email}`}>
          {(me.name || me.email).charAt(0).toUpperCase()}
        </button>
      )}
    >
      {({ close }) => (
        <div className="py-2">
          <div className="px-3.5 pb-2 border-b border-border">
            <div className="text-ui font-medium text-text truncate">{me.name}</div>
            <div className="text-caption text-muted truncate">{me.email}</div>
            {me.member_role && <div className="text-[11px] text-brand-ink mt-1">Team member</div>}
          </div>
          <button type="button" role="menuitem" onClick={() => { close(); onSignOut(); }} className="ui-focus-inset w-full text-left px-3.5 py-2 text-ui text-text hover:bg-subtle mt-1">
            Sign out
          </button>
        </div>
      )}
    </Popover>
  );
}

function NotFound() {
  return (
    <div className="max-w-[560px] mx-auto px-4 py-24 text-center flex flex-col items-center gap-3">
      <div className="text-title font-semibold text-text">There's nothing at this address</div>
      <Link to="/" className="btn-secondary text-sm">See all dashboards</Link>
    </div>
  );
}

// ------------------------------------------------------------------ home --

function HomePage({ host, site, version, onMe, onSignedIn }: { host: string; site: Site; version: number; onMe: (m: Me | null) => void; onSignedIn: () => void }) {
  const [data, setData] = useState<HomeOut | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    viewerApi
      .home(host)
      .then((d) => {
        setData(d);
        onMe(d.me);
      })
      .catch((e) => setError(err(e, "This site isn't available right now.")));
  }, [host, version, onMe]);

  const shown = useMemo(() => (data?.dashboards || []).filter((d) => !q.trim() || d.title.toLowerCase().includes(q.trim().toLowerCase())), [data, q]);

  if (error) return <Centered title="Something went wrong">{error}</Centered>;
  if (!data) return <div className="max-w-[1320px] mx-auto px-4 sm:px-6 py-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[150px] rounded-card" />)}</div>;
  if (!data.can_open_site) {
    return <AccessGate host={host} site={site} reason={data.reason} me={data.me} onSignedIn={onSignedIn} />;
  }
  const firstName = data.me?.name?.split(" ")[0];
  return (
    <main className="max-w-[1320px] mx-auto px-4 sm:px-6 py-8 sm:py-12 flex flex-col gap-8">
      <section className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-2">
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{data.site.workspace_name}</div>
          <h1 className="m-0 text-[30px] sm:text-[40px] font-bold tracking-tight leading-[1.05] text-text">{firstName ? `Hi ${firstName}` : data.site.title}</h1>
          <p className="m-0 text-body text-secondary">{data.dashboards.length} dashboard{data.dashboards.length === 1 ? "" : "s"} you can open here.</p>
        </div>
        {data.dashboards.length > 6 && (
          <input className="input w-full sm:w-[260px]" placeholder="Find a dashboard" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a dashboard" />
        )}
      </section>
      {data.pending_requests.length > 0 && (
        <div className="rounded-card border border-warning-border bg-warning-fill px-4 py-3 text-ui text-text">
          Waiting for access to {data.pending_requests.map((p) => `“${p.title || p.path}”`).join(", ")}. You'll get an email when it's decided.
        </div>
      )}
      {shown.length === 0 ? (
        <Centered title={data.dashboards.length ? "Nothing matches" : "Nothing here yet"}>
          {data.dashboards.length ? "Try another name." : "When the team publishes a dashboard for you, it appears here."}
        </Centered>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((d) => (
            <Link key={d.path} to={`/${d.path}`} className="group rounded-card border border-border bg-surface hover:border-border-strong transition-colors p-5 flex flex-col gap-4 min-h-[150px]">
              <div className="flex items-start justify-between gap-3">
                <span className="w-9 h-9 rounded-ctl bg-tint text-brand-ink flex items-center justify-center" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>
                </span>
                <div className="flex gap-1.5 flex-wrap justify-end">
                  {d.personal_view && <span className="h-[22px] px-2 rounded-full text-[11px] font-medium bg-[rgb(var(--ops-refresh)/0.12)] text-[rgb(var(--ops-refresh))] inline-flex items-center">Your view</span>}
                  {d.subscribed && <span className="h-[22px] px-2 rounded-full text-[11px] font-medium bg-subtle text-secondary inline-flex items-center">Mondays</span>}
                </div>
              </div>
              <div className="flex-1">
                <div className="text-section font-semibold text-text group-hover:underline">{d.title}</div>
                <div className="font-mono text-caption text-muted mt-1">/{d.path}</div>
              </div>
              <div className="text-caption text-muted">
                {d.pages} page{d.pages === 1 ? "" : "s"}{d.updated_at ? ` · updated ${ago(d.updated_at)}` : d.published_at ? ` · published ${ago(d.published_at)}` : ""}
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}

function Centered({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="max-w-[560px] mx-auto px-4 py-20 text-center flex flex-col items-center gap-2">
      <div className="text-title font-semibold text-text">{title}</div>
      {children && <div className="text-ui text-muted leading-relaxed">{children}</div>}
    </div>
  );
}

// ------------------------------------------------------------- dashboard --

function DashboardPage({ host, site, version, onMe, onSignedIn }: { host: string; site: Site; version: number; onMe: (m: Me | null) => void; onSignedIn: () => void }) {
  const { path = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [data, setData] = useState<DashOut | null>(null);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [notice, setNotice] = useState("");
  const [subBusy, setSubBusy] = useState(false);

  const load = useCallback(() => {
    viewerApi
      .dashboard(host, path)
      .then((d) => {
        setData(d);
        onMe(d.me);
        setNotFound(false);
      })
      .catch((e) => {
        if (e?.response?.status === 404) setNotFound(true);
        else setError(err(e, "This dashboard isn't available right now."));
      });
  }, [host, path, onMe]);
  useEffect(() => {
    setData(null);
    setPageIndex(0);
    load();
  }, [load, version]);

  // "Stop these emails" in a Monday email lands here with ?unsubscribe=1.
  useEffect(() => {
    if (!data?.me || !new URLSearchParams(location.search).has("unsubscribe")) return;
    viewerApi.unsubscribe(host, path).then(() => {
      setNotice("You won't get Monday emails for this dashboard any more.");
      setData((d) => (d ? { ...d, subscribed: false } : d));
      navigate(`/${path}`, { replace: true });
    }).catch(() => {});
  }, [data?.me, location.search, host, path, navigate]);

  if (notFound) return <NotFound />;
  if (error) return <Centered title="Something went wrong">{error}</Centered>;
  if (!data) return <div className="max-w-[1320px] mx-auto px-4 sm:px-6 py-8 flex flex-col gap-4"><Skeleton className="h-10 w-1/3" /><Skeleton className="h-[420px] rounded-card" /></div>;
  if (!data.access.ok || !data.dashboard) {
    return <AccessGate host={host} site={site} reason={data.access.reason} me={data.me} onSignedIn={onSignedIn} dash={data} onAsked={load} />;
  }

  const toggleSub = async () => {
    setSubBusy(true);
    try {
      if (data.subscribed) {
        await viewerApi.unsubscribe(host, path);
        setNotice("Monday emails stopped.");
      } else {
        const r = await viewerApi.subscribe(host, path);
        setNotice(`You'll get a link every Monday at 8:00 (${r.timezone}).`);
      }
      setData({ ...data, subscribed: !data.subscribed });
    } catch (e: any) {
      setNotice(err(e, "Couldn't change that."));
    } finally {
      setSubBusy(false);
    }
  };

  return (
    <ViewerDashboard
      host={host}
      path={path}
      data={data}
      dash={data.dashboard}
      pageIndex={pageIndex}
      setPageIndex={setPageIndex}
      notice={notice}
      onDismiss={() => setNotice("")}
      subBusy={subBusy}
      onToggleSub={data.me ? toggleSub : undefined}
    />
  );
}

function ViewerDashboard({
  host, path, data, dash, pageIndex, setPageIndex, notice, onDismiss, subBusy, onToggleSub,
}: {
  host: string; path: string; data: DashOut; dash: PublicDashboard; pageIndex: number; setPageIndex: (i: number) => void;
  notice: string; onDismiss: () => void; subBusy: boolean; onToggleSub?: () => void;
}) {
  const page = dash.pages[pageIndex];
  const warehouse = Boolean(dash.warehouse_native);
  const source = useMemo<RunSource>(
    () =>
      warehouse
        ? {
            kind: "warehouse",
            hideSql: true,
            run: (pageId, req, signal) => viewerApi.run(host, path, pageId, req, signal),
            options: (paramId, opts, signal) => viewerApi.options(host, path, paramId, opts, signal),
          }
        : {
            kind: "file",
            hideSql: true,
            preview: (pageId, filters, blockFilters) => viewerApi.preview(host, path, pageId, filters, blockFilters),
            distinctValues: page ? (column) => viewerApi.filterOptions(host, path, page.id, column).then((r) => ({ values: r.values, dtype: r.dtype })) : undefined,
          },
    [warehouse, host, path, page]
  );
  const run = useDashboardRun({ dashboard: dash, page, source });
  const [viewMode, setViewMode] = useDashboardViewMode(`domain:${host}/${path}`);

  const setTransientTheme = useTransientTheme();
  const themeDefault = dash.appearance?.theme_default;
  useEffect(() => {
    if (themeDefault !== "light" && themeDefault !== "dark") return;
    setTransientTheme(themeDefault);
    return () => setTransientTheme(null);
  }, [themeDefault, setTransientTheme]);

  const bg = dash.has_background_image ? viewerApi.brandingUrl(host, path, "background") : null;
  const style: React.CSSProperties = { ...brandingStyleVars(dash), ...brandingBackgroundImageStyle(dash, bg) };
  const [copied, setCopied] = useState(false);

  return (
    <div style={style} className="min-h-full">
      <div className="max-w-[1320px] mx-auto px-4 sm:px-6 pt-5 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-caption text-muted min-w-0">
            <Link to="/" className="hover:text-text">All dashboards</Link>
            <span aria-hidden="true">/</span>
            <span className="text-secondary truncate">{data.title}</span>
          </nav>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="ui-focus h-8 px-3 rounded-ctl border border-border text-caption text-secondary hover:text-text hover:border-border-strong inline-flex items-center gap-1.5"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(window.location.href.split("?")[0]);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  /* the address bar has it */
                }
              }}
            >
              {copied ? <CheckIcon size={13} className="text-good" /> : null}
              {copied ? "Copied" : "Copy link"}
            </button>
            {onToggleSub && (
              <button
                type="button"
                disabled={subBusy}
                aria-pressed={data.subscribed}
                onClick={onToggleSub}
                className={`ui-focus h-8 px-3 rounded-ctl border text-caption inline-flex items-center gap-1.5 transition-colors ${data.subscribed ? "border-tint-border bg-tint text-brand-ink" : "border-border text-secondary hover:text-text hover:border-border-strong"}`}
              >
                {data.subscribed ? <CheckIcon size={13} /> : null}
                {data.subscribed ? "Emailed on Mondays" : "Email me on Mondays"}
              </button>
            )}
          </div>
        </div>
        {notice && (
          <div role="status" className="rounded-card border border-border bg-surface px-4 py-2.5 text-ui text-text flex items-center gap-3">
            <span className="flex-1">{notice}</span>
            <button type="button" className="text-caption text-muted hover:text-text" onClick={onDismiss}>Dismiss</button>
          </div>
        )}
        {data.view.personal && (
          <div role="note" className="rounded-card border border-[rgb(var(--ops-refresh)/0.35)] bg-[rgb(var(--ops-refresh)/0.08)] px-4 py-2.5 text-ui text-text flex items-start gap-3">
            <span className="w-2 h-2 rounded-full bg-[rgb(var(--ops-refresh))] mt-[7px] shrink-0" aria-hidden="true" />
            <span>
              {data.view.values && data.view.values.length
                ? <>Your view: every number is for <b>{data.view.column}</b> {data.view.values.join(", ")}.</>
                : <>You don't have any rows on this dashboard yet - ask its owner to add you.</>}
              {data.view.hidden_blocks ? <span className="text-muted"> {data.view.hidden_blocks} block{data.view.hidden_blocks === 1 ? " isn't" : "s aren't"} part of your view.</span> : null}
            </span>
          </div>
        )}
      </div>
      <div className="w-full py-4">
        <DashboardShell
          dashboard={dash}
          page={page}
          run={run}
          source={source}
          mode={warehouse ? "warehouse" : "file"}
          owner={null}
          view={viewMode}
          onViewChange={setViewMode}
          beforeContent={
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              {page && !warehouse && <DataFreshnessBadge blocks={page.blocks} />}
              {dash.pages.length > 1 && (
                <div className="flex items-center gap-1.5 flex-wrap" role="tablist" aria-label="Pages">
                  {dash.pages.map((p, i) => (
                    <button
                      key={p.id}
                      type="button"
                      role="tab"
                      aria-selected={i === pageIndex}
                      className={`dash-pagepill text-xs font-medium px-3.5 py-1.5 border transition ${i === pageIndex ? "bg-primary text-on-primary border-primary" : "border-border text-muted hover:text-text hover:bg-surface2"}`}
                      onClick={() => setPageIndex(i)}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          }
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------- access gate --

function AccessGate({
  host, site, reason, me, onSignedIn, dash, onAsked,
}: {
  host: string; site: Site; reason: string; me: Me | null; onSignedIn: () => void; dash?: DashOut; onAsked?: () => void;
}) {
  const title = dash?.title;
  if (reason === "sign_in" || (!me && reason !== "gone")) {
    return (
      <AuthCard site={site} subtitle={title ? `Sign in to open “${title}”.` : undefined}>
        <SignIn host={host} site={site} onDone={onSignedIn} />
      </AuthCard>
    );
  }
  if (reason === "verify_email" && me) {
    return (
      <AuthCard site={site} subtitle={undefined}>
        <VerifyEmail host={host} me={me} onDone={onSignedIn} />
      </AuthCard>
    );
  }
  if (reason === "gone") return <Centered title="This dashboard isn't published any more" />;
  // not_allowed / members_only
  return (
    <AuthCard site={site}>
      <AskAccess host={host} site={site} me={me!} dash={dash} reason={reason} onAsked={onAsked} onSwitch={() => { setToken(null); onSignedIn(); }} />
    </AuthCard>
  );
}

function AuthCard({ site, subtitle, children }: { site: Site; subtitle?: string; children: React.ReactNode }) {
  return (
    <main className="min-h-[calc(100vh-56px)] flex items-start sm:items-center justify-center px-4 py-10">
      <div className="w-full max-w-[420px] flex flex-col gap-5">
        <div className="text-center flex flex-col gap-1.5">
          <div className="text-[24px] font-bold tracking-tight text-text">{site.title}</div>
          {subtitle && <div className="text-ui text-muted">{subtitle}</div>}
        </div>
        <div className="rounded-card border border-border bg-surface p-6 sm:p-7 shadow-card">{children}</div>
        <div className="text-center text-caption text-faint">Your GD360 account works on every company's GD360 site.</div>
      </div>
    </main>
  );
}

function SignIn({ host, site, onDone }: { host: string; site: Site; onDone: () => void }) {
  const [mode, setMode] = useState<"password" | "code" | "create">(site.sign_in.email_code ? "code" : "password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [mfa, setMfa] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState<{ captcha_id: string; question: string } | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hint = site.audience === "company" && site.email_domains.length ? `Use your ${site.email_domains.map((d) => `@${d}`).join(" or ")} email.` : "";

  useEffect(() => {
    if (mode === "create" && !captcha) viewerApi.captcha().then(setCaptcha).catch(() => setCaptcha(null));
  }, [mode, captcha]);

  const finish = (t: TokenOut) => {
    if (t.mfa_required && t.mfa_token) {
      setMfa(t.mfa_token);
      return;
    }
    setToken(t.access_token);
    onDone();
  };
  const go = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(err(e, "That didn't work - try again."));
      if (mode === "create") {
        setCaptcha(null);
        setAnswer("");
      }
    } finally {
      setBusy(false);
    }
  };

  if (mfa) {
    return <MfaStep email={email} onBack={() => setMfa(null)} onSubmit={async (c) => { const t = await viewerApi.loginMfa(mfa, c); setToken(t.access_token); onDone(); }} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 rounded-ctl border border-border p-1 bg-base" role="tablist" aria-label="How to sign in">
        {(site.sign_in.email_code ? (["code", "password"] as const) : (["password", "create"] as const)).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setError(""); }}
            className={`h-8 rounded-[6px] text-caption font-medium transition-colors ${mode === m ? "bg-surface text-text shadow-card" : "text-muted hover:text-text"}`}>
            {m === "code" ? "Email me a code" : m === "password" ? "Password" : "New here"}
          </button>
        ))}
      </div>
      {error && <div role="alert" className="text-sm text-danger bg-danger-fill border border-danger-border rounded-ctl px-3 py-2">{error}</div>}

      {mode === "code" && !codeSent && (
        <form className="flex flex-col gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); go(async () => { await viewerApi.codeRequest(email.trim(), host); setCodeSent(true); }); }}>
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-muted">Work email</span>
            <input className="input" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder={site.email_domains[0] ? `you@${site.email_domains[0]}` : "you@company.com"} />
          </label>
          {hint && <div className="text-caption text-muted -mt-1">{hint}</div>}
          <button className="btn-primary w-full" type="submit" disabled={busy || !email.trim()}>{busy ? "Sending…" : "Send me a code"}</button>
          <div className="text-caption text-muted text-center">New here? The code creates your GD360 account.</div>
        </form>
      )}
      {mode === "code" && codeSent && (
        <form className="flex flex-col gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); go(async () => finish(await viewerApi.codeVerify(email.trim(), code, host, name))); }}>
          <div className="text-ui text-secondary">We sent a 6-digit code to <b className="text-text">{email}</b>. It works for 10 minutes.</div>
          <input className="input text-center font-mono text-[22px] tracking-[0.35em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus
            value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="123456" aria-label="Code" />
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name (for a new account)" aria-label="Your name" />
          <button className="btn-primary w-full" type="submit" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Sign in"}</button>
          <div className="flex justify-between text-caption">
            <button type="button" className="text-muted hover:text-text" onClick={() => { setCodeSent(false); setCode(""); }}>Use another email</button>
            <button type="button" className="text-primary hover:underline" onClick={() => go(async () => { await viewerApi.codeRequest(email.trim(), host); })}>Send again</button>
          </div>
        </form>
      )}
      {mode === "password" && (
        <form className="flex flex-col gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); go(async () => finish(await viewerApi.login(email.trim(), password))); }}>
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-muted">Email</span>
            <input className="input" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-muted">Password</span>
            <input className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          {hint && <div className="text-caption text-muted -mt-1">{hint}</div>}
          <button className="btn-primary w-full" type="submit" disabled={busy || !email.trim() || !password}>{busy ? "Signing in…" : "Sign in"}</button>
          {!site.sign_in.email_code && (
            <div className="text-caption text-muted text-center">No GD360 account? <button type="button" className="text-primary hover:underline" onClick={() => setMode("create")}>Create one</button></div>
          )}
        </form>
      )}
      {mode === "create" && (
        <form className="flex flex-col gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); if (!captcha) return; go(async () => finish(await viewerApi.register({ email: email.trim(), password, full_name: name.trim(), captcha_id: captcha.captcha_id, captcha_answer: answer.trim() }))); }}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" aria-label="Your name" required />
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Work email" aria-label="Work email" required autoComplete="username" />
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (8+ characters)" aria-label="Password" required minLength={8} autoComplete="new-password" />
          <label className="flex items-center gap-3">
            <span className="text-caption text-muted flex-1">{captcha ? captcha.question : "Loading a quick check…"}</span>
            <input className="input w-[90px]" value={answer} onChange={(e) => setAnswer(e.target.value)} aria-label="Answer" required />
          </label>
          {hint && <div className="text-caption text-muted -mt-1">{hint}</div>}
          <button className="btn-primary w-full" type="submit" disabled={busy || !captcha}>{busy ? "Creating…" : "Create account"}</button>
          <div className="text-caption text-muted text-center">Have one? <button type="button" className="text-primary hover:underline" onClick={() => setMode("password")}>Sign in</button></div>
        </form>
      )}
    </div>
  );
}

function VerifyEmail({ host, me, onDone }: { host: string; me: Me; onDone: () => void }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e?.response?.status === 503 ? "Email isn't switched on for this site yet, so your address can't be confirmed. Ask the team to add you as a member." : err(e, "That didn't work."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-xl font-semibold text-text">Confirm it's your email</h2>
        <p className="m-0 text-sm text-muted leading-relaxed">You're signed in as <b className="text-text">{me.email}</b>. This site opens for people at the company, so we check the address once with a code.</p>
      </div>
      {error && <div role="alert" className="text-sm text-danger bg-danger-fill border border-danger-border rounded-ctl px-3 py-2">{error}</div>}
      {!sent ? (
        <button className="btn-primary w-full" type="button" disabled={busy} onClick={() => go(async () => { await viewerApi.verifyEmailRequest(host); setSent(true); })}>
          {busy ? "Sending…" : `Email a code to ${me.email}`}
        </button>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); go(async () => { await viewerApi.verifyEmailConfirm(code); onDone(); }); }}>
          <input className="input text-center font-mono text-[22px] tracking-[0.35em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="123456" aria-label="Code" />
          <button className="btn-primary w-full" type="submit" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Confirm"}</button>
        </form>
      )}
      <button type="button" className="text-caption text-muted hover:text-text" onClick={() => { setToken(null); onDone(); }}>Use another account</button>
    </div>
  );
}

function AskAccess({ host, site, me, dash, reason, onAsked, onSwitch }: { host: string; site: Site; me: Me; dash?: DashOut; reason: string; onAsked?: () => void; onSwitch: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const req = dash?.access.request;
  const membersOnly = reason === "members_only";
  if (!dash) {
    return (
      <div className="flex flex-col gap-3 text-center">
        <h2 className="m-0 text-xl font-semibold text-text">You can't open this site yet</h2>
        <p className="m-0 text-sm text-muted leading-relaxed">
          You're signed in as <b className="text-text">{me.email}</b>.{" "}
          {site.audience === "company" && site.email_domains.length ? `It's for people with an ${site.email_domains.map((d) => `@${d}`).join(" or ")} email.` : "It's only for people the team has invited."}{" "}
          If someone sent you a link to a dashboard, open it to ask for access.
        </p>
        <button type="button" className="btn-secondary text-sm" onClick={onSwitch}>Use another account</button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-xl font-semibold text-text">{req?.status === "pending" ? "Request sent" : req?.status === "declined" ? "Access wasn't given" : `Ask to open “${dash.title}”`}</h2>
        <p className="m-0 text-sm text-muted leading-relaxed">
          {req?.status === "pending"
            ? `The team will decide soon - you'll get an email at ${me.email}.`
            : membersOnly
              ? `“${dash.title}” is for the ${site.workspace_name} team. You're signed in as ${me.email}.`
              : `It isn't shared with ${me.email} yet.`}
        </p>
      </div>
      {error && <div role="alert" className="text-sm text-danger bg-danger-fill border border-danger-border rounded-ctl px-3 py-2">{error}</div>}
      {req?.status !== "pending" && dash.access.can_request && (
        <form className="flex flex-col gap-3" onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await viewerApi.askAccess(host, dash.path, note);
            onAsked?.();
          } catch (er: any) {
            setError(err(er, "Couldn't send it."));
          } finally {
            setBusy(false);
          }
        }}>
          <textarea className="input min-h-[80px]" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why you need it (optional)" maxLength={500} aria-label="Note" />
          <button className="btn-primary w-full" type="submit" disabled={busy}>{busy ? "Sending…" : "Ask for access"}</button>
        </form>
      )}
      {req?.status === "pending" && <div className="rounded-ctl bg-subtle px-3 py-2.5 text-caption text-secondary">Asked {ago(req.at)}</div>}
      <div className="flex justify-between text-caption">
        <Link to="/" className="text-muted hover:text-text">All dashboards</Link>
        <button type="button" className="text-muted hover:text-text" onClick={onSwitch}>Use another account</button>
      </div>
    </div>
  );
}

/** Decides what a custom hostname is: a company domain (this app), one
 * dashboard's older own address (PublicDashboardView) or nothing. */
export function useCustomHostKind(host: string) {
  const [state, setState] = useState<{ kind: "loading" | "org" | "legacy" | "none" | "error"; site?: Site }>({ kind: "loading" });
  useEffect(() => {
    viewerApi
      .site(host)
      .then((r) => setState({ kind: r.kind, site: r.site }))
      .catch(() => setState({ kind: "legacy" }));
  }, [host]);
  return state;
}

export function UnknownHost() {
  return (
    <div className="dash-shell min-h-screen bg-base text-text flex items-center justify-center px-4">
      <div className="text-center flex flex-col gap-2 max-w-[460px]">
        <div className="text-title font-semibold">This address isn't set up yet</div>
        <div className="text-ui text-muted">If you just connected it, the team may still be finishing the setup. Try again in a few minutes.</div>
      </div>
    </div>
  );
}

export { getToken };

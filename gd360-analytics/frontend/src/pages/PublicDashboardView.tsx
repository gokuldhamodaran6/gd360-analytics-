import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { API_URL, publicDashboardApi, PublicDashboard } from "../api/client";
import ThemeToggle from "../components/ThemeToggle";
import { DataFreshnessBadge } from "../components/DashboardBlocks";
import { DashboardShell, useDashboardRun, useDashboardViewMode, type RunSource } from "../dashboard";
import { brandingBackgroundImageStyle, brandingStyleVars } from "../lib/branding";

// 2026-09-24 (Dashboard Builder Phase 1 + Phase 3): the anonymous, no-login
// viewer a published dashboard's public OR private link actually opens -
// reached at /d/:slug (see App.tsx, deliberately NOT wrapped in
// <Protected>). This deliberately does NOT use TopNav (that component
// calls useAuth() and renders account/admin/logout controls that make no
// sense for a stranger who has never signed in and never will) - same
// reasoning PrivacyPolicy.tsx already established for this app's other
// genuinely public pages: a minimal wordmark + theme toggle header instead.
//
// Phase 3 adds the private-dashboard email/password gate. A private
// dashboard's first fetch 401s (no viewer token yet) - that's treated as
// an ordinary, expected state here, not an error, and shows this page's
// own small email/password form rather than any kind of "something went
// wrong" message. See api/client.ts's publicDashboardApi for why this uses
// its own separate axios instance instead of the shared `api` one (the
// shared instance would wrongly redirect a real logged-in GD360 user to
// /login on this page's very ordinary 401s).
//
// 2026-09-24 (Phase 4, white-label): this component is reached TWO ways
// now - at /d/:slug (a real slug param, GD360's own onrender.com URL) or,
// with no slug param at all, as App.tsx's catch-all render for EVERY path
// when this whole SPA has been loaded through a customer's own custom
// domain (see App.tsx's own comment for why that's a deliberate whole-
// domain catch-all rather than a specific route). `resolverKey` below is
// whichever one is actually present - the single source of truth for
// which mode this is, rather than a separate boolean that could drift out
// of sync with it. In hostname mode, the GD360 wordmark header and the
// "Built with GD360 Analytics" footer are both hidden - the entire point
// of a white-label domain is that a visitor never sees GD360's own
// branding on it.
//
// The viewer token issued after passing the gate is kept in
// sessionStorage, keyed per slug/hostname - deliberately NOT localStorage:
// it's a narrow, short-lived "may view this one dashboard" grant, not
// something that should silently outlive the browser tab across days/
// weeks on a shared or public computer.
//
// 2026-09-25 (Round 4, branding/customization): this is the surface
// branding is really FOR - a stranger who opens this link should see the
// owner's own logo/colors/background, not GD360's defaults. `dash` (once
// loaded) already carries brand_primary_color/brand_accent_color/
// background_style/background_color/has_logo/has_background_image (see
// api/client.ts's DashboardBranding) and is rendered through the exact
// same lib/branding.ts helpers DashboardBuilderView.tsx's owner editor
// uses, so a dashboard looks identical here and there. Unlike the owner
// editor, the branding image URLs here point straight at this file's own
// UNAUTHENTICATED public endpoints (/public/dashboards/{slug}/branding/...
// or /public/domains/{hostname}/branding/...) - no bearer token to attach,
// so a plain <img src> works with no blob-fetch dance.
function tokenStorageKey(kind: "slug" | "host", key: string) {
  return `gd360_dashboard_access:${kind}:${key}`;
}

function AccessGate({
  reasonMessage,
  verify,
  fetchDashboard,
  storageKey,
  onUnlocked,
}: {
  // Set only when we arrived here after a 403 (a previously-working token
  // just got revoked, or was for a different dashboard) - shown once,
  // above the form, so the person understands why they're being asked
  // again rather than assuming the link is simply broken.
  reasonMessage?: string;
  // Bound to either publicDashboardApi.verify/get (slug mode) or
  // .verifyByHostname/.getByHostname (hostname mode) by the caller below -
  // this component itself has no idea which one it's talking to.
  verify: (email: string, password?: string) => Promise<string>;
  fetchDashboard: (token: string) => Promise<PublicDashboard>;
  storageKey: string;
  // 2026-10-05 (public-filters round): now also hands back the token
  // itself (not just the unlocked dashboard) - PublicDashboardView keeps
  // it in state so the new preview-filtered/filter-options calls can carry
  // it as X-Dashboard-Access-Token, same as the initial fetch already did.
  onUnlocked: (dash: PublicDashboard, token: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const token = await verify(email.trim(), password || undefined);
      sessionStorage.setItem(storageKey, token);
      const dash = await fetchDashboard(token);
      onUnlocked(dash, token);
    } catch (err: any) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.detail;
      if (status === 429) {
        setError("Too many attempts. Please wait a minute and try again.");
      } else if (typeof detail === "string") {
        setError(detail);
      } else {
        setError("Couldn't verify your access. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-sm mx-auto mt-16">
      <div className="dash-card p-6">
        <h1 className="text-lg font-bold mb-1.5">Private dashboard</h1>
        <p className="text-sm text-muted mb-5">
          This dashboard is only shared with specific people. Enter the email address it was shared with to
          continue.
        </p>
        {reasonMessage && (
          <div className="text-xs text-amber-500 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 mb-4">
            {reasonMessage}
          </div>
        )}
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div>
            <label className="text-[11px] text-muted uppercase tracking-wide">Email</label>
            <input
              type="email"
              required
              autoFocus
              className="input text-sm w-full mt-1"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="text-[11px] text-muted uppercase tracking-wide">Password (if one was set)</label>
            <input
              type="password"
              className="input text-sm w-full mt-1"
              placeholder="Leave blank if you weren't given one"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
          <button type="submit" disabled={busy || !email.trim()} className="btn-primary text-sm w-full disabled:opacity-50">
            {busy ? "Checking…" : "View dashboard"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function PublicDashboardView() {
  const { slug } = useParams();
  // Hostname mode has no slug param at all - see this file's own module
  // docstring above and App.tsx for how a request ever gets routed here
  // with none. window.location.hostname is read once at mount; a custom
  // domain never changes out from under an already-open tab, so this
  // doesn't need to be reactive to navigation the way slug already is.
  const [hostname] = useState(() => (typeof window !== "undefined" ? window.location.hostname : ""));
  const byHostname = !slug;
  const resolverKey = slug || hostname;

  const [dash, setDash] = useState<PublicDashboard | null>(null);
  const [error, setError] = useState("");
  const [needsAccess, setNeedsAccess] = useState(false);
  const [gateReason, setGateReason] = useState<string | undefined>(undefined);
  const [activePageIndex, setActivePageIndex] = useState(0);
  // 2026-10-05 (public-filters round): the private-dashboard viewer token
  // used to only ever live in sessionStorage (write-only from this
  // component's own perspective) - the new preview-filtered/filter-options
  // calls below need it in hand to attach as X-Dashboard-Access-Token, the
  // same way the initial dashboard fetch already does. Stays undefined for
  // a public (non-private) dashboard, which is fine - the backend only
  // ever checks this header for share.mode == "private".
  const [viewerToken, setViewerToken] = useState<string | undefined>(undefined);

  const fetchDashboard = useCallback(
    (token?: string) =>
      byHostname ? publicDashboardApi.getByHostname(resolverKey, token) : publicDashboardApi.get(resolverKey, token),
    [byHostname, resolverKey]
  );
  const verifyAccess = useCallback(
    (email: string, password?: string) =>
      byHostname
        ? publicDashboardApi.verifyByHostname(resolverKey, email, password)
        : publicDashboardApi.verify(resolverKey, email, password),
    [byHostname, resolverKey]
  );
  const storageKey = tokenStorageKey(byHostname ? "host" : "slug", resolverKey);

  useEffect(() => {
    if (!resolverKey) return;
    let cancelled = false;
    const storedToken = sessionStorage.getItem(storageKey) || undefined;
    setViewerToken(storedToken);

    fetchDashboard(storedToken)
      .then((data) => {
        if (cancelled) return;
        setDash(data);
        setActivePageIndex(0);
      })
      .catch((err) => {
        if (cancelled) return;
        const status = err?.response?.status;
        if (status === 401) {
          // No token yet - the ordinary first-visit state for a private
          // dashboard, not an error.
          setNeedsAccess(true);
        } else if (status === 403) {
          // Had a token (from a previous visit, or from a DIFFERENT
          // private dashboard's gate) that no longer grants access here -
          // clear it and show the gate again with an explanation.
          sessionStorage.removeItem(storageKey);
          const detail = err?.response?.data?.detail;
          setGateReason(typeof detail === "string" ? detail : "Your access has changed - please sign in again.");
          setNeedsAccess(true);
        } else {
          setError("This dashboard isn't available. It may be unpublished or the link may be wrong.");
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolverKey, storageKey]);

  const activePage = dash?.pages[activePageIndex];

  // 2026-09-25 (Round 4, branding): built from resolverKey/byHostname
  // (already known before `dash` loads), not from anything in the
  // response - these are plain, unauthenticated URLs the browser can just
  // <img src> directly, matching get_public_logo/get_public_background
  // (or their _by_domain counterparts) in routers/dashboard_builder.py.
  const brandingBase = byHostname
    ? `${API_URL}/public/domains/${encodeURIComponent(resolverKey)}`
    : `${API_URL}/public/dashboards/${resolverKey}`;
  const logoUrl = dash?.has_logo ? `${brandingBase}/branding/logo` : null;
  const backgroundImageUrl = dash?.has_background_image ? `${brandingBase}/branding/background` : null;
  const shellStyle: React.CSSProperties = {
    ...brandingStyleVars(dash),
    ...brandingBackgroundImageStyle(dash, backgroundImageUrl),
  };

  // 2026-09-25 (naming fix + premium light theme foundation round): this
  // is the one surface in the whole app an external viewer - a customer,
  // an investor, a professor - ever opens with no GD360 account at all,
  // so it's the surface the "should look like a website page" ask matters
  // most for. dash-shell/dash-card (index.css) give it the same soft,
  // premium treatment as the owner's own editor/preview, just laid out as
  // a proper page: a clean sticky header bar instead of a bare row, an
  // eyebrow-labeled title block, and pill-styled page tabs, all still
  // riding the app's existing light/dark tokens so it looks right in
  // either theme rather than only one.
  return (
    <div className="dash-shell min-h-screen bg-base text-text" style={shellStyle}>
      <div className="sticky top-0 z-20 backdrop-blur-md bg-base/80 border-b border-border">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          {byHostname ? (
            // White-label: never show the GD360 wordmark on a customer's
            // own domain - see this file's own module docstring. The
            // owner's own logo (Round 4 branding) takes its place instead,
            // when one is set.
            logoUrl ? <img src={logoUrl} alt="" className="h-7 w-auto max-w-[160px] object-contain" /> : <span />
          ) : (
            <div className="flex items-center gap-2.5">
              {logoUrl && <img src={logoUrl} alt="" className="h-7 w-auto max-w-[140px] object-contain" />}
              <Link to="/" className="font-bold text-lg tracking-tight">
                GD360 <span className="text-primary">Analytics</span>
              </Link>
            </div>
          )}
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full bg-surface2 border border-border text-muted">
              {needsAccess ? "Private dashboard" : "Public dashboard"}
            </span>
            <ThemeToggle />
          </div>
        </div>
      </div>

      <div className={dash ? "w-full py-4" : "max-w-6xl mx-auto px-4 sm:px-6 py-10"}>
        {error && (
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 inline-block">
            {error}
          </div>
        )}

        {needsAccess && !dash && !error && resolverKey && (
          <AccessGate
            reasonMessage={gateReason}
            verify={verifyAccess}
            fetchDashboard={fetchDashboard}
            storageKey={storageKey}
            onUnlocked={(data, token) => {
              setDash(data);
              setViewerToken(token);
              setNeedsAccess(false);
              setActivePageIndex(0);
            }}
          />
        )}

        {!dash && !error && !needsAccess && <div className="text-sm text-muted">Loading&hellip;</div>}

        {dash && (
          <>
            {/* 2026-10-07 (Option A dashboard view): the published link
                renders the SAME DashboardShell the owner's view mode does
                (src/dashboard/), over the public run/options endpoints
                with the viewer token - no owner-only actions, comments
                hidden. See PublicDashboardBody below. */}
            <PublicDashboardBody
              dash={dash}
              activePage={activePage}
              activePageIndex={activePageIndex}
              setActivePageIndex={setActivePageIndex}
              byHostname={byHostname}
              resolverKey={resolverKey}
              viewerToken={viewerToken}
            />

            {/* White-label: no GD360 upsell footer on a customer's own domain. */}
            {!byHostname && (
              <div className="mx-6 mt-6 pt-6 border-t border-border text-xs text-muted flex items-center justify-between flex-wrap gap-2 print:hidden">
                <span>Built with GD360 Analytics</span>
                <Link to="/register" className="text-primary font-medium hover:underline">Build your own dashboard &rarr;</Link>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}


// Split out so useDashboardRun only ever mounts once the dashboard (and,
// for a private share, the viewer token) is known - the gate/loading/
// error states above render before this component exists.
function PublicDashboardBody({
  dash,
  activePage,
  activePageIndex,
  setActivePageIndex,
  byHostname,
  resolverKey,
  viewerToken,
}: {
  dash: PublicDashboard;
  activePage: PublicDashboard["pages"][number] | undefined;
  activePageIndex: number;
  setActivePageIndex: (i: number) => void;
  byHostname: boolean;
  resolverKey: string;
  viewerToken: string | undefined;
}) {
  const warehouse = Boolean(dash.warehouse_native);
  // The slug-keyed and hostname-keyed public twins of run / options /
  // preview-filtered (backend public_router / public_domains_router). The
  // public filter-options endpoint (a file dashboard's distinct values,
  // derived from the page's own materialised rows) is slug-only.
  const source = useMemo<RunSource>(
    () =>
      warehouse
        ? {
            kind: "warehouse",
            // 2026-10-07 (round 9): a published link never shows SQL - and
            // the public endpoints no longer send any.
            hideSql: true,
            run: (pageId, req, signal) =>
              byHostname
                ? publicDashboardApi.runPageByHostname(resolverKey, pageId, req, viewerToken, signal)
                : publicDashboardApi.runPage(resolverKey, pageId, req, viewerToken, signal),
            options: (paramId, opts, signal) =>
              byHostname
                ? publicDashboardApi.parameterOptionsByHostname(resolverKey, paramId, opts, viewerToken, signal)
                : publicDashboardApi.parameterOptions(resolverKey, paramId, opts, viewerToken, signal),
          }
        : {
            kind: "file",
            hideSql: true,
            preview: (pageId, filters, blockFilters) =>
              byHostname
                ? publicDashboardApi.previewFilteredByHostname(resolverKey, pageId, filters, blockFilters, viewerToken)
                : publicDashboardApi.previewFiltered(resolverKey, pageId, filters, blockFilters, viewerToken),
            distinctValues:
              !byHostname && activePage
                ? (column) => publicDashboardApi.getColumnFilterOptions(resolverKey, activePage.id, column, viewerToken).then((r) => ({ values: r.values, dtype: r.dtype }))
                : undefined,
          },
    [warehouse, byHostname, resolverKey, viewerToken, activePage]
  );
  const run = useDashboardRun({ dashboard: dash, page: activePage, source });
  // 2026-10-07 (analyst canvas round): the published link can read the
  // page as a canvas too - nothing editable, no comments (there is no
  // identity to attribute one to) and, since round 9, no SQL: a cell
  // shows what it returned, never its statement. Keyed by the share's
  // slug/hostname since PublicDashboardOut never carries the id.
  const [viewMode, setViewMode] = useDashboardViewMode(`public:${resolverKey}`);

  return (
    <DashboardShell
      dashboard={dash}
      page={activePage}
      run={run}
      source={source}
      mode={warehouse ? "warehouse" : "file"}
      owner={null}
      view={viewMode}
      onViewChange={setViewMode}
      beforeContent={
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          {/* Stored-number dashboards only - see DashboardBuilderView's same line. */}
          {activePage && !warehouse && <DataFreshnessBadge blocks={activePage.blocks} />}
          {dash.pages.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap" role="tablist" aria-label="Pages">
              {dash.pages.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={i === activePageIndex}
                  className={`dash-pagepill text-xs font-medium px-3.5 py-1.5 border transition ${
                    i === activePageIndex ? "bg-primary text-white border-primary" : "border-border text-muted hover:text-text hover:bg-surface2"
                  }`}
                  onClick={() => setActivePageIndex(i)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
      }
    />
  );
}

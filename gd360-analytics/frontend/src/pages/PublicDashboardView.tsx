import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { publicDashboardApi, PublicDashboard } from "../api/client";
import ThemeToggle from "../components/ThemeToggle";
import { DashboardBlockGrid } from "../components/DashboardBlocks";

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
// The viewer token issued after passing the gate is kept in
// sessionStorage, keyed per slug - deliberately NOT localStorage: it's a
// narrow, short-lived "may view this one dashboard" grant, not something
// that should silently outlive the browser tab across days/weeks on a
// shared or public computer.
function tokenStorageKey(slug: string) {
  return `gd360_dashboard_access:${slug}`;
}

function AccessGate({
  slug,
  reasonMessage,
  onUnlocked,
}: {
  slug: string;
  // Set only when we arrived here after a 403 (a previously-working token
  // just got revoked, or was for a different dashboard) - shown once,
  // above the form, so the person understands why they're being asked
  // again rather than assuming the link is simply broken.
  reasonMessage?: string;
  onUnlocked: (dash: PublicDashboard) => void;
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
      const token = await publicDashboardApi.verify(slug, email.trim(), password || undefined);
      sessionStorage.setItem(tokenStorageKey(slug), token);
      const dash = await publicDashboardApi.get(slug, token);
      onUnlocked(dash);
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
      <div className="card p-6">
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
  const [dash, setDash] = useState<PublicDashboard | null>(null);
  const [error, setError] = useState("");
  const [needsAccess, setNeedsAccess] = useState(false);
  const [gateReason, setGateReason] = useState<string | undefined>(undefined);
  const [activePageIndex, setActivePageIndex] = useState(0);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    const storedToken = sessionStorage.getItem(tokenStorageKey(slug)) || undefined;

    publicDashboardApi
      .get(slug, storedToken)
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
          sessionStorage.removeItem(tokenStorageKey(slug));
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
  }, [slug]);

  const activePage = dash?.pages[activePageIndex];

  return (
    <div className="min-h-screen bg-base text-text">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <Link to="/" className="font-bold text-lg tracking-tight">
            GD360 <span className="text-primary">Analytics</span>
          </Link>
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-surface2 border border-border text-muted">
              {needsAccess ? "Private dashboard" : "Public dashboard"}
            </span>
            <ThemeToggle />
          </div>
        </div>

        {error && (
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 inline-block">
            {error}
          </div>
        )}

        {needsAccess && !dash && !error && slug && (
          <AccessGate
            slug={slug}
            reasonMessage={gateReason}
            onUnlocked={(data) => {
              setDash(data);
              setNeedsAccess(false);
              setActivePageIndex(0);
            }}
          />
        )}

        {!dash && !error && !needsAccess && <div className="text-sm text-muted">Loading&hellip;</div>}

        {dash && (
          <>
            <h1 className="text-2xl sm:text-3xl font-bold mb-2">{dash.name}</h1>

            {dash.pages.length > 1 && (
              <div className="flex items-center gap-1.5 mt-4 mb-2 flex-wrap">
                {dash.pages.map((p, i) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`text-xs font-medium px-3 py-1.5 rounded-full border transition ${
                      i === activePageIndex
                        ? "bg-primary text-white border-primary"
                        : "border-border text-muted hover:text-text hover:bg-surface2"
                    }`}
                    onClick={() => setActivePageIndex(i)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}

            <div className="mt-6">
              {activePage ? <DashboardBlockGrid blocks={activePage.blocks} /> : (
                <div className="text-sm text-muted py-10 text-center">This dashboard has no pages yet.</div>
              )}
            </div>

            <div className="mt-12 pt-6 border-t border-border text-xs text-muted flex items-center justify-between flex-wrap gap-2">
              <span>Built with GD360 Analytics</span>
              <Link to="/register" className="text-primary hover:underline">Build your own dashboard &rarr;</Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

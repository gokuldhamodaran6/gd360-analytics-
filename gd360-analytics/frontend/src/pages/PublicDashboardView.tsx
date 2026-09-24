import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { dashboardBuilderApi, PublicDashboard } from "../api/client";
import ThemeToggle from "../components/ThemeToggle";
import { DashboardBlockGrid } from "../components/DashboardBlocks";

// 2026-09-24 (Dashboard Builder Phase 1): the anonymous, no-login viewer a
// published dashboard's public link actually opens - reached at /d/:slug
// (see App.tsx, deliberately NOT wrapped in <Protected>). This deliberately
// does NOT use TopNav (that component calls useAuth() and renders
// account/admin/logout controls that make no sense for a stranger who has
// never signed in and never will) - same reasoning PrivacyPolicy.tsx
// already established for this app's other genuinely public pages: a
// minimal wordmark + theme toggle header instead.

export default function PublicDashboardView() {
  const { slug } = useParams();
  const [dash, setDash] = useState<PublicDashboard | null>(null);
  const [error, setError] = useState("");
  const [activePageIndex, setActivePageIndex] = useState(0);

  useEffect(() => {
    if (!slug) return;
    dashboardBuilderApi
      .getPublic(slug)
      .then((data) => {
        setDash(data);
        setActivePageIndex(0);
      })
      .catch(() => setError("This dashboard isn't available. It may be unpublished or the link may be wrong."));
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
              Public dashboard
            </span>
            <ThemeToggle />
          </div>
        </div>

        {error && (
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 inline-block">
            {error}
          </div>
        )}

        {!dash && !error && <div className="text-sm text-muted">Loading&hellip;</div>}

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

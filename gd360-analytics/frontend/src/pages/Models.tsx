import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { modelsApi, SharedModel } from "../api/client";
import TopNav from "../components/TopNav";
import AppSidebar from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";

// Phase 2, feature 1 (shared, reusable models): the /models library page -
// every DatasetVersion someone has promoted into a reusable, named "model"
// (see backend routers/datasources.py promote_version), across EVERY data
// source the signed-in person can see, not just whichever one happens to
// be open. Copies the template-gallery card grid this app already has
// (components/BuildDashboardModal.tsx's "Start from a template" step, and
// this page's own .dash-card/.dash-icon-chip/.dash-accent-N classes - see
// index.css's own comment on why those are shared, reusable primitives)
// rather than inventing new visual language for one more card grid.
//
// There is no cross-datasource "continue chat" mechanism in this app yet -
// "Open" always lands on the model's own datasource's Workspace page,
// where that exact table is already visible and pickable from the
// existing, real version list (see DataTable.tsx's own tab strip) - never
// a fabricated deep link to a specific version, since nothing in this app
// yet supports that (see this page's own module docstring in the Phase 2
// build notes for the full reasoning).

function StackIcon({ className = "w-[18px] h-[18px]" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l8 4-8 4-8-4 8-4z" />
      <path d="M4 11l8 4 8-4" />
      <path d="M4 15l8 4 8-4" />
    </svg>
  );
}

const ACCENT_CLASSES = ["dash-accent-0", "dash-accent-1", "dash-accent-2", "dash-accent-3", "dash-accent-4", "dash-accent-5"];

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(dateStr).toLocaleDateString();
}

function ModelCard({ model, accentIndex, onOpen }: { model: SharedModel; accentIndex: number; onOpen: () => void }) {
  const accentClass = ACCENT_CLASSES[accentIndex % ACCENT_CLASSES.length];
  return (
    <div className="dash-card p-4 flex flex-col gap-2.5">
      <div className="flex items-start justify-between gap-2">
        <span className={`dash-icon-chip ${accentClass}`}>
          <StackIcon />
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/30 shrink-0">
          Shared model
        </span>
      </div>
      <div className="min-w-0">
        <div className="font-semibold text-sm truncate" title={model.name}>{model.name}</div>
        <div className="text-xs text-muted mt-0.5 truncate" title={model.datasource_name}>
          From {model.datasource_name}
        </div>
      </div>
      {model.description && (
        <p className="text-xs text-muted leading-relaxed line-clamp-3">{model.description}</p>
      )}
      <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-muted">
        <span className="px-1.5 py-0.5 rounded-full bg-surface2 border border-border">
          {model.step_count} step{model.step_count === 1 ? "" : "s"}
        </span>
        {model.row_count !== null && (
          <span className="px-1.5 py-0.5 rounded-full bg-surface2 border border-border">
            {model.row_count.toLocaleString()} rows
          </span>
        )}
        {model.promoted_at && <span>Promoted {timeAgo(model.promoted_at)}</span>}
      </div>
      <button type="button" className="btn-primary text-xs mt-2" onClick={onOpen}>
        Open &rarr;
      </button>
    </div>
  );
}

export default function Models() {
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [models, setModels] = useState<SharedModel[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    modelsApi
      .list()
      .then(setModels)
      .catch(() => setError("Couldn't load your shared models. Please try refreshing."));
  }, []);

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onWorkspaceSwitch={switchWorkspace}
        onWorkspaceCreated={handleWorkspaceCreated}
      />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
          <div className="mb-6">
            <h1 className="text-2xl font-bold tracking-tight">Saved Tables</h1>
            <p className="text-sm text-muted mt-1">
              Prepared tables promoted into reusable, named tables - browsable here from any data source you have
              access to, not just wherever each one was originally built.
            </p>
          </div>

          {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-4">{error}</div>}

          {models === null && !error && <div className="text-sm text-muted">Loading&hellip;</div>}

          {models !== null && models.length === 0 && (
            <div className="dash-card p-8 text-center">
              <div className="text-sm text-muted mb-1 leading-relaxed">No shared models yet.</div>
              <div className="text-xs text-muted leading-relaxed max-w-md mx-auto">
                Open any data source's Data tab, pick a prepared table, and choose &ldquo;Promote to shared
                model&rdquo; to make it reusable and discoverable here.
              </div>
            </div>
          )}

          {models !== null && models.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {models.map((m, i) => (
                <ModelCard key={m.id} model={m} accentIndex={i} onOpen={() => navigate(`/workspace/${m.datasource_id}`)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

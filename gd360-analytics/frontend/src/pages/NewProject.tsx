import { useState } from "react";
import { useNavigate } from "react-router-dom";
import TopNav from "../components/TopNav";
import AppSidebar, { ConnectDataPopup } from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";

function SendIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

function DatabaseIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </svg>
  );
}

const SUGGESTIONS = [
  "Show me monthly revenue trends and flag any outliers",
  "Summarize this dataset and point out anything unusual",
  "Which segments are driving the most growth this quarter?",
];

// 2026-09-23, "New Project" round two: clicking "+ New Project" on the
// Projects home page used to open a connect-data popup FIRST and only
// landed on the real chat workspace once a source was picked - Gokul's
// explicit ask this round was the opposite order: a blank chat page opens
// immediately (so the person can start typing right away), and "connect
// data" is the thing that shows up as a popup from inside it, only once
// they actually try to run something.
//
// This page intentionally does not reimplement any chat/analysis logic of
// its own - Workspace.tsx already owns all of that (chart history, saved
// tables, the WORKING ON picker, etc.) and is deeply built around having a
// real data source to analyze. Duplicating that here would be a second,
// drifting copy of the same machinery. Instead: capture the prompt, let
// ConnectDataPicker (shared with the sidebar's own "Connect data" button -
// see AppSidebar.tsx) pick or connect a source, then hand off to the real
// workspace page with the prompt carried along in the URL - Workspace.tsx
// picks up `?draft=` on arrival and runs it automatically the moment that
// data source is ready, so the handoff is invisible: type, connect,
// you're straight into the real analysis.
export default function NewProject() {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [showConnect, setShowConnect] = useState(false);
  const {
    workspaces,
    activeWorkspaceId,
    switchWorkspace,
    handleWorkspaceCreated,
  } = useWorkspaceNav();

  const isViewerHere = workspaces.find((w) => w.id === activeWorkspaceId)?.role === "viewer";
  const canRun = text.trim().length > 0 && !isViewerHere;

  const startAnalysis = () => {
    if (!canRun) return;
    setShowConnect(true);
  };

  const useSuggestion = (s: string) => setText(s);

  return (
    <div className="flex">
      <AppSidebar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onWorkspaceSwitch={switchWorkspace}
        onWorkspaceCreated={handleWorkspaceCreated}
      />
      <div className="flex-1 min-w-0 flex flex-col">
        <TopNav hideLogo />

        <div className="flex-1 flex items-start sm:items-center justify-center px-4 py-10 sm:py-16">
          <div className="w-full max-w-2xl">
            <div className="text-center mb-7">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">New project</h1>
              <p className="text-sm text-muted max-w-md mx-auto leading-relaxed">
                {isViewerHere
                  ? "You have view-only access to this workspace, so you can't start a new project here."
                  : "Ask GD360 anything about your data. Connect a data source once you're ready to run it."}
              </p>
            </div>

            <div className="card p-4 sm:p-5">
              <textarea
                autoFocus
                rows={4}
                className="input w-full text-sm resize-none"
                placeholder="e.g. Show me monthly revenue trends and flag any outliers..."
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={isViewerHere}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    startAnalysis();
                  }
                }}
              />
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-3">
                <span className="text-xs text-muted">Press Enter to run - Shift+Enter for a new line</span>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    className="btn-secondary text-sm px-4 py-2.5 inline-flex items-center gap-1.5"
                    onClick={() => setShowConnect(true)}
                    disabled={isViewerHere}
                  >
                    <DatabaseIcon className="w-4 h-4" /> Connect data
                  </button>
                  <button
                    type="button"
                    className="btn-primary text-sm px-4 py-2.5 inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={startAnalysis}
                    disabled={!canRun}
                    title={isViewerHere ? "You have view-only access to this workspace." : undefined}
                  >
                    <SendIcon className="w-4 h-4" /> Run analysis
                  </button>
                </div>
              </div>
            </div>

            {!isViewerHere && (
              <div className="mt-5">
                <div className="text-xs font-medium text-muted mb-2">Or try one of these</div>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="text-xs px-3 py-1.5 rounded-full border border-border text-muted hover:text-text hover:border-primary/50 hover:bg-surface2 transition text-left"
                      onClick={() => useSuggestion(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button
              type="button"
              className="mt-6 text-xs text-muted hover:text-text hover:underline block mx-auto"
              onClick={() => navigate("/")}
            >
              &larr; Back to Projects
            </button>
          </div>
        </div>
      </div>

      {showConnect && (
        <ConnectDataPopup
          activeWorkspaceId={activeWorkspaceId}
          draft={text}
          onClose={() => setShowConnect(false)}
        />
      )}
    </div>
  );
}

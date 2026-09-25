import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { dashboardBuilderApi } from "../api/client";

// 2026-09-24 (Dashboard Builder Phase 1): the choice Gokul asked for right
// in the chat flow - "so only they done with analysis our dashboard button
// should show like the flow which will show build by ai or create by own".
//
// 2026-09-25 (Round 2, the "AI Build" wizard + "build own"): both tiles are
// now real. "Build with AI" no longer builds the instant you click it - it
// asks one question first ("what should this dashboard show?", per Gokul's
// own spec: "ai should ask user what we going to build from this data"),
// then GD360 plans and runs a fresh set of analyses against the real data
// for exactly that description (see backend generate_dashboard's own
// docstring) - answering is optional, "Skip" keeps the original one-shot
// behavior of just laying out whatever's already in this chat. "Create
// your own" was shown-but-disabled since Phase 1 ("coming in the next
// round") - the canvas it needed has worked per-block since Phase 2, so
// this now just creates the blank dashboard and hands off to it.

function CloseIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function SparkleIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

function GridIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function ArrowLeftIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}

export default function BuildDashboardModal({
  open,
  conversationId,
  onClose,
}: {
  open: boolean;
  conversationId: string | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [step, setStep] = useState<"choose" | "goal">("choose");
  const [goal, setGoal] = useState("");
  const [building, setBuilding] = useState(false);
  const [creatingBlank, setCreatingBlank] = useState(false);
  const [error, setError] = useState("");

  // Fresh every time this reopens - a stale question/answer or error from
  // a previous open of this same modal (e.g. a different chart) should
  // never carry over.
  useEffect(() => {
    if (open) {
      setStep("choose");
      setGoal("");
      setError("");
    }
  }, [open]);

  if (!open) return null;

  const goToBuild = async (goalText: string) => {
    if (!conversationId) return;
    setBuilding(true);
    setError("");
    try {
      const dash = await dashboardBuilderApi.generate(conversationId, goalText);
      onClose();
      navigate(`/dashboard-builder/${dash.id}`);
    } catch (err: any) {
      setError(
        err?.response?.data?.detail ||
          "Couldn't build a dashboard from this yet. Ask a question in the chat first, then try again."
      );
      setBuilding(false);
    }
  };

  const createOwn = async () => {
    if (!conversationId || creatingBlank) return;
    setCreatingBlank(true);
    setError("");
    try {
      const dash = await dashboardBuilderApi.createBlank(conversationId);
      onClose();
      navigate(`/dashboard-builder/${dash.id}`);
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Couldn't start a new dashboard. Please try again.");
      setCreatingBlank(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !building && !creatingBlank) onClose();
      }}
    >
      <div className="dash-card w-full max-w-lg p-6 relative">
        <button
          className="absolute top-4 right-4 text-muted hover:text-text transition disabled:opacity-40"
          onClick={onClose}
          disabled={building || creatingBlank}
          aria-label="Close"
        >
          <CloseIcon />
        </button>

        {step === "choose" ? (
          <>
            <h2 className="text-lg font-bold mb-1">Build a dashboard</h2>
            <p className="text-xs text-muted mb-5 leading-relaxed max-w-sm">
              Turn this analysis into a real, publishable dashboard - a live page you can share, not just a
              saved chart.
            </p>

            {error && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-4">
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                disabled={!conversationId}
                onClick={() => setStep("goal")}
                className="text-left border border-border rounded-2xl p-4 hover:border-primary hover:bg-primary/5 transition disabled:opacity-50 disabled:cursor-not-allowed group"
              >
                <span className="dash-icon-chip dash-accent-0 mb-3 group-hover:brightness-110 transition">
                  <SparkleIcon className="w-[18px] h-[18px]" />
                </span>
                <div className="font-semibold text-sm mb-1">Build with AI</div>
                <div className="text-xs text-muted leading-relaxed">
                  Tell GD360 what you want to see - it plans and builds a complete dashboard for exactly
                  that, from your real data.
                </div>
              </button>

              <button
                type="button"
                disabled={!conversationId || creatingBlank}
                onClick={createOwn}
                className="text-left border border-border rounded-2xl p-4 hover:border-primary hover:bg-primary/5 transition disabled:opacity-50 disabled:cursor-not-allowed group"
              >
                <span className="dash-icon-chip dash-accent-2 mb-3 group-hover:brightness-110 transition">
                  <GridIcon className="w-[18px] h-[18px]" />
                </span>
                <div className="font-semibold text-sm mb-1">{creatingBlank ? "Starting…" : "Create your own"}</div>
                <div className="text-xs text-muted leading-relaxed">
                  Start from a blank canvas - add your own blocks, then ask AI or build manually to fill
                  each one in.
                </div>
              </button>
            </div>

            <p className="text-[11px] text-muted mt-4 leading-relaxed">
              Either way, you&rsquo;ll be able to add pages, rearrange blocks and style charts once it&rsquo;s
              created - and publish this dashboard publicly whenever you&rsquo;re ready.
            </p>
          </>
        ) : (
          <>
            <button
              type="button"
              className="text-xs text-muted hover:text-text transition flex items-center gap-1 mb-3 disabled:opacity-40"
              onClick={() => setStep("choose")}
              disabled={building}
            >
              <ArrowLeftIcon /> Back
            </button>
            <h2 className="text-lg font-bold mb-1">What should this dashboard show?</h2>
            <p className="text-xs text-muted mb-4 leading-relaxed max-w-sm">
              Describe who it&rsquo;s for or what matters most - GD360 will plan the right KPIs, charts and
              tables and build fresh ones from your real data to match.
            </p>

            {error && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">
                {error}
              </div>
            )}

            <textarea
              autoFocus
              className="input text-sm w-full min-h-[90px] resize-none"
              placeholder='e.g. "A revenue overview for my exec team" or "Customer churn broken down by region"'
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              maxLength={500}
              disabled={building}
            />

            <div className="flex items-center gap-2.5 mt-4">
              <button
                type="button"
                disabled={building || !goal.trim()}
                onClick={() => goToBuild(goal.trim())}
                className="btn-primary text-sm flex-1 disabled:opacity-50"
              >
                {building ? "Building…" : "Build dashboard"}
              </button>
              <button
                type="button"
                disabled={building}
                onClick={() => goToBuild("")}
                className="text-xs text-muted hover:text-text transition disabled:opacity-40 shrink-0"
              >
                Skip - use everything from this analysis
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

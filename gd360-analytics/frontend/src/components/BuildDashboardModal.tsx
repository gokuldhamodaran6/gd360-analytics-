import { useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { dashboardBuilderApi } from "../api/client";

// 2026-09-24 (Dashboard Builder Phase 1): the choice Gokul asked for right
// in the chat flow - "so only they done with analysis our dashboard button
// should show like the flow which will show build by ai or create by own".
// "Build with AI" is real end to end in this round (calls
// dashboardBuilderApi.generate and lands on the new editor/viewer). "Blank
// canvas" is shown but disabled with an honest "coming in the next round"
// note rather than faked - the actual drag/resize block canvas is Phase 2,
// and this app doesn't ship features that only look like they work.

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
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  const buildWithAi = async () => {
    if (!conversationId) return;
    setBuilding(true);
    setError("");
    try {
      const dash = await dashboardBuilderApi.generate(conversationId);
      onClose();
      navigate(`/dashboard-builder/${dash.id}`);
    } catch (err: any) {
      setError(
        err?.response?.data?.detail ||
          "Couldn't build a dashboard from this analysis yet. Ask a question in the chat first, then try again."
      );
      setBuilding(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !building) onClose();
      }}
    >
      <div className="card w-full max-w-lg p-6 relative">
        <button
          className="absolute top-4 right-4 text-muted hover:text-text transition disabled:opacity-40"
          onClick={onClose}
          disabled={building}
          aria-label="Close"
        >
          <CloseIcon />
        </button>
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
            disabled={building || !conversationId}
            onClick={buildWithAi}
            className="text-left border border-border rounded-2xl p-4 hover:border-primary hover:bg-primary/5 transition disabled:opacity-50 disabled:cursor-not-allowed group"
          >
            <span className="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center mb-3 group-hover:bg-primary/20 transition">
              <SparkleIcon />
            </span>
            <div className="font-semibold text-sm mb-1">{building ? "Building…" : "Build with AI"}</div>
            <div className="text-xs text-muted leading-relaxed">
              GD360 picks the right KPIs, charts and tables from this analysis and lays out a full
              dashboard instantly.
            </div>
          </button>

          <div
            className="text-left border border-border rounded-2xl p-4 opacity-50 cursor-not-allowed"
            title="Blank-canvas building arrives in the next round"
          >
            <span className="w-9 h-9 rounded-xl bg-surface2 text-muted flex items-center justify-center mb-3">
              <GridIcon />
            </span>
            <div className="font-semibold text-sm mb-1">Create your own</div>
            <div className="text-xs text-muted leading-relaxed">
              Start from a blank canvas and place your own blocks. Coming in the next round.
            </div>
          </div>
        </div>

        <p className="text-[11px] text-muted mt-4 leading-relaxed">
          Either way, you&rsquo;ll be able to add pages, rearrange blocks and style charts once the full
          canvas editor ships - and publish this dashboard publicly right after it&rsquo;s built.
        </p>
      </div>
    </div>,
    document.body
  );
}

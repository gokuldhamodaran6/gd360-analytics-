import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { dashboardBuilderApi, type DashboardTemplate, type DashboardTemplateBlock } from "../api/client";

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
//
// 2026-09-25 (Round 5, template gallery): a third choice, "Start from a
// template" - a fixed catalog of ready-made LAYOUTS (backend
// _TEMPLATES), never ready-made data. Picking one builds a real v2
// dashboard the same way createOwn does, just pre-laid-out with page
// names/block types/positions/placeholder titles - every block still
// starts genuinely empty and still has to be filled in with real data
// via Ask AI / build manually on the same canvas as always.

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

// 2026-09-25 (Round 5, template gallery): "Start from a template" tile +
// the per-template icons the gallery cards show, keyed by the `icon`
// string backend _TEMPLATES sends for each entry - see TEMPLATE_ICONS
// below the gallery components for the mapping.
function LayersIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l9 5-9 5-9-5 9-5Z" />
      <path d="M3 13l9 5 9-5" />
    </svg>
  );
}

function BarChartIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 21V10M12 21V3M19 21v-7" />
    </svg>
  );
}

function TargetIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.5" fill="currentColor" />
    </svg>
  );
}

function UsersIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
      <path d="M16 9a3 3 0 1 0 0-5.8" />
      <path d="M21.5 20c0-3-2-5.1-4.8-5.8" />
    </svg>
  );
}

function MegaphoneIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 11v2a2 2 0 0 0 2 2h1l3.5 4.5a1 1 0 0 0 1.8-.6V6.1a1 1 0 0 0-1.8-.6L6 10H5a2 2 0 0 0-2 1Z" />
      <path d="M17 9a3 3 0 0 1 0 6M20 6a6.5 6.5 0 0 1 0 12" />
    </svg>
  );
}

function BriefcaseIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7.5" width="18" height="12" rx="2" />
      <path d="M8 7.5V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1.5" />
      <path d="M3 13h18" />
    </svg>
  );
}

const TEMPLATE_ICONS: Record<string, (p: { className?: string }) => JSX.Element> = {
  "bar-chart": BarChartIcon,
  target: TargetIcon,
  users: UsersIcon,
  megaphone: MegaphoneIcon,
  briefcase: BriefcaseIcon,
};

// The same six hues KpiTile/DashboardBlocks already cycle through for
// automatic accent colors (see accentIndex there) - reused here rather
// than invented fresh, just picked in a fixed order per template card.
const TEMPLATE_ACCENT_CLASSES = ["dash-accent-0", "dash-accent-1", "dash-accent-2", "dash-accent-3", "dash-accent-4", "dash-accent-5"];

// A small to-scale wireframe of a template's first page - literally the
// same x/y/w/h grid coordinates the real canvas will place these blocks
// at, just drawn tiny. KPI tiles render as filled squares, every other
// block type as an outlined panel, so the shape of the layout reads at
// a glance without needing real content.
function TemplateThumbnail({ blocks, accentIndex }: { blocks: DashboardTemplateBlock[]; accentIndex: number }) {
  const accentClass = TEMPLATE_ACCENT_CLASSES[accentIndex % TEMPLATE_ACCENT_CLASSES.length];
  return (
    <div
      className="w-full rounded-lg border border-border/60 bg-base/40 p-2"
      style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gridAutoRows: "7px", gap: "3px" }}
    >
      {blocks.map((b, i) => (
        <div
          key={i}
          className={b.type === "kpi" ? `${accentClass} rounded-sm` : "rounded-sm border border-border bg-surface/60"}
          style={{ gridColumn: `${b.x + 1} / span ${b.w}`, gridRow: `${b.y + 1} / span ${b.h}` }}
        />
      ))}
    </div>
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
  const [step, setStep] = useState<"choose" | "goal" | "templates">("choose");
  const [goal, setGoal] = useState("");
  const [building, setBuilding] = useState(false);
  const [creatingBlank, setCreatingBlank] = useState(false);
  const [error, setError] = useState("");

  // 2026-09-25 (Round 5, template gallery) - the catalog for the
  // "templates" step. Fetched lazily the first time that step is
  // reached (not on every open) since most opens of this modal never
  // touch it; cached in state for the rest of this modal's lifetime.
  const [templates, setTemplates] = useState<DashboardTemplate[] | null>(null);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState("");
  const [applyingTemplateKey, setApplyingTemplateKey] = useState<string | null>(null);

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

  useEffect(() => {
    if (step !== "templates" || templates !== null || templatesLoading) return;
    setTemplatesLoading(true);
    setTemplatesError("");
    dashboardBuilderApi
      .listTemplates()
      .then((list) => setTemplates(list))
      .catch(() => setTemplatesError("Couldn't load templates. Please try again."))
      .finally(() => setTemplatesLoading(false));
  }, [step, templates, templatesLoading]);

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

  // 2026-09-25 (Round 5, template gallery): "Use this template" - same
  // shape as createOwn above, just via create-from-template instead of
  // create-blank. applyingTemplateKey (rather than a single boolean)
  // disables only the one card being applied, so the rest of the
  // gallery doesn't grey out while it's happening.
  const useTemplate = async (templateKey: string) => {
    if (!conversationId || applyingTemplateKey) return;
    setApplyingTemplateKey(templateKey);
    setTemplatesError("");
    try {
      const dash = await dashboardBuilderApi.createFromTemplate(conversationId, templateKey);
      onClose();
      navigate(`/dashboard-builder/${dash.id}`);
    } catch (err: any) {
      setTemplatesError(err?.response?.data?.detail || "Couldn't start this template. Please try again.");
      setApplyingTemplateKey(null);
    }
  };

  const busy = building || creatingBlank || !!applyingTemplateKey;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className={`dash-card w-full p-6 relative ${step === "templates" ? "max-w-2xl" : "max-w-lg"}`}>
        <button
          className="absolute top-4 right-4 text-muted hover:text-text transition disabled:opacity-40"
          onClick={onClose}
          disabled={busy}
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

              <button
                type="button"
                disabled={!conversationId}
                onClick={() => setStep("templates")}
                className="text-left border border-border rounded-2xl p-4 hover:border-primary hover:bg-primary/5 transition disabled:opacity-50 disabled:cursor-not-allowed group sm:col-span-2"
              >
                <span className="dash-icon-chip dash-accent-4 mb-3 group-hover:brightness-110 transition">
                  <LayersIcon className="w-[18px] h-[18px]" />
                </span>
                <div className="font-semibold text-sm mb-1">Start from a template</div>
                <div className="text-xs text-muted leading-relaxed">
                  Pick a ready-made layout - revenue, sales, customers, marketing and more - then fill it in
                  with your real data.
                </div>
              </button>
            </div>

            <p className="text-[11px] text-muted mt-4 leading-relaxed">
              Either way, you&rsquo;ll be able to add pages, rearrange blocks and style charts once it&rsquo;s
              created - and publish this dashboard publicly whenever you&rsquo;re ready.
            </p>
          </>
        ) : step === "goal" ? (
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
        ) : (
          <>
            <button
              type="button"
              className="text-xs text-muted hover:text-text transition flex items-center gap-1 mb-3 disabled:opacity-40"
              onClick={() => setStep("choose")}
              disabled={!!applyingTemplateKey}
            >
              <ArrowLeftIcon /> Back
            </button>
            <h2 className="text-lg font-bold mb-1">Start from a template</h2>
            <p className="text-xs text-muted mb-4 leading-relaxed max-w-md">
              Every template is layout only - pages, blocks and placeholder titles, never real numbers. Once
              it&rsquo;s created you fill each block in with your own data, the same way as any block you add
              by hand.
            </p>

            {templatesError && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">
                {templatesError}
              </div>
            )}

            {templatesLoading ? (
              <div className="text-xs text-muted py-8 text-center">Loading templates…</div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[60vh] overflow-y-auto pr-1">
                {(templates || []).map((t, i) => {
                  const Icon = TEMPLATE_ICONS[t.icon] || LayersIcon;
                  const applying = applyingTemplateKey === t.key;
                  return (
                    <div key={t.key} className="border border-border rounded-2xl p-4 flex flex-col">
                      <span className={`dash-icon-chip ${TEMPLATE_ACCENT_CLASSES[i % TEMPLATE_ACCENT_CLASSES.length]} mb-3`}>
                        <Icon className="w-[18px] h-[18px]" />
                      </span>
                      <div className="font-semibold text-sm mb-1">{t.name}</div>
                      <div className="text-xs text-muted leading-relaxed mb-3">{t.description}</div>
                      <div className="mb-3">
                        <TemplateThumbnail blocks={t.pages[0]?.blocks || []} accentIndex={i} />
                      </div>
                      {t.pages.length > 1 && (
                        <div className="text-[11px] text-muted mb-3">{t.pages.length} pages</div>
                      )}
                      <button
                        type="button"
                        disabled={!!applyingTemplateKey}
                        onClick={() => useTemplate(t.key)}
                        className="btn-primary text-xs mt-auto disabled:opacity-50"
                      >
                        {applying ? "Starting…" : "Use this template"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

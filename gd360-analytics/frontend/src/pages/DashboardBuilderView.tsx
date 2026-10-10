import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { MadeFromLink, sourceHref } from "../lib/kinds";
import { Link, useParams } from "react-router-dom";
import { DomainPublishRow, PublishToDomainSheet } from "../components/PublishToDomain";
import {
  dashboardBuilderApi, DashboardBlock, DashboardBuilderDetail, DashboardBuilderPage, DashboardBlockType, datasourceApi, WorkspaceSummary, qualityChecksApi,
} from "../api/client";
import TopNav from "../components/TopNav";
import AppSidebar from "../components/AppSidebar";
import { DataFreshnessBadge } from "../components/DashboardBlocks";
import {
  DashboardShell, isEmptyBlock, readEditFromUrl, useComments, useDashboardEditor, useDashboardRun, useDashboardViewMode, useEditMode, type CanvasOwnerActions, type RunSource,
} from "../dashboard";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { brandingBackgroundImageStyle, brandingStyleVars, hexToRgbTriple, useBrandingAsset } from "../lib/branding";
import { ConfirmDialog, MergeIcon as KitMergeIcon, MoreIcon, PaletteIcon as KitPaletteIcon, Popover, Sheet, WarningIcon, buttonClasses, cn } from "../ui";
import { MenuRow } from "../dashboard/menu";
import { AppearanceSheet } from "../dashboard/theme/AppearanceSheet";
import { BrandAssets } from "../dashboard/theme/BrandAssets";
import { previewSamples } from "../dashboard/theme/PalettePreview";
import { useDashboardAppearance } from "../dashboard/theme/useAppearanceEditor";

// 2026-09-25d (elite pass): the dashboard builder/editor - the exact page
// Gokul's own screenshots of the live app's edit mode were taken from -
// used to render on the old top-bar-only layout, the one real page left
// out of the persistent left AppSidebar (Projects/Dashboards/Data Sources)
// the rest of the app already got in the 2026-09-23 sidebar redesign. That
// gap is very likely a real part of why editing a dashboard still felt
// like "just a chart" next to the Vision UI/Horizon UI references - every
// other page already has the premium sidebar-nav shell those references
// use, this one didn't. Wired in here exactly the same way Dashboard.tsx,
// Dashboards.tsx and DataSources.tsx already do it (useWorkspaceNav owns
// which workspace is active; TopNav keeps its own logo hidden since the
// sidebar already shows one - see TopNav's own hideLogo prop), so this
// page now matches every other authenticated page in the app instead of
// standing out as the one place the shell doesn't apply.

// 2026-09-24 (Dashboard Builder Phase 1 + Phase 2 + Phase 2b + Phase 3): the
// owner/editor view for the new pages+blocks kind of dashboard - opened
// from Dashboards.tsx (routed here instead of DashboardView.tsx whenever
// layout_version===2) or straight after "Build with AI" finishes (see
// BuildDashboardModal.tsx).
//
// 2026-10-07 (dashboard edit mode): opening a dashboard - and landing on
// it after "Publish dashboard" in the prompt builder - shows the FINISHED
// dashboard. Editing is the same page made editable (?edit=1, kept across
// a refresh): the same DashboardShell with the run engine still on, its
// header, rail, KPI strip and grid, plus the edit toolbar - see
// src/dashboard/edit/. The old separate editor screen (a centred column
// around components/DashboardCanvas, whose cards read cached render keys a
// warehouse block does not have) is gone. A dashboard its owner can edit
// that has no block on any page opens straight in edit mode: there is
// nothing to view yet.
//
// Phase 2b adds cross-filtering, live in BOTH Edit and Preview here (never
// on the public link - see lib/useDashboardFilters.ts and the backend's
// own reasoning). One useDashboardFilters() call per active page, shared
// by both DashboardCanvas and DashboardBlockGrid below so a filter
// selection behaves identically whichever mode you're looking at it in.
//
// Phase 3 adds two things to this file specifically: (1) PublishPanel grows
// a public/private mode choice, an optional password, and the named-email
// access list (see PrivateAccessEditor) - editing that list works whether
// or not the dashboard has ever been published yet, since the backend
// auto-creates an unpublished private share row the first time an email is
// added; (2) the page-tabs bar (PageTabsBar) is now always visible for an
// editor (not gated on having more than one page) with inline rename,
// reorder, duplicate and delete - a view-only visitor still gets the old
// plain read-only tabs, unchanged, only shown once there's more than one
// page to switch between.

function LinkIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function CopyIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function TrashIcon({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16Z" />
    </svg>
  );
}

function PencilIcon({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function PlusIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ChevronLeftIcon({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function ChevronRightIcon({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

// 2026-09-25d (elite pass) - see DashboardCanvas.tsx's own KebabIcon for the
// same reasoning: an active page tab used to sprout up to seven separate
// icon buttons (move left/right, rename, duplicate, a color swatch, clear
// tint, delete) the moment it was selected - the same "unwanted editing
// options" clutter, just one level up from the block cards. One kebab menu
// here too, so a page tab reads as just its name and color dot until
// someone deliberately opens its menu.
function KebabIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="12" cy="19" r="1.9" />
    </svg>
  );
}

// "merge with other dashboards in the same project" - two shapes flowing
// into one.
function MergeIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 3v6a4 4 0 0 0 4 4h6" />
      <path d="M7 21v-6a4 4 0 0 1 4-4" />
      <path d="m14 6 3-3 3 3" />
      <path d="m14 18 3 3 3-3" />
    </svg>
  );
}

// 2026-09-24 (Phase 3): manages the "who can view it" list for a PRIVATE
// share - add-by-email plus a remove button per row. Deliberately usable
// even before the dashboard has ever been published: dashboardBuilderApi
// .addShareEmail auto-creates an unpublished private share row server-side
// the first time it's called, so someone can build up the access list
// first and hit Publish once it's ready, rather than being forced to
// publish empty-and-inaccessible before adding anyone.
function PrivateAccessEditor({ dash, onChange }: { dash: DashboardBuilderDetail; onChange: (d: DashboardBuilderDetail) => void }) {
  const [emailDraft, setEmailDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const addEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = emailDraft.trim();
    if (!email || busy) return;
    setBusy(true);
    setError("");
    try {
      onChange(await dashboardBuilderApi.addShareEmail(dash.id, email));
      setEmailDraft("");
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Couldn't add that email.");
    } finally {
      setBusy(false);
    }
  };

  const removeEmail = async (emailId: string) => {
    setBusy(true);
    setError("");
    try {
      onChange(await dashboardBuilderApi.removeShareEmail(dash.id, emailId));
    } catch {
      setError("Couldn't remove that person. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3">
      <label className="text-[11px] text-muted uppercase tracking-wide">Who can view it</label>
      <form onSubmit={addEmail} className="flex items-center gap-1.5 mt-1 mb-2">
        <input
          type="email"
          className="input text-xs flex-1"
          placeholder="name@company.com"
          value={emailDraft}
          onChange={(e) => setEmailDraft(e.target.value)}
        />
        <button type="submit" disabled={busy || !emailDraft.trim()} className="btn-secondary text-xs px-2.5 py-1.5 shrink-0 disabled:opacity-50">
          Add
        </button>
      </form>
      {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-2.5 py-1.5 mb-2">{error}</div>}
      {dash.share_emails.length === 0 ? (
        <div className="text-xs text-muted italic">No one added yet - this link won't open for anyone until you add at least one email.</div>
      ) : (
        <ul className="flex flex-col gap-1 max-h-32 overflow-y-auto">
          {dash.share_emails.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-2 text-xs bg-surface2 rounded-md px-2 py-1">
              <span className="truncate">{e.email}</span>
              <button
                type="button"
                disabled={busy}
                className="text-muted hover:text-red-400 transition shrink-0 disabled:opacity-50"
                onClick={() => removeEmail(e.id)}
                title="Remove access"
              >
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// 2026-09-24 (Phase 4, white-label custom domains): friendly labels for
// the three-state custom_domain_status the backend collapses Render's own
// DNS-verification/SSL-issuance progress into (see
// services/render_domains.py's own docstring). Anything not "live" is
// shown with the same amber "still in progress" styling, since from a
// dashboard owner's point of view "waiting for DNS" and "verifying/
// issuing the certificate" are both just "not ready yet, check back."
const DOMAIN_STATUS_LABEL: Record<string, string> = {
  pending_dns: "Waiting for DNS",
  pending_ssl: "Verifying · issuing certificate",
  live: "Live",
};

function CustomDomainEditor({ dash, onChange }: { dash: DashboardBuilderDetail; onChange: (d: DashboardBuilderDetail) => void }) {
  const [domainDraft, setDomainDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The exact hostname a visitor's CNAME record needs to point at. This
  // editor only ever renders inside DashboardBuilderView, which - per
  // App.tsx's isRecognizedHost - only ever loads on GD360's own
  // onrender.com frontend hostname, never on a customer's own custom
  // domain. So window.location.hostname right here IS that target - no
  // separate "what's our own frontend hostname" config needed on the
  // frontend side at all.
  const cnameTarget = typeof window !== "undefined" ? window.location.hostname : "";

  const addDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    const domain = domainDraft.trim();
    if (!domain || busy) return;
    setBusy(true);
    setError("");
    try {
      onChange(await dashboardBuilderApi.setCustomDomain(dash.id, domain));
      setDomainDraft("");
    } catch (err: any) {
      // A 503 here means this GD360 installation hasn't had
      // RENDER_API_KEY/RENDER_FRONTEND_SERVICE_ID configured yet (see
      // backend config.py) - that message is already written for exactly
      // this reader (the account owner), so it's shown as-is rather than
      // replaced with something generic.
      setError(err?.response?.data?.detail || "Couldn't set that domain. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const recheck = async () => {
    setBusy(true);
    setError("");
    try {
      onChange(await dashboardBuilderApi.recheckCustomDomain(dash.id));
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Couldn't check this domain's status. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const removeDomain = async () => {
    setBusy(true);
    setError("");
    try {
      onChange(await dashboardBuilderApi.removeCustomDomain(dash.id));
    } catch {
      setError("Couldn't remove this domain. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 pt-3 border-t border-border">
      <label className="text-[11px] text-muted uppercase tracking-wide">Custom domain (optional)</label>

      {!dash.custom_domain ? (
        <>
          <form onSubmit={addDomain} className="flex items-center gap-1.5 mt-1">
            <input
              type="text"
              className="input text-xs flex-1"
              placeholder="dashboards.yourcompany.com"
              value={domainDraft}
              onChange={(e) => setDomainDraft(e.target.value)}
            />
            <button type="submit" disabled={busy || !domainDraft.trim()} className="btn-secondary text-xs px-2.5 py-1.5 shrink-0 disabled:opacity-50">
              Add
            </button>
          </form>
          <div className="text-[11px] text-muted mt-1.5 leading-relaxed">
            Point your own subdomain at this dashboard - a free SSL certificate is issued automatically once the
            DNS record is in place.
          </div>
        </>
      ) : (
        <div className="mt-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium truncate">{dash.custom_domain}</span>
            <span
              className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full border shrink-0 ${
                dash.custom_domain_status === "live"
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-500"
                  : "bg-amber-500/10 border-amber-500/30 text-amber-500"
              }`}
            >
              {DOMAIN_STATUS_LABEL[dash.custom_domain_status || ""] || "Setting up"}
            </span>
          </div>

          {dash.custom_domain_status === "live" ? (
            <div className="text-[11px] text-muted mt-1.5">
              This domain is live -{" "}
              <a href={`https://${dash.custom_domain}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                open it &rarr;
              </a>
            </div>
          ) : (
            <div className="text-[11px] text-muted mt-1.5 leading-relaxed">
              Add a CNAME record for <span className="font-mono text-text">{dash.custom_domain}</span> pointing to{" "}
              <span className="font-mono text-text">{cnameTarget}</span>. This can take anywhere from a few minutes
              to a few hours depending on your DNS provider.
            </div>
          )}

          {dash.custom_domain_error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-2.5 py-1.5 mt-1.5">
              {dash.custom_domain_error}
            </div>
          )}

          <div className="flex items-center gap-3 mt-2">
            <button type="button" disabled={busy} className="text-xs text-muted hover:text-text transition disabled:opacity-50" onClick={recheck}>
              {busy ? "Working…" : "Check again"}
            </button>
            <button type="button" disabled={busy} className="text-xs text-muted hover:text-red-400 transition disabled:opacity-50" onClick={removeDomain}>
              Remove
            </button>
          </div>
        </div>
      )}

      {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-2.5 py-1.5 mt-2">{error}</div>}
    </div>
  );
}

// 2026-10-07 (identity-colour round): the "Branding" panel that lived here
// (logo, brand colours, page background) is now the Brand section of the
// one Appearance sheet - src/dashboard/theme/AppearanceSheet.tsx, with the
// logo / background controls in theme/BrandAssets.tsx on the same
// endpoints - next to the chart palette, layout, numbers and public-link
// settings. Nothing stored changed.

// 2026-09-29 (design revamp): "merge with other dashboards in the same
// project" - Gokul's own words. Only ever rendered when this dashboard
// actually HAS sibling dashboards to offer (see DashboardBuilderOut.
// sibling_dashboards's own backend comment for exactly what "same
// project" means - every other real dashboard built from this same
// source chat conversation) - a dashboard with no source conversation, or
// the only dashboard built from its own conversation so far, never shows
// this button at all rather than showing one that opens to an empty,
// useless list. Same dropdown-button shape as PublishPanel right below,
// for visual consistency in this same header row.
function MergeDashboardsPanel({ dash, onChange, inline = false, onMerged }: { dash: DashboardBuilderDetail; onChange: (d: DashboardBuilderDetail) => void; inline?: boolean; onMerged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (!dash.can_edit || dash.sibling_dashboards.length === 0) return null;

  const merge = async (sourceId: string) => {
    if (busyId) return;
    setBusyId(sourceId);
    setError("");
    try {
      onChange(await dashboardBuilderApi.mergeFrom(dash.id, sourceId));
      setOpen(false);
      onMerged?.();
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Couldn't merge that dashboard in. Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className={inline ? undefined : "relative"} ref={boxRef} data-merge-panel="">
      {!inline && (
        <button type="button" className="btn-secondary text-xs flex items-center gap-1.5" onClick={() => setOpen((o) => !o)}>
          <MergeIcon /> Merge dashboards
        </button>
      )}
      {(open || inline) && (
        <div className={inline ? "space-y-2" : "absolute right-0 top-full mt-2 w-80 dash-card bg-surface shadow-2xl border border-border p-3 z-30 space-y-2"}>
          <div className="text-sm font-semibold">Merge in from this project</div>
          <p className="text-[11px] text-muted leading-relaxed">
            Pull another dashboard&apos;s pages into this one, as new tabs here. The other dashboard is left exactly
            as it is - nothing is removed from it.
          </p>
          {error && <div className="text-[11px] text-amber-500 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2 py-1.5">{error}</div>}
          <div className="max-h-64 overflow-y-auto -mx-1 px-1 space-y-1">
            {dash.sibling_dashboards.map((sib) => (
              <div key={sib.id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-surface2/60 transition">
                <div className="min-w-0">
                  <div className="text-xs font-medium truncate">{sib.name}</div>
                  <div className="text-[10px] text-muted">
                    {sib.page_count} page{sib.page_count === 1 ? "" : "s"} · {sib.block_count} block{sib.block_count === 1 ? "" : "s"}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busyId !== null}
                  className="btn-secondary text-[11px] px-2 py-1 shrink-0 disabled:opacity-50"
                  onClick={() => merge(sib.id)}
                >
                  {busyId === sib.id ? "Merging…" : "Merge in"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PublishPanel({ dash, onChange, triggerClassName, onOpenDomain }: { dash: DashboardBuilderDetail; onChange: (d: DashboardBuilderDetail) => void; triggerClassName?: string; onOpenDomain?: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  // Drafts for the (re-)publish form - only read when it's actually
  // submitted. Seeded from the dashboard's current share settings so
  // reopening "Change sharing settings" on an already-private dashboard
  // starts from Private, not defaults back to Public.
  const [mode, setMode] = useState<"public" | "private">(dash.share_mode === "private" ? "private" : "public");
  const [password, setPassword] = useState("");
  // True while showing the editable mode/password form on an ALREADY
  // published dashboard (opened via "Change sharing settings" below) -
  // false means show the read-only published summary instead.
  const [editingSettings, setEditingSettings] = useState(false);

  const publicUrl = dash.public_slug ? `${window.location.origin}/d/${dash.public_slug}` : "";

  const doPublish = async () => {
    setBusy(true);
    setError("");
    try {
      onChange(await dashboardBuilderApi.publish(dash.id, mode, mode === "private" ? password : undefined));
      setEditingSettings(false);
      setPassword("");
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Couldn't publish this dashboard. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const doUnpublish = async () => {
    setBusy(true);
    setError("");
    try {
      onChange(await dashboardBuilderApi.unpublish(dash.id));
    } catch {
      setError("Couldn't unpublish this dashboard. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard permission can be refused in some contexts - the link
      // text itself is still selectable, so this just silently no-ops.
    }
  };

  if (!dash.can_edit) {
    return dash.is_published ? (
      <a href={publicUrl} target="_blank" rel="noreferrer" className={triggerClassName || "btn-secondary text-xs flex items-center gap-1.5"}>
        <LinkIcon className="w-3.5 h-3.5" /> View {dash.share_mode === "private" ? "private" : "public"} link
      </a>
    ) : null;
  }

  const showEditForm = !dash.is_published || editingSettings;

  return (
    <div className="relative">
      <button
        type="button"
        className={triggerClassName || (dash.is_published ? "btn-secondary text-xs" : "btn-primary text-xs")}
        aria-expanded={open}
        data-publish-trigger=""
        onClick={() => setOpen((o) => !o)}
      >
        {dash.is_published ? (dash.share_mode === "private" ? "Published · Private" : "Published") : "Publish"}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-[340px] max-w-[calc(100vw-32px)] card bg-surface shadow-2xl border border-border p-4 z-30">
          {/* 2026-10-10 (round 19): the company's own address comes first. */}
          {onOpenDomain && (
            <DomainPublishRow dashboardId={dash.id} onOpen={() => { setOpen(false); onOpenDomain(); }} />
          )}
          <div className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-muted mb-2">Link</div>
          {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">{error}</div>}
          {!showEditForm ? (
            <>
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-xs text-muted">
                  {dash.share_mode === "private"
                    ? "Only the people you've added below can open this link."
                    : "Anyone with this link can view this dashboard."}
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-surface2 border border-border text-muted shrink-0">
                  {dash.share_mode === "private" ? "Private" : "Public"}
                </span>
              </div>
              <div className="flex items-center gap-1.5 mb-3">
                <input readOnly className="input text-xs flex-1 truncate" value={publicUrl} onFocus={(e) => e.target.select()} />
                <button type="button" className="btn-secondary text-xs px-2.5 py-1.5 shrink-0 flex items-center gap-1" onClick={copyLink}>
                  <CopyIcon /> {copied ? "Copied" : "Copy"}
                </button>
              </div>

              {dash.share_mode === "private" && (
                <>
                  <div className="text-[11px] text-muted mb-3">
                    {dash.share_has_password ? "Password protected." : "No password - the email address alone is enough."}
                  </div>
                  <PrivateAccessEditor dash={dash} onChange={onChange} />
                </>
              )}

              {/* 2026-09-24 (Phase 4, white-label): a custom domain applies
                  regardless of public/private mode - it's a different way
                  in, same underlying share and same access rules. */}
              <CustomDomainEditor dash={dash} onChange={onChange} />

              <div className="flex items-center justify-between mt-1 pt-2 border-t border-border">
                <button
                  type="button"
                  className="text-xs text-muted hover:text-text transition"
                  onClick={() => {
                    setMode(dash.share_mode === "private" ? "private" : "public");
                    setPassword("");
                    setEditingSettings(true);
                  }}
                >
                  Change sharing settings
                </button>
                <button type="button" disabled={busy} className="text-xs text-muted hover:text-red-400 transition disabled:opacity-50" onClick={doUnpublish}>
                  {busy ? "Working…" : "Unpublish"}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="text-xs text-muted mb-3 leading-relaxed">
                {mode === "private"
                  ? "Only the email addresses you add below will be able to open this link - optionally behind a password too."
                  : "Anyone who has the link can view this dashboard without signing in."}
              </div>
              <div className="flex items-center rounded-lg border border-border overflow-hidden text-xs mb-3">
                <button
                  type="button"
                  className={`flex-1 px-2.5 py-1.5 transition ${mode === "public" ? "bg-primary text-on-primary" : "text-muted hover:text-text hover:bg-surface2"}`}
                  onClick={() => setMode("public")}
                >
                  Anyone with the link
                </button>
                <button
                  type="button"
                  className={`flex-1 px-2.5 py-1.5 transition ${mode === "private" ? "bg-primary text-on-primary" : "text-muted hover:text-text hover:bg-surface2"}`}
                  onClick={() => setMode("private")}
                >
                  Named people
                </button>
              </div>

              {mode === "private" && (
                <>
                  <label className="text-[11px] text-muted uppercase tracking-wide">Password (optional)</label>
                  <input
                    type="password"
                    className="input text-xs w-full mt-1 mb-3"
                    placeholder={dash.share_has_password ? "Leave blank to remove the current password" : "Leave blank for no password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <PrivateAccessEditor dash={dash} onChange={onChange} />
                </>
              )}

              <div className="flex items-center gap-2 mt-1">
                {editingSettings && (
                  <button type="button" className="text-xs text-muted hover:text-text transition" onClick={() => setEditingSettings(false)}>
                    Cancel
                  </button>
                )}
                <button type="button" disabled={busy} className="btn-primary text-xs flex-1" onClick={doPublish}>
                  {busy ? "Publishing…" : dash.is_published ? "Save changes" : mode === "private" ? "Publish privately" : "Publish publicly"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// 2026-09-24 (Phase 3): the page-tabs bar. An editor always sees it (even
// with a single page, so "+ Add page" stays discoverable) with rename,
// reorder, duplicate and delete on the active tab; a view-only visitor
// gets the old plain, read-only tabs unchanged, shown only once there's
// more than one page.
function PageTabsBar({
  dash,
  activePageId,
  setActivePageId,
  onChange,
  className = "mt-5 mb-4",
}: {
  dash: DashboardBuilderDetail;
  activePageId: string | undefined;
  setActivePageId: (id: string) => void;
  onChange: (d: DashboardBuilderDetail) => void;
  // Spacing around the bar (the dashboard's context row passes none).
  className?: string;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // 2026-10-07: "Delete page" asks through the kit's confirm, never window.confirm.
  const [deleting, setDeleting] = useState<DashboardBuilderPage | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // 2026-09-25d (elite pass) - see KebabIcon above. Which page's menu is
  // currently open, if any - only ever one at a time.
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const pages = dash.pages;

  const startRename = (p: DashboardBuilderPage) => {
    setRenamingId(p.id);
    setRenameDraft(p.name);
  };

  const commitRename = async (pageId: string) => {
    const name = renameDraft.trim();
    setRenamingId(null);
    const original = pages.find((p) => p.id === pageId)?.name || "";
    if (!name || name === original || busy) return;
    setBusy(true);
    try {
      onChange(await dashboardBuilderApi.renamePage(dash.id, pageId, name));
    } catch {
      // Transient failure - dash still reflects the last-known-good server
      // state, so the tab just keeps its old name locally rather than
      // showing something that was never actually saved.
    } finally {
      setBusy(false);
    }
  };

  const move = async (p: DashboardBuilderPage, direction: -1 | 1) => {
    const idx = pages.findIndex((x) => x.id === p.id);
    const targetIdx = idx + direction;
    if (busy || idx < 0 || targetIdx < 0 || targetIdx >= pages.length) return;
    setBusy(true);
    try {
      onChange(await dashboardBuilderApi.reorderPage(dash.id, p.id, targetIdx));
    } catch {
      // no-op - tabs just stay where they were
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async (p: DashboardBuilderPage) => {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await dashboardBuilderApi.duplicatePage(dash.id, p.id);
      onChange(updated);
      const idx = updated.pages.findIndex((x) => x.id === p.id);
      const dup = updated.pages[idx + 1];
      if (dup) setActivePageId(dup.id);
    } catch {
      // no-op
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: DashboardBuilderPage) => {
    if (busy || pages.length <= 1) return;
    setBusy(true);
    try {
      const updated = await dashboardBuilderApi.deletePage(dash.id, p.id);
      onChange(updated);
      if (activePageId === p.id) {
        const first = updated.pages[0];
        if (first) setActivePageId(first.id);
      }
    } catch {
      // no-op
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  };

  const addPage = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await dashboardBuilderApi.createPage(dash.id);
      onChange(updated);
      const last = updated.pages[updated.pages.length - 1];
      if (last) setActivePageId(last.id);
    } catch {
      // no-op
    } finally {
      setBusy(false);
    }
  };

  // 2026-09-25 (Round 4, branding): this one page's own background tint,
  // separate from the dashboard-level Branding panel above - lets pages
  // read as visually distinct at a glance (an "Overview" vs. a "Details"
  // tab, say) without a second image-upload surface per page. "" clears
  // it back to "inherit the dashboard's background."
  const setPageColor = async (p: DashboardBuilderPage, color: string) => {
    if (busy) return;
    setBusy(true);
    try {
      onChange(await dashboardBuilderApi.setPageBackgroundColor(dash.id, p.id, color));
    } catch {
      // no-op - swatch just stays where it was
    } finally {
      setBusy(false);
    }
  };

  if (!dash.can_edit) {
    if (pages.length <= 1) return null;
    return (
      <div className={cn("flex items-center gap-1.5 flex-wrap", className)} data-page-tabs="">
        {pages.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`text-xs font-medium px-3 py-1.5 rounded-full border transition ${
              activePageId === p.id
                ? "bg-primary text-on-primary border-primary"
                : "border-border text-muted hover:text-text hover:bg-surface2"
            }`}
            onClick={() => setActivePageId(p.id)}
          >
            {p.name}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-1.5 flex-wrap", className)} data-page-tabs="" data-page-tabs-editable="">
      {pages.map((p, i) => {
        const isActive = activePageId === p.id;
        return (
          <div
            key={p.id}
            className={`relative flex items-center gap-1 pl-3 pr-1.5 py-1 rounded-full border text-xs font-medium transition ${
              isActive ? "bg-primary text-on-primary border-primary" : "border-border text-muted hover:text-text hover:bg-surface2"
            }`}
          >
            {p.background_color && (
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: p.background_color }}
                title="Page background tint"
              />
            )}
            {renamingId === p.id ? (
              <input
                autoFocus
                className={`bg-transparent outline-none text-xs w-24 ${isActive ? "text-white placeholder-white/60" : "text-text"}`}
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={() => commitRename(p.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setRenamingId(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              // 2026-09-25h (inline editing round): double-click renames
              // right here, no detour through the kebab menu - the menu's
              // own "Rename" stays too (same startRename/commitRename this
              // calls), since not everyone discovers a double-click on
              // their own.
              <button
                type="button"
                className="max-w-[10rem] truncate"
                onClick={() => setActivePageId(p.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startRename(p);
                }}
                title="Double-click to rename"
              >
                {p.name}
              </button>
            )}
            {isActive && (
              <button
                type="button"
                className="p-0.5 rounded hover:bg-white/15 text-white/80 hover:text-white transition"
                aria-label="Page options"
                aria-haspopup="menu"
                aria-expanded={openMenuId === p.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenuId((id) => (id === p.id ? null : p.id));
                }}
              >
                <KebabIcon />
              </button>
            )}
            {isActive && openMenuId === p.id && (
              <div
                role="menu"
                className="absolute left-0 top-full mt-1 w-44 card bg-surface shadow-2xl border border-border p-1.5 z-30 text-text normal-case font-normal"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-1 mb-1">
                  <button
                    type="button"
                    disabled={busy || i === 0}
                    className="flex-1 flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded-md hover:bg-surface2 transition-colors disabled:opacity-30 disabled:cursor-default"
                    title="Move left"
                    onClick={() => move(p, -1)}
                  >
                    <ChevronLeftIcon />
                  </button>
                  <button
                    type="button"
                    disabled={busy || i === pages.length - 1}
                    className="flex-1 flex items-center justify-center gap-1 text-xs px-2 py-1.5 rounded-md hover:bg-surface2 transition-colors disabled:opacity-30 disabled:cursor-default"
                    title="Move right"
                    onClick={() => move(p, 1)}
                  >
                    <ChevronRightIcon />
                  </button>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  className="w-full text-left text-xs px-2 py-1.5 rounded-md hover:bg-surface2 transition-colors flex items-center gap-2 disabled:opacity-50"
                  onClick={() => {
                    setOpenMenuId(null);
                    startRename(p);
                  }}
                >
                  <PencilIcon /> Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  className="w-full text-left text-xs px-2 py-1.5 rounded-md hover:bg-surface2 transition-colors flex items-center gap-2 disabled:opacity-50"
                  onClick={() => {
                    setOpenMenuId(null);
                    duplicate(p);
                  }}
                >
                  <CopyIcon className="w-3 h-3" /> Duplicate
                </button>
                <label className="w-full text-left text-xs px-2 py-1.5 rounded-md hover:bg-surface2 transition-colors flex items-center gap-2 cursor-pointer">
                  <input
                    type="color"
                    title="Page background tint"
                    disabled={busy}
                    value={p.background_color || "#000000"}
                    onChange={(e) => setPageColor(p, e.target.value)}
                    className="w-3.5 h-3.5 rounded-full border-0 bg-transparent cursor-pointer p-0 disabled:opacity-50 shrink-0"
                  />
                  Page color
                </label>
                {p.background_color && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    className="w-full text-left text-xs px-2 py-1.5 rounded-md hover:bg-surface2 transition-colors disabled:opacity-50"
                    onClick={() => {
                      setOpenMenuId(null);
                      setPageColor(p, "");
                    }}
                  >
                    Clear page color
                  </button>
                )}
                {pages.length > 1 && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    className="w-full text-left text-xs px-2 py-1.5 rounded-md hover:bg-red-500/10 text-red-400 transition-colors flex items-center gap-2 disabled:opacity-50"
                    onClick={() => {
                      setOpenMenuId(null);
                      setDeleting(p);
                    }}
                  >
                    <TrashIcon /> Delete page
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      <button
        type="button"
        disabled={busy}
        className="flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-full border border-dashed border-border text-muted hover:text-text hover:border-text/40 transition disabled:opacity-50"
        onClick={addPage}
      >
        <PlusIcon className="w-3 h-3" /> Add page
      </button>
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete the page "${deleting?.name || ""}"?`}
        confirmLabel="Delete page"
        busy={busy}
        onCancel={() => setDeleting(null)}
        onConfirm={() => { if (deleting) remove(deleting); }}
      >
        Every block on it is deleted too. This can't be undone.
      </ConfirmDialog>
    </div>
  );
}

// The app chrome every state of this page sits in (sidebar + top bar).
function PageFrame({
  workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated, style, children,
}: {
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string;
  switchWorkspace: (id: string) => void;
  handleWorkspaceCreated: (ws: WorkspaceSummary) => void;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <div className="flex">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="dash-shell flex-1 min-w-0 min-h-screen flex flex-col bg-base" style={style}>
        <TopNav hideLogo />
        {children}
      </div>
    </div>
  );
}

export default function DashboardBuilderView() {
  const { dashboardId } = useParams();
  const [dash, setDash] = useState<DashboardBuilderDetail | null>(null);
  const [error, setError] = useState("");
  const [activePageId, setActivePageId] = useState<string | null>(null);
  // 2026-10-07 (dashboard edit mode): view by default; ?edit=1 is the
  // editor (see the note at the top of this file). Only ever honoured for
  // someone who can_edit - guarded in the body, since that is not known
  // until the fetch below resolves.
  const [editing, setEditing] = useEditMode();
  // 2026-09-25d (elite pass) - see the file-top note above.
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const frame = { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated };

  useEffect(() => {
    if (!dashboardId) return;
    let cancelled = false;
    dashboardBuilderApi
      .get(dashboardId)
      .then((data) => {
        if (cancelled) return;
        setDash(data);
        setActivePageId(data.pages[0]?.id || null);
        // A dashboard with no block on any page has nothing to view yet
        // ("Create your own", a blank start) - nor has one whose blocks
        // were all added but never built (a template's layout): its owner
        // opens in the editor.
        const blank = data.pages.every((p) => p.blocks.every((b) => isEmptyBlock(b)));
        const wantsEdit = readEditFromUrl();
        if (data.can_edit && (blank || wantsEdit)) setEditing(true);
        else if (wantsEdit) setEditing(false);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.response?.status === 404 ? "Dashboard not found." : "Couldn't load this dashboard.");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardId]);

  if (error) {
    return (
      <PageFrame {...frame}>
        <div className="px-6 py-8">
          <div role="alert" className="inline-flex items-center gap-2 rounded-card border border-danger-border bg-danger-fill px-4 py-2.5 text-ui text-danger">
            <WarningIcon size={14} /> {error}
          </div>
          <div className="mt-4">
            <Link to="/dashboards" className="text-ui font-medium text-brand-ink hover:underline">&larr; Back to Dashboards</Link>
          </div>
        </div>
      </PageFrame>
    );
  }

  if (!dash) {
    return (
      <PageFrame {...frame}>
        <div className="flex flex-col gap-4 px-6 py-6" aria-busy="true" data-dashboard-loading="">
          <div className="ui-shimmer h-6 w-72" />
          <div className="ui-shimmer h-4 w-96 max-w-full" />
          <div className="mt-2 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <div key={i} className="ui-shimmer h-28 !rounded-card" />)}
          </div>
          <span className="sr-only">Loading&hellip;</span>
        </div>
      </PageFrame>
    );
  }

  const activePage = dash.pages.find((p) => p.id === activePageId) || dash.pages[0];

  return (
    <DashboardBuilderViewBody
      dash={dash}
      workspaces={workspaces}
      activeWorkspaceId={activeWorkspaceId}
      switchWorkspace={switchWorkspace}
      handleWorkspaceCreated={handleWorkspaceCreated}
      setDash={setDash}
      activePage={activePage}
      setActivePageId={setActivePageId}
      editing={editing}
      setEditing={setEditing}
    />
  );
}

// Split out so the engine hooks (which can't be called conditionally) only
// ever run once `dash` is loaded and `activePage` is known - the
// loading/error early-returns above happen before this component mounts.
function DashboardBuilderViewBody({
  dash,
  setDash,
  activePage,
  setActivePageId,
  editing,
  setEditing,
  workspaces,
  activeWorkspaceId,
  switchWorkspace,
  handleWorkspaceCreated,
}: {
  dash: DashboardBuilderDetail;
  setDash: Dispatch<SetStateAction<DashboardBuilderDetail | null>>;
  activePage: DashboardBuilderDetail["pages"][number] | undefined;
  setActivePageId: (id: string) => void;
  editing: boolean;
  setEditing: (on: boolean) => void;
  // 2026-09-25d (elite pass) - see the file-top note above.
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string;
  switchWorkspace: (id: string) => void;
  handleWorkspaceCreated: (ws: WorkspaceSummary) => void;
}) {
  const isEditing = dash.can_edit && editing;
  // 2026-10-10 (round 19): "Publish to company domain" - also opened by
  // ?publish=domain (the Domains settings page's "Edit" link).
  const [domainOpen, setDomainOpen] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get("publish") === "domain";
    } catch {
      return false;
    }
  });

  // Phase 5, Batch A (2026-09-28, data governance & quality): whether any
  // quality check on this dashboard's own data source is currently
  // failing - a v2 dashboard's blocks are always built against exactly one
  // data source (dash.datasource_id - see _resolve_datasource on the
  // backend), so "the distinct data sources this dashboard's blocks use"
  // collapses to that one id here. Polls the cheap, read-only
  // /quality-status endpoint (never triggers a live re-run) and swallows
  // ANY failure completely silently - a slow/erroring quality check must
  // never block, delay, or otherwise affect this dashboard's own normal
  // rendering, which happens exactly as it always did regardless of
  // whether this succeeds.
  const [hasFailingQualityChecks, setHasFailingQualityChecks] = useState(false);
  // File sources: the column list the editor's pickers need (the filters
  // editor, the step-by-step builder, the AI examples). A warehouse
  // dashboard reads dash.tables instead.
  const [editorColumns, setEditorColumns] = useState<{ name: string; dtype: string }[] | undefined>(undefined);
  useEffect(() => {
    if (!dash.datasource_id || dash.warehouse_native || !dash.can_edit) return;
    let cancelled = false;
    datasourceApi
      .preview(dash.datasource_id, null, 1, 0)
      .then((p) => {
        if (!cancelled) setEditorColumns(p.columns.map((name: string) => ({ name, dtype: p.dtypes?.[name] || "" })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [dash.datasource_id, dash.warehouse_native, dash.can_edit]);
  useEffect(() => {
    let cancelled = false;
    if (!dash.datasource_id) {
      setHasFailingQualityChecks(false);
      return;
    }
    qualityChecksApi
      .status(dash.datasource_id)
      .then((status) => {
        if (!cancelled) setHasFailingQualityChecks(status.has_failing_rules);
      })
      .catch(() => {
        // Silently ignored, on purpose - see this effect's own comment
        // above. The banner just doesn't show if this check couldn't run.
      });
    return () => {
      cancelled = true;
    };
  }, [dash.datasource_id]);

  // 2026-09-25 (Round 4, branding): fetched once here (not inside
  // BrandingPanel itself) so the same object URLs back both the header
  // logo / full-page background AND BrandingPanel's own thumbnail
  // previews - one network round trip per asset, not two. brandingNonce
  // is bumped after every successful upload/remove so a REPLACE (has_logo/
  // has_background_image staying true with new bytes underneath) actually
  // refetches instead of quietly keeping the stale blob url - see
  // lib/branding.ts's useBrandingAsset for why has_logo/has_background_
  // image alone can't be the only dependency.
  const [brandingNonce, setBrandingNonce] = useState(0);
  const bumpBranding = () => setBrandingNonce((n) => n + 1);
  const logoUrl = useBrandingAsset(dash.id, "logo", dash.has_logo, brandingNonce);
  const backgroundImageUrl = useBrandingAsset(
    dash.id,
    "background",
    dash.background_style === "image" && dash.has_background_image,
    brandingNonce
  );
  const shellStyle: React.CSSProperties = {
    ...brandingStyleVars(dash),
    ...brandingBackgroundImageStyle(dash, backgroundImageUrl),
  };
  const pageBgTriple = activePage?.background_color ? hexToRgbTriple(activePage.background_color) : null;

  // 2026-10-07 (Option A dashboard view): DashboardShell (header + filter
  // rail + KPI strip + block grid) through this one engine hook. A
  // warehouse dashboard runs every block inside the warehouse (POST
  // /pages/{id}/run); a file dashboard keeps today's preview-filtered path
  // under the same skin.
  // 2026-10-07 (dashboard edit mode): the engine STAYS ON while editing -
  // the editor shows the same live numbers as the view and re-runs just
  // the block that changed.
  const warehouse = Boolean(dash.warehouse_native);
  const source = useMemo<RunSource>(
    () =>
      warehouse
        ? {
            kind: "warehouse",
            run: (pageId, req, signal) => dashboardBuilderApi.runPage(dash.id, pageId, req, signal),
            options: (paramId, opts, signal) => dashboardBuilderApi.parameterOptions(dash.id, paramId, opts, signal),
          }
        : {
            kind: "file",
            datasourceId: dash.datasource_id,
            // What a file block's subtitle calls its table ("... · Bookings export").
            name: dash.datasource_name,
            preview: (pageId, filters, blockFilters) => dashboardBuilderApi.previewFiltered(dash.id, pageId, filters, blockFilters),
            distinctValues: dash.datasource_id
              ? (column, search) =>
                  datasourceApi.getColumnDistinctValues(dash.datasource_id as string, column, null, { search, limit: 200 }).then((r) => ({ values: r.values }))
              : undefined,
          },
    [warehouse, dash.id, dash.datasource_id, dash.datasource_name]
  );
  const persistSavedViews = useCallback(
    async (views: Parameters<typeof dashboardBuilderApi.updateSavedViews>[1]) => {
      const updated = await dashboardBuilderApi.updateSavedViews(dash.id, views);
      setDash(updated);
      return updated.saved_views;
    },
    [dash.id, setDash]
  );
  const run = useDashboardRun({
    dashboard: dash,
    page: activePage,
    source,
    persistSavedViews: dash.can_edit ? persistSavedViews : undefined,
  });
  const columnsFor = useCallback(
    (block: DashboardBlock) => {
      const table = block.config?.spec?.table as string | undefined;
      const cols = table ? dash.tables?.[table] : undefined;
      return cols ? cols.map((c) => ({ name: c.name, dtype: String(c.type || "") })) : undefined;
    },
    [dash.tables]
  );
  // 2026-10-07 (analyst canvas round): Dashboard · Canvas - two renderings
  // of the same blocks (remembered per dashboard, mirrored as ?mode=),
  // the comment threads (one hook per dashboard, counts shared by both
  // renderings) and the canvas's owner actions - each one the existing
  // block endpoint plus setDash, nothing the grid couldn't also show.
  const [renderMode, setRenderMode] = useDashboardViewMode(dash.id);
  const comments = useComments(dash.id);
  // The editor: always mounted (hooks), only handed to the shell while editing.
  const editor = useDashboardEditor({ dash, setDash, page: activePage, run, warehouse, fileColumns: editorColumns });
  const canvasOwner = useMemo<CanvasOwnerActions | null>(
    () =>
      dash.can_edit
        ? {
            updateBlock: async (blockId, payload) => { const d = await dashboardBuilderApi.updateBlock(dash.id, blockId, payload); setDash(d); return d; },
            createBlock: async (type, title, config) => {
              if (!activePage) throw new Error("This dashboard has no page to add a cell to.");
              const d = await dashboardBuilderApi.createBlock(dash.id, activePage.id, type, title, undefined, config);
              setDash(d);
              return d;
            },
            deleteBlock: async (blockId) => { const d = await dashboardBuilderApi.deleteBlock(dash.id, blockId); setDash(d); return d; },
            swapBlock: async (blockId, payload) => { const d = await dashboardBuilderApi.swapBlock(dash.id, blockId, payload); setDash(d); return d; },
          }
        : null,
    [dash.can_edit, dash.id, activePage, setDash]
  );
  const ownerActions = dash.can_edit
    ? {
        onEdit: () => setEditing(true),
        onSwap: async (block: DashboardBlock, payload: { chart_type?: string; type?: DashboardBlockType }) => {
          const updated = await dashboardBuilderApi.swapBlock(dash.id, block.id, payload);
          setDash(updated);
          run.rerunBlock(block.id);
        },
        onRemove: async (block: DashboardBlock) => {
          setDash(await dashboardBuilderApi.deleteBlock(dash.id, block.id));
        },
        commentCounts: dash.comment_counts,
        datasourceId: dash.datasource_id,
        columnsFor,
      }
    : null;
  const fetchSql = warehouse
    ? (block: DashboardBlock) =>
        dashboardBuilderApi.blockSql(dash.id, block.id, { filters: run.filters, period: run.state.period, date_range: run.state.dateRange })
    : undefined;
  const upgradeBlocks = dash.can_edit && warehouse
    ? async () => {
        const result = await dashboardBuilderApi.upgradeBlocks(dash.id);
        setDash(await dashboardBuilderApi.get(dash.id));
        run.rerun();
        return result;
      }
    : undefined;

  const renameDashboard = async (name: string) => {
    setDash(await dashboardBuilderApi.rename(dash.id, name));
  };
  const done = () => {
    editor.flushLayout();
    setEditing(false);
  };

  // Appearance and Merge sit behind the header's "More" menu, each in a Sheet.
  const [moreSheet, setMoreSheet] = useState<"appearance" | "merge" | null>(null);
  const canMerge = dash.sibling_dashboards.length > 0;
  // 2026-10-07 (identity-colour round): the dashboard's appearance - every
  // change shows on the page at once and saves by itself (see
  // theme/useAppearanceEditor). The pin handler is what a legend key or a
  // chip's dot calls while editing.
  const appearance = useDashboardAppearance({ dash, setDash, onColorsReset: run.rerun });
  const openAppearance = useCallback(() => setMoreSheet("appearance"), []);
  // The palette cards are drawn on this page's own results.
  const appearanceSamples = useMemo(
    () => (moreSheet === "appearance" ? previewSamples(activePage, run, warehouse ? "warehouse" : "file", dash.datasource_name) : undefined),
    [moreSheet, activePage, run, warehouse, dash.datasource_name]
  );

  const tabs = (
    <PageTabsBar
      dash={isEditing ? dash : { ...dash, can_edit: false }}
      activePageId={activePage?.id}
      setActivePageId={setActivePageId}
      onChange={setDash}
      className=""
    />
  );

  return (
    <PageFrame workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} switchWorkspace={switchWorkspace} handleWorkspaceCreated={handleWorkspaceCreated} style={shellStyle}>
      {hasFailingQualityChecks && (
        <div className="px-4 pt-4 sm:px-6" data-quality-banner="">
          <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-card border border-danger-border bg-danger-fill px-4 py-2.5 text-ui text-danger">
            <WarningIcon size={14} className="shrink-0" />
            <span>One or more data-quality checks are failing on a data source this dashboard uses.</span>
            {dash.datasource_id && (
              <Link to={`/workspace/${dash.datasource_id}?tab=quality`} className="font-medium underline underline-offset-2 hover:no-underline">
                Review the checks
              </Link>
            )}
          </div>
        </div>
      )}
      <DashboardShell
        dashboard={dash}
        page={activePage}
        run={run}
        source={source}
        mode={warehouse ? "warehouse" : "file"}
        owner={ownerActions}
        fetchSql={fetchSql}
        view={renderMode}
        onViewChange={setRenderMode}
        canvasOwner={canvasOwner}
        comments={comments}
        onEditDashboard={dash.can_edit ? () => setEditing(true) : undefined}
        onUpgradeBlocks={upgradeBlocks}
        editing={isEditing ? { editor, onDone: done, onRename: renameDashboard } : null}
        onPinColor={appearance.pin}
        onOpenAppearance={openAppearance}
        subtitleExtra={
          // 2026-10-10 (one kind of dashboard): "Made from answer / analysis"
          // - the way back to what this dashboard was made from.
          dash.can_edit && dash.source_conversation_title && dash.source_conversation_id ? (() => {
            const kind = dash.source_conversation_kind === "answer" ? "answer" : "analysis";
            const href = sourceHref(kind, dash.source_conversation_id, dash.source_conversation_datasource_id);
            return href ? <MadeFromLink kind={kind} title={dash.source_conversation_title} href={href} /> : undefined;
          })() : undefined
        }
        headerExtra={
          <>
            {logoUrl && <img src={logoUrl} alt="" className="h-8 w-auto max-w-[140px] object-contain rounded-md" />}
            {/* The owner's More menu - while viewing and while editing:
                the dashboard's appearance is not a layout edit. */}
            {dash.can_edit && (
              <Popover
                align="end"
                width={220}
                haspopup="menu"
                role="menu"
                ariaLabel="More"
                trigger={(api) => (
                  <button type="button" className={buttonClasses({ variant: "secondary" })} data-popover-trigger="" data-edit-more="" {...api.props}>
                    <MoreIcon size={15} /> More
                  </button>
                )}
              >
                {({ close }) => (
                  <div className="py-1">
                    <MenuRow icon={<KitPaletteIcon size={14} />} onClick={() => { close(); openAppearance(); }}>Appearance…</MenuRow>
                    {isEditing && canMerge && <MenuRow icon={<KitMergeIcon size={14} />} onClick={() => { close(); setMoreSheet("merge"); }}>Merge dashboards…</MenuRow>}
                  </div>
                )}
              </Popover>
            )}
            <PublishPanel dash={dash} onChange={setDash} triggerClassName={buttonClasses({ variant: "secondary" })} onOpenDomain={dash.can_edit ? () => setDomainOpen(true) : undefined} />
            {dash.can_edit && <PublishToDomainSheet dashboardId={dash.id} open={domainOpen} onClose={() => setDomainOpen(false)} />}
          </>
        }
        contextRow={{
          left: (
            <>
              <Link to="/dashboards" className="ui-focus rounded text-caption text-muted transition hover:text-text">&larr; Dashboards</Link>
              {/* 2026-10-07 (real end-to-end run): only for a dashboard whose
                  numbers are stored on its blocks. A warehouse-native one is
                  recomputed on every run - the header already says
                  "refreshed just now" - and block.data_updated_at there is
                  only when a block's QUERY was last saved, so this badge sat
                  next to it saying "Data updated 10 minutes ago" (and would
                  say "3 days ago" next week) about live numbers. */}
              {activePage && !dash.warehouse_native && <DataFreshnessBadge blocks={activePage.blocks} />}
            </>
          ),
          tabs,
        }}
        style={pageBgTriple ? { background: `rgb(${pageBgTriple} / 0.35)` } : undefined}
      />
      {dash.can_edit && (
        <AppearanceSheet
          open={moreSheet === "appearance"}
          onClose={() => setMoreSheet(null)}
          controller={appearance}
          samples={appearanceSamples}
          registry={run.colors?.assignments ?? null}
          brandExtra={<BrandAssets dash={dash} controller={appearance} onChange={setDash} logoUrl={logoUrl} backgroundImageUrl={backgroundImageUrl} onAssetChanged={bumpBranding} />}
        />
      )}
      {isEditing && (
        <Sheet open={moreSheet === "merge"} onClose={() => setMoreSheet(null)} title="Merge dashboards" size="sm" id="edit-merge">
          <MergeDashboardsPanel inline dash={dash} onChange={setDash} onMerged={() => setMoreSheet(null)} />
        </Sheet>
      )}
    </PageFrame>
  );
}

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { dashboardBuilderApi, DashboardBuilderDetail, DashboardBuilderPage } from "../api/client";
import TopNav from "../components/TopNav";
import { DashboardBlockGrid } from "../components/DashboardBlocks";
import DashboardCanvas from "../components/DashboardCanvas";
import { useDashboardFilters } from "../lib/useDashboardFilters";

// 2026-09-24 (Dashboard Builder Phase 1 + Phase 2 + Phase 2b + Phase 3): the
// owner/editor view for the new pages+blocks kind of dashboard - opened
// from Dashboards.tsx (routed here instead of DashboardView.tsx whenever
// layout_version===2) or straight after "Build with AI" finishes (see
// BuildDashboardModal.tsx).
//
// Phase 2 adds a real edit/view toggle: someone who can_edit this dashboard
// lands in edit mode by default (DashboardCanvas - drag/resize/add/remove
// blocks, per-block Ask AI/manual build/style) and can switch to a plain
// read view (DashboardBlockGrid, the exact same renderer the public link
// uses) at any time; a view-only visitor (can_edit===false) only ever sees
// the read view, with no toggle offered at all.
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

function PublishPanel({ dash, onChange }: { dash: DashboardBuilderDetail; onChange: (d: DashboardBuilderDetail) => void }) {
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
      <a href={publicUrl} target="_blank" rel="noreferrer" className="btn-secondary text-xs flex items-center gap-1.5">
        <LinkIcon className="w-3.5 h-3.5" /> View {dash.share_mode === "private" ? "private" : "public"} link
      </a>
    ) : null;
  }

  const showEditForm = !dash.is_published || editingSettings;

  return (
    <div className="relative">
      <button
        type="button"
        className={dash.is_published ? "btn-secondary text-xs" : "btn-primary text-xs"}
        onClick={() => setOpen((o) => !o)}
      >
        {dash.is_published ? (dash.share_mode === "private" ? "Published · Private" : "Published") : "Publish"}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 card bg-surface shadow-2xl border border-border p-4 z-30">
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
                  className={`flex-1 px-2.5 py-1.5 transition ${mode === "public" ? "bg-primary text-white" : "text-muted hover:text-text hover:bg-surface2"}`}
                  onClick={() => setMode("public")}
                >
                  Public
                </button>
                <button
                  type="button"
                  className={`flex-1 px-2.5 py-1.5 transition ${mode === "private" ? "bg-primary text-white" : "text-muted hover:text-text hover:bg-surface2"}`}
                  onClick={() => setMode("private")}
                >
                  Private
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
}: {
  dash: DashboardBuilderDetail;
  activePageId: string | undefined;
  setActivePageId: (id: string) => void;
  onChange: (d: DashboardBuilderDetail) => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [busy, setBusy] = useState(false);

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
    if (!confirm(`Delete the page "${p.name}"? Every block on it will be deleted too. This can't be undone.`)) return;
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

  if (!dash.can_edit) {
    if (pages.length <= 1) return null;
    return (
      <div className="flex items-center gap-1.5 mt-5 mb-4 flex-wrap">
        {pages.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`text-xs font-medium px-3 py-1.5 rounded-full border transition ${
              activePageId === p.id
                ? "bg-primary text-white border-primary"
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
    <div className="flex items-center gap-1.5 mt-5 mb-4 flex-wrap">
      {pages.map((p, i) => {
        const isActive = activePageId === p.id;
        return (
          <div
            key={p.id}
            className={`flex items-center gap-1 pl-3 pr-1.5 py-1 rounded-full border text-xs font-medium transition ${
              isActive ? "bg-primary text-white border-primary" : "border-border text-muted hover:text-text hover:bg-surface2"
            }`}
          >
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
              <button type="button" className="max-w-[10rem] truncate" onClick={() => setActivePageId(p.id)}>
                {p.name}
              </button>
            )}
            {isActive && (
              <div className="flex items-center gap-0.5 text-white/80">
                <button
                  type="button"
                  disabled={busy || i === 0}
                  className="p-0.5 hover:text-white disabled:opacity-30 disabled:cursor-default"
                  title="Move left"
                  onClick={() => move(p, -1)}
                >
                  <ChevronLeftIcon />
                </button>
                <button
                  type="button"
                  disabled={busy || i === pages.length - 1}
                  className="p-0.5 hover:text-white disabled:opacity-30 disabled:cursor-default"
                  title="Move right"
                  onClick={() => move(p, 1)}
                >
                  <ChevronRightIcon />
                </button>
                <button type="button" disabled={busy} className="p-0.5 hover:text-white disabled:opacity-50" title="Rename page" onClick={() => startRename(p)}>
                  <PencilIcon />
                </button>
                <button type="button" disabled={busy} className="p-0.5 hover:text-white disabled:opacity-50" title="Duplicate page" onClick={() => duplicate(p)}>
                  <CopyIcon className="w-3 h-3" />
                </button>
                {pages.length > 1 && (
                  <button type="button" disabled={busy} className="p-0.5 hover:text-red-300 disabled:opacity-50" title="Delete page" onClick={() => remove(p)}>
                    <TrashIcon />
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
    </div>
  );
}

export default function DashboardBuilderView() {
  const { dashboardId } = useParams();
  const [dash, setDash] = useState<DashboardBuilderDetail | null>(null);
  const [error, setError] = useState("");
  const [activePageId, setActivePageId] = useState<string | null>(null);
  // 2026-09-24 (Phase 2): edit mode by default for whoever can actually
  // edit this dashboard - a view-only visitor never sees "edit" at all
  // (guarded below in the render, not just here) since dash.can_edit isn't
  // known until the fetch below resolves.
  const [mode, setMode] = useState<"edit" | "view">("edit");

  useEffect(() => {
    if (!dashboardId) return;
    dashboardBuilderApi
      .get(dashboardId)
      .then((data) => {
        setDash(data);
        setActivePageId(data.pages[0]?.id || null);
        if (!data.can_edit) setMode("view");
      })
      .catch((err) =>
        setError(err?.response?.status === 404 ? "Dashboard not found." : "Couldn't load this dashboard.")
      );
  }, [dashboardId]);

  if (error) {
    return (
      <div>
        <TopNav />
        <div className="max-w-6xl mx-auto px-6 py-8">
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 inline-block">{error}</div>
          <div className="mt-4">
            <Link to="/dashboards" className="text-sm text-primary hover:underline">&larr; Back to Dashboards</Link>
          </div>
        </div>
      </div>
    );
  }

  if (!dash) {
    return (
      <div>
        <TopNav />
        <div className="max-w-6xl mx-auto px-6 py-8 text-sm text-muted">Loading&hellip;</div>
      </div>
    );
  }

  const activePage = dash.pages.find((p) => p.id === activePageId) || dash.pages[0];

  return (
    <DashboardBuilderViewBody
      dash={dash}
      setDash={setDash}
      activePage={activePage}
      setActivePageId={setActivePageId}
      mode={mode}
      setMode={setMode}
    />
  );
}

// Split out so useDashboardFilters (a hook, which can't be called
// conditionally) only ever runs once `dash` is loaded and `activePage` is
// known - the loading/error early-returns above happen before this
// component even mounts.
function DashboardBuilderViewBody({
  dash,
  setDash,
  activePage,
  setActivePageId,
  mode,
  setMode,
}: {
  dash: DashboardBuilderDetail;
  setDash: (d: DashboardBuilderDetail) => void;
  activePage: DashboardBuilderDetail["pages"][number] | undefined;
  setActivePageId: (id: string) => void;
  mode: "edit" | "view";
  setMode: (m: "edit" | "view") => void;
}) {
  const filterState = useDashboardFilters(dash.id, activePage);

  // Every block-mutating action anywhere on this page (build manually,
  // ask AI, restyle, delete, add) flows through here - re-running the
  // active filter selection afterward means an override never lingers on
  // a block whose real, persisted content just changed underneath it.
  const handleDashChange = (d: DashboardBuilderDetail) => {
    setDash(d);
    filterState.refresh();
  };

  return (
    <div className="dash-shell min-h-screen">
      <TopNav />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <Link to="/dashboards" className="text-xs text-muted hover:text-text transition inline-block mb-3">&larr; Dashboards</Link>

        <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2 flex-wrap">
              {dash.name}
              <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/30">
                Dashboard
              </span>
            </h1>
            <div className="text-xs text-muted mt-1.5">
              {dash.is_published ? "Published - anyone with the link can view it" : "Not published yet - only you can see this"}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {dash.can_edit && (
              <div className="flex items-center rounded-lg border border-border overflow-hidden text-xs">
                <button
                  type="button"
                  className={`px-2.5 py-1.5 transition ${mode === "edit" ? "bg-primary text-white" : "text-muted hover:text-text hover:bg-surface2"}`}
                  onClick={() => setMode("edit")}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={`px-2.5 py-1.5 transition ${mode === "view" ? "bg-primary text-white" : "text-muted hover:text-text hover:bg-surface2"}`}
                  onClick={() => setMode("view")}
                >
                  Preview
                </button>
              </div>
            )}
            <PublishPanel dash={dash} onChange={handleDashChange} />
          </div>
        </div>

        <PageTabsBar dash={dash} activePageId={activePage?.id} setActivePageId={setActivePageId} onChange={handleDashChange} />

        {filterState.activeFilters.length > 0 && (
          <div className="text-[11px] text-muted mb-2 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
            Filtering {filterState.loading ? "…" : `${filterState.activeFilters.length} active`}
          </div>
        )}

        <div className="mt-6">
          {!activePage ? (
            <div className="text-sm text-muted py-10 text-center">This dashboard has no pages yet.</div>
          ) : dash.can_edit && mode === "edit" ? (
            <DashboardCanvas dash={dash} page={activePage} onChange={handleDashChange} filterState={filterState} />
          ) : (
            <DashboardBlockGrid blocks={activePage.blocks} datasourceId={dash.datasource_id} filterState={filterState} />
          )}
        </div>
      </div>
    </div>
  );
}

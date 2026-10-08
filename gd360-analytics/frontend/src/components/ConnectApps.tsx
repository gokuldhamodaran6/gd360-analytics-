// 2026-10-08 (round 11): connect a synced app - Shopify, Google Analytics 4,
// Meta Ads, Google Ads - and see/drive its sync. The steps to get each
// credential are shown next to the form, in plain words.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AppInfo, appsApi, AppStatus, INTERVAL_LABELS } from "../api/projects";
import { connectionKindMeta } from "./DataSourceForm";
import type { DataSourceSummary } from "../api/client";
import { timeAgo } from "../project/format";

function errorText(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  return typeof d === "string" && d.trim() ? d : fallback;
}

export function AppGrid({ workspaceId, onConnected }: { workspaceId?: string; onConnected: (s: AppStatus) => void }) {
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [open, setOpen] = useState<AppInfo | null>(null);
  useEffect(() => {
    appsApi.list().then(setApps).catch(() => setApps([]));
  }, []);
  if (!apps?.length) return null;
  return (
    <div className="mt-6 pt-6 border-t border-border">
      <h3 className="text-sm font-bold">Apps — synced automatically</h3>
      <p className="text-xs text-muted mt-0.5 mb-3">
        Sales, analytics and ad accounts. GD360 copies their records on a schedule you choose, so you can ask about them alongside your other data.
      </p>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        {apps.map((a) => {
          const meta = connectionKindMeta(a.kind);
          return (
            <button
              key={a.kind}
              type="button"
              onClick={() => setOpen(a)}
              className="ui-focus text-left rounded-card border border-border bg-surface p-3.5 flex gap-3 items-start hover:border-primary/50"
            >
              <span className="w-9 h-9 rounded-lg grid place-items-center shrink-0" style={{ backgroundColor: `${meta.color}1a`, color: meta.color }}>
                <meta.Logo className="w-4 h-4" />
              </span>
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm font-semibold text-text">{a.label}</span>
                <span className="text-xs text-muted leading-snug">{a.summary}</span>
              </span>
            </button>
          );
        })}
      </div>
      {open && (
        <ConnectAppSheet
          app={open}
          workspaceId={workspaceId}
          onClose={() => setOpen(null)}
          onConnected={(s) => {
            setOpen(null);
            onConnected(s);
          }}
        />
      )}
    </div>
  );
}

export function ConnectAppSheet({
  app, workspaceId, onClose, onConnected,
}: { app: AppInfo; workspaceId?: string; onClose: () => void; onConnected: (s: AppStatus) => void }) {
  const [name, setName] = useState(app.label);
  const [values, setValues] = useState<Record<string, string>>({});
  const [interval, setInterval_] = useState(app.default_interval);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const missing = app.fields.filter((f) => !f.optional && !(values[f.key] || "").trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (missing.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const out = await appsApi.connect({
        kind: app.kind, name: name.trim() || app.label, credentials: values, sync_interval: interval,
        workspace_id: workspaceId || undefined,
      });
      onConnected(out);
    } catch (err: any) {
      setError(errorText(err, `Couldn't connect to ${app.label}. Check the details and try again.`));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-start sm:items-center justify-center bg-black/50 p-3 sm:p-6 overflow-auto" role="dialog" aria-modal="true" aria-label={`Connect ${app.label}`}>
      <form onSubmit={submit} className="w-full max-w-[880px] rounded-card border border-border bg-surface shadow-pop flex flex-col md:flex-row overflow-hidden">
        <div className="md:w-[42%] bg-base p-5 sm:p-6 flex flex-col gap-3 border-b md:border-b-0 md:border-r border-border">
          <span className="text-caption uppercase tracking-caps text-muted">How to get the details</span>
          <ol className="m-0 pl-5 flex flex-col gap-2.5 text-ui text-secondary leading-relaxed">
            {app.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          <p className="text-caption text-muted mt-auto">
            GD360 only reads. Credentials are encrypted at rest and never shown again after you save them.
          </p>
        </div>
        <div className="flex-1 p-5 sm:p-6 flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="m-0 text-section font-semibold text-text">Connect {app.label}</h2>
              <p className="m-0 mt-1 text-ui text-muted">{app.summary}</p>
            </div>
            <button type="button" onClick={onClose} disabled={busy} className="text-muted hover:text-text text-xl leading-none" aria-label="Close">×</button>
          </div>
          <label className="flex flex-col gap-1.5 text-ui text-text">
            Name in GD360
            <input value={name} onChange={(e) => setName(e.target.value)} className="h-10 rounded-ctl border border-border bg-base px-3 text-ui text-text" />
          </label>
          {app.fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-1.5 text-ui text-text">
              <span>{f.label}{f.optional ? <span className="text-muted"> (optional)</span> : null}</span>
              {f.multiline ? (
                <textarea
                  rows={5}
                  value={values[f.key] || ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  className="rounded-ctl border border-border bg-base px-3 py-2 font-mono text-[12px] text-text"
                />
              ) : (
                <input
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  value={values[f.key] || ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  className="h-10 rounded-ctl border border-border bg-base px-3 text-ui text-text"
                />
              )}
            </label>
          ))}
          <label className="flex flex-col gap-1.5 text-ui text-text">
            New data arrives
            <select value={interval} onChange={(e) => setInterval_(e.target.value)} className="h-10 rounded-ctl border border-border bg-base px-3 text-ui text-text">
              {app.intervals.map((i) => <option key={i} value={i}>{INTERVAL_LABELS[i] || i}</option>)}
            </select>
          </label>
          {error && <div role="alert" className="rounded-ctl border border-danger-border bg-danger-fill p-3 text-ui text-text">{error}</div>}
          <div className="flex gap-2 justify-end mt-auto">
            <button type="button" className="btn-secondary text-sm" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn-primary text-sm" disabled={busy || missing.length > 0}>
              {busy ? "Checking the connection…" : "Connect"}
            </button>
          </div>
        </div>
      </form>
    </div>,
    document.body
  );
}

export function SyncControl({ ds, onChanged }: { ds: DataSourceSummary; onChanged?: (s: AppStatus) => void }) {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const syncing = busy || !!status?.syncing;
  useEffect(() => {
    if (!syncing) return;
    const t = setInterval(async () => {
      try {
        const s = await appsApi.status(ds.id);
        setStatus(s);
        if (!s.syncing) {
          setBusy(false);
          onChanged?.(s);
        }
      } catch {
        setBusy(false);
      }
    }, 2500);
    return () => clearInterval(t);
  }, [syncing, ds.id, onChanged]);
  const last = status?.last_synced_at ?? ds.last_synced_at;
  const err = status ? status.sync_error : ds.sync_error;
  return (
    <span className="flex items-center gap-2 flex-wrap text-[11px]" onClick={(e) => e.stopPropagation()}>
      <span className={err ? "text-danger" : "text-muted"} title={err || undefined}>
        {syncing ? "Syncing…" : err ? "Last sync failed" : last ? `Synced ${timeAgo(last)}` : "Not synced yet"}
      </span>
      <button
        type="button"
        disabled={syncing}
        className="text-brand-ink hover:underline disabled:opacity-50"
        onClick={async (e) => {
          e.stopPropagation();
          setBusy(true);
          try {
            setStatus(await appsApi.syncNow(ds.id));
          } catch {
            setBusy(false);
          }
        }}
      >
        Sync now
      </button>
    </span>
  );
}

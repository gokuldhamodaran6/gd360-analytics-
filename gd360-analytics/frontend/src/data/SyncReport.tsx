import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { appsApi, type AppStatus, type SyncReport } from "../api/projects";
import { Sheet } from "../ui";
import { timeAgo } from "../project/format";

// 2026-10-12 (round 38c): what an app really sent at its last sync. A sync
// used to read "Synced 2 min ago" with 0 posts and no reason. Now each page /
// account says what came back (followers, posts, the latest post), what
// didn't and why - in the app's own terms, with the one thing to do about it
// (Reconnect and allow a permission, wait for 100 followers, sync again).

function n(v: number | null | undefined): string {
  return typeof v === "number" ? v.toLocaleString() : "—";
}

function day(v: string | null | undefined): string {
  if (!v) return "";
  const d = new Date(v.length <= 10 ? `${v}T00:00:00` : v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** One line per reason - "No daily reach, daily views or video views - the sign-in didn't allow read_insights." */
function byReason(missing: { what: string; why: string }[]): { why: string; what: string[] }[] {
  const out: { why: string; what: string[] }[] = [];
  for (const m of missing) {
    const g = out.find((x) => x.why === m.why);
    if (g) { if (!g.what.includes(m.what)) g.what.push(m.what); } else out.push({ why: m.why, what: [m.what] });
  }
  return out;
}

function orList(xs: string[]): string {
  return xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`;
}

export function reportTone(r: SyncReport | null | undefined): "good" | "warn" | null {
  if (!r) return null;
  return r.problems && r.problems.length ? "warn" : "good";
}

export function SyncReportView({ status, report }: { status: AppStatus | null; report: SyncReport }) {
  const needsReconnect = (report.problems || []).some((p) => /Reconnect/i.test(p));
  return (
    <div className="flex flex-col gap-5" data-sync-report="">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted">Last sync{report.at ? ` · ${timeAgo(report.at + "Z")}` : ""}</span>
        <b className="text-[16px] text-text font-semibold leading-snug">{report.headline}</b>
      </div>
      {(report.problems || []).length > 0 && (
        <div className="rounded-[14px] border border-warning-border bg-warning-fill/50 p-3.5 flex flex-col gap-2" data-sync-problems="">
          <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-warning">What didn't come back</span>
          <ul className="m-0 pl-4 flex flex-col gap-1.5 text-[13.5px] text-secondary leading-snug list-disc">
            {report.problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
          {needsReconnect && status && (
            <Link to={`/data?tab=catalog&connect=${status.kind}`} className="ui-focus self-start mt-1 h-9 px-3.5 rounded-full bg-primary text-on-primary text-[13px] font-semibold inline-flex items-center" data-sync-reconnect="">
              Reconnect {status.label}
            </Link>
          )}
        </div>
      )}
      <div className="flex flex-col gap-2.5">
        <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">Per {report.accounts.length === 1 ? "account" : `account · ${report.accounts.length}`}</span>
        {report.accounts.map((a) => (
          <div key={a.id} className="rounded-[14px] border border-border bg-surface p-3.5 flex flex-col gap-2" data-sync-account={a.id}>
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <b className="text-[14.5px] text-text font-semibold">{a.name || a.id}</b>
              <span className="text-[12.5px] text-muted tabular-nums">{n(a.followers)} followers</span>
            </div>
            <div className="text-[13px] text-secondary leading-snug">
              {a.posts === 0
                ? a.lifetime_posts ? `None of its ${n(a.lifetime_posts)} posts came back.` : "No posts."
                : a.posts != null
                  ? `${n(a.posts)} posts imported${a.lifetime_posts ? ` of ${n(a.lifetime_posts)}` : ""}${a.latest_post ? ` · latest ${day(a.latest_post)}` : ""}`
                  : null}
            </div>
            {a.ok.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {a.ok.map((m) => (
                  <span key={m} className="h-6 px-2 rounded-full bg-good-fill text-good text-[11.5px] font-medium inline-flex items-center gap-1">✓ {m}</span>
                ))}
              </div>
            )}
            {a.missing.length > 0 && (
              <ul className="m-0 pl-0 list-none flex flex-col gap-1">
                {byReason(a.missing).map((g) => (
                  <li key={g.why} className="text-[12.5px] text-secondary leading-snug" data-sync-missing="">
                    <span className="text-warning font-medium">No {orList(g.what)}</span> - {g.why}
                  </li>
                ))}
              </ul>
            )}
            {a.note && <span className="text-[12px] text-muted">{a.note}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The report in a sheet - opened from a source's sync line, or from an answer ("See what … sent"). */
export function SyncReportSheet({ sourceId, onClose }: { sourceId: string | null; onClose: () => void }) {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    if (!sourceId) return;
    setStatus(null);
    setError("");
    appsApi.status(sourceId).then(setStatus).catch(() => setError("Couldn't load this source's last sync."));
  }, [sourceId]);
  useEffect(() => {
    if (!sourceId || !(syncing || status?.syncing)) return;
    const t = window.setInterval(async () => {
      try {
        const s = await appsApi.status(sourceId);
        setStatus(s);
        if (!s.syncing) setSyncing(false);
      } catch {
        setSyncing(false);
      }
    }, 2500);
    return () => window.clearInterval(t);
  }, [sourceId, syncing, status?.syncing]);
  const busy = syncing || Boolean(status?.syncing);
  return (
    <Sheet
      open={Boolean(sourceId)}
      onClose={onClose}
      title={status ? `${status.name}: what came back` : "What came back"}
      subtitle={status?.last_synced_at ? `Synced ${timeAgo(status.last_synced_at)}${status.sync_error ? " · last sync failed" : ""}` : undefined}
      size="md"
      id="sync-report"
      footer={status ? (
        <button
          type="button"
          disabled={busy}
          onClick={async () => { setSyncing(true); try { setStatus(await appsApi.syncNow(status.id)); } catch { setSyncing(false); } }}
          className="ui-focus h-10 px-4 rounded-full bg-primary text-on-primary text-[13.5px] font-semibold disabled:opacity-50"
          data-sync-again=""
        >
          {busy ? "Syncing…" : "Sync again"}
        </button>
      ) : undefined}
    >
      {error && <p className="m-0 text-ui text-danger">{error}</p>}
      {!status && !error && <p className="m-0 text-ui text-muted">Loading…</p>}
      {status?.sync_error && (
        <p className="m-0 mb-4 rounded-[12px] border border-danger-border bg-danger-fill px-3 py-2 text-[13.5px] text-danger">{status.sync_error}</p>
      )}
      {status && status.sync_report && <SyncReportView status={status} report={status.sync_report} />}
      {status && !status.sync_report && !status.sync_error && (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-ui text-secondary">Tables from the last sync:</p>
          <ul className="m-0 pl-4 text-[13.5px] text-secondary list-disc">
            {status.tables.map((t) => <li key={t.name}>{t.name.replace(/_/g, " ")} · {t.rows.toLocaleString()} rows</li>)}
          </ul>
          <p className="m-0 text-[12.5px] text-muted">Sync again to see what each account sent.</p>
        </div>
      )}
    </Sheet>
  );
}

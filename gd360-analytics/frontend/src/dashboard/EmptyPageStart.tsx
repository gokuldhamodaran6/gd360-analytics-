// 2026-10-12 (round 35b): what an empty dashboard page offers its editor, above the quick-add
// buttons - say what it should show (GD360 drafts checked blocks from THIS page's source, the same
// engine as every dashboard proposal), or merge pages in from dashboards you already have.
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { dashboardBuilderApi, type DashboardBuilderDetail, type DashboardBuilderPage } from "../api/client";
import { Button, MergeIcon, SparkleIcon, WarningIcon } from "../ui";
import { suggestFromColumns } from "./builder/Composer";
import { DashboardChecklist } from "./DashboardChecklist";

export function EmptyPageStart({
  dash, page, columns, onChange,
}: {
  dash: DashboardBuilderDetail;
  page: DashboardBuilderPage;
  columns?: { name: string; dtype: string }[];
  onChange: (d: DashboardBuilderDetail, focusPageId?: string) => void;
}) {
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState<null | "draft" | "merge">(null);
  const [error, setError] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const suggestions = useMemo(() => suggestFromColumns(columns || []).slice(0, 3), [columns]);
  const sourceName = page.datasource_name || dash.datasource_name || "this page's data";

  const newPageOf = (before: DashboardBuilderDetail, after: DashboardBuilderDetail): string | undefined => {
    const had = new Set(before.pages.map((p) => p.id));
    return after.pages.find((p) => !had.has(p.id))?.id;
  };
  const draft = async () => {
    const g = goal.trim();
    if (g.length < 3 || busy) return;
    setBusy("draft");
    setError(null);
    try {
      const d = await dashboardBuilderApi.draftIntoPage(dash.id, page.id, g);
      onChange(d, newPageOf(dash, d));
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Couldn't draft that just now - try again, or add blocks yourself.");
    } finally {
      setBusy(null);
    }
  };
  const merge = async () => {
    if (!picked.length || busy) return;
    setBusy("merge");
    setError(null);
    try {
      const d = await dashboardBuilderApi.mergeIn(dash.id, picked);
      setMergeOpen(false);
      setPicked([]);
      onChange(d, newPageOf(dash, d));
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Couldn't merge those dashboards in.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex w-full max-w-[720px] flex-col gap-3" data-empty-page-start="">
      <div className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-3.5 text-left shadow-card">
        <label htmlFor={`draft-${page.id}`} className="sr-only">What should this page show?</label>
        <textarea
          id={`draft-${page.id}`}
          data-draft-goal=""
          rows={2}
          value={goal}
          maxLength={2000}
          disabled={busy !== null}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); draft(); } }}
          placeholder={`What should it show? e.g. ${(suggestions[0] || "the key numbers and how they trend").replace(/^./, (c) => c.toLowerCase())}`}
          className="ui-focus w-full resize-none rounded-ctl border-0 bg-transparent px-1 py-1 text-body text-text placeholder:text-faint"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap gap-1.5" aria-label="Suggestions">
            {suggestions.map((sug) => (
              <button
                key={sug}
                type="button"
                disabled={busy !== null}
                onClick={() => setGoal(sug)}
                data-draft-suggestion=""
                className="ui-focus max-w-full truncate rounded-full border border-border px-2.5 py-1 text-caption text-secondary hover:border-border-strong hover:text-text"
                title={sug}
              >
                {sug}
              </button>
            ))}
          </div>
          <Button variant="primary" size="sm" icon={<SparkleIcon size={13} />} loading={busy === "draft"} disabled={goal.trim().length < 3 || busy !== null} onClick={draft} data-draft-submit="">
            {busy === "draft" ? `Drafting from ${sourceName}…` : "Draft blocks"}
          </Button>
        </div>
      </div>
      {error && (
        <div role="alert" className="flex items-start gap-1.5 rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-left text-caption text-danger">
          <WarningIcon size={13} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}
      <div className="flex justify-center">
        <Button variant="secondary" icon={<MergeIcon size={14} />} onClick={() => setMergeOpen(true)} disabled={busy !== null} data-merge-in-open="">
          Merge a dashboard in
        </Button>
      </div>

      {mergeOpen && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:items-center" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !busy) setMergeOpen(false); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="merge-in-title" className="my-8 flex w-full max-w-[560px] flex-col rounded-card border border-border bg-surface shadow-pop" data-merge-in-dialog="">
            <div className="flex flex-col gap-1 border-b border-border px-5 py-4">
              <h2 id="merge-in-title" className="m-0 text-section font-semibold text-text">Merge a dashboard in</h2>
              <p className="m-0 text-caption text-muted">Their pages are added to “{dash.name}”, each still reading its own source. The originals stay as they are.</p>
            </div>
            <div className="px-5 py-4">
              <DashboardChecklist value={picked} onChange={setPicked} exclude={[dash.id]} />
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
              <Button variant="secondary" onClick={() => setMergeOpen(false)} disabled={busy !== null}>Cancel</Button>
              <Button variant="primary" onClick={merge} loading={busy === "merge"} disabled={!picked.length || busy !== null} data-merge-in-confirm="">
                {picked.length ? `Merge ${picked.length} in` : "Merge in"}
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

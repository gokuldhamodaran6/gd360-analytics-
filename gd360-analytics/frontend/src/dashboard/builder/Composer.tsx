import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { datasourceApi, type DashboardProposal, type DataSourceSummary, type ProposalTemplate } from "../../api/client";
import { getTableEntries } from "../../components/DataSourceForm";
import {
  Button, CheckIcon, DatabaseIcon, ProviderBadge, Select, Skeleton, SparkleIcon, TableIcon, Textarea, WarningIcon, cn, providerDisplayName,
} from "../../ui";
import { kindLabel, proposalSupport, schemaSummary, type SourceSupport } from "./sourceSupport";
import { SourcePicker } from "./SourcePicker";

// Builder.dc.html's left column: "Describe". The source picker (name,
// provider badge, "119,386 rows · 32 columns" when the schema cache / file
// versions know it), the goal textarea, example chips, and "Start from a
// template" (GET /dashboard-builder/propose/templates). Cmd/Ctrl+Enter
// submits. Once a proposal exists the column turns into the conversation:
// the goal as a sent bubble and GD360's answer card ("What it used").

export const GOAL_MAX = 2000;
export const GOAL_MIN = 3;

// round 35: starting points written from the chosen source's OWN columns ("Net sales by marketing
// channel and customer segment") - before, four fixed sentences about revenue and cancellations sat
// here for every source, next to a second set of "templates" saying the same thing.
export const EXAMPLE_GOALS = [
  "A weekly overview of the key numbers for leadership, and how they trend",
  "Where the results come from, by the main categories, with a detail table",
  "The main measure over time, with filters for each segment",
];

const MONEY = /(revenue|sales|amount|price|profit|cost|gmv|income|spend|margin|adr|value|fee|payment)/i;
const NOT_MEASURE = /(^id$|_id$|^id_|zip|postal|code$|phone|^year$|_year$|_month$|_week|_day|number$|latitude|longitude|^lat$|^lon|^lng$|^(is|has|was|flag)_|^(is|has)[A-Z])/i;
const GOOD_DIM = /(channel|segment|category|region|country|city|state|product|type|status|source|campaign|department|market|brand|store|hotel|team|plan|tier|device|platform)/i;
const DATE_NAME = /(date|month|time|period|_at$|^day$|week)/i;
const ACRONYMS = new Set(["adr", "aov", "gmv", "roi", "cac", "ltv", "arr", "mrr", "kpi", "ctr", "cpc", "cpm", "nps", "roas", "sku", "id"]);
const human = (c: string) => c.replace(/[_\s]+/g, " ").trim().toLowerCase().replace(/^(total|sum|count) (of )?/, "")
  .split(" ").map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w)).join(" ");

export function suggestGoals(ds: DataSourceSummary | null): string[] {
  if (!ds) return [];
  const tables = getTableEntries(ds.kind, ds.schema_cache, ds.name) || [];
  const t = [...tables].sort((a, b) => (b.columns?.length || 0) - (a.columns?.length || 0))[0];
  return suggestFromColumns((t?.columns || []).map((c: any) => ({ name: String(c.name || ""), type: String(c.type || "") })));
}

/** Round 35b: the same starting points from a plain column list (an empty dashboard page). */
export function suggestFromColumns(columns: { name: string; type?: string; dtype?: string }[]): string[] {
  const cols = columns.map((c) => ({ name: String(c.name || ""), type: String(c.type || c.dtype || "").toLowerCase() })).filter((c) => c.name);
  if (!cols.length) return EXAMPLE_GOALS;
  const numeric = cols.filter((c) => /(int|float|double|numeric|decimal|number|real|money|bigint)/.test(c.type) && !NOT_MEASURE.test(c.name));
  const measures = [...numeric.filter((c) => MONEY.test(c.name)), ...numeric.filter((c) => !MONEY.test(c.name))].map((c) => human(c.name));
  const textual = cols.filter((c) => /(str|text|char|object|varchar|category|bool)/.test(c.type) || !c.type);
  const dims = [...textual.filter((c) => GOOD_DIM.test(c.name)), ...textual.filter((c) => !GOOD_DIM.test(c.name) && !/(name|email|description|comment|note|url|address|id$)/i.test(c.name))].map((c) => human(c.name));
  const hasDate = cols.some((c) => /(date|time|timestamp)/.test(c.type) || DATE_NAME.test(c.name));
  const [m1, m2] = measures;
  const [d1, d2] = dims;
  if (!m1) return EXAMPLE_GOALS;
  const out: string[] = [];
  out.push(`Leadership overview: ${m1}${m2 ? ` and ${m2}` : ""}${hasDate ? ", and how they trend month by month" : ""}`);
  if (d1) out.push(`Where ${m1} comes from: by ${d1}${d2 ? ` and ${d2}` : ""}, with a detail table`);
  if (hasDate && d1) out.push(`${m1.charAt(0).toUpperCase()}${m1.slice(1)} over time, with filters for ${d2 || d1}`);
  else if (m2 && d1) out.push(`Compare ${m1} and ${m2} across ${d1}`);
  return out.slice(0, 3);
}

export function isSubmitShortcut(e: KeyboardEvent): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey);
}

export type SourceStats = { rows: number | null; columns: number; tables: number; loading: boolean };

// Rows for a file-backed source come from its versions list (an exact,
// stored count - no load); a warehouse source only reports its schema
// (a row count there is a real metered query, which belongs on the Data
// tab, not a decoration).
export function useSourceStats(ds: DataSourceSummary | null): SourceStats {
  const [rows, setRows] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const summary = useMemo(() => schemaSummary(ds), [ds]);
  useEffect(() => {
    setRows(null);
    if (!ds) return;
    const support = proposalSupport(ds.kind);
    if (support.level !== "file" || ds.kind === "mongodb" || ds.kind === "api") return;
    let cancelled = false;
    setLoading(true);
    datasourceApi
      .listVersions(ds.id)
      .then((versions) => {
        if (cancelled) return;
        const original = versions.find((v) => !v.parent_version_id) || versions[0];
        setRows(typeof original?.row_count === "number" ? original.row_count : null);
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ds]);
  return { rows, columns: summary.columns, tables: summary.tables, loading };
}

export function sourceStatsText(stats: SourceStats): string {
  const parts: string[] = [];
  if (typeof stats.rows === "number") parts.push(`${stats.rows.toLocaleString()} rows`);
  if (stats.columns) parts.push(`${stats.columns.toLocaleString()} column${stats.columns === 1 ? "" : "s"}`);
  if (stats.tables > 1) parts.push(`${stats.tables} tables`);
  return parts.join(" · ");
}

export type ComposerProps = {
  sources: DataSourceSummary[] | null;
  sourcesError?: string | null;
  sourceId: string;
  onSourceChange: (id: string) => void;
  goal: string;
  onGoalChange: (goal: string) => void;
  templates: ProposalTemplate[] | null;
  templateId: string | null;
  onTemplateChange: (id: string | null) => void;
  onSubmit: () => void;
  busy?: boolean;
  error?: string | null;
  // Set once a proposal exists: the column shows the conversation.
  proposal?: DashboardProposal | null;
  onDescribeAgain?: () => void;
  className?: string;
  // round 35: the chat this page was opened from - its "Made from" link, shown and removable, so a
  // dashboard is never stamped "Made from <a chat>" it has nothing to do with
  linkedChat?: { title: string; onUnlink: () => void } | null;
};

function SupportNote({ support, ds }: { support: SourceSupport; ds: DataSourceSummary }) {
  if (support.level === "unsupported") {
    return (
      <div role="alert" data-source-unsupported="" className="flex flex-col gap-1.5 rounded-ctl border border-warning-border bg-warning-fill px-3 py-2.5 text-caption text-warning">
        <span className="inline-flex items-center gap-1.5 font-medium"><WarningIcon size={13} /> Not available for this source</span>
        <span>{support.reason}</span>
        <Link to={`/workspace/${ds.id}`} className="ui-focus w-fit rounded font-medium underline-offset-2 hover:underline">
          Open {ds.name} and use Build Dashboard → Create your own
        </Link>
      </div>
    );
  }
  return <div className="text-caption text-muted">{support.note}</div>;
}

function UsedList({ proposal }: { proposal: DashboardProposal }) {
  const metrics = proposal.used?.metrics || [];
  const columns = proposal.used?.columns || [];
  const tables = proposal.used?.tables || [];
  if (!metrics.length && !columns.length && !tables.length) return null;
  const row = (icon: ReactNode, main: ReactNode, aside: ReactNode) => (
    <div className="flex items-center gap-2 text-ui">
      <span className="inline-flex shrink-0 text-brand-ink">{icon}</span>
      <span className="min-w-0 truncate">{main}</span>
      <span className="shrink-0 text-caption text-faint">{aside}</span>
    </div>
  );
  return (
    <div className="flex flex-col gap-1.5" data-proposal-used="">
      <div className="text-[11.5px] font-semibold uppercase tracking-caps text-muted">What it used</div>
      {metrics.map((m) => <div key={`m-${m}`}>{row(<CheckIcon size={14} strokeWidth={2.4} />, m, "saved metric")}</div>)}
      {columns.slice(0, 8).map((c) => <div key={`c-${c}`}>{row(<TableIcon size={14} className="text-muted" />, <span className="font-mono text-[12.5px]">{c}</span>, "column")}</div>)}
      {columns.length > 8 && <div className="text-caption text-faint">+{columns.length - 8} more columns</div>}
      {tables.length > 0 && <div className="text-caption text-muted">From {tables.map((t) => <span key={t} className="font-mono text-[12px]">{t}</span>).reduce<ReactNode[]>((acc, el, i) => (i ? [...acc, ", ", el] : [el]), [])}</div>}
    </div>
  );
}

export function Composer({
  sources, sourcesError, sourceId, onSourceChange, goal, onGoalChange, templateId, onTemplateChange, onSubmit, busy = false, error, proposal, onDescribeAgain, className, linkedChat,
}: ComposerProps) {
  const ds = useMemo(() => (sources || []).find((d) => d.id === sourceId) || null, [sources, sourceId]);
  const support = ds ? proposalSupport(ds.kind) : null;
  const stats = useSourceStats(ds);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const trimmed = goal.trim();
  const [touched, setTouched] = useState(false);
  const goalTooShort = trimmed.length < GOAL_MIN;
  const canSubmit = Boolean(ds) && support?.level !== "unsupported" && !goalTooShort && !busy;

  const submit = () => {
    setTouched(true);
    if (!ds || support?.level === "unsupported") return;
    if (goalTooShort) {
      textareaRef.current?.focus();
      return;
    }
    onSubmit();
  };

  void templateId; void onTemplateChange;
  const suggestions = useMemo(() => suggestGoals(ds), [ds]);

  const statsText = sourceStatsText(stats);
  const tableEntries = ds ? getTableEntries(ds.kind, ds.schema_cache, ds.name) : [];

  return (
    <section data-composer="" aria-label="Describe the dashboard" className={cn("flex min-w-0 flex-col rounded-card border border-border bg-surface shadow-card", className)}>
      <header className="flex items-center justify-between gap-2.5 border-b border-border px-[18px] py-3.5">
        <h2 className="text-[15px] font-semibold text-text">Describe</h2>
        {ds && proposal && (
          <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border bg-base px-2.5 py-[3px] text-caption text-secondary" title={ds.name}>
            <span aria-hidden="true" className="h-[7px] w-[7px] shrink-0 rounded-full bg-primary" />
            <span className="truncate">{ds.name}</span>
          </span>
        )}
      </header>

      <div className="flex flex-1 flex-col gap-4 px-[18px] py-4">
        {proposal ? (
          <>
            <div data-goal-bubble="" className="max-w-[88%] self-end rounded-[12px_12px_4px_12px] bg-primary px-3.5 py-3 text-body text-on-primary">{goal.trim()}</div>
            <div data-proposal-card="" className="flex flex-col gap-3 rounded-card border border-border bg-base p-3.5">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-[6px] bg-primary text-[11px] font-bold text-on-primary">G</span>
                <span className="text-[12.5px] font-semibold text-text">GD360</span>
                <span className="text-caption text-faint">· proposal in {(proposal.generated_in_ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s{proposal.revision > 1 ? ` · revision ${proposal.revision}` : ""}</span>
              </div>
              <div className="text-body text-text">
                Here's a proposal built from <span className="font-mono text-[13px]">{proposal.datasource_name || ds?.name || "your data"}</span>
                {stats.columns ? ` (${stats.columns} columns)` : ""}
                {proposal.used?.metrics?.length ? ` and your ${proposal.used.metrics.length} saved metric${proposal.used.metrics.length === 1 ? "" : "s"}` : ""}.{" "}
                <strong className="font-semibold">{proposal.valid_blocks} block{proposal.valid_blocks === 1 ? "" : "s"}, {proposal.pages.length} page{proposal.pages.length === 1 ? "" : "s"}.</strong>
                {proposal.proposed_blocks > proposal.valid_blocks && (
                  <span className="text-secondary"> {proposal.proposed_blocks - proposal.valid_blocks} proposed block{proposal.proposed_blocks - proposal.valid_blocks === 1 ? "" : "s"} failed validation and {proposal.proposed_blocks - proposal.valid_blocks === 1 ? "is" : "are"} shown with the reason.</span>
                )}
              </div>
              {proposal.warning && (
                <div role="status" className="flex items-start gap-1.5 rounded-ctl border border-warning-border bg-warning-fill px-2.5 py-2 text-caption text-warning">
                  <WarningIcon size={13} className="mt-0.5 shrink-0" /> {proposal.warning}
                </div>
              )}
              <UsedList proposal={proposal} />
              <div className="text-[12.5px] text-muted">
                {proposal.warehouse_native
                  ? `Every block was checked in ${providerDisplayName(proposal.datasource_kind)} without running it · numbers compute on publish.`
                  : "Every block is a simple recipe over the complete file · numbers compute on publish."}
              </div>
            </div>
            {onDescribeAgain && (
              <button type="button" className="ui-focus w-fit rounded text-caption font-medium text-brand-ink hover:underline" onClick={onDescribeAgain}>
                Describe it differently
              </button>
            )}
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="builder-source" className="text-caption font-medium uppercase tracking-caps text-muted">Data source</label>
              {sources === null && !sourcesError ? (
                <Skeleton height={36} />
              ) : sourcesError ? (
                <div role="alert" className="rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-caption text-danger">{sourcesError}</div>
              ) : sources && sources.length === 0 ? (
                <div className="rounded-ctl border border-border bg-base px-3 py-2.5 text-caption text-secondary">
                  No data connected yet. <Link to="/data" className="font-medium text-brand-ink hover:underline">Connect a data source</Link> first.
                </div>
              ) : (
                <SourcePicker sources={sources || []} value={sourceId} onChange={onSourceChange} disabled={busy} />
              )}
              {ds && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted" data-source-stats="">
                  {stats.loading && !statsText ? <span className="ui-shimmer h-3 w-28" aria-busy="true" /> : statsText ? <span className="tabular-nums">{statsText}</span> : tableEntries.length === 0 ? <span>Schema not cached yet</span> : null}
                </div>
              )}
              {ds && support && <SupportNote support={support} ds={ds} />}
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="builder-goal" className="text-caption font-medium uppercase tracking-caps text-muted">What should it show?</label>
              <Textarea
                ref={textareaRef}
                id="builder-goal"
                data-goal-input=""
                rows={5}
                value={goal}
                maxLength={GOAL_MAX}
                disabled={busy || support?.level === "unsupported"}
                invalid={touched && goalTooShort}
                placeholder={suggestions[0] ? `Who is it for and what matters most - e.g. ${suggestions[0].charAt(0).toLowerCase()}${suggestions[0].slice(1)}.` : "Who is it for and what matters most - the numbers, the breakdowns, the filters."}
                onChange={(e) => onGoalChange(e.target.value)}
                onKeyDown={(e) => { if (isSubmitShortcut(e)) { e.preventDefault(); submit(); } }}
                aria-describedby="builder-goal-hint"
              />
              <div id="builder-goal-hint" className="flex items-center justify-between gap-2 text-caption">
                {touched && goalTooShort ? (
                  <span role="alert" data-goal-error="" className="text-danger">Describe the dashboard first - a few words are enough.</span>
                ) : (
                  <span className="text-muted">⌘/Ctrl + Enter to propose</span>
                )}
                <span className="tabular-nums text-faint">{goal.length}/{GOAL_MAX}</span>
              </div>
            </div>

            {linkedChat && (
              <div className="flex items-center gap-2 rounded-ctl border border-border bg-base px-2.5 py-2 text-caption text-secondary" data-linked-chat="">
                <span className="min-w-0 flex-1 truncate" title={linkedChat.title}>Made from <span className="font-medium text-text">“{linkedChat.title}”</span></span>
                <button type="button" onClick={linkedChat.onUnlink} className="ui-focus shrink-0 rounded font-medium text-muted hover:text-text" data-unlink-chat="">Unlink</button>
              </div>
            )}

            {suggestions.length > 0 && <div className="text-[11.5px] font-semibold uppercase tracking-caps text-muted">Start from</div>}
            <div className="flex flex-col gap-1.5" aria-label="Suggestions from this source" data-example-chips="">
              {suggestions.map((g) => (
                <button
                  key={g}
                  type="button"
                  disabled={busy}
                  className="ui-focus rounded-ctl border border-border bg-surface px-3 py-2 text-left text-[12.5px] leading-snug text-secondary hover:border-border-strong hover:bg-subtle hover:text-text disabled:text-faint"
                  data-suggestion="" 
                  onClick={() => { onGoalChange(g); textareaRef.current?.focus(); }}
                >
                  {g}
                </button>
              ))}
            </div>

            {error && (
              <div role="alert" data-propose-error="" className="flex flex-col gap-2 rounded-ctl border border-danger-border bg-danger-fill px-3 py-2.5 text-ui text-danger">
                <span className="inline-flex items-start gap-1.5"><WarningIcon size={14} className="mt-0.5 shrink-0" /> <span>{error}</span></span>
                <Button size="sm" variant="secondary" className="h-8 w-fit text-caption" onClick={submit} disabled={!canSubmit}>Try again</Button>
              </div>
            )}
          </>
        )}
      </div>

      {!proposal && (
        <footer className="flex flex-col gap-3 border-t border-border px-[18px] py-3.5">
          <Button variant="primary" size="lg" data-propose-submit="" loading={busy} disabled={!canSubmit && !busy} icon={<SparkleIcon size={15} />} onClick={submit} className="w-full">
            {busy ? "Proposing…" : "Propose a dashboard"}
          </Button>
          {ds && support?.level !== "unsupported" && (
            <div className="inline-flex items-center gap-1.5 text-caption text-muted">
              <DatabaseIcon size={13} className="text-brand-ink" /> Every block carries its own query - see it before you publish.
            </div>
          )}
        </footer>
      )}
    </section>
  );
}

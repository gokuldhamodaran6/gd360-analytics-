import { useMemo, useState, type ReactNode } from "react";
import type { DashboardBlock, DashboardParameter, DashboardPeriod, DashboardProposal, ProposalBlock } from "../../api/client";
import { TextBlock, useIsNarrow } from "../../components/DashboardBlocks";
import { useBox } from "../charts/useBox";
import {
  BarChartIcon, ChartCard, ChartIcon, DateRangePicker, FilterRail, FilterRailSection, KpiTile, ProviderBadge, SegmentedControl, Skeleton, SparkleIcon, StatusPill, TableIcon, cn, providerDisplayName,
} from "../../ui";
import { ROW_UNIT_PX, SqlSheet, compactLayout } from "../BlockGrid";
import { PERIOD_LABEL, PERIODS, describeSpec, normalizePeriod } from "../runState";
import { ProposedBlockFrame, PROPOSAL_TYPE_LABEL, swapLabel } from "./ProposedBlockFrame";
import type { ProposalFlow, SwapPayload } from "./useProposalFlow";

// Builder.dc.html's right column: the proposal rendered in the real
// dashboard chrome - header (title, "Hotel_data · BigQuery · month"),
// the 260 px filter rail with one section per parameter the commit will
// create, the KPI strip and the 12-column block grid - each block wrapped
// in ProposedBlockFrame (pill, Keep / Swap / Remove, why, Show SQL).
// Nothing in a proposal has been run (the backend only dry-runs the SQL),
// so every body is an honest "Will compute on publish" placeholder; the
// same kit pieces (KpiTile, ChartCard, FilterRail, SegmentedControl,
// DateRangePicker) and the grid geometry (compactLayout, ROW_UNIT_PX)
// the live dashboard uses, so the preview is the page it will become.

const GRID_GAP_PX = 16;
const STACK_HEIGHT: Record<string, number> = { table: 320, chart: 300, donut: 300, sparkline: 220, text: 140 };

function effectiveType(block: ProposalBlock, swap: SwapPayload | null): string {
  if (swap?.type) return swap.type;
  if (swap?.chart_type) return swap.chart_type === "donut" ? "donut" : "chart";
  return block.type;
}

function toDashboardBlock(b: ProposalBlock): DashboardBlock {
  // The frame adds a strip and a why line above/below the card, so a
  // block needs at least 3 rows (160 px) to show anything.
  const h = Math.max(3, b.layout?.h ?? 6);
  return { id: b.client_id, type: b.type as DashboardBlock["type"], title: b.title, x: b.layout?.x ?? 0, y: b.layout?.y ?? 0, w: b.layout?.w ?? 6, h, config: { spec: b.spec, chart_type: b.chart_type, text: b.text }, position: 0, query_sql: b.sql };
}

function BodyPlaceholder({ block, type, provider, swap }: { block: ProposalBlock; type: string; provider: string; swap: SwapPayload | null }) {
  const Icon = type === "table" ? TableIcon : type === "chart" && (swap?.chart_type || block.chart_type || "").includes("bar") ? BarChartIcon : ChartIcon;
  const shape = swap ? swapLabel(swap) : type === "chart" ? `${(block.chart_type || "bar").replace(/_/g, " ")} chart` : PROPOSAL_TYPE_LABEL[type] || type;
  return (
    <div data-block-placeholder="" className="flex h-full min-h-[120px] flex-col items-center justify-center gap-1.5 rounded-ctl border border-dashed border-border-strong bg-base px-4 py-5 text-center">
      <Icon size={18} className="text-muted" />
      <div className="text-ui font-medium text-secondary">Will compute in {provider} on publish</div>
      <div className="max-w-[36ch] text-caption text-muted">{shape}{block.columns?.length ? ` · ${block.columns.map((c) => c.name).join(", ")}` : ""}</div>
    </div>
  );
}

function InvalidBody({ block }: { block: ProposalBlock }) {
  return (
    <div role="alert" className="flex h-full min-h-[120px] flex-col items-center justify-center gap-1 rounded-ctl border border-danger-border bg-danger-fill px-4 py-5 text-center">
      <div className="text-ui font-medium text-danger">Couldn't be validated</div>
      <div className="text-caption text-danger">{block.error || "The server rejected this block."}</div>
    </div>
  );
}

export function PreviewSkeleton() {
  return (
    <div data-preview-skeleton="" aria-busy="true" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <Skeleton height={20} width={240} />
        <Skeleton height={28} width={180} />
      </div>
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="tile" />)}
      </div>
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(12, minmax(0, 1fr))" }}>
        <div style={{ gridColumn: "span 8" }}><Skeleton height={280} className="w-full rounded-card" /></div>
        <div style={{ gridColumn: "span 4" }}><Skeleton height={280} className="w-full rounded-card" /></div>
        <div style={{ gridColumn: "span 12" }}><Skeleton height={200} className="w-full rounded-card" /></div>
      </div>
    </div>
  );
}

export function PreviewEmpty() {
  return (
    <div data-preview-empty="" className="flex min-h-[320px] flex-col items-center justify-center gap-2 rounded-card border border-dashed border-border-strong bg-surface/60 px-6 py-10 text-center">
      <SparkleIcon size={20} className="text-brand-ink" />
      <div className="text-body font-medium text-text">Your proposal appears here</div>
      <div className="max-w-[44ch] text-ui text-muted">Describe who the dashboard is for and what matters; GD360 proposes the KPIs, charts and tables from your real columns and saved metrics. Nothing is created until you publish.</div>
    </div>
  );
}

function ParameterPreview({ param }: { param: DashboardParameter }) {
  if (param.control === "date_range") {
    return <DateRangePicker value={{ from: null, to: null }} onChange={() => undefined} disabled label={param.column} ariaLabel={`Date range on ${param.column}`} />;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5" aria-hidden="true">
        {[64, 48, 56].map((w, i) => <span key={i} className="h-7 rounded-full border border-border bg-base" style={{ width: w }} />)}
      </div>
      <span className="text-caption text-muted">Values load on publish · {param.control === "chips" ? "chips" : param.control}</span>
    </div>
  );
}

// Below this width (of the window, or of the preview's own card) the
// preview stacks: filters inline, one block per row.
const PREVIEW_DESKTOP_MIN_PX = 900;
// Up to four KPI tiles in a row, but never a tile narrower than the
// Keep / Swap / Remove bar above it (about 250px) - fewer per row instead.
const KPI_STRIP_COLUMNS = "repeat(auto-fit, minmax(min(100%, max(260px, calc((100% - 48px) / 4))), 1fr))";

export type ProposalPreviewProps = {
  flow: ProposalFlow;
  className?: string;
};

export function ProposalPreview({ flow, className }: ProposalPreviewProps) {
  const { proposal, loading, revising, publishing } = flow;
  // 2026-10-07 (real end-to-end run): the preview is "narrow" when ITS OWN
  // box is, not only when the window is. On the New dashboard page it sits
  // beside the 380px composer and the app sidebar, so on a 1440px window
  // it is about 730px wide - and the desktop arrangement (a 260px rail, a
  // 12-column grid, four KPI tiles in a row) was being squeezed into it:
  // 94px KPI tiles with their Keep/Swap/Remove bars overlapping each
  // other, 200px charts whose placeholder ran over the card footer.
  const viewportNarrow = useIsNarrow(PREVIEW_DESKTOP_MIN_PX);
  const [shellRef, , shellBox] = useBox({ w: 1280, h: 1 });
  const narrow = viewportNarrow || shellBox.w < PREVIEW_DESKTOP_MIN_PX;
  const [pageIndex, setPageIndex] = useState(0);
  const [sqlFor, setSqlFor] = useState<ProposalBlock | null>(null);
  const page = proposal?.pages[Math.min(pageIndex, Math.max(0, (proposal?.pages.length || 1) - 1))];
  const provider = proposal ? (proposal.warehouse_native ? providerDisplayName(proposal.datasource_kind) : "GD360") : "";
  const busy = revising || publishing;

  const kpis = useMemo(() => (page?.blocks || []).filter((b) => b.type === "kpi"), [page]);
  const others = useMemo(() => (page?.blocks || []).filter((b) => b.type !== "kpi"), [page]);
  const laidOut = useMemo(() => compactLayout(others.map(toDashboardBlock)), [others]);
  const byId = useMemo(() => new Map(others.map((b) => [b.client_id, b] as const)), [others]);

  if (loading && !proposal) return <div className={className}><PreviewSkeleton /></div>;
  if (!proposal || !page) return <div className={className}><PreviewEmpty /></div>;

  const keptCount = flow.keep.length;
  const totalOk = flow.blocks.length;
  const period = normalizePeriod(proposal.period);

  const frameFor = (b: ProposalBlock, body: ReactNode, extraClass?: string) => {
    const kept = flow.isKept(b);
    const swap = flow.swapOf(b);
    return (
      <ProposedBlockFrame
        key={b.client_id}
        block={b}
        kept={kept}
        swap={swap}
        canSwap={proposal.warehouse_native && Boolean(b.spec)}
        onKeep={() => flow.setKept(b, true)}
        onRemove={() => flow.setKept(b, false)}
        onSwap={(p) => flow.swap(b, p)}
        onShowSql={b.sql ? () => setSqlFor(b) : undefined}
        disabled={busy}
        className={extraClass}
      >
        {body}
      </ProposedBlockFrame>
    );
  };

  const cardFor = (b: ProposalBlock, heightPx?: number) => {
    const swap = flow.swapOf(b);
    const type = effectiveType(b, swap);
    if (b.status !== "ok") {
      return <ChartCard title={b.title} subtitle={b.spec ? describeSpec(b.spec) : undefined} className="h-full" bodyClassName="flex flex-col"><InvalidBody block={b} /></ChartCard>;
    }
    if (b.type === "text") {
      return <div className="h-full" data-block-id={b.client_id} data-block-type="text"><TextBlock title={null} config={{ text: b.text }} /></div>;
    }
    const bodyHeight = heightPx ? Math.max(120, heightPx - 56 - 34) : undefined;
    return (
      <ChartCard
        title={b.title}
        subtitle={b.spec ? describeSpec(b.spec) : undefined}
        className="h-full"
        bodyClassName="flex flex-col"
        flush={false}
        footer={<div className="px-4 py-2 text-caption text-muted" data-computed-in="">Will compute in {provider} · {b.sql ? "query checked, not run" : "recipe runs once on publish"}</div>}
      >
        <div className="relative min-h-0 flex-1" data-block-id={b.client_id} data-block-type={type} style={bodyHeight ? { minHeight: Math.min(bodyHeight, 160) } : undefined}>
          <BodyPlaceholder block={b} type={type} provider={provider} swap={swap} />
        </div>
      </ChartCard>
    );
  };

  const kpiTile = (b: ProposalBlock) => {
    if (b.status !== "ok") return <ChartCard title={b.title} className="h-full"><InvalidBody block={b} /></ChartCard>;
    const swap = flow.swapOf(b);
    if (swap) return cardFor(b);
    return (
      <div data-block-id={b.client_id} data-block-type="kpi" className="h-full">
        <KpiTile
          label={b.title}
          value={<span className="text-faint">—</span>}
          // A file KPI has no prior period (its delta is "vs all rows",
          // and only while a filter is on): the frame does not promise one.
          caption={`Will compute in ${provider} on publish${proposal.warehouse_native && b.spec?.compare_prior_period ? " · vs prior period" : ""}`}
          className="h-full"
        />
      </div>
    );
  };

  return (
    <section data-proposal-preview="" aria-busy={busy || undefined} className={cn("flex min-w-0 flex-col gap-3.5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-ui text-secondary tabular-nums" data-preview-status="">
          <span className="font-semibold text-text">Live proposal</span>
          <span aria-hidden="true" className="text-border-strong">·</span>
          {proposal.pages.length > 1 ? (
            <SegmentedControl<string>
              ariaLabel="Page"
              value={String(pageIndex)}
              onChange={(v) => setPageIndex(Number(v))}
              options={proposal.pages.map((p, i) => ({ value: String(i), label: p.title || `Page ${i + 1}` }))}
            />
          ) : (
            <span>{page.title}</span>
          )}
          <span aria-hidden="true" className="text-border-strong">·</span>
          <span data-keep-count="">{keptCount} of {totalOk} block{totalOk === 1 ? "" : "s"} kept</span>
          {proposal.revision > 1 && (
            <>
              <span aria-hidden="true" className="text-border-strong">·</span>
              <span>revision {proposal.revision}</span>
            </>
          )}
        </div>
        <StatusPill tone="neutral" icon="dot" title="The proposal was validated, not run - the dashboard computes every block on publish.">
          Numbers compute on publish · {provider}
        </StatusPill>
      </div>

      <div ref={shellRef} className="relative flex min-w-0 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card" data-dashboard-shell="">
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-6 pb-4 pt-5">
          <div className="min-w-0">
            <h2 className="truncate text-title font-semibold text-text" data-preview-title="">{proposal.title}</h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-ui text-muted" data-dashboard-subtitle="">
              {proposal.datasource_name && <span>{proposal.datasource_name}</span>}
              {proposal.datasource_kind && <><span aria-hidden="true">·</span><ProviderBadge provider={proposal.datasource_kind} /></>}
              {proposal.date_column && <><span aria-hidden="true">·</span><span>by <span className="font-mono text-caption">{proposal.date_column}</span></span></>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl<DashboardPeriod>
              ariaLabel="Period"
              value={period}
              onChange={() => undefined}
              options={PERIODS.filter((p) => p !== "quarter" || period === "quarter").map((p) => ({ value: p, label: PERIOD_LABEL[p] }))}
              disabled
            />
          </div>
        </header>

        <div className={cn("flex min-h-0 flex-1 items-stretch", narrow && "flex-col")}>
          {narrow ? (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-6 py-3" data-preview-filters-inline="">
              <span className="text-caption font-semibold uppercase tracking-caps text-secondary">Filters</span>
              {proposal.parameters.length === 0 && <span className="text-caption text-muted">none proposed</span>}
              {proposal.parameters.map((p) => (
                <span key={p.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-base px-2 py-[2px] text-caption text-secondary">{p.label}<span className="font-mono text-faint">{p.column}</span></span>
              ))}
            </div>
          ) : (
            <FilterRail sticky={false} note={proposal.parameters.length ? "Filters apply to every chart · values load on publish" : undefined}>
              {proposal.parameters.length === 0 ? (
                <div className="text-caption text-muted">No filters proposed - the dashboard's editor can add rail controls after publishing.</div>
              ) : (
                proposal.parameters.map((p) => (
                  <FilterRailSection key={p.id} label={p.label} trailing={<span className="font-mono">{p.column}</span>} id={`preview-param-${p.id}`}>
                    <ParameterPreview param={p} />
                  </FilterRailSection>
                ))
              )}
            </FilterRail>
          )}
          <main className="min-w-0 flex-1 px-6 pb-8 pt-1">
            {kpis.length > 0 && (
              <div data-kpi-strip="" className={cn("mb-5 grid gap-4")} style={{ gridTemplateColumns: KPI_STRIP_COLUMNS }}>
                {kpis.map((b) => frameFor(b, kpiTile(b), "h-full"))}
              </div>
            )}
            {others.length === 0 && kpis.length === 0 && <div className="py-10 text-center text-ui text-muted">This page has no blocks.</div>}
            {others.length > 0 && (narrow ? (
              <div className="flex flex-col gap-5" data-block-grid="">
                {[...laidOut].sort((a, b) => a.y - b.y || a.block.x - b.block.x).map(({ block }) => {
                  const b = byId.get(block.id)!;
                  return <div key={b.client_id} style={{ minHeight: STACK_HEIGHT[b.type] ?? 240 }}>{frameFor(b, cardFor(b, STACK_HEIGHT[b.type] ?? 240), "h-full")}</div>;
                })}
              </div>
            ) : (
              <div
                data-block-grid=""
                className="grid"
                style={{ gridTemplateColumns: "repeat(12, minmax(0, 1fr))", gridAutoRows: `${ROW_UNIT_PX}px`, gap: `${GRID_GAP_PX}px` }}
              >
                {laidOut.map(({ block, y }) => {
                  const b = byId.get(block.id)!;
                  const h = Math.max(1, block.h);
                  const heightPx = h * ROW_UNIT_PX + (h - 1) * GRID_GAP_PX;
                  return (
                    <div key={b.client_id} className="min-w-0" style={{ gridColumn: `${block.x + 1} / span ${Math.min(12, Math.max(1, block.w))}`, gridRow: `${y + 1} / span ${h}` }}>
                      {frameFor(b, cardFor(b, heightPx), "h-full")}
                    </div>
                  );
                })}
              </div>
            ))}
          </main>
        </div>
        {busy && <div aria-hidden="true" data-preview-shimmer="" className="ui-shimmer pointer-events-none absolute inset-0 opacity-30" />}
      </div>

      {sqlFor && (
        <SqlSheet
          open
          onClose={() => setSqlFor(null)}
          block={toDashboardBlock(sqlFor)}
          info={{ sql: sqlFor.sql || "", dialect: proposal.datasource_kind }}
          loading={false}
          error={null}
        />
      )}
    </section>
  );
}

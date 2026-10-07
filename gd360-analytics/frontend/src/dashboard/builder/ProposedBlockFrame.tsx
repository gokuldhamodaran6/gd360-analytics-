import type { ReactNode } from "react";
import type { ProposalBlock } from "../../api/client";
import { Badge, CheckIcon, ChevronDownIcon, CloseIcon, Popover, SqlIcon, StatusPill, cn } from "../../ui";
import { SWAP_OPTIONS } from "../BlockGrid";
import { describeSpec } from "../runState";
import type { SwapPayload } from "./useProposalFlow";

// Builder.dc.html: every proposed block carries a header strip - the
// block-type pill ("KPI · Revenue metric"), then Keep ✓ / Swap ▾ /
// Remove × - above the real block card, and a one-line "why" (what the
// block is built from) with "Show SQL" under it. The backend sends
// `intent` ("Trend · revenue by month") rather than a prose "why", so the
// pill is the part before the dot and the why line is the rest plus the
// spec in words (describeSpec) and the saved metric it came from.

export const PROPOSAL_TYPE_LABEL: Record<string, string> = { kpi: "KPI", chart: "Chart", table: "Table", text: "Text", sparkline: "Sparkline", donut: "Donut", avatar_list: "Top list", gauge: "Gauge" };

export function splitIntent(block: ProposalBlock): { kind: string; detail: string } {
  const [first, ...rest] = (block.intent || "").split("·");
  const kind = (first || "").trim();
  const detail = rest.join("·").trim();
  return { kind: kind || PROPOSAL_TYPE_LABEL[block.type] || block.type, detail };
}

export function whyOf(block: ProposalBlock): string {
  const { detail } = splitIntent(block);
  const parts: string[] = [];
  if (detail) parts.push(detail);
  if (block.from_metric_name) parts.push(`uses your saved metric "${block.from_metric_name}"`);
  const spec = block.spec ? describeSpec(block.spec) : "";
  if (spec && spec.toLowerCase() !== detail.toLowerCase()) parts.push(spec);
  if (block.type === "text") parts.push("a note on the page");
  return parts.join(" · ");
}

export function swapLabel(payload: SwapPayload | null): string | null {
  if (!payload) return null;
  const match = SWAP_OPTIONS.find((o) => (o.payload.type || null) === (payload.type || null) && (o.payload.chart_type || null) === (payload.chart_type || null));
  return match?.label || payload.chart_type || payload.type || null;
}

export type ProposedBlockFrameProps = {
  block: ProposalBlock;
  kept: boolean;
  swap: SwapPayload | null;
  canSwap: boolean;
  onKeep: () => void;
  onRemove: () => void;
  onSwap: (payload: SwapPayload | null) => void;
  onShowSql?: () => void;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
};

const ACTION = "ui-focus inline-flex h-6 items-center gap-1 rounded-[5px] px-2 text-caption font-medium transition-colors disabled:cursor-default disabled:opacity-50";

export function ProposedBlockFrame({ block, kept, swap, canSwap, onKeep, onRemove, onSwap, onShowSql, disabled = false, children, className }: ProposedBlockFrameProps) {
  const invalid = block.status !== "ok";
  const { kind } = splitIntent(block);
  const why = whyOf(block);
  const swapped = swapLabel(swap);
  const currentChart = block.chart_type || null;

  return (
    <div
      data-proposed-block={block.client_id}
      data-block-type={block.type}
      data-kept={invalid ? "invalid" : kept ? "true" : "false"}
      className={cn("flex min-w-0 flex-col gap-1.5", className)}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge variant={invalid ? "neutral" : "brand"} className="shrink-0" title={block.intent}>
            <span data-block-pill="">{kind}</span>
          </Badge>
          {swapped && !invalid && (
            <span className="truncate text-caption text-secondary" data-swap-label="">→ {swapped}</span>
          )}
          {invalid && <StatusPill tone="danger" icon="glyph" title={block.error || undefined}>Invalid · not published</StatusPill>}
          {!invalid && !kept && <StatusPill tone="neutral" icon="dot">Removed</StatusPill>}
        </div>
        {!invalid && (
          <div className="flex shrink-0 items-center gap-0.5 rounded-ctl border border-border bg-surface p-[3px] shadow-card" role="group" aria-label={`Actions for ${block.title}`}>
            <button
              type="button"
              data-action="keep"
              aria-pressed={kept}
              disabled={disabled}
              className={cn(ACTION, kept ? "bg-tint text-brand-ink" : "text-secondary hover:bg-subtle hover:text-text")}
              onClick={onKeep}
              title={kept ? "Kept - this block will be published" : "Restore this block"}
              aria-label={kept ? `Keep ${block.title} (kept)` : `Restore ${block.title}`}
            >
              {kept ? "Keep" : "Restore"} <CheckIcon size={11} strokeWidth={2.8} />
            </button>
            {canSwap && block.type !== "text" ? (
              <Popover
                align="end"
                width={260}
                haspopup="menu"
                role="menu"
                ariaLabel={`Swap ${block.title}`}
                disabled={disabled || !kept}
                trigger={(api) => (
                  <button type="button" data-action="swap" data-popover-trigger="" disabled={disabled || !kept} className={cn(ACTION, "text-text hover:bg-subtle")} {...api.props}>
                    Swap <ChevronDownIcon size={11} />
                  </button>
                )}
              >
                {({ close }) => (
                  <div className="flex flex-col gap-2 p-3">
                    <div className="text-caption font-medium uppercase tracking-caps text-muted">Show it as</div>
                    <div className="flex flex-wrap gap-1" data-swap-options="">
                      {SWAP_OPTIONS.filter((o) => !(o.payload.type === block.type && (o.payload.chart_type || null) === currentChart)).map((o) => {
                        const active = swapped === o.label;
                        return (
                          <button
                            key={o.label}
                            type="button"
                            role="menuitemradio"
                            aria-checked={active}
                            className={cn(
                              "ui-focus rounded-full border px-2 py-[2px] text-caption",
                              active ? "border-tint-border bg-tint text-brand-ink" : "border-border bg-surface text-secondary hover:border-border-strong hover:bg-subtle hover:text-text"
                            )}
                            onClick={() => { onSwap(active ? null : o.payload); close(); }}
                          >
                            {o.label}
                          </button>
                        );
                      })}
                    </div>
                    {swapped && (
                      <button type="button" className="ui-focus w-fit rounded text-caption font-medium text-brand-ink hover:underline" onClick={() => { onSwap(null); close(); }}>
                        Back to the proposed {PROPOSAL_TYPE_LABEL[block.type] || block.type}
                      </button>
                    )}
                    <div className="text-caption text-faint">Same query, another shape - applied right after publish.</div>
                  </div>
                )}
              </Popover>
            ) : block.type !== "text" ? (
              <button type="button" data-action="swap" disabled className={cn(ACTION, "text-secondary")} title="Swap needs a warehouse source - a file block is computed once at publish">
                Swap <ChevronDownIcon size={11} />
              </button>
            ) : null}
            <button
              type="button"
              data-action="remove"
              disabled={disabled || !kept}
              className={cn(ACTION, "text-danger hover:bg-danger-fill")}
              onClick={onRemove}
              title="Remove this block from the dashboard"
            >
              Remove <CloseIcon size={11} strokeWidth={2.4} />
            </button>
          </div>
        )}
      </div>

      <div className={cn("min-h-0 min-w-0 flex-1 transition-opacity", !invalid && !kept && "opacity-45 grayscale")} aria-disabled={!invalid && !kept ? true : undefined}>
        {children}
      </div>

      {(why || block.sql) && (
        <div className="flex min-w-0 items-baseline justify-between gap-3 px-1 text-caption text-muted">
          {why && <span className="min-w-0 truncate" data-block-why="" title={why}>{why}</span>}
          {block.sql && onShowSql && (
            <button type="button" data-action="show-sql" className="ui-focus inline-flex shrink-0 items-center gap-1 rounded font-medium text-brand-ink hover:underline" onClick={onShowSql}>
              <SqlIcon size={12} /> Show SQL
            </button>
          )}
        </div>
      )}
    </div>
  );
}

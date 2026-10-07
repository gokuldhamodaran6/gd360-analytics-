import type { ReactNode } from "react";
import { cn } from "./cn";
import { DatabaseIcon, FileIcon } from "./Icons";

// "Computed in BigQuery · 119,386 rows · 0.8 s" - the footer line every
// chart card, table and KPI strip carries, so the person always knows
// where a number ran and over how many rows. Files (CSV/Excel uploads)
// read "Computed in GD360 · N rows" with a file glyph instead of the
// database. `cached` swaps the verb for "Cached from".

export type ComputedInProps = {
  // "BigQuery" | "Snowflake" | "Postgres" | "GD360" (files). A provider
  // id like "bigquery" / "file" / "csv" is normalised to its display name.
  provider?: string;
  rows?: number | null;
  durationMs?: number | null;
  cached?: boolean;
  // "exact" | "sample of 20" - rendered after the row count.
  precision?: ReactNode;
  // Right-hand slot ("Jan → Dec · peak Aug 12%").
  trailing?: ReactNode;
  approximate?: boolean;
  className?: string;
};

const PROVIDER_NAMES: Record<string, string> = {
  bigquery: "BigQuery",
  snowflake: "Snowflake",
  postgres: "Postgres",
  postgresql: "Postgres",
  redshift: "Redshift",
  mysql: "MySQL",
  file: "GD360",
  files: "GD360",
  csv: "GD360",
  excel: "GD360",
  xlsx: "GD360",
  upload: "GD360",
  gd360: "GD360",
  duckdb: "GD360",
};

const FILE_RE = /^(file|files|csv|excel|xlsx|upload|gd360|duckdb)$/i;

export function providerDisplayName(provider: string | undefined | null): string {
  if (!provider) return "GD360";
  const key = provider.trim().toLowerCase();
  return PROVIDER_NAMES[key] || provider;
}

export function isFileProvider(provider: string | undefined | null): boolean {
  if (!provider) return true;
  return FILE_RE.test(provider.trim()) || /excel file|csv file/i.test(provider);
}

export function formatDuration(ms: number): string {
  if (ms < 50) return "<0.1 s";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m} min ${s} s` : `${m} min`;
}

export function ComputedIn({ provider, rows, durationMs, cached = false, precision, trailing, approximate = false, className }: ComputedInProps) {
  const file = isFileProvider(provider);
  const Icon = file ? FileIcon : DatabaseIcon;
  const name = providerDisplayName(provider);
  return (
    <div data-computed-in="" className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 text-[11.5px] text-muted tabular-nums", className)}>
      <span className="inline-flex items-center gap-1.5">
        <Icon size={13} className="shrink-0" />
        <span>
          {cached ? "Cached from" : "Computed in"} {name}
          {typeof rows === "number" && <> · {approximate ? "~" : ""}{rows.toLocaleString()} rows</>}
          {precision && <> · {precision}</>}
          {typeof durationMs === "number" && <> · {formatDuration(durationMs)}</>}
        </span>
      </span>
      {trailing && <span>{trailing}</span>}
    </div>
  );
}

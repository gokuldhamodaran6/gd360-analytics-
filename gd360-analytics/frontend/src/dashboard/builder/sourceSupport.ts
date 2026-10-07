import type { DataSourceSummary } from "../../api/client";
import { getTableEntries } from "../../components/DataSourceForm";
import { providerDisplayName } from "../../ui";

// 2026-10-07 (dashboard from a prompt): what POST /dashboard-builder/propose
// can do with a data source, mirrored from the backend so the composer can
// say it BEFORE the person writes a goal. The router has no explicit kind
// guard - _build_proposal branches on dashboard_engine.is_warehouse_native
// (services/warehouse_exec.SQL_WAREHOUSE_KINDS) and otherwise derives a
// file schema through _file_schema / load_dataframe, which covers every
// loadable kind (csv, excel, api, google_sheets, microsoft_excel, mongodb)
// with the file-source recipe limits (_spec_to_recipe: one plain measure,
// at most one group-by, no filters). A streaming source has no loadable
// table until events arrive, so it is routed to the blank canvas instead.

export const WAREHOUSE_KINDS = ["bigquery", "snowflake", "postgres", "mysql", "sqlserver", "supabase"] as const;
export const FILE_LIKE_KINDS = ["csv", "excel", "api", "google_sheets", "microsoft_excel", "mongodb"] as const;

export type SourceSupport =
  | { level: "warehouse"; note: string }
  | { level: "file"; note: string }
  | { level: "unsupported"; reason: string };

export function proposalSupport(kind: string | null | undefined): SourceSupport {
  const k = (kind || "").toLowerCase();
  if ((WAREHOUSE_KINDS as readonly string[]).includes(k)) {
    return { level: "warehouse", note: "Every block is a query checked in the warehouse before you see it; numbers compute on publish." };
  }
  if ((FILE_LIKE_KINDS as readonly string[]).includes(k)) {
    return { level: "file", note: "Computed in GD360 on publish. Blocks stay simple here: one measure and at most one group-by each." };
  }
  if (k === "streaming") {
    return { level: "unsupported", reason: "A streaming source has no table to propose from until events have arrived. Start from a blank canvas in its project instead." };
  }
  return { level: "unsupported", reason: "GD360 can't propose a dashboard from this kind of source yet. Start from a blank canvas in its project instead." };
}

// The source's kind as a person reads it ("BigQuery", "CSV file") - the
// kit's providerDisplayName maps every file kind to "GD360" (where it
// computes), which is the wrong word next to a source's name.
const KIND_LABELS: Record<string, string> = {
  csv: "CSV file", excel: "Excel file", google_sheets: "Google Sheets", microsoft_excel: "Excel (OneDrive)", api: "API", mongodb: "MongoDB",
  streaming: "Streaming", sqlserver: "SQL Server", supabase: "Supabase",
};
export function kindLabel(kind: string | null | undefined): string {
  const k = (kind || "").toLowerCase();
  return KIND_LABELS[k] || providerDisplayName(kind);
}

export function schemaSummary(ds: DataSourceSummary | null | undefined): { tables: number; columns: number } {
  if (!ds) return { tables: 0, columns: 0 };
  const entries = getTableEntries(ds.kind, ds.schema_cache, ds.name);
  return { tables: entries.length, columns: entries.reduce((n, t) => n + (t.columns?.length || 0), 0) };
}

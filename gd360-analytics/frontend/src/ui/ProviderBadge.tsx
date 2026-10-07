import type { ReactNode } from "react";
import { Badge } from "./Badge";
import { isFileProvider, providerDisplayName } from "./ComputedIn";
import { DatabaseIcon, FileIcon, TableIcon } from "./Icons";

// "BigQuery" / "Snowflake" / "Excel file" with a monochrome glyph, surface
// fill, 1 px border, radius 6 (System.dc.html "Provider" row: no vendor
// logos, ever). Takes a provider id ("bigquery", "snowflake", "postgres",
// "csv", "excel", "file") or a display name.

export type ProviderBadgeProps = {
  provider: string;
  // Override the label ("Hotel_data.xlsx").
  label?: ReactNode;
  // A sheet/table badge rather than a source badge.
  kind?: "source" | "table";
  className?: string;
  title?: string;
};

export function ProviderBadge({ provider, label, kind = "source", className, title }: ProviderBadgeProps) {
  const file = isFileProvider(provider);
  const Icon = kind === "table" ? TableIcon : file ? FileIcon : DatabaseIcon;
  const text = label ?? (file ? fileLabel(provider) : providerDisplayName(provider));
  return (
    <Badge variant="provider" icon={<Icon size={13} className="text-muted" />} className={className} title={title ?? (typeof text === "string" ? text : undefined)}>
      {text}
    </Badge>
  );
}

function fileLabel(provider: string): string {
  const p = provider.trim().toLowerCase();
  if (/xlsx|excel/.test(p)) return "Excel file";
  if (/csv/.test(p)) return "CSV file";
  if (/file|upload/.test(p)) return "File";
  return providerDisplayName(provider);
}

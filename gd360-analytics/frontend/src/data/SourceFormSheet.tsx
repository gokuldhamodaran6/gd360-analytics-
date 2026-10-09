// 2026-10-09 (round 15): the right-hand sheet a catalog tile opens for a
// database, warehouse, file, Google Sheet, REST API or webhook - it hosts the
// existing DataSourceForm, opened straight on the right form.
import BrandTile from "../components/BrandTile";
import DataSourceForm, { CreatedDataSource, DataSourceFormStart } from "../components/DataSourceForm";
import type { CatalogConnector } from "../api/spaces";
import { CloseButton, Overlay } from "./shared";

const SUBTITLE: Record<string, string> = {
  db: "Queried where it lives · read-only",
  warehouse: "Computed in place · read-only",
  file: "Upload once · profiled on upload",
  connect: "Sign in with Google · stays in sync",
  api: "Any JSON endpoint · GET only",
  streaming: "A private URL other systems post events to",
};

const FALLBACK: Record<string, { label: string; slug: string }> = {
  file: { label: "a file", slug: "files" },
  api: { label: "a REST or GraphQL API", slug: "api" },
  streaming: { label: "a webhook", slug: "webhooks" },
  connect: { label: "Google Sheets", slug: "google_sheets" },
};

export default function SourceFormSheet({
  start,
  connector,
  onClose,
  onCreated,
  onConnected,
}: {
  start: DataSourceFormStart;
  connector?: CatalogConnector | null;
  onClose: () => void;
  onCreated: (ds: { id: string; name: string; kind: string; created_at: string }) => void;
  onConnected: (ds: CreatedDataSource) => void;
}) {
  const fb = FALLBACK[start.mode];
  const label = connector?.label || fb?.label || "a source";
  return (
    // z-[45]: below DataSourceForm's own popouts (z-50), which open on top of
    // this sheet for a database or warehouse.
    <Overlay label={`Connect ${label}`} onClose={onClose} side="right" maxWidth="max-w-[560px]" z="z-[45]">
      <div className="p-5 sm:p-7 flex flex-col gap-6">
        <div className="flex justify-between items-center gap-3">
          <div className="flex items-center gap-3.5 min-w-0">
            {connector ? (
              <BrandTile slug={connector.slug} monogram={connector.monogram} color={connector.color} ink={connector.ink} size={48} />
            ) : (
              <BrandTile kind={start.kind || fb?.slug || start.mode} name={label} size={48} />
            )}
            <span className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[19px] font-semibold text-text truncate">Connect {label}</span>
              <span className="text-[12.5px] text-muted">{SUBTITLE[start.mode]}</span>
            </span>
          </div>
          <CloseButton onClick={onClose} />
        </div>
        <DataSourceForm start={start} hideModeTabs onCreated={onCreated} onConnected={onConnected} />
      </div>
    </Overlay>
  );
}

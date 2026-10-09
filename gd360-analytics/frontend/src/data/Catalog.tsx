// 2026-10-09 (round 15): the connector catalog - every source GD360 can
// connect (GET /apps/catalog), searchable and filterable, grouped by
// category. A tile opens the right flow: a synced app's four-step sheet, the
// database / warehouse / file / Sheets / API / webhook form, or - for one
// that isn't built yet - a short note offering another way in.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import BrandTile from "../components/BrandTile";
import type { CreatedDataSource, DataSourceFormStart } from "../components/DataSourceForm";
import { AppMeta, catalogApi, CatalogCategory, CatalogConnector, ConnectedApp, Space } from "../api/spaces";
import ConnectAppSheet from "./ConnectAppSheet";
import SourceFormSheet from "./SourceFormSheet";
import { chipClass, CloseButton, errorText, ErrorNote, Overlay, Skeleton } from "./shared";

type Filter = "All" | "Ready now" | "New" | "Connected";
const FILTERS: Filter[] = ["All", "Ready now", "New", "Connected"];

type Badge = "Connected" | "New" | "Live" | "Next";
function badgeOf(c: CatalogConnector): Badge {
  if (c.status === "connected") return "Connected";
  if (c.status === "next") return "Next";
  return c.is_new ? "New" : "Live";
}
const BADGE_CLASS: Record<Badge, string> = {
  Connected: "bg-good-fill text-good",
  Live: "bg-primary/10 text-brand-ink",
  New: "bg-[rgb(var(--auto-tell-fill))] text-[rgb(var(--auto-tell))]",
  Next: "bg-surface2 text-muted",
};

function formStart(flow: string): DataSourceFormStart | null {
  const [head, kind] = flow.split(":");
  if (head === "database") return { mode: "db", kind };
  if (head === "warehouse") return { mode: "warehouse", kind };
  if (flow === "file") return { mode: "file" };
  if (flow === "sheets") return { mode: "connect", kind: "google_sheets" };
  if (flow === "api") return { mode: "api" };
  if (flow === "streaming") return { mode: "streaming" };
  return null;
}

type Open =
  | { type: "app"; meta: AppMeta; tile: CatalogConnector | null; pendingId?: string | null; error?: string | null }
  | { type: "form"; start: DataSourceFormStart; connector: CatalogConnector | null }
  | { type: "request"; connector: CatalogConnector | null };

function SearchGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="absolute left-[15px] top-[15px] text-muted pointer-events-none">
      <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function Tile({ c, disabled, onOpen }: { c: CatalogConnector; disabled: boolean; onOpen: () => void }) {
  const badge = badgeOf(c);
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      aria-label={badge === "Next" ? `${c.label} — not available yet` : `Connect ${c.label}`}
      className={`ui-focus grid grid-cols-[40px_1fr] gap-3 items-start text-left p-3.5 rounded-[14px] border border-border bg-surface min-h-[92px] transition-colors hover:border-border-strong hover:bg-surface2/60 disabled:cursor-not-allowed disabled:hover:bg-surface disabled:hover:border-border ${
        badge === "Next" ? "opacity-80" : ""
      }`}
    >
      <BrandTile slug={c.slug} monogram={c.monogram} color={c.color} ink={c.ink} size={40} />
      <span className="flex flex-col gap-[5px] min-w-0">
        <span className="flex justify-between gap-2 items-start">
          <span className="text-[14.5px] font-semibold text-text leading-snug min-w-0 break-words">{c.label}</span>
          <span className={`inline-flex items-center h-5 px-[7px] rounded-[6px] font-mono text-[10.5px] tracking-[0.02em] uppercase shrink-0 mt-px ${BADGE_CLASS[badge]}`}>
            {badge}
          </span>
        </span>
        <span className="text-[12.5px] text-muted leading-[1.45]">{c.summary}</span>
      </span>
    </button>
  );
}

function MissingCard({ onRequest, className = "" }: { onRequest: () => void; className?: string }) {
  return (
    <div className={`p-3.5 rounded-[14px] border border-dashed border-border-strong flex flex-col gap-2 ${className}`}>
      <span className="text-[13.5px] font-semibold text-text">Missing one?</span>
      <span className="text-[12.5px] text-secondary leading-relaxed">
        Any REST or GraphQL API, a webhook, or a file drop works today. Ask for a native connector and it joins the roadmap.
      </span>
      <button type="button" className={chipClass(false, "self-start")} onClick={onRequest}>
        Request a connector
      </button>
    </div>
  );
}

function RequestDialog({
  connector, viewer, onClose, onPick,
}: { connector: CatalogConnector | null; viewer: boolean; onClose: () => void; onPick: (start: DataSourceFormStart) => void }) {
  const title = connector ? `${connector.label} isn’t available yet` : "Request a connector";
  const options: { start: DataSourceFormStart; title: string; text: string }[] = [
    { start: { mode: "api" }, title: "REST or GraphQL API", text: "Point GD360 at any JSON endpoint; it reads it on a schedule." },
    { start: { mode: "streaming" }, title: "Webhook", text: "Get a private URL that other systems post events to." },
    { start: { mode: "file" }, title: "Upload a file", text: "An export as CSV or Excel, profiled the moment it lands." },
  ];
  return (
    <Overlay label={title} onClose={onClose} maxWidth="max-w-[480px]">
      <div className="p-6 sm:p-7 flex flex-col gap-5">
        <div className="flex justify-between items-start gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {connector && <BrandTile slug={connector.slug} monogram={connector.monogram} color={connector.color} ink={connector.ink} size={40} />}
            <h2 className="m-0 text-[19px] font-semibold text-text">{title}</h2>
          </div>
          <CloseButton onClick={onClose} />
        </div>
        <p className="m-0 text-[14px] text-secondary leading-relaxed">
          {connector
            ? `A native ${connector.label} connector is on the roadmap. Until then, most teams bring the same data in one of these ways:`
            : "Tell whoever runs GD360 for your team which source you need — native connectors are added in the order teams ask for them. Until then, any of these works today:"}
        </p>
        <div className="flex flex-col gap-2">
          {options.map((o) => (
            <button
              key={o.title}
              type="button"
              disabled={viewer}
              onClick={() => onPick(o.start)}
              className="ui-focus text-left flex flex-col gap-0.5 px-4 py-3 rounded-[12px] border border-border bg-surface hover:border-border-strong disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className="text-[14px] font-medium text-text">{o.title}</span>
              <span className="text-[12.5px] text-muted">{o.text}</span>
            </button>
          ))}
        </div>
        {viewer && <p className="m-0 text-[12.5px] text-muted">You have view-only access to this workspace, so you can’t connect sources here.</p>}
        <button type="button" className="btn-secondary h-10 text-[14px] self-end" onClick={onClose}>
          Close
        </button>
      </div>
    </Overlay>
  );
}

export default function Catalog({
  workspaceId,
  spaces,
  isViewer,
  onSourcesChanged,
  onCreated,
}: {
  workspaceId?: string | null;
  spaces: Space[] | null;
  isViewer: boolean;
  /** A source was connected - reload sources and Spaces. */
  onSourcesChanged: () => void;
  /** The person chose "Try it out" on a just-connected source. */
  onCreated: (ds: { id: string; name: string; kind: string; created_at: string }) => void;
}) {
  const [params, setParams] = useSearchParams();
  const [categories, setCategories] = useState<CatalogCategory[] | null>(null);
  const [connectors, setConnectors] = useState<CatalogConnector[] | null>(null);
  const [apps, setApps] = useState<AppMeta[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("All");
  const [cat, setCat] = useState<string>("all");
  const [open, setOpen] = useState<Open | null>(null);

  const loadCatalog = useCallback(() => {
    setLoadError("");
    catalogApi
      .catalog()
      .then((d) => {
        setCategories(d.categories);
        setConnectors(d.connectors);
      })
      .catch((e) => setLoadError(errorText(e, "Couldn't load the catalog. Please try again.")));
  }, []);

  useEffect(() => {
    loadCatalog();
    catalogApi
      .apps()
      .then(setApps)
      .catch(() => setApps([]));
  }, [loadCatalog]);

  // Back from an app's own sign-in page: /data?tab=catalog&connect=<kind>
  // &pending=<id> (or &error=<message>). Open that app's sheet at step 2,
  // then tidy the address bar.
  const connectKind = params.get("connect");
  const pending = params.get("pending");
  const returnError = params.get("error");
  useEffect(() => {
    if (!connectKind && !returnError) return;
    if (connectKind && apps === null) return; // wait for the app list
    const meta = connectKind ? (apps || []).find((a) => a.kind === connectKind) : undefined;
    if (meta) {
      const tile = (connectors || []).find((c) => c.flow === `app:${meta.kind}`) || null;
      setOpen({ type: "app", meta, tile, pendingId: returnError ? null : pending, error: returnError });
    } else if (returnError) {
      setNotice(returnError);
    } else if (connectKind) {
      setNotice("That sign-in came back for an app GD360 doesn't recognise. Please start again from its tile.");
    }
    const next = new URLSearchParams(params);
    next.delete("connect");
    next.delete("pending");
    next.delete("error");
    next.set("tab", "catalog");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectKind, pending, returnError, apps]);

  const openTile = (c: CatalogConnector) => {
    setNotice("");
    if (c.flow === "request" || c.status === "next") {
      setOpen({ type: "request", connector: c });
      return;
    }
    if (isViewer) return;
    if (c.flow.startsWith("app:")) {
      const kind = c.flow.slice(4);
      const meta = (apps || []).find((a) => a.kind === kind);
      if (!meta) {
        setNotice(apps === null ? "Still loading the app details — try again in a moment." : `Couldn't load the details for ${c.label}. Please refresh the page and try again.`);
        return;
      }
      setOpen({ type: "app", meta, tile: c });
      return;
    }
    const start = formStart(c.flow);
    if (start) setOpen({ type: "form", start, connector: c });
    else setOpen({ type: "request", connector: c });
  };

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of connectors || []) m.set(c.category, (m.get(c.category) || 0) + 1);
    return m;
  }, [connectors]);

  const total = connectors?.length ?? 0;
  const needle = q.trim().toLowerCase();

  const sections = useMemo(() => {
    if (!categories || !connectors) return [];
    return categories
      .filter((c) => cat === "all" || cat === c.id)
      .map((c) => ({
        ...c,
        items: connectors
          .filter((it) => it.category === c.id)
          .filter((it) => !needle || `${it.label} ${it.summary} ${c.label}`.toLowerCase().includes(needle))
          .filter((it) => {
            const b = badgeOf(it);
            if (filter === "All") return true;
            if (filter === "Connected") return b === "Connected";
            if (filter === "Ready now") return it.status === "live" || it.status === "connected";
            return it.is_new;
          }),
      }))
      .filter((c) => c.items.length > 0);
  }, [categories, connectors, cat, needle, filter]);

  const afterConnect = () => {
    onSourcesChanged();
    loadCatalog();
  };

  const loading = !connectors && !loadError;

  return (
    <div className="flex flex-col gap-6">
      {isViewer && (
        <div role="status" className="rounded-card border border-border bg-surface px-4 py-3 text-ui text-secondary">
          You have view-only access to this workspace, so you can browse the catalog but not connect sources. Ask the workspace owner to add one.
        </div>
      )}
      {notice && (
        <ErrorNote className="flex items-start justify-between gap-3">
          <span>{notice}</span>
          <button type="button" className="ui-focus text-muted hover:text-text shrink-0" aria-label="Dismiss" onClick={() => setNotice("")}>
            Dismiss
          </button>
        </ErrorNote>
      )}

      <div className="flex gap-3 items-center flex-wrap">
        <div className="relative flex-[1_1_320px] min-w-0 max-w-[560px]">
          <SearchGlyph />
          <label htmlFor="catalog-search" className="sr-only">Search sources</label>
          <input
            id="catalog-search"
            type="search"
            className="w-full h-[46px] pl-[42px] pr-4 rounded-[12px] border border-border bg-surface text-text text-[15px] outline-none focus:border-primary/60 placeholder:text-muted"
            placeholder={`Search ${total || 71} sources — try “instagram”, “stripe”, “payroll”`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="flex gap-2 flex-wrap" role="group" aria-label="Filter">
          {FILTERS.map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={chipClass(filter === f)}>
              {f}
            </button>
          ))}
        </div>
      </div>

      {loadError && (
        <ErrorNote className="flex items-center justify-between gap-3 flex-wrap">
          <span>{loadError}</span>
          <button type="button" className="btn-secondary text-sm" onClick={loadCatalog}>
            Try again
          </button>
        </ErrorNote>
      )}

      <div className="flex flex-col lg:flex-row gap-5 lg:gap-7 items-stretch lg:items-start">
        <nav aria-label="Categories" className="lg:w-[236px] shrink-0 min-w-0">
          {/* phones: a scrolling row of chips; wider: the list */}
          <div className="lg:hidden flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            {loading && <Skeleton className="h-8 w-full rounded-full" />}
            {!loading && [{ id: "all", label: "All sources", n: total }, ...(categories || []).map((c) => ({ id: c.id, label: c.label, n: counts.get(c.id) || 0 }))].map((c) => (
              <button key={c.id} type="button" aria-pressed={cat === c.id} onClick={() => setCat(c.id)} className={chipClass(cat === c.id, "shrink-0 whitespace-nowrap")}>
                {c.label}
                <span className="font-mono text-[11px] text-muted">{c.n}</span>
              </button>
            ))}
          </div>
          <div className="hidden lg:flex flex-col gap-0.5">
            {loading &&
              Array.from({ length: 13 }).map((_, i) => <Skeleton key={i} className="h-9" />)}
            {!loading &&
              [{ id: "all", label: "All sources", n: total }, ...(categories || []).map((c) => ({ id: c.id, label: c.label, n: counts.get(c.id) || 0 }))].map((c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={cat === c.id}
                  onClick={() => setCat(c.id)}
                  className={`ui-focus flex justify-between items-center gap-2.5 w-full h-9 px-3 rounded-[9px] text-left text-[13.5px] transition-colors ${
                    cat === c.id ? "bg-surface2 text-text" : "text-secondary hover:bg-surface hover:text-text"
                  }`}
                >
                  <span className="truncate">{c.label}</span>
                  <span className="font-mono text-[11.5px] text-muted">{c.n}</span>
                </button>
              ))}
            <MissingCard className="mt-[18px]" onRequest={() => setOpen({ type: "request", connector: null })} />
          </div>
        </nav>

        <div className="flex-1 min-w-0 flex flex-col gap-[30px]">
          {loading && (
            <section className="flex flex-col gap-3.5" aria-busy="true" aria-label="Loading the catalog">
              <Skeleton className="h-5 w-48" />
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(232px, 100%), 1fr))" }}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-[92px] rounded-[14px]" />
                ))}
              </div>
            </section>
          )}
          {sections.map((sec) => (
            <section key={sec.id} className="flex flex-col gap-3.5" aria-labelledby={`cat-${sec.id}`}>
              <div className="flex justify-between items-baseline gap-3 flex-wrap">
                <h2 id={`cat-${sec.id}`} className="m-0 text-[17px] font-semibold tracking-[-0.01em] text-text">
                  {sec.label}
                </h2>
                <span className="text-[12.5px] text-muted">{sec.description}</span>
              </div>
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(232px, 100%), 1fr))" }}>
                {sec.items.map((c) => (
                  <Tile key={c.id} c={c} disabled={isViewer && c.status !== "next" && c.flow !== "request"} onOpen={() => openTile(c)} />
                ))}
              </div>
            </section>
          ))}
          {!loading && connectors && sections.length === 0 && (
            <div className="p-8 sm:p-10 rounded-[16px] border border-dashed border-border-strong text-center text-secondary text-[14px]">
              {needle ? `No source matches “${q.trim()}”.` : "Nothing matches these filters."} Connect it through a REST API, a webhook or a file — or{" "}
              <button type="button" className="ui-focus underline underline-offset-2 hover:text-text" onClick={() => setOpen({ type: "request", connector: null })}>
                request it
              </button>
              .
            </div>
          )}
          <MissingCard className="lg:hidden" onRequest={() => setOpen({ type: "request", connector: null })} />
        </div>
      </div>

      {open?.type === "app" && (
        <ConnectAppSheet
          key={`${open.meta.kind}-${open.pendingId || ""}`}
          meta={open.meta}
          tile={open.tile}
          workspaceId={workspaceId}
          spaces={spaces}
          pendingId={open.pendingId}
          initialError={open.error}
          onClose={() => setOpen(null)}
          onConnected={(_app: ConnectedApp) => afterConnect()}
        />
      )}
      {open?.type === "form" && (
        <SourceFormSheet
          start={open.start}
          connector={open.connector}
          onClose={() => setOpen(null)}
          onConnected={(_ds: CreatedDataSource) => afterConnect()}
          onCreated={(ds) => {
            setOpen(null);
            onCreated(ds);
          }}
        />
      )}
      {open?.type === "request" && (
        <RequestDialog
          connector={open.connector}
          viewer={isViewer}
          onClose={() => setOpen(null)}
          onPick={(start) => {
            const conn = (connectors || []).find((c) => c.flow === (start.mode === "file" ? "file" : start.mode)) || null;
            setOpen({ type: "form", start, connector: conn });
          }}
        />
      )}
    </div>
  );
}

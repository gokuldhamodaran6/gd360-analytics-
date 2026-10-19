import { useCallback, useEffect, useState, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { datasourceApi, DataSourceSummary } from "../api/client";
import { Space, spacesApi } from "../api/spaces";
import TopNav from "../components/TopNav";
import AppSidebar from "../components/AppSidebar";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import Catalog from "../data/Catalog";
import SourcesPanel from "../data/SourcesPanel";
import SpacesPanel from "../data/SpacesPanel";
import SpaceEditor from "../data/SpaceEditor";
import { errorText, ErrorNote, Skeleton } from "../data/shared";
import { SyncReportSheet } from "../data/SyncReport";
import { SourcePanel, SourcesKpis, SourcesTable, useDataOverview } from "../data/SourcesOverview";
import { ListPage, PageHead, Tabs } from "../studio/Page";

// 2026-09-23 (sidebar redesign round): the dedicated home for browsing every
// connected data source. Rounds two and three (Gokul's feedback) made "see
// what's connected" and "connect something new" two exclusive views.
//
// 2026-10-09 (round 15): rebuilt as the Data page with three tabs, driven by
// ?tab= - Sources (the browsing above, now with each source's Spaces and
// bulk "add to Space"), Spaces (the groups of sources each team works from)
// and Catalog (every connector GD360 offers, each tile opening the right
// connect flow). With no ?tab=, a workspace with no sources opens on the
// Catalog and any other on Sources. The Catalog also handles the return
// from an app's own sign-in page (?connect=<kind>&pending=<id> or &error=).
//
// 2026-10-10: connecting something new is never hidden. "Connect data" sits
// in the header on every tab, the Connected tab opens with an "Add data"
// strip of the sources most teams start with, and the third tab is named
// for what it does ("Add data"). After a source connects, "Start with this
// data" lands on Home with it attached, where the person chooses Instant
// Answers or Guided Analysis.

type Tab = "sources" | "spaces" | "catalog";
const TABS: Tab[] = ["sources", "spaces", "catalog"];

const HEAD: Record<Tab, { title: string; text: string }> = {
  sources: {
    title: "Sources",
    text: "Read-only and encrypted. Data stays where it is unless a pipeline copies it.",
  },
  spaces: {
    title: "Spaces",
    text: "A Space is the set of sources one team works from. Ask a Space, give it dashboards and automations, and decide who can see it — sales stays with sales, payroll stays with HR.",
  },
  catalog: {
    title: "Add data",
    text: "Databases, warehouses, files and every app your teams run on — social pages, ads, stores, CRM, finance and HR. Read-only, encrypted, and organised into Spaces the moment it lands.",
  },
};

function PlusGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export default function DataSources() {
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [params, setParams] = useSearchParams();
  const [sources, setSources] = useState<DataSourceSummary[] | null>(null);
  const [error, setError] = useState("");
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [spacesError, setSpacesError] = useState("");
  const [editor, setEditor] = useState<Space | "new" | null>(null);

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const isViewerHere = workspace?.role === "viewer";

  const loadSources = useCallback(() => {
    if (!activeWorkspaceId) return;
    setError("");
    datasourceApi
      .list(activeWorkspaceId)
      .then(setSources)
      .catch((e) => {
        setError(errorText(e, "Couldn't load your data sources. Please try refreshing."));
        setSources((prev) => prev ?? []);
      });
  }, [activeWorkspaceId]);

  const loadSpaces = useCallback(() => {
    if (!activeWorkspaceId) return;
    setSpacesError("");
    spacesApi
      .list(activeWorkspaceId)
      .then(setSpaces)
      .catch((e) => {
        setSpacesError(errorText(e, "Couldn't load your Spaces. Please try again."));
        setSpaces((prev) => prev ?? []);
      });
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    setSources(null);
    setSpaces(null);
    loadSources();
    loadSpaces();
  }, [activeWorkspaceId, loadSources, loadSpaces]);

  const tabParam = params.get("tab");
  const tab: Tab | null = TABS.includes(tabParam as Tab)
    ? (tabParam as Tab)
    : sources === null
    ? null
    : sources.length
    ? "sources"
    : "catalog";

  const setTab = (t: Tab) => {
    const next = new URLSearchParams();
    next.set("tab", t);
    setParams(next);
  };

  const upsertSpace = (s: Space) =>
    setSpaces((prev) => {
      const list = prev || [];
      return list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s];
    });

  // "Start with this data": Home, with the new source attached, where the
  // person picks Instant Answers or Guided Analysis.
  const startWith = (ds: { id: string }) => navigate(`/?source=${encodeURIComponent(ds.id)}&connected=1`);

  const afterConnect = () => {
    loadSources();
    loadSpaces();
  };

  // "Settings" on a Space page links here with ?tab=spaces&edit=<id>.
  useEffect(() => {
    const id = params.get("edit");
    if (!id || !spaces) return;
    const found = spaces.find((x) => x.id === id);
    if (found && found.can_edit) setEditor(found);
    const next = new URLSearchParams(params);
    next.delete("edit");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaces, params]);

  // The sidebar lists Spaces: tell it when they change here.
  const firstSpaces = useRef(true);
  useEffect(() => {
    if (spaces === null) return;
    if (firstSpaces.current) {
      firstSpaces.current = false;
      return;
    }
    window.dispatchEvent(new Event("gd360:spaces-changed"));
  }, [spaces]);

  const head = HEAD[tab || "sources"];

  const view = params.get("view") === "manage" ? "manage" : "table";
  const [sel, setSel] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const { data: overview, err: ovErr } = useDataOverview(tab === "sources" ? activeWorkspaceId : null, bump);
  const selRow = overview?.sources.find((x) => x.id === sel) || null;
  const setView = (v: "table" | "manage") => { const n = new URLSearchParams(params); if (v === "manage") n.set("view", "manage"); else n.delete("view"); setParams(n, { replace: true }); };
  void TopNav; void AppSidebar; void switchWorkspace; void handleWorkspaceCreated; void workspaces;
  return (
    <>
      <ListPage data="data" crumbs={[{ label: "Data", to: "/data" }, { label: tab === "spaces" ? "Spaces" : tab === "catalog" ? "Add data" : "Sources" }]}
        side={tab === "sources" && view === "table" && selRow ? <SourcePanel r={selRow} onClose={() => setSel(null)} onChanged={() => setBump((b) => b + 1)} onManage={() => setView("manage")} /> : undefined}>
        <SyncReportSheet
          sourceId={params.get("report")}
          onClose={() => { const next = new URLSearchParams(params); next.delete("report"); setParams(next, { replace: true }); }}
        />
        <PageHead title={head.title}
          sub={tab === "sources" && overview ? `${overview.kpis.total} connection${overview.kpis.total === 1 ? "" : "s"}, ${head.text.charAt(0).toLowerCase()}${head.text.slice(1)}` : head.text}
          actions={<>
            {tab === "sources" && <button type="button" className="sd-pill" onClick={() => setView(view === "manage" ? "table" : "manage")} data-data-view="">{view === "manage" ? "Table view" : "Manage sources"}</button>}
            {tab !== "catalog" && tab !== "spaces" && !isViewerHere && (
              <button type="button" className="sd-btnp" onClick={() => setTab("catalog")} data-connect-data=""><PlusGlyph />Connect a source</button>
            )}
            {tab === "spaces" && !isViewerHere && (
              <button type="button" className="sd-btnp" onClick={() => setEditor("new")}><PlusGlyph />New space</button>
            )}
          </>} />
        {tab && <Tabs<Tab> tabs={[{ id: "sources", label: "Sources", n: sources?.length ?? null }, { id: "spaces", label: "Spaces", n: spaces?.length ?? null }, { id: "catalog", label: "Add data" }]} value={tab} onChange={setTab} />}
        {tab === "sources" && view === "table" && <SourcesKpis data={overview} />}
        {ovErr && tab === "sources" && <div className="sd-err">{ovErr}</div>}
          {error && (
            <ErrorNote className="flex items-center justify-between gap-3 flex-wrap">
              <span>{error}</span>
              <button type="button" className="btn-secondary text-sm" onClick={loadSources}>
                Try again
              </button>
            </ErrorNote>
          )}

          <div id="data-tabpanel" role="tabpanel" aria-labelledby={tab ? `data-tab-${tab}` : undefined}>
            {tab === null && (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4" aria-busy="true" aria-label="Loading">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-[150px] rounded-[14px]" />
                ))}
              </div>
            )}
            {tab === "sources" && view === "table" && <SourcesTable data={overview} selected={sel} onSelect={(id) => setSel(sel === id ? null : id)} />}
            {tab === "sources" && view === "manage" && !isViewerHere && (
              <div className="mb-6">
                <Catalog
                  variant="quick"
                  workspaceId={activeWorkspaceId}
                  spaces={spaces}
                  isViewer={isViewerHere}
                  onSourcesChanged={afterConnect}
                  onCreated={startWith}
                  onBrowseAll={() => setTab("catalog")}
                />
              </div>
            )}
            {tab === "sources" && view === "manage" && (
              <SourcesPanel
                sources={sources}
                setSources={setSources}
                spaces={spaces}
                isViewer={isViewerHere}
                onSpaceUpdated={upsertSpace}
                onConnectNew={() => setTab("catalog")}
              />
            )}
            {tab === "spaces" && (
              <SpacesPanel
                spaces={spaces}
                spacesError={spacesError}
                sources={sources}
                workspaceId={activeWorkspaceId}
                canManage={!isViewerHere}
                onRetry={loadSpaces}
                onNew={() => setEditor("new")}
                onEdit={(s) => setEditor(s)}
                onSpaceUpdated={upsertSpace}
              />
            )}
            {tab === "catalog" && (
              <Catalog
                workspaceId={activeWorkspaceId}
                spaces={spaces}
                isViewer={isViewerHere}
                onSourcesChanged={afterConnect}
                onCreated={startWith}
              />
            )}
          </div>
      </ListPage>

      {editor && (
        <SpaceEditor
          space={editor === "new" ? null : editor}
          sources={sources}
          workspaceId={activeWorkspaceId}
          isPersonalWorkspace={workspace?.is_personal}
          onClose={() => setEditor(null)}
          onSaved={(s) => {
            upsertSpace(s);
            setEditor(null);
          }}
          onDeleted={(id) => {
            setSpaces((prev) => (prev || []).filter((x) => x.id !== id));
            setEditor(null);
          }}
        />
      )}
    </>
  );
}

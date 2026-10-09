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

type Tab = "sources" | "spaces" | "catalog";
const TABS: Tab[] = ["sources", "spaces", "catalog"];

const HEAD: Record<Tab, { title: string; text: string }> = {
  sources: {
    title: "Your sources",
    text: "Every app, database, warehouse and file connected to this workspace — and the Spaces each one is in.",
  },
  spaces: {
    title: "Spaces",
    text: "A Space is the set of sources one team works from. Ask a Space, give it dashboards and automations, and decide who can see it — sales stays with sales, payroll stays with HR.",
  },
  catalog: {
    title: "Connect a source",
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

  return (
    <div className="flex">
      <AppSidebar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onWorkspaceSwitch={switchWorkspace}
        onWorkspaceCreated={handleWorkspaceCreated}
      />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />

        <main className="max-w-[1240px] mx-auto px-4 sm:px-8 lg:px-10 pt-8 pb-16 flex flex-col gap-6">
          <header className="flex justify-between items-end gap-5 flex-wrap">
            <div className="flex flex-col gap-2 min-w-0">
              <span className="font-mono text-[11px] text-muted tracking-[0.1em] uppercase">Data</span>
              {tab ? (
                <>
                  <h1 className="m-0 text-[28px] sm:text-[34px] tracking-[-0.03em] font-semibold text-text">{head.title}</h1>
                  <p className="m-0 text-[15px] text-secondary max-w-[660px]">{head.text}</p>
                </>
              ) : (
                <>
                  <Skeleton className="h-10 w-64" />
                  <Skeleton className="h-5 w-80 max-w-full" />
                </>
              )}
            </div>
            <div className="flex gap-2.5 items-center flex-wrap">
              <div role="tablist" aria-label="Data" className="flex gap-0.5 bg-surface border border-border rounded-[11px] p-[3px]">
                {TABS.map((t) => {
                  const on = tab === t;
                  const count = t === "sources" ? sources?.length : t === "spaces" ? spaces?.length : undefined;
                  return (
                    <button
                      key={t}
                      type="button"
                      role="tab"
                      id={`data-tab-${t}`}
                      aria-selected={on}
                      aria-controls="data-tabpanel"
                      onClick={() => setTab(t)}
                      className={`ui-focus h-[34px] px-3.5 rounded-[9px] text-[14px] inline-flex items-center gap-1.5 transition-colors ${
                        on ? "bg-surface2 text-text" : "text-secondary hover:text-text"
                      }`}
                    >
                      {t === "sources" ? "Sources" : t === "spaces" ? "Spaces" : "Catalog"}
                      {count !== undefined && <span className="font-mono text-[12px] text-muted">{count}</span>}
                    </button>
                  );
                })}
              </div>
              {tab === "spaces" && !isViewerHere && (
                <button type="button" className="btn-primary h-10 text-[14px] inline-flex items-center gap-2" onClick={() => setEditor("new")}>
                  <PlusGlyph />
                  New space
                </button>
              )}
            </div>
          </header>

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
            {tab === "sources" && (
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
                onCreated={(ds) => navigate(`/workspace/${ds.id}`)}
              />
            )}
          </div>
        </main>
      </div>

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
    </div>
  );
}

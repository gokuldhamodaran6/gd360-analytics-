import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  dashboardBuilderApi, type BlockLayoutItem, type BlockSpec, type DashboardBlock, type DashboardBlockType, type DashboardBuilderDetail, type DashboardBuilderPage,
} from "../../api/client";
import { providerDisplayName } from "../../ui";
import { isRunnable } from "../blockData";
import { orderCells, slimConfig, uniqueCellName } from "../canvas/cells";
import type { DashboardRun } from "../useDashboardRun";
import {
  changedItems, type GridItem, isGridBlock, kpiBand, kpiBlocksInOrder, kpiLayoutItems, minSizeOf, type MoveDir, moveItem, reconcileLayout, resizeItem, sameLayout, type SizeDir,
  toStoredItems, viewLayout,
} from "./layout";

// 2026-10-07 (dashboard edit mode): everything the editable dashboard does,
// in one hook the page owns and DashboardShell / KpiStrip / BlockGrid read.
//
// - Block changes (add, rename, duplicate, remove, config, swap, build with
//   AI, save a query) go through the existing block endpoints; each one
//   hands the page the updated dashboard and re-runs just that block.
// - The layout is ONE optimistic state per page, saved through the bulk
//   layout endpoint: debounced ~400 ms after the last drag / resize stop,
//   never two requests in flight (the newest layout waits for the one in
//   flight and then goes out), rolled back to the last server state with an
//   inline "Couldn't save - Retry" when it fails. Never a PATCH per block.
// - The save pill in the header reads `saveState`.

export type SaveState = "idle" | "saving" | "saved" | "error";

export type EditorSheet =
  | { kind: "ai"; blockId: string }
  | { kind: "query"; blockId: string }
  | { kind: "filters" }
  | null;

type LayoutIntent = { pageId: string; items: GridItem[] | null; kpiOrder: string[] | null };

export type DashboardEditor = {
  dash: DashboardBuilderDetail;
  page: DashboardBuilderPage | undefined;
  run: DashboardRun;
  warehouse: boolean;
  // "BigQuery", "Snowflake", ... (null on a file dashboard).
  provider: string | null;
  // File dashboards: the datasource's columns (a warehouse dashboard reads dash.tables).
  fileColumns: { name: string; dtype: string }[];
  saveState: SaveState;
  saveError: string | null;
  retrySave: () => void;
  // ---- layout ----
  gridLayout: GridItem[];
  commitLayout: (items: GridItem[]) => void;
  moveBlock: (blockId: string, dir: MoveDir) => void;
  resizeBlock: (blockId: string, dir: SizeDir) => void;
  flushLayout: () => void;
  // ---- KPI strip ----
  kpis: DashboardBlock[];
  moveKpi: (blockId: string, toIndex: number) => void;
  // ---- blocks ----
  addBlock: (type: DashboardBlockType) => Promise<void>;
  adding: boolean;
  renameBlock: (block: DashboardBlock, title: string) => Promise<void>;
  duplicateBlock: (block: DashboardBlock) => Promise<void>;
  updateConfig: (block: DashboardBlock, patch: Record<string, any>) => Promise<void>;
  swapBlock: (block: DashboardBlock, payload: { chart_type?: string; type?: DashboardBlockType }) => Promise<void>;
  // Opens the kit confirm; `confirmRemove` does it.
  requestRemove: (block: DashboardBlock) => void;
  removing: { block: DashboardBlock; busy: boolean; error: string | null } | null;
  confirmRemove: () => Promise<void>;
  cancelRemove: () => void;
  // Build / change with AI and save a query: these reject with the
  // backend's own `detail` so the sheet can show it verbatim.
  askAi: (block: DashboardBlock, prompt: string) => Promise<void>;
  saveSpec: (block: DashboardBlock, spec: BlockSpec) => Promise<void>;
  // A panel that already made its own request (the file-source build /
  // style panels, the filters editor) hands the result over here.
  applyDash: (d: DashboardBuilderDetail, opts?: { blockId?: string; rerunPage?: boolean }) => void;
  refreshBlock: (blockId: string) => void;
  // ---- sheets ----
  sheet: EditorSheet;
  openSheet: (s: EditorSheet) => void;
  closeSheet: () => void;
  // The block that was just added: its card scrolls into view and its
  // "Describe..." input takes focus, once.
  focusBlockId: string | null;
  clearFocusBlock: () => void;
};

export function errorDetail(e: any, fallback: string): string {
  const detail = e?.response?.data?.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail) && detail.length && typeof detail[0]?.msg === "string") return detail.map((d: any) => d.msg).join(" ");
  return fallback;
}

const LAYOUT_DEBOUNCE_MS = 400;

export function useDashboardEditor({
  dash, setDash, page, run, warehouse, fileColumns,
}: {
  dash: DashboardBuilderDetail;
  setDash: Dispatch<SetStateAction<DashboardBuilderDetail | null>>;
  page: DashboardBuilderPage | undefined;
  run: DashboardRun;
  warehouse: boolean;
  fileColumns?: { name: string; dtype: string }[];
}): DashboardEditor {
  const dashRef = useRef(dash);
  dashRef.current = dash;
  const pageRef = useRef(page);
  pageRef.current = page;
  const runRef = useRef(run);
  runRef.current = run;

  // ---- the save pill ----
  const [inFlight, setInFlight] = useState(0);
  const [savedOnce, setSavedOnce] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const retryRef = useRef<(() => void) | null>(null);
  const begin = useCallback(() => {
    setInFlight((n) => n + 1);
    setSaveError(null);
    retryRef.current = null;
  }, []);
  const succeed = useCallback(() => {
    setInFlight((n) => Math.max(0, n - 1));
    setSavedOnce(true);
  }, []);
  const fail = useCallback((message: string, retry: () => void) => {
    setInFlight((n) => Math.max(0, n - 1));
    setSaveError(message);
    retryRef.current = retry;
  }, []);
  const retrySave = useCallback(() => {
    const r = retryRef.current;
    retryRef.current = null;
    setSaveError(null);
    r?.();
  }, []);
  const saveState: SaveState = inFlight > 0 ? "saving" : saveError ? "error" : savedOnce ? "saved" : "idle";

  const refreshBlock = useCallback((blockId: string) => {
    // After the page has re-rendered with the new dashboard.
    setTimeout(() => {
      if (warehouse) runRef.current.rerunBlock(blockId);
      else runRef.current.rerun();
    }, 0);
  }, [warehouse]);

  const applyDash = useCallback((d: DashboardBuilderDetail, opts: { blockId?: string; rerunPage?: boolean } = {}) => {
    setDash(d);
    if (opts.blockId) refreshBlock(opts.blockId);
    else if (opts.rerunPage) setTimeout(() => runRef.current.rerun(), 0);
  }, [setDash, refreshBlock]);

  // One tracked request: the save pill follows it, a failure offers Retry.
  const mutate = useCallback(
    async (fn: () => Promise<DashboardBuilderDetail>, fallback: string): Promise<DashboardBuilderDetail> => {
      begin();
      try {
        const d = await fn();
        setDash(d);
        succeed();
        return d;
      } catch (e) {
        fail(errorDetail(e, fallback), () => { mutate(fn, fallback).catch(() => undefined); });
        throw e;
      }
    },
    [begin, succeed, fail, setDash]
  );

  // ---- layout ----
  const pageId = page?.id;
  const gridBlocks = useMemo(() => (page?.blocks || []).filter(isGridBlock), [page?.blocks]);
  const serverLayout = useMemo(() => viewLayout(gridBlocks), [gridBlocks]);
  const [intent, setIntent] = useState<LayoutIntent | null>(null);
  const intentRef = useRef<LayoutIntent | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendingRef = useRef(false);
  const setLayoutIntent = (next: LayoutIntent | null) => {
    intentRef.current = next;
    setIntent(next);
  };

  const gridLayout = useMemo(() => {
    if (!intent || intent.pageId !== pageId || !intent.items) return serverLayout;
    return reconcileLayout(intent.items, gridBlocks);
  }, [intent, pageId, serverLayout, gridBlocks]);
  const gridLayoutRef = useRef(gridLayout);
  gridLayoutRef.current = gridLayout;

  const kpis = useMemo(() => {
    const stored = kpiBlocksInOrder(page?.blocks || []);
    if (!intent || intent.pageId !== pageId || !intent.kpiOrder) return stored;
    const byId = new Map(stored.map((b) => [b.id, b]));
    const ordered = intent.kpiOrder.map((id) => byId.get(id)).filter((b): b is DashboardBlock => Boolean(b));
    for (const b of stored) if (!ordered.includes(b)) ordered.push(b);
    return ordered;
  }, [intent, pageId, page?.blocks]);
  const kpisRef = useRef(kpis);
  kpisRef.current = kpis;

  // What one intent means in stored coordinates, against the server's
  // current blocks: only the placements that actually differ.
  const buildPatch = (target: LayoutIntent): BlockLayoutItem[] => {
    const p = dashRef.current.pages.find((x) => x.id === target.pageId);
    if (!p) return [];
    const grid = p.blocks.filter(isGridBlock);
    const storedKpis = kpiBlocksInOrder(p.blocks);
    let kpiItems: BlockLayoutItem[] = [];
    let band = kpiBand(p.blocks);
    if (target.kpiOrder) {
      const byId = new Map(storedKpis.map((b) => [b.id, b]));
      const ordered = target.kpiOrder.map((id) => byId.get(id)).filter((b): b is DashboardBlock => Boolean(b));
      for (const b of storedKpis) if (!ordered.includes(b)) ordered.push(b);
      kpiItems = kpiLayoutItems(ordered);
      band = kpiItems.reduce((m, it) => Math.max(m, it.y + it.h), 0);
    }
    // A KPI reorder alone leaves the other blocks where they are stored,
    // unless the band they sit under changed height.
    const items = target.items ? reconcileLayout(target.items, grid) : target.kpiOrder && band !== kpiBand(p.blocks) ? viewLayout(grid) : null;
    const gridItems = items ? toStoredItems(items, band) : [];
    return changedItems([...kpiItems, ...gridItems], p.blocks);
  };

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (sendingRef.current) return; // the request in flight re-flushes when it lands
    const target = intentRef.current;
    if (!target) return;
    const patch = buildPatch(target);
    if (patch.length === 0) {
      if (intentRef.current === target) setLayoutIntent(null);
      return;
    }
    sendingRef.current = true;
    begin();
    try {
      const updated = await dashboardBuilderApi.updatePageLayout(dashRef.current.id, target.pageId, patch);
      // Only the placements are taken from the response, so a rename or an
      // AI build that landed while this was in flight is never undone.
      const fresh = updated.pages.find((x) => x.id === target.pageId);
      if (fresh) {
        const placed = new Map(fresh.blocks.map((b) => [b.id, b]));
        setDash((prev) =>
          prev
            ? {
                ...prev,
                pages: prev.pages.map((p) =>
                  p.id !== target.pageId
                    ? p
                    : { ...p, blocks: p.blocks.map((b) => { const nb = placed.get(b.id); return nb ? { ...b, x: nb.x, y: nb.y, w: nb.w, h: nb.h } : b; }) }
                ),
              }
            : prev
        );
      }
      if (intentRef.current === target) setLayoutIntent(null);
      succeed();
    } catch (e) {
      if (intentRef.current === target) {
        // Nothing newer is waiting: back to what the server has.
        setLayoutIntent(null);
        fail(errorDetail(e, "Couldn't save the layout."), () => {
          setLayoutIntent(target);
          flush();
        });
      } else {
        // A newer layout is queued behind this one; it is tried next.
        setInFlight((n) => Math.max(0, n - 1));
      }
    } finally {
      sendingRef.current = false;
      if (intentRef.current) flush();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [begin, succeed, fail, setDash]);

  const schedule = useCallback((delay = LAYOUT_DEBOUNCE_MS) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flush();
    }, delay);
  }, [flush]);

  const commitLayout = useCallback((items: GridItem[]) => {
    const p = pageRef.current;
    if (!p) return;
    const clean = items.map((it) => ({ i: it.i, x: it.x, y: it.y, w: it.w, h: it.h }));
    const prev = intentRef.current && intentRef.current.pageId === p.id ? intentRef.current : null;
    if (!prev && sameLayout(clean, gridLayoutRef.current)) return;
    setSaveError(null);
    retryRef.current = null;
    setLayoutIntent({ pageId: p.id, items: clean, kpiOrder: prev?.kpiOrder ?? null });
    schedule();
  }, [schedule]);

  const blockTypeOf = (id: string): DashboardBlockType | undefined => pageRef.current?.blocks.find((b) => b.id === id)?.type;

  const moveBlock = useCallback((blockId: string, dir: MoveDir) => {
    const next = moveItem(gridLayoutRef.current, blockId, dir);
    if (next) commitLayout(next);
  }, [commitLayout]);

  const resizeBlock = useCallback((blockId: string, dir: SizeDir) => {
    const type = blockTypeOf(blockId);
    if (!type) return;
    const next = resizeItem(gridLayoutRef.current, blockId, dir, minSizeOf(type));
    if (next) commitLayout(next);
  }, [commitLayout]);

  const persistKpiOrder = useCallback((ids: string[], delay = 0) => {
    const p = pageRef.current;
    if (!p) return;
    const prev = intentRef.current && intentRef.current.pageId === p.id ? intentRef.current : null;
    setSaveError(null);
    retryRef.current = null;
    setLayoutIntent({ pageId: p.id, items: prev?.items ?? null, kpiOrder: ids });
    schedule(delay);
  }, [schedule]);

  const moveKpi = useCallback((blockId: string, toIndex: number) => {
    const ids = kpisRef.current.map((b) => b.id);
    const from = ids.indexOf(blockId);
    if (from < 0) return;
    const to = Math.max(0, Math.min(ids.length - 1, toIndex));
    if (to === from) return;
    ids.splice(from, 1);
    ids.splice(to, 0, blockId);
    persistKpiOrder(ids);
  }, [persistKpiOrder]);

  // Leaving the page (or the editor) with a layout still waiting: send it now.
  const flushLayout = useCallback(() => { if (intentRef.current) flush(); }, [flush]);
  useEffect(() => () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      const target = intentRef.current;
      if (target) {
        const patch = buildPatch(target);
        if (patch.length) dashboardBuilderApi.updatePageLayout(dashRef.current.id, target.pageId, patch).catch(() => undefined);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A different page: the pending layout was for the old one - send it and
  // show the new page from the server's state.
  useEffect(() => {
    if (intentRef.current && intentRef.current.pageId !== pageId) flush();
  }, [pageId, flush]);

  // ---- blocks ----
  const [sheet, setSheet] = useState<EditorSheet>(null);
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const newBlocksOf = (before: Set<string>, d: DashboardBuilderDetail, inPage: string): DashboardBlock[] =>
    (d.pages.find((x) => x.id === inPage)?.blocks || []).filter((b) => !before.has(b.id));

  const addBlock = useCallback(async (type: DashboardBlockType) => {
    const p = pageRef.current;
    if (!p || adding) return;
    setAdding(true);
    const before = new Set(p.blocks.map((b) => b.id));
    const config =
      type === "sql" ? { sql: "", name: uniqueCellName(orderCells(p.blocks)) } : type === "text" || type === "heading" ? { text: "" } : undefined;
    try {
      const d = await mutate(() => dashboardBuilderApi.createBlock(dashRef.current.id, p.id, type, undefined, undefined, config), "Couldn't add the block.");
      const created = newBlocksOf(before, d, p.id)[0];
      if (!created) return;
      setFocusBlockId(created.id);
      if (created.type === "kpi") {
        // The backend appends below everything; a KPI belongs in the strip's row.
        persistKpiOrder([...kpiBlocksInOrder(p.blocks).map((b) => b.id), created.id]);
      }
    } catch {
      // The save pill already says what failed.
    } finally {
      setAdding(false);
    }
  }, [adding, mutate, persistKpiOrder]);

  const renameBlock = useCallback(async (block: DashboardBlock, title: string) => {
    const clean = title.trim();
    if (clean === (block.title || "")) return;
    await mutate(() => dashboardBuilderApi.updateBlock(dashRef.current.id, block.id, { title: clean }), "Couldn't rename the block.").catch(() => undefined);
  }, [mutate]);

  const updateConfig = useCallback(async (block: DashboardBlock, patch: Record<string, any>) => {
    // The PATCH replaces the whole config. A block the engine recomputes
    // drops its cached render keys; a block whose saved result IS its
    // content (a file / legacy block) resends everything.
    const base = isRunnable(block) ? slimConfig(block.config) : { ...(block.config || {}) };
    const config = { ...base, ...patch };
    for (const k of Object.keys(config)) if (config[k] === undefined) delete config[k];
    await mutate(() => dashboardBuilderApi.updateBlock(dashRef.current.id, block.id, { config }), "Couldn't save that change.").catch(() => undefined);
  }, [mutate]);

  const duplicateBlock = useCallback(async (block: DashboardBlock) => {
    const p = pageRef.current;
    if (!p) return;
    const before = new Set(p.blocks.map((b) => b.id));
    try {
      const d = await mutate(() => dashboardBuilderApi.duplicateBlock(dashRef.current.id, block.id), "Couldn't duplicate the block.");
      const created = newBlocksOf(before, d, p.id)[0];
      if (!created) return;
      refreshBlock(created.id);
      if (created.type === "kpi") {
        const ids = kpisRef.current.map((b) => b.id).filter((id) => id !== created.id);
        ids.splice(ids.indexOf(block.id) + 1, 0, created.id);
        persistKpiOrder(ids);
      }
    } catch {
      // The save pill already says what failed.
    }
  }, [mutate, refreshBlock, persistKpiOrder]);

  const swapBlock = useCallback(async (block: DashboardBlock, payload: { chart_type?: string; type?: DashboardBlockType }) => {
    try {
      const d = await mutate(() => dashboardBuilderApi.swapBlock(dashRef.current.id, block.id, payload), "Couldn't change the block's type.");
      refreshBlock(block.id);
      // A block that became a KPI joins the strip's row (last), instead of
      // keeping a chart's place and size under it.
      const p = pageRef.current;
      if (p && payload.type === "kpi" && block.type !== "kpi") {
        const fresh = d.pages.find((x) => x.id === p.id);
        if (fresh) persistKpiOrder([...kpiBlocksInOrder(fresh.blocks).map((b) => b.id).filter((id) => id !== block.id), block.id]);
      }
    } catch {
      // The save pill already says what failed.
    }
  }, [mutate, refreshBlock, persistKpiOrder]);

  const [removing, setRemoving] = useState<{ block: DashboardBlock; busy: boolean; error: string | null } | null>(null);
  const requestRemove = useCallback((block: DashboardBlock) => setRemoving({ block, busy: false, error: null }), []);
  const cancelRemove = useCallback(() => setRemoving(null), []);
  const confirmRemove = useCallback(async () => {
    const target = removing?.block;
    if (!target) return;
    setRemoving({ block: target, busy: true, error: null });
    try {
      setDash(await dashboardBuilderApi.deleteBlock(dashRef.current.id, target.id));
      setSavedOnce(true);
      setRemoving(null);
      setSheet((s) => (s && "blockId" in s && s.blockId === target.id ? null : s));
    } catch (e) {
      setRemoving({ block: target, busy: false, error: errorDetail(e, "Couldn't remove the block.") });
    }
  }, [removing, setDash]);

  const askAi = useCallback(async (block: DashboardBlock, prompt: string) => {
    const d = await dashboardBuilderApi.askAiBlock(dashRef.current.id, block.id, prompt.trim());
    setDash(d);
    setSavedOnce(true);
    refreshBlock(block.id);
  }, [setDash, refreshBlock]);

  const saveSpec = useCallback(async (block: DashboardBlock, spec: BlockSpec) => {
    const d = await dashboardBuilderApi.setBlockSpec(dashRef.current.id, block.id, {
      spec,
      block_type: block.type,
      chart_type: block.type === "chart" && typeof block.config?.chart_type === "string" ? block.config.chart_type : undefined,
    });
    setDash(d);
    setSavedOnce(true);
    refreshBlock(block.id);
  }, [setDash, refreshBlock]);

  const openSheet = useCallback((s: EditorSheet) => setSheet(s), []);
  const closeSheet = useCallback(() => setSheet(null), []);
  const clearFocusBlock = useCallback(() => setFocusBlockId(null), []);

  const provider = warehouse && dash.datasource_kind ? providerDisplayName(dash.datasource_kind) : null;
  const columns = useMemo(() => fileColumns || [], [fileColumns]);

  return {
    dash, page, run, warehouse, provider, fileColumns: columns,
    saveState, saveError, retrySave,
    gridLayout, commitLayout, moveBlock, resizeBlock, flushLayout,
    kpis, moveKpi,
    addBlock, adding, renameBlock, duplicateBlock, updateConfig, swapBlock,
    requestRemove, removing, confirmRemove, cancelRemove,
    askAi, saveSpec, applyDash, refreshBlock,
    sheet, openSheet, closeSheet,
    focusBlockId, clearFocusBlock,
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BlockResult, ColumnDistinctValue, ColumnFilterSpec, DashboardBuilderPage, DashboardDateRange, DashboardParameter, DashboardPeriod,
  DashboardSavedView, FilterCriterion, FilteredBlock, ParameterOptions, RunPageRequest, RunPageResponse, WarehouseDashboardFields,
} from "../api/client";
import {
  buildPageFilters, buildParameterValues, type CrossFilter, EMPTY_RANGE, emptyRunState, type ParamValue, parseRunState, type RunState,
  sameFilters, serializeRunState, stateFromSavedView, URL_KEYS,
} from "./runState";
import type { ColorRegistry } from "./theme/appearance";

// 2026-10-07 (Option A dashboard view): the engine hook behind
// DashboardShell / FilterRailPanel / KpiStrip / BlockGrid. One hook per
// (dashboard, page), shared by the owner's view/preview mode and the
// published view - the two differ only in the `source` adapter they pass
// (authenticated dashboardBuilderApi vs. the public slug/hostname twins).
//
// What it owns: the rail state (per-parameter values, cross-filters from
// clicked bars, per-chart filters, period, date range, saved view), the
// run itself (debounced 250 ms, the in-flight request aborted on every
// change, and a sequence number so a slow older response can never
// overwrite a newer one), the per-block BlockResult map, and the URL
// (?f=&period=&from=&to=&view=&bf=) it mirrors the state into so a link
// restores exactly what the person was looking at.
//
// A file-source dashboard (warehouse_native=false) keeps today's
// preview-filtered path under the new skin: `source.preview` returns
// FilteredBlock overrides instead of BlockResults, exposed as `overrides`.

export type RunSource = {
  kind: "warehouse" | "file";
  run?: (pageId: string, req: RunPageRequest, signal: AbortSignal) => Promise<RunPageResponse>;
  options?: (paramId: string, opts: { search?: string; limit?: number }, signal: AbortSignal) => Promise<ParameterOptions>;
  preview?: (pageId: string, filters: FilterCriterion[], blockFilters: Record<string, FilterCriterion[]>) => Promise<{ blocks: FilteredBlock[]; matchedRows: number | null; dateBounds?: Record<string, { min: string; max: string }> | null; colors?: ColorRegistry | null }>;
  // File sources: a column's distinct values for the rail (owner: the live
  // datasource; public: the page's own materialised rows).
  distinctValues?: (column: string, search?: string) => Promise<{ values: ColumnDistinctValue[]; dtype?: string }>;
  // File sources, owner only: lets the rail's filter-block editor read a
  // column's real dtype from the live datasource (ColumnFilterSpecEditor).
  datasourceId?: string | null;
  // 2026-10-07 (round 9). The source's name as the person knows it
  // ("Bookings export") - what a file block's subtitle calls its table.
  name?: string | null;
  // The published view: no SQL is ever shown ("Show SQL", a SQL cell's
  // statement) - and none is in the public endpoints' responses either.
  hideSql?: boolean;
  // 2026-10-12 (round 35): warehouse only - the viewer's last complete run of the page. When the
  // page opens unfiltered it is drawn at once ("as of 3:32 PM"); a live source older than
  // `staleAfterMs` (default 15 min) then refreshes quietly behind it.
  snapshot?: (pageId: string, signal: AbortSignal) => Promise<{ computed_at: string | null; period: string | null; run: RunPageResponse | null }>;
  staleAfterMs?: number;
};

export type DateBounds = { min: string; max: string };

function cleanBounds(raw: unknown): Record<string, DateBounds> {
  const out: Record<string, DateBounds> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [column, b] of Object.entries(raw as Record<string, any>)) {
    if (b && typeof b.min === "string" && typeof b.max === "string" && /^\d{4}-\d{2}-\d{2}/.test(b.min) && /^\d{4}-\d{2}-\d{2}/.test(b.max)) {
      out[column] = { min: b.min.slice(0, 10), max: b.max.slice(0, 10) };
    }
  }
  return out;
}

function sameBounds(a: Record<string, DateBounds>, b: Record<string, DateBounds>): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => b[k] && a[k].min === b[k].min && a[k].max === b[k].max);
}

export type DashboardRunOptions = {
  dashboard: WarehouseDashboardFields;
  page: DashboardBuilderPage | undefined;
  source: RunSource;
  // Mirror the state into window.location (default true).
  syncUrl?: boolean;
  debounceMs?: number;
  // Persists the whole saved-view list; resolves with the stored list
  // (ids minted server-side). Absent on the published view.
  persistSavedViews?: (views: Partial<DashboardSavedView>[]) => Promise<DashboardSavedView[]>;
  // False while the view is not on screen (the owner's edit mode) - no
  // run is made until it becomes true again, then one runs at once.
  enabled?: boolean;
};

export type DashboardRun = {
  state: RunState;
  parameters: DashboardParameter[];
  filters: FilterCriterion[];
  activeFilterCount: number;
  results: Record<string, BlockResult>;
  overrides: Record<string, FilteredBlock>;
  loading: boolean;
  // True once the first run for this page has landed (success or failure).
  ready: boolean;
  error: string | null;
  matchedRows: number | null;
  totalRows: number | null;
  computedIn: string | null;
  totalDurationMs: number | null;
  lastRunAt: string | null;
  // 2026-10-12 (round 35): when the numbers on screen were computed - the snapshot's time until a
  // run lands, then the run's - and whether the run in flight is a quiet background refresh
  // (the page keeps its numbers; only the freshness control says "Updating…").
  asOf: string | null;
  quiet: boolean;
  fromSnapshot: boolean;
  // 2026-10-12 (round 35b): auto-refresh. `revalidate` re-runs quietly (Real-time, every minute
  // while open); `reloadSnapshot` picks up numbers a scheduled refresh computed on the server. A
  // quiet update reports the blocks whose numbers changed ("2 numbers changed").
  revalidate: () => void;
  reloadSnapshot: () => void;
  changed: { ids: string[]; at: number } | null;
  clearChanged: () => void;
  skippedBlockIds: string[];
  // 2026-10-07 (dashboard edit mode): blocks the run reported as created
  // but never built (RunPageOut.empty_block_ids; [] on an older backend).
  emptyBlockIds: string[];
  missingParameters: string[];
  // 2026-10-07 (analyst canvas): the run response's cell graph -
  // {block_id: [source ids]} and the resolved run order - plus the
  // parameter values the SQL cells were actually bound to, by name.
  dependencies: Record<string, string[]>;
  order: string[];
  parametersUsed: Record<string, any>;
  // 2026-10-07 (round 9): {column: {min, max}} - the real first and last
  // date of the dashboard's date column(s), from the run (one cached
  // MIN/MAX query in the warehouse; pandas for a file). The date pickers
  // open on `max` and disable days outside the bounds. {} until known.
  dateBounds: Record<string, DateBounds>;
  // 2026-10-07 (identity-colour round): the dashboard's colour registry as
  // of the latest response ({column: {value: palette slot}}) - newer than
  // the one the page payload carried; null until a response brought one
  // (and on an older backend). The chart theme reads it.
  colors: ColorRegistry | null;
  setParamValue: (paramId: string, value: ParamValue) => void;
  setFilterBlockValue: (blockId: string, spec: ColumnFilterSpec | null) => void;
  setCrossFilter: (cf: CrossFilter | null, column?: string) => void;
  setBlockFilters: (blockId: string, criteria: FilterCriterion[]) => void;
  setPeriod: (p: DashboardPeriod) => void;
  setDateRange: (r: DashboardDateRange) => void;
  resetFilters: () => void;
  refresh: () => void;
  // Re-run under the same state without bypassing the cache (after a
  // block was edited/swapped/removed).
  rerun: () => void;
  rerunBlock: (blockId: string) => void;
  // Several blocks in one request (a SQL cell plus the cells bound to it).
  rerunBlocks: (blockIds: string[], opts?: { force?: boolean }) => void;
  // Every block that (transitively) reads from `blockId`, from the last
  // run's dependency graph.
  dependentsOf: (blockId: string) => string[];
  // Saved views
  savedViews: DashboardSavedView[];
  viewDirty: boolean;
  applyView: (id: string) => void;
  saveCurrentView: (name: string) => Promise<void>;
  renameView: (id: string, name: string) => Promise<void>;
  deleteView: (id: string) => Promise<void>;
  canSaveViews: boolean;
  // "Pin to URL": the current state as a shareable link (also copied).
  shareUrl: () => string;
  copyLink: () => Promise<boolean>;
};

function currentSearch(): string {
  return typeof window !== "undefined" ? window.location.search : "";
}

export function useDashboardRun({ dashboard, page, source, syncUrl = true, debounceMs = 250, persistSavedViews, enabled = true }: DashboardRunOptions): DashboardRun {
  const parameters = useMemo(() => (Array.isArray(dashboard.parameters) ? dashboard.parameters : []), [dashboard.parameters]);
  const [savedViews, setSavedViews] = useState<DashboardSavedView[]>(Array.isArray(dashboard.saved_views) ? dashboard.saved_views : []);
  useEffect(() => {
    setSavedViews(Array.isArray(dashboard.saved_views) ? dashboard.saved_views : []);
  }, [dashboard.saved_views]);

  const [state, setState] = useState<RunState>(() => {
    const base = emptyRunState(dashboard.default_period);
    const fromUrl = syncUrl ? parseRunState(currentSearch(), parameters, dashboard.default_period) : {};
    let merged: RunState = { ...base, ...fromUrl };
    // A ?view= with no explicit filters applies that saved view.
    if (fromUrl.viewId && !fromUrl.paramValues) {
      const v = (dashboard.saved_views || []).find((x) => x.id === fromUrl.viewId);
      if (v) merged = stateFromSavedView(parameters, v, merged);
    }
    return merged;
  });

  const [results, setResults] = useState<Record<string, BlockResult>>({});
  const [overrides, setOverrides] = useState<Record<string, FilteredBlock>>({});
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matchedRows, setMatchedRows] = useState<number | null>(null);
  const [totalRows, setTotalRows] = useState<number | null>(null);
  const [computedIn, setComputedIn] = useState<string | null>(null);
  const [totalDurationMs, setTotalDurationMs] = useState<number | null>(null);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  const [quiet, setQuiet] = useState(false);
  const [fromSnapshot, setFromSnapshot] = useState(false);
  const [changed, setChanged] = useState<{ ids: string[]; at: number } | null>(null);
  const resultsRef = useRef<Record<string, BlockResult>>({});
  resultsRef.current = results;
  const [skippedBlockIds, setSkipped] = useState<string[]>([]);
  const [emptyBlockIds, setEmptyIds] = useState<string[]>([]);
  const [missingParameters, setMissing] = useState<string[]>([]);
  const [dependencies, setDependencies] = useState<Record<string, string[]>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [parametersUsed, setParametersUsed] = useState<Record<string, any>>({});
  const [dateBounds, setDateBounds] = useState<Record<string, DateBounds>>({});
  const [colors, setColors] = useState<ColorRegistry | null>(null);
  // The same registry keeps its identity, so nothing repaints or re-plans
  // when a run brings back what the page already had.
  const applyColors = useCallback((next: ColorRegistry | null | undefined) => {
    if (!next || typeof next !== "object" || !next.assignments) return;
    setColors((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : { assignments: next.assignments, overflow: Array.isArray(next.overflow) ? next.overflow : [], registry_full: Boolean(next.registry_full) }));
  }, []);
  // A response without bounds (a partial run, an older backend) keeps the
  // ones already known.
  const applyBounds = useCallback((raw: unknown) => {
    const next = cleanBounds(raw);
    if (Object.keys(next).length === 0) return;
    setDateBounds((prev) => (sameBounds(prev, next) ? prev : next));
  }, []);

  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const pageRef = useRef(page);
  pageRef.current = page;

  const filterBlocks = useMemo(
    () => (page?.blocks || []).filter((b) => b.type === "filter").map((b) => ({ id: b.id, column: (b.config?.column as string | null) || null })),
    [page]
  );
  const filters = useMemo(() => buildPageFilters(parameters, state, filterBlocks), [parameters, state, filterBlocks]);

  // ---- the run ----
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  // One response (a run, or a snapshot of one) onto the page. `track`: say which blocks' numbers
  // changed against what was on screen (a quiet, automatic update).
  const applyResponse = useCallback((res: RunPageResponse, blockIds?: string[], track = false) => {
    if (track) {
      const before = resultsRef.current;
      const ids = Object.keys(res.blocks || {}).filter((id) => {
        const a = before[id] as any, b = (res.blocks as any)[id];
        return a && b && a.status === "ok" && b.status === "ok" && JSON.stringify(a.rows) !== JSON.stringify(b.rows);
      });
      if (ids.length) setChanged({ ids, at: Date.now() });
    }
    // Before the results: the charts they draw are coloured in the same paint.
    applyColors(res.colors);
    setResults((prev) => (blockIds ? { ...prev, ...res.blocks } : res.blocks));
    setMatchedRows(res.matched_rows);
    setTotalRows(res.total_rows);
    setComputedIn(res.computed_in);
    setTotalDurationMs(res.total_duration_ms);
    setSkipped(res.skipped_block_ids || []);
    // A partial run only speaks for the blocks it was asked about.
    setEmptyIds((prev) => {
      const next = res.empty_block_ids || [];
      const merged = blockIds ? [...prev.filter((id) => !blockIds.includes(id)), ...next] : next;
      return merged.length === prev.length && merged.every((id, i) => id === prev[i]) ? prev : merged;
    });
    setMissing(res.missing_parameters || []);
    // A partial run (block_ids) reports only the graph it touched;
    // keep the rest of the page's edges from the last full run.
    setDependencies((prev) => (blockIds ? { ...prev, ...(res.dependencies || {}) } : res.dependencies || {}));
    setOrder((prev) => (blockIds ? prev : res.order || []));
    setParametersUsed(res.parameters_used || {});
    applyBounds(res.date_bounds);
  }, [applyBounds, applyColors]);

  const execute = useCallback(
    (opts: { force?: boolean; blockIds?: string[]; quiet?: boolean } = {}) => {
      const p = pageRef.current;
      if (!p || !enabledRef.current) return;
      const s = stateRef.current;
      const seq = ++seqRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setQuiet(Boolean(opts.quiet));
      setError(null);
      const pageFilters = buildPageFilters(parameters, s, filterBlocks);
      const activeBlockFilters: Record<string, FilterCriterion[]> = {};
      for (const [bid, crit] of Object.entries(s.blockFilters)) if (crit.length) activeBlockFilters[bid] = crit;

      const finish = () => {
        if (seq !== seqRef.current) return;
        setLoading(false);
        setQuiet(false);
        setReady(true);
      };

      if (source.kind === "file") {
        if (!source.preview) {
          finish();
          return;
        }
        source
          .preview(p.id, pageFilters, activeBlockFilters)
          .then(({ blocks, matchedRows: mr, dateBounds: bounds, colors: registry }) => {
            if (seq !== seqRef.current) return;
            applyBounds(bounds);
            applyColors(registry);
            const hasAny = pageFilters.length > 0 || Object.keys(activeBlockFilters).length > 0;
            const next: Record<string, FilteredBlock> = {};
            if (hasAny) for (const b of blocks) next[b.id] = b;
            setOverrides(next);
            setMatchedRows(mr);
            setLastRunAt(new Date().toISOString());
          })
          .catch((e: any) => {
            if (seq !== seqRef.current) return;
            setError(e?.response?.data?.detail || "Couldn't apply these filters.");
          })
          .finally(finish);
        return;
      }
      if (!source.run) {
        finish();
        return;
      }
      const req: RunPageRequest = {
        filters: pageFilters,
        block_filters: activeBlockFilters,
        period: s.period,
        date_range: s.dateRange.from || s.dateRange.to ? s.dateRange : null,
        parameters: buildParameterValues(parameters, s.paramValues),
        force_refresh: opts.force || false,
        block_ids: opts.blockIds || null,
      };
      source
        .run(p.id, req, controller.signal)
        .then((res) => {
          if (seq !== seqRef.current) return;
          applyResponse(res, opts.blockIds, Boolean(opts.quiet));
          setFromSnapshot(false);
          setLastRunAt(new Date().toISOString());
        })
        .catch((e: any) => {
          if (seq !== seqRef.current) return;
          if (e?.name === "CanceledError" || e?.name === "AbortError" || e?.code === "ERR_CANCELED") return;
          const status = e?.response?.status;
          const detail = e?.response?.data?.detail;
          // A quiet refresh that fails keeps the snapshot on screen - and says the numbers are older
          setError(
            status === 429 ? "Too many runs in a minute - please wait a moment and try again." : typeof detail === "string" ? detail : opts.quiet ? "Couldn't update just now - showing the last saved numbers." : "This page couldn't be computed right now."
          );
        })
        .finally(finish);
    },
    [parameters, filterBlocks, source, applyBounds, applyColors, applyResponse]
  );

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      execute();
    }, debounceMs);
  }, [execute, debounceMs]);

  // First load of a page: immediate (no debounce), nothing stale to keep.
  // 2026-10-12 (round 35): a warehouse page opened unfiltered draws this viewer's last complete run
  // at once (stale-while-revalidate) - no 10-second skeleton - then a live source older than
  // staleAfterMs refreshes quietly behind it. Any filter, or no snapshot, runs as before.
  const pageId = page?.id;
  useEffect(() => {
    setResults({});
    setOverrides({});
    setEmptyIds([]);
    setReady(false);
    setError(null);
    setFromSnapshot(false);
    setLastRunAt(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!pageId) return;
    const s = stateRef.current;
    const unfiltered = buildPageFilters(parameters, s, filterBlocks).length === 0
      && Object.values(s.blockFilters).every((c) => !c.length)
      && !s.dateRange.from && !s.dateRange.to
      && Object.values(buildParameterValues(parameters, s.paramValues)).every((v) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length));
    if (source.kind !== "warehouse" || !source.snapshot || !unfiltered || !enabledRef.current) {
      execute();
      return () => { abortRef.current?.abort(); };
    }
    const seq = seqRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    source.snapshot(pageId, controller.signal)
      .then((snap) => {
        if (seq !== seqRef.current) return; // the person already changed something - that run wins
        const usable = snap.run && snap.computed_at && (!snap.period || snap.period === stateRef.current.period);
        if (!usable) { execute(); return; }
        applyResponse(snap.run!);
        setFromSnapshot(true);
        setLastRunAt(snap.computed_at);
        setReady(true);
        setLoading(false);
        const age = Date.now() - new Date(snap.computed_at!).getTime();
        if (!(age >= 0 && age < (source.staleAfterMs ?? 15 * 60 * 1000))) execute({ quiet: true });
      })
      .catch((e: any) => {
        if (e?.name === "CanceledError" || e?.name === "AbortError" || e?.code === "ERR_CANCELED") return;
        if (seq === seqRef.current) execute();
      });
    return () => {
      controller.abort();
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, source]);

  // Coming back on screen (edit -> view): the blocks may have changed
  // underneath, so run again right away.
  const wasEnabled = useRef(enabled);
  useEffect(() => {
    if (enabled && !wasEnabled.current && pageId) execute();
    wasEnabled.current = enabled;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  // ---- state updates (each one schedules a debounced run) ----
  const update = useCallback(
    (fn: (prev: RunState) => RunState) => {
      setState((prev) => {
        const next = fn(prev);
        stateRef.current = next;
        return next;
      });
      schedule();
    },
    [schedule]
  );

  const setParamValue = useCallback((paramId: string, value: ParamValue) => {
    update((prev) => ({ ...prev, paramValues: { ...prev.paramValues, [paramId]: value }, viewId: prev.viewId }));
  }, [update]);

  const setFilterBlockValue = useCallback((blockId: string, spec: ColumnFilterSpec | null) => {
    update((prev) => {
      const next = { ...prev.filterBlockValues };
      if (spec) next[blockId] = spec;
      else delete next[blockId];
      return { ...prev, filterBlockValues: next };
    });
  }, [update]);

  const setCrossFilter = useCallback((cf: CrossFilter | null, column?: string) => {
    update((prev) => {
      const next = { ...prev.crossFilters };
      if (cf) next[cf.column] = cf;
      else if (column) delete next[column];
      else return { ...prev, crossFilters: {} };
      return { ...prev, crossFilters: next };
    });
  }, [update]);

  const setBlockFilters = useCallback((blockId: string, criteria: FilterCriterion[]) => {
    update((prev) => {
      const next = { ...prev.blockFilters, [blockId]: criteria };
      if (criteria.length === 0) delete next[blockId];
      return { ...prev, blockFilters: next };
    });
  }, [update]);

  const setPeriod = useCallback((p: DashboardPeriod) => update((prev) => ({ ...prev, period: p })), [update]);
  const setDateRange = useCallback((r: DashboardDateRange) => update((prev) => ({ ...prev, dateRange: { from: r.from || null, to: r.to || null } })), [update]);

  const resetFilters = useCallback(() => {
    update((prev) => ({ ...prev, paramValues: {}, crossFilters: {}, filterBlockValues: {}, dateRange: EMPTY_RANGE, viewId: null }));
  }, [update]);

  const refresh = useCallback(() => execute({ force: true }), [execute]);
  const revalidate = useCallback(() => execute({ force: true, quiet: true }), [execute]);
  const lastRunRef = useRef(lastRunAt);
  lastRunRef.current = lastRunAt;
  const reloadSnapshot = useCallback(() => {
    const p = pageRef.current;
    if (!p || source.kind !== "warehouse" || !source.snapshot || !enabledRef.current) return;
    const s = stateRef.current;
    const unfiltered = buildPageFilters(parameters, s, filterBlocks).length === 0 && !s.dateRange.from && !s.dateRange.to
      && Object.values(s.blockFilters).every((c) => !c.length);
    if (!unfiltered) return;
    const seq = seqRef.current;
    const controller = new AbortController();
    source.snapshot(p.id, controller.signal).then((snap) => {
      if (seq !== seqRef.current || !snap.run || !snap.computed_at) return;
      if (snap.period && snap.period !== stateRef.current.period) return;
      const cur = lastRunRef.current ? new Date(lastRunRef.current).getTime() : 0;
      if (new Date(snap.computed_at).getTime() <= cur) return;
      applyResponse(snap.run, undefined, true);
      setLastRunAt(snap.computed_at);
      setFromSnapshot(true);
    }).catch(() => undefined);
  }, [source, parameters, filterBlocks, applyResponse]);
  const clearChanged = useCallback(() => setChanged(null), []);
  const rerun = useCallback(() => execute(), [execute]);
  const rerunBlock = useCallback((blockId: string) => execute({ force: true, blockIds: [blockId] }), [execute]);
  const rerunBlocks = useCallback((blockIds: string[], o: { force?: boolean } = {}) => {
    if (blockIds.length) execute({ force: o.force ?? true, blockIds });
  }, [execute]);
  const dependenciesRef = useRef(dependencies);
  dependenciesRef.current = dependencies;
  const dependentsOf = useCallback((blockId: string) => {
    const deps = dependenciesRef.current;
    const out: string[] = [];
    const seen = new Set<string>([blockId]);
    const queue = [blockId];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const [target, sources] of Object.entries(deps)) {
        if (sources.includes(cur) && !seen.has(target)) {
          seen.add(target);
          out.push(target);
          queue.push(target);
        }
      }
    }
    return out;
  }, []);

  // ---- URL mirror ----
  useEffect(() => {
    if (!syncUrl || typeof window === "undefined" || !window.history?.replaceState) return;
    const qs = serializeRunState(parameters, state, window.location.search);
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (url !== current) {
      try {
        window.history.replaceState(window.history.state, "", url);
      } catch {
        // A sandboxed frame can refuse; the state still lives in memory.
      }
    }
  }, [syncUrl, parameters, state]);

  const shareUrl = useCallback(() => {
    if (typeof window === "undefined") return "";
    const qs = serializeRunState(parameters, stateRef.current, window.location.search);
    return `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ""}`;
  }, [parameters]);

  const copyLink = useCallback(async () => {
    const url = shareUrl();
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  }, [shareUrl]);

  // ---- saved views ----
  const currentView = state.viewId ? savedViews.find((v) => v.id === state.viewId) || null : null;
  const viewDirty = useMemo(() => {
    if (!currentView) return false;
    const viewFilters = buildPageFilters(parameters, { ...emptyRunState(null), ...stateFromSavedView(parameters, currentView, emptyRunState(null)) });
    const pageFiltersNow = buildPageFilters(parameters, state);
    if (!sameFilters(viewFilters, pageFiltersNow)) return true;
    if (currentView.period && currentView.period !== state.period) return true;
    const vr = currentView.date_range || EMPTY_RANGE;
    return (vr.from || null) !== (state.dateRange.from || null) || (vr.to || null) !== (state.dateRange.to || null);
  }, [currentView, parameters, state]);

  const applyView = useCallback((id: string) => {
    const v = savedViews.find((x) => x.id === id);
    if (!v) return;
    update((prev) => stateFromSavedView(parameters, v, prev));
  }, [savedViews, parameters, update]);

  const persist = useCallback(async (next: Partial<DashboardSavedView>[]) => {
    if (!persistSavedViews) throw new Error("Saved views can't be changed from this view.");
    const stored = await persistSavedViews(next);
    setSavedViews(stored);
    return stored;
  }, [persistSavedViews]);

  const saveCurrentView = useCallback(async (name: string) => {
    const s = stateRef.current;
    const entry: Partial<DashboardSavedView> = {
      name: name.trim(),
      filters: buildPageFilters(parameters, s),
      period: s.period,
      date_range: s.dateRange.from || s.dateRange.to ? s.dateRange : null,
    };
    const stored = await persist([...savedViews, entry]);
    const created = [...stored].reverse().find((v) => v.name === entry.name);
    if (created) setState((prev) => ({ ...prev, viewId: created.id }));
  }, [parameters, savedViews, persist]);

  const renameView = useCallback(async (id: string, name: string) => {
    await persist(savedViews.map((v) => (v.id === id ? { ...v, name: name.trim() } : v)));
  }, [savedViews, persist]);

  const deleteView = useCallback(async (id: string) => {
    await persist(savedViews.filter((v) => v.id !== id));
    setState((prev) => (prev.viewId === id ? { ...prev, viewId: null } : prev));
  }, [savedViews, persist]);

  return {
    state,
    parameters,
    filters,
    activeFilterCount: filters.length,
    results,
    overrides,
    loading,
    ready,
    error,
    matchedRows,
    totalRows,
    computedIn,
    totalDurationMs,
    lastRunAt,
    asOf: lastRunAt,
    quiet: loading && quiet,
    fromSnapshot,
    revalidate,
    reloadSnapshot,
    changed,
    clearChanged,
    skippedBlockIds,
    emptyBlockIds,
    missingParameters,
    dependencies,
    order,
    parametersUsed,
    dateBounds,
    colors,
    setParamValue,
    setFilterBlockValue,
    setCrossFilter,
    setBlockFilters,
    setPeriod,
    setDateRange,
    resetFilters,
    refresh,
    rerun,
    rerunBlock,
    rerunBlocks,
    dependentsOf,
    savedViews,
    viewDirty,
    applyView,
    saveCurrentView,
    renameView,
    deleteView,
    canSaveViews: Boolean(persistSavedViews),
    shareUrl,
    copyLink,
  };
}

export { URL_KEYS };

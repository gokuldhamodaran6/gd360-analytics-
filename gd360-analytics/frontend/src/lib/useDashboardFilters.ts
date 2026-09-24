import { useCallback, useEffect, useRef, useState } from "react";
import { dashboardBuilderApi, DashboardBuilderPage, FilterCriterion, FilteredBlock } from "../api/client";

// 2026-09-24 (Dashboard Builder Phase 2b): cross-filtering's entire
// client-side state, in one hook - used by DashboardBuilderView.tsx and
// shared by both DashboardCanvas (edit mode) and DashboardBlockGrid
// (Preview mode), so a filter selection behaves identically in both.
//
// Everything here is per-viewer and lives only in this component tree's
// memory - nothing is written back to the server except a filter block's
// own `column` (a structural setting, saved the normal way through
// updateBlock). See backend routers/dashboard_builder.py's module
// docstring (Phase 2b) for the full reasoning: two people looking at the
// same dashboard can have completely different filter selections active
// at once without affecting each other or the dashboard's saved content,
// exactly like a PowerBI/Tableau slicer. Switching pages resets this
// state - filters are page-scoped, same as everything else about a page's
// blocks.
export type DashboardFilterState = {
  // Current value per filter BLOCK id (not per column, since two filter
  // blocks could target the same column) - "" means "All" / cleared.
  values: Record<string, string>;
  // What preview-filtered last returned, keyed by the block id it
  // recomputed - DashboardCanvas/DashboardBlockGrid overlay this onto a
  // block's own type/config when rendering, and fall back to the block's
  // real persisted content whenever an id isn't present here (an AI-built
  // block, a filter block itself, or one that failed to recompute).
  overrides: Record<string, FilteredBlock>;
  // The filters actually being applied right now, in the shape the
  // backend expects - empty when every filter block is set to "All".
  activeFilters: FilterCriterion[];
  setFilterValue: (filterBlockId: string, value: string) => void;
  // Re-runs the current filter selection against the server - call this
  // after ANY block edit (a new manual-build block, a restyle, an ask-ai
  // fill, a delete) so a stale override never lingers on a block whose
  // real content just changed underneath it.
  refresh: () => void;
  loading: boolean;
};

export function useDashboardFilters(dashboardId: string, page: DashboardBuilderPage | undefined): DashboardFilterState {
  const [values, setValues] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Record<string, FilteredBlock>>({});
  const [loading, setLoading] = useState(false);
  const requestSeq = useRef(0);

  useEffect(() => {
    setValues({});
    setOverrides({});
  }, [dashboardId, page?.id]);

  const activeFiltersFor = useCallback(
    (vals: Record<string, string>): FilterCriterion[] => {
      if (!page) return [];
      const out: FilterCriterion[] = [];
      for (const b of page.blocks) {
        if (b.type !== "filter") continue;
        const column = b.config?.column as string | null | undefined;
        const value = vals[b.id];
        if (column && value) out.push({ column, value });
      }
      return out;
    },
    [page]
  );

  const runPreview = useCallback(
    (vals: Record<string, string>) => {
      if (!page) return;
      const filters = activeFiltersFor(vals);
      if (filters.length === 0) {
        setOverrides({});
        return;
      }
      const seq = ++requestSeq.current;
      setLoading(true);
      dashboardBuilderApi
        .previewFiltered(dashboardId, page.id, filters)
        .then((blocks) => {
          if (seq !== requestSeq.current) return; // superseded by a newer change
          const next: Record<string, FilteredBlock> = {};
          for (const b of blocks) next[b.id] = b;
          setOverrides(next);
        })
        .catch(() => {
          // Leave whatever's currently shown alone rather than clearing
          // it out from under the viewer on a transient failure.
        })
        .finally(() => {
          if (seq === requestSeq.current) setLoading(false);
        });
    },
    [dashboardId, page, activeFiltersFor]
  );

  const setFilterValue = useCallback(
    (filterBlockId: string, value: string) => {
      const next = { ...values };
      if (value) next[filterBlockId] = value;
      else delete next[filterBlockId];
      setValues(next);
      runPreview(next);
    },
    [values, runPreview]
  );

  const refresh = useCallback(() => runPreview(values), [values, runPreview]);

  return { values, overrides, activeFilters: activeFiltersFor(values), setFilterValue, refresh, loading };
}

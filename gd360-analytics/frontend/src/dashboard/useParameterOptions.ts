import { useEffect, useRef, useState } from "react";
import type { DashboardParameter, ParameterOptionValue } from "../api/client";
import type { RunSource } from "./useDashboardRun";

// 2026-10-07 (Option A dashboard view): one rail control's option list -
// GET /parameters/{id}/options for a warehouse dashboard (one GROUP BY,
// cached server-side), or the source's distinctValues fetcher for a file
// dashboard. `search` is debounced 250 ms and the previous request is
// aborted, so typing in the country search never shows a stale list.

export type ParameterOptionsState = {
  values: ParameterOptionValue[];
  loading: boolean;
  truncated: boolean;
  error: string | null;
  search: string;
  setSearch: (q: string) => void;
};

const SEARCH_DEBOUNCE_MS = 250;

export function useParameterOptions(source: RunSource, param: DashboardParameter, enabled = true, limit = 50): ParameterOptionsState {
  const [values, setValues] = useState<ParameterOptionValue[]>([]);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearchState] = useState("");
  const [query, setQuery] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const setSearch = (q: string) => {
    setSearchState(q);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setQuery(q.trim()), SEARCH_DEBOUNCE_MS);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useEffect(() => {
    if (!enabled) return;
    const mySeq = ++seq.current;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const request: Promise<{ values: ParameterOptionValue[]; truncated?: boolean; error?: string | null }> =
      source.kind === "warehouse" && source.options
        ? source.options(param.id, { search: query || undefined, limit }, controller.signal)
        : source.distinctValues
          ? source.distinctValues(param.column, query || undefined).then((r) => ({ values: r.values.map((v) => ({ value: v.value, count: v.count })), truncated: false }))
          : Promise.resolve({ values: [] });
    request
      .then((res) => {
        if (mySeq !== seq.current) return;
        setValues(res.values || []);
        setTruncated(Boolean(res.truncated));
        setError(res.error || null);
      })
      .catch((e: any) => {
        if (mySeq !== seq.current) return;
        if (e?.name === "CanceledError" || e?.name === "AbortError" || e?.code === "ERR_CANCELED") return;
        setError(e?.response?.data?.detail || "Couldn't load the values for this filter.");
      })
      .finally(() => {
        if (mySeq === seq.current) setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [source, param.id, param.column, query, enabled, limit]);

  return { values, loading, truncated, error, search, setSearch };
}

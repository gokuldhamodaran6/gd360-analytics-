import { useEffect, useState } from "react";
import { datasourceApi, DataPreview } from "../api/client";

const PAGE_SIZE = 25;

export default function DataTable({
  datasourceId,
  refreshKey,
  onDataChanged,
}: {
  datasourceId: string;
  refreshKey: number;
  onDataChanged?: () => void;
}) {
  const [version, setVersion] = useState<"cleaned" | "original">("original");
  const [preview, setPreview] = useState<DataPreview | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [showLog, setShowLog] = useState(false);

  const loadVersion = async (v: "cleaned" | "original", off: number) => {
    setLoading(true);
    setError("");
    try {
      const data = await datasourceApi.preview(datasourceId, v, PAGE_SIZE, off);
      setPreview(data);
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Could not load data preview.");
    } finally {
      setLoading(false);
    }
  };

  // On mount, or when a cleaning step changes the data, re-check with "auto"
  // to see which version exists and default to showing the most useful one.
  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const auto = await datasourceApi.preview(datasourceId, "auto", PAGE_SIZE, 0);
        setPreview(auto);
        setVersion(auto.has_cleaned_version ? "cleaned" : "original");
        setOffset(0);
      } catch (err: any) {
        setError(err?.response?.data?.detail || "Could not load data preview.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasourceId, refreshKey]);

  const switchTab = (v: "cleaned" | "original") => {
    setVersion(v);
    setOffset(0);
    loadVersion(v, 0);
  };

  const nextPage = () => {
    if (!preview) return;
    const newOffset = offset + PAGE_SIZE;
    if (newOffset >= preview.total_rows) return;
    setOffset(newOffset);
    loadVersion(version, newOffset);
  };

  const prevPage = () => {
    const newOffset = Math.max(0, offset - PAGE_SIZE);
    setOffset(newOffset);
    loadVersion(version, newOffset);
  };

  const doReset = async () => {
    if (!confirm("Discard the cleaned/prepared version and go back to the original data? This cannot be undone.")) return;
    setBusyAction("reset");
    try {
      await datasourceApi.resetCleaning(datasourceId);
      setVersion("original");
      setOffset(0);
      await loadVersion("original", 0);
      onDataChanged?.();
    } catch {
      setError("Could not reset. Please try again.");
    } finally {
      setBusyAction("");
    }
  };

  const doExport = async (format: "csv" | "xlsx") => {
    setBusyAction(format);
    try {
      await datasourceApi.downloadExport(datasourceId, version, format);
    } catch {
      setError("Could not export the data. Please try again.");
    } finally {
      setBusyAction("");
    }
  };

  if (loading && !preview) {
    return <div className="card h-full flex items-center justify-center text-muted p-10 text-center">Loading data...</div>;
  }

  if (error && !preview) {
    return <div className="card h-full flex items-center justify-center text-red-400 p-10 text-center">{error}</div>;
  }

  if (!preview) return null;

  const from = preview.total_rows === 0 ? 0 : offset + 1;
  const to = Math.min(offset + preview.limit, preview.total_rows);

  return (
    <div className="card h-full flex flex-col overflow-hidden">
      <div className="p-3 border-b border-border flex items-center justify-between gap-3 flex-wrap shrink-0">
        <div className="flex gap-1.5">
          <button
            className={`text-xs px-3 py-1.5 rounded-lg font-medium transition ${
              version === "original" ? "bg-primary text-white" : "btn-secondary"
            }`}
            onClick={() => switchTab("original")}
          >
            Original data
          </button>
          <button
            className={`text-xs px-3 py-1.5 rounded-lg font-medium transition ${
              version === "cleaned" ? "bg-primary text-white" : "btn-secondary"
            } ${!preview.has_cleaned_version ? "opacity-40 cursor-not-allowed" : ""}`}
            onClick={() => preview.has_cleaned_version && switchTab("cleaned")}
            disabled={!preview.has_cleaned_version}
          >
            Cleaned / prepared data
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-secondary text-xs px-2.5 py-1.5" disabled={!!busyAction} onClick={() => doExport("csv")}>
            {busyAction === "csv" ? "Exporting..." : "Export CSV"}
          </button>
          <button className="btn-secondary text-xs px-2.5 py-1.5" disabled={!!busyAction} onClick={() => doExport("xlsx")}>
            {busyAction === "xlsx" ? "Exporting..." : "Export Excel"}
          </button>
          {version === "cleaned" && (
            <button className="text-xs text-red-400 hover:text-red-300 underline" disabled={!!busyAction} onClick={doReset}>
              {busyAction === "reset" ? "Resetting..." : "Reset to original"}
            </button>
          )}
        </div>
      </div>

      {error && <div className="mx-3 mt-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}

      {version === "cleaned" && preview.cleaning_log.length > 0 && (
        <div className="px-3 pt-2 shrink-0">
          <button className="text-xs text-accent underline" onClick={() => setShowLog((v) => !v)}>
            {showLog ? "Hide" : "Show"} what changed ({preview.cleaning_log.length} step{preview.cleaning_log.length === 1 ? "" : "s"})
          </button>
          {showLog && (
            <div className="mt-2 space-y-1.5 max-h-32 overflow-y-auto">
              {preview.cleaning_log.map((entry, i) => (
                <div key={i} className="text-xs bg-surface2 border border-border rounded-lg px-2.5 py-1.5">
                  <div className="text-muted italic">"{entry.prompt}"</div>
                  <div className="text-text mt-0.5">{entry.summary}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {preview.rows.length === 0 ? (
          <div className="h-full flex items-center justify-center text-muted text-sm p-10 text-center">No rows to show.</div>
        ) : (
          <table className="min-w-full text-xs">
            <thead className="sticky top-0 bg-surface2 z-10">
              <tr>
                {preview.columns.map((col) => (
                  <th key={col} className="text-left px-3 py-2 font-semibold border-b border-border whitespace-nowrap">
                    {col}
                    <span className="text-muted font-normal ml-1.5">{preview.dtypes[col]}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, i) => (
                <tr key={i} className="hover:bg-surface2/60 border-b border-border/50">
                  {preview.columns.map((col) => (
                    <td key={col} className="px-3 py-1.5 whitespace-nowrap">
                      {row[col] === null || row[col] === undefined || row[col] === "" ? (
                        <span className="text-muted">—</span>
                      ) : (
                        String(row[col])
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="p-3 border-t border-border flex items-center justify-between shrink-0 text-xs text-muted">
        <div>
          {from}-{to} of {preview.total_rows} rows
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary text-xs px-2.5 py-1" disabled={offset === 0 || loading} onClick={prevPage}>
            Prev
          </button>
          <button className="btn-secondary text-xs px-2.5 py-1" disabled={to >= preview.total_rows || loading} onClick={nextPage}>
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

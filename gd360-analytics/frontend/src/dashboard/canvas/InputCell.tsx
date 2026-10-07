import { useState } from "react";
import { Select } from "../../ui";
import { ParameterField } from "../FilterRailPanel";
import { isParamValueSet } from "../runState";
import { slimConfig } from "./cells";
import type { CellBodyProps } from "./types";

// 2026-10-07 (analyst canvas round): an "input" cell - one of the
// dashboard's parameters rendered inline, driven by the same run state as
// the strip and the rail (the same ParameterField). Owner: "Bound to"
// picks which parameter (PATCH config.parameter_id; the backend fills in
// parameter_name).

export function InputCell({ cell, run, source, parameters, owner }: CellBodyProps) {
  const block = cell.block;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const param = parameters.find((p) => p.id === block.config?.parameter_id || (block.config?.parameter_name && p.name === block.config.parameter_name));
  const value = param ? run.state.paramValues[param.id] : undefined;
  const rebind = async (pid: string) => {
    if (!owner) return;
    setBusy(true);
    setError(null);
    try {
      await owner.updateBlock(block.id, { config: { ...slimConfig(block.config), parameter_id: pid || null, parameter_name: pid ? parameters.find((p) => p.id === pid)?.name : undefined } });
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "Couldn't bind this input.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="px-4 pb-3" data-input-cell="">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted">
        {param ? (
          <span>
            Sets <code className="font-mono font-medium text-text">{param.name || param.column}</code> for every cell below
            {isParamValueSet(param, value) && <button type="button" className="ui-focus ml-2 rounded px-0.5 text-muted hover:text-text hover:underline" onClick={() => run.setParamValue(param.id, null)}>Clear</button>}
          </span>
        ) : (
          <span>{owner ? "Pick a parameter for this input." : "This input is not bound to a parameter yet."}</span>
        )}
        {owner && (
          <label className="ml-auto flex items-center gap-1.5">
            <span>Bound to</span>
            <Select size="sm" aria-label="Bound parameter" data-input-bind="" value={param?.id || ""} disabled={busy} onChange={(e) => rebind(e.target.value)} className="h-7 w-[200px] font-mono text-caption">
              <option value="">— none —</option>
              {parameters.map((p) => <option key={p.id} value={p.id}>{p.name || p.column}</option>)}
            </Select>
          </label>
        )}
      </div>
      {error && <div role="alert" className="mb-2 text-caption text-danger">{error}</div>}
      {param && <ParameterField param={param} value={value} onChange={(v) => run.setParamValue(param.id, v)} source={source} />}
    </div>
  );
}

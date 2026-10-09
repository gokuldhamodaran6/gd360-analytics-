// 2026-10-09 (round 15): learning from several tables - step 1 "Choose
// tables" (the main table plus candidates from /ml-studio/join/suggest) and
// step 2 "Check the join" (/ml-studio/join/preview: per-join match rate, how
// it was built, and the joined rows with each column's source).
import BrandTile from "../components/BrandTile";
import type { JoinCandidate, JoinPreview, StudioTable } from "../api/mlStudio";

export const MAX_JOINS = 6;

export const candKey = (c: { source_id: string; table: string }) => `${c.source_id}::${c.table}`;

const CARD = "rounded-card border border-border bg-surface p-4 sm:p-5 flex flex-col gap-3 min-w-0";

export function Stepper({ step, canGo, onGo }: { step: number; canGo: (n: number) => boolean; onGo: (n: number) => void }) {
  const steps = ["Choose tables", "Check the join", "Plan"];
  return (
    <ol className="m-0 p-0 list-none flex gap-2 flex-wrap" aria-label="Steps">
      {steps.map((n, i) => {
        const no = i + 1;
        const on = step === no;
        const done = step > no;
        return (
          <li key={n}>
            <button
              type="button"
              onClick={() => onGo(no)}
              disabled={!on && !canGo(no)}
              aria-current={on ? "step" : undefined}
              className={`inline-flex items-center gap-2.5 h-10 px-3.5 rounded-[11px] border text-ui disabled:cursor-not-allowed disabled:opacity-60 ${
                on ? "text-text" : done ? "border-border bg-surface" : "border-border bg-surface text-muted"
              }`}
              style={on ? { borderColor: "rgb(var(--auto-do-border))", background: "rgb(var(--auto-do-fill))" } : done ? { color: "rgb(var(--auto-do))" } : undefined}
            >
              <span className="font-mono text-[11px]">{done ? "✓" : no}</span>
              {n}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function kindOf(tables: StudioTable[], sourceId: string): string | undefined {
  return tables.find((t) => t.source_id === sourceId)?.kind;
}

// ------------------------------------------------------------ step 1 ----

export function ChooseTables({
  tables,
  base,
  onBase,
  spaceName,
  candidates,
  loading,
  error,
  picked,
  onToggle,
  onNext,
  busy,
}: {
  tables: StudioTable[];
  base: string;
  onBase: (v: string) => void;
  spaceName: string | null;
  candidates: JoinCandidate[] | null;
  loading: boolean;
  error: string;
  picked: string[];
  onToggle: (key: string) => void;
  onNext: () => void;
  busy: boolean;
}) {
  const [sid, tbl] = base ? base.split("::") : ["", ""];
  const baseT = tables.find((t) => t.source_id === sid && t.table === tbl);
  const chosen = (candidates || []).filter((c) => picked.includes(candKey(c)));
  const full = picked.length >= MAX_JOINS;
  return (
    <div className="grid gap-4 lg:grid-cols-2 items-start">
      <section className={CARD} aria-labelledby="ml-use">
        <h2 id="ml-use" className="m-0 text-section font-semibold text-text">Tables GD360 will use</h2>
        <div className="flex flex-col gap-1">
          <label htmlFor="ml-base" className="text-caption text-secondary">Main table - one row for each thing you want an answer about</label>
          <select id="ml-base" value={base} onChange={(e) => onBase(e.target.value)} className="h-10 w-full min-w-0 rounded-ctl border border-border bg-base px-2.5 text-ui text-text">
            <option value="">Pick the main table…</option>
            {tables.map((t) => (
              <option key={`${t.source_id}::${t.table}`} value={`${t.source_id}::${t.table}`}>{t.source} · {t.table}</option>
            ))}
          </select>
        </div>
        {baseT && (
          <TableRow kind={baseT.kind} title={`${baseT.source} · ${baseT.table}`} sub={`${baseT.columns.length} columns`} role="One row each" highlight />
        )}
        {chosen.map((c) => (
          <TableRow
            key={candKey(c)}
            kind={kindOf(tables, c.source_id)}
            title={`${c.source} · ${c.table}`}
            sub={`Joined on ${c.base_key === c.key ? c.key : `${c.base_key} = ${c.key}`}`}
            role={c.many_per_key ? "Summed per key" : "Adds columns"}
          />
        ))}
        <p className="m-0 text-caption text-muted leading-snug">
          Every joined table is matched to the main table's rows. When a table has several rows per key (orders, events, tickets) they are counted and
          summed per key, so the main table keeps one row each.
        </p>
      </section>

      <section className={CARD} aria-labelledby="ml-add">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 id="ml-add" className="m-0 text-section font-semibold text-text">{spaceName ? `Add more from the ${spaceName} Space` : "Add more tables"}</h2>
          <span className="text-caption text-muted">{picked.length} of {MAX_JOINS} at most</span>
        </div>
        {!base && <p className="m-0 text-ui text-muted">Pick the main table first.</p>}
        {base && loading && (
          <div className="flex items-center gap-2.5 text-ui text-muted">
            <span className="w-4 h-4 rounded-full border-2 border-border border-t-[rgb(var(--auto-do))] animate-spin" aria-hidden="true" />
            Looking for tables that share a key with {tbl}…
          </div>
        )}
        {error && <div role="alert" className="rounded-ctl border border-danger-border bg-danger-fill px-3 py-2.5 text-ui text-text">{error}</div>}
        {base && !loading && candidates && candidates.length === 0 && !error && (
          <p className="m-0 text-ui text-muted">No other table shares a key with {tbl}{spaceName ? ` in this Space` : ""}. You can still go on with the main table alone.</p>
        )}
        <div className="flex flex-col gap-2">
          {(candidates || []).map((c) => {
            const k = candKey(c);
            const on = picked.includes(k);
            return (
              <label
                key={k}
                className={`grid grid-cols-[18px_30px_minmax(0,1fr)] gap-3 items-center p-2.5 sm:p-3 rounded-[12px] border cursor-pointer ${on ? "" : "border-border hover:border-border-strong"} ${!on && full ? "opacity-60 cursor-not-allowed" : ""}`}
                style={on ? { borderColor: "rgb(var(--auto-do-border))", background: "rgb(var(--auto-do-fill) / 0.4)" } : undefined}
              >
                <input type="checkbox" checked={on} disabled={!on && full} onChange={() => onToggle(k)} className="w-4 h-4" style={{ accentColor: "rgb(var(--auto-do))" }} />
                <BrandTile kind={kindOf(tables, c.source_id)} name={c.source} size={30} />
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-ui text-text truncate">{c.source} · {c.table}</span>
                    <span className="font-mono text-caption shrink-0" style={{ color: c.overlap >= 0.5 ? "rgb(var(--auto-do))" : "rgb(var(--color-warning))" }}>
                      {(c.overlap * 100).toFixed(0)}% match
                    </span>
                  </span>
                  <span className="text-caption text-muted leading-snug">{c.why}</span>
                </span>
              </label>
            );
          })}
        </div>
        <button type="button" className="btn-primary text-sm self-end" onClick={onNext} disabled={!base || busy || loading}>
          {picked.length ? "Check the join" : "Go on with one table"}
        </button>
      </section>
    </div>
  );
}

function TableRow({ kind, title, sub, role, highlight }: { kind?: string; title: string; sub: string; role: string; highlight?: boolean }) {
  return (
    <div
      className="grid grid-cols-[34px_minmax(0,1fr)_auto] gap-3 items-center p-3 rounded-[12px] border bg-base"
      style={{ borderColor: highlight ? "rgb(var(--auto-do-border))" : "rgb(var(--color-border))" }}
    >
      <BrandTile kind={kind} name={title} size={34} />
      <span className="flex flex-col gap-0.5 min-w-0">
        <span className="text-ui font-medium text-text truncate">{title}</span>
        <span className="text-caption text-muted truncate">{sub}</span>
      </span>
      <span className="font-mono text-[10.5px] uppercase tracking-[0.04em]" style={{ color: highlight ? "rgb(var(--auto-do))" : "rgb(var(--color-muted))" }}>
        {role}
      </span>
    </div>
  );
}

// ------------------------------------------------------------ step 2 ----

export function CheckJoin({
  preview,
  tables,
  loading,
  error,
  onBack,
  onNext,
}: {
  preview: JoinPreview | null;
  tables: StudioTable[];
  loading: boolean;
  error: string;
  onBack: () => void;
  onNext: () => void;
}) {
  if (loading) {
    return (
      <div className="rounded-card border border-border bg-surface p-5 flex items-center gap-2.5 text-ui text-muted">
        <span className="w-4 h-4 rounded-full border-2 border-border border-t-[rgb(var(--auto-do))] animate-spin" aria-hidden="true" />
        Joining the tables and counting matches…
      </div>
    );
  }
  if (error || !preview) {
    return (
      <div className="flex flex-col gap-3">
        <div role="alert" className="rounded-card border border-danger-border bg-danger-fill px-4 py-3 text-ui text-text">{error || "Couldn't build the join."}</div>
        <button type="button" className="btn-secondary text-sm self-start" onClick={onBack}>Change tables</button>
      </div>
    );
  }
  const key = preview.joins[0]?.base_key;
  return (
    <div className="flex flex-col gap-4">
      {preview.text && <p className="m-0 text-ui text-secondary">{preview.text}.</p>}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))" }}>
        {preview.joins.map((j) => {
          const missing = Math.max(0, j.base_rows - j.matched);
          const low = j.match_rate < 0.5;
          return (
            <section key={`${j.source_id}::${j.table}`} className={CARD} aria-label={`${j.source} · ${j.table}`}>
              <span className="flex items-center gap-2.5 text-ui text-text min-w-0">
                <BrandTile kind={kindOf(tables, j.source_id)} name={j.source} size={26} />
                <span className="truncate">{j.source} · {j.table}</span>
              </span>
              <span className="text-ui text-secondary">
                Joined on <span className="font-mono text-text">{j.base_key === j.key ? j.key : `${j.base_key} = ${j.key}`}</span>
              </span>
              <span
                className="h-2 rounded-full overflow-hidden flex"
                style={{ background: "rgb(var(--color-danger) / 0.22)" }}
                role="img"
                aria-label={`${(j.match_rate * 100).toFixed(1)}% of rows matched`}
              >
                <span style={{ width: `${Math.max(0, Math.min(100, j.match_rate * 100))}%`, background: low ? "rgb(var(--color-warning))" : "rgb(var(--auto-do))" }} />
              </span>
              <span className="flex justify-between gap-3 flex-wrap text-caption">
                <span className="text-text">
                  {j.matched.toLocaleString()} matched <span className="font-mono">({(j.match_rate * 100).toFixed(1)}%)</span>
                </span>
                <span className="text-danger">{missing.toLocaleString()} without a match</span>
              </span>
              {j.many_per_key && (
                <span className="text-caption text-muted">
                  {j.join_rows.toLocaleString()} rows in {j.table} become one per {j.key} · {j.added.length} column{j.added.length === 1 ? "" : "s"} added
                </span>
              )}
              <span className="text-caption text-muted leading-relaxed">{j.how}</span>
            </section>
          );
        })}
      </div>

      {preview.warnings.map((w) => (
        <div key={w} className="rounded-card border border-warning-border bg-warning-fill px-4 py-3 text-ui text-text">{w}</div>
      ))}

      <section className={CARD} aria-labelledby="ml-preview">
        <div className="flex justify-between gap-2 flex-wrap items-baseline">
          <h2 id="ml-preview" className="m-0 text-section font-semibold text-text">{key ? `One row per ${key}, ready to learn from` : "The rows GD360 will learn from"}</h2>
          <span className="text-caption text-muted">
            {preview.rows.toLocaleString()} rows · {preview.columns.length} columns · first {preview.preview.length} shown
          </span>
        </div>
        <div className="overflow-x-auto -mx-1">
          <table className="border-collapse text-ui" style={{ minWidth: Math.min(2400, Math.max(360, preview.columns.length * 120)) }}>
            <thead>
              <tr className="text-left">
                {preview.columns.map((c) => (
                  <th key={c.name} scope="col" className="align-bottom px-2.5 py-2 border-b border-border whitespace-nowrap font-medium text-caption text-muted">
                    <span className="block text-secondary">{c.name}</span>
                    <span className="block font-mono text-[10px] text-faint">{c.from}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.preview.map((r, i) => (
                <tr key={i} className="border-b border-border last:border-b-0">
                  {preview.columns.map((c) => {
                    const v = r[c.name];
                    const empty = v === null || v === undefined || v === "";
                    const num = typeof v === "number";
                    return (
                      <td key={c.name} className={`px-2.5 py-2 whitespace-nowrap max-w-[220px] truncate ${num ? "font-mono text-right" : ""} ${empty ? "text-faint" : "text-secondary"}`}>
                        {empty ? "—" : num ? (Number.isInteger(v) ? (v as number).toLocaleString() : (v as number).toFixed(2)) : String(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="flex justify-end gap-2.5 flex-wrap">
        <button type="button" className="btn-secondary text-sm" onClick={onBack}>Change tables</button>
        <button type="button" className="btn-primary text-sm" onClick={onNext}>Looks right — show the plan</button>
      </div>
    </div>
  );
}

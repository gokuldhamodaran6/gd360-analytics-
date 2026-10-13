// 2026-10-12 (round 40): a model trained inside the database IS one SQL
// statement. This panel hands it over - as a SELECT, a view or a dbt model,
// to copy or download - shows that the SQL and the model agree, and runs it
// in the database (read only) to prove it scores every row there.
import { useState } from "react";
import { errorText, mlStudioApi, type Pushdown, type SqlTest } from "../api/mlStudio";
import CodeBlock from "./CodeBlock";
import { compact } from "./StageVisuals";
import { DownloadIcon, SegmentedControl } from "../ui";

type Form = "select" | "view" | "dbt";

const FORM_WORDS: Record<Form, { title: string; how: string }> = {
  select: { title: "Score every row (SELECT)", how: "Run it as it is, or paste it into a dashboard or a scheduled query." },
  view: { title: "Keep it as a view", how: "Create the view once; every query on it scores the newest rows. Needs a schema called gd360_models (or change the name)." },
  dbt: { title: "As a dbt model", how: "Drop it into your dbt project's models folder and point the FROM at your source() or ref()." },
};

export default function ModelSql({ id, pd, canRun }: { id: string; pd: Pushdown; canRun: boolean }) {
  const [form, setForm] = useState<Form>("select");
  const [test, setTest] = useState<SqlTest | null>(pd.last_test || null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const binary = !!test?.buckets;
  const code = pd.sql[form];

  const download = async (f: Form) => {
    setBusy(`dl-${f}`);
    setError("");
    try {
      const blob = await mlStudioApi.sqlFile(id, f);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${pd.out_column}${f === "dbt" ? "_dbt" : f === "view" ? "_view" : ""}.sql`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(errorText(e, "Couldn't download the SQL."));
    } finally {
      setBusy("");
    }
  };

  const run = async () => {
    setBusy("test");
    setError("");
    try {
      setTest(await mlStudioApi.sqlTest(id));
    } catch (e) {
      setError(errorText(e, `Couldn't run it in ${pd.engine}.`));
    } finally {
      setBusy("");
    }
  };

  const maxB = Math.max(1, ...(test?.buckets || []).map((b) => b.rows));
  const agree = pd.agree?.max_diff;
  return (
    <section id="model-sql" className="rounded-card border border-border bg-surface flex flex-col min-w-0" aria-label="The model as SQL" data-ml-sql="">
      <header className="px-4 sm:px-5 pt-4 pb-3 flex flex-col gap-2 border-b border-border">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="m-0 text-[18px] font-semibold text-text">The model as SQL</h2>
          <span className="text-[11px] px-2 py-0.5 rounded-full border border-border text-secondary">{pd.sql.engine}</span>
          <span className="flex-1" />
          <SegmentedControl
            size="sm"
            ariaLabel="Form"
            value={form}
            onChange={(v) => setForm(v as Form)}
            options={[
              { value: "select", label: "SELECT" },
              { value: "view", label: "View" },
              { value: "dbt", label: "dbt" },
            ]}
          />
        </div>
        <p className="m-0 text-ui text-secondary leading-snug">
          One statement scores every row where it lives - in {pd.sql.engine}, adding <span className="font-mono text-text">{pd.out_column}</span>. {FORM_WORDS[form].how}
        </p>
      </header>
      <div className="p-4 sm:p-5 flex flex-col gap-4 min-w-0">
        <CodeBlock entry={{ title: FORM_WORDS[form].title, lang: "sql", engine: pd.sql.engine, code }} />
        <div className="flex gap-2 flex-wrap items-center">
          <button type="button" className="btn-secondary text-sm inline-flex items-center gap-1.5" disabled={!!busy} onClick={() => download(form)} data-ml-sql-download={form}>
            <DownloadIcon size={14} /> {busy === `dl-${form}` ? "Preparing…" : `Download .sql`}
          </button>
          {canRun && (
            <button type="button" className="btn-primary text-sm" disabled={!!busy} onClick={run} data-ml-sql-test="">
              {busy === "test" ? `Running in ${pd.engine}…` : test ? "Run it again" : `Run it in ${pd.engine}`}
            </button>
          )}
          {agree != null && (
            <span className="text-caption text-secondary" data-ml-sql-agree="">
              {pd.agree?.where
                ? <>The SQL and the model agree to {agree < 1e-12 ? "within 10⁻¹²" : agree.toExponential(1)} on all {(pd.agree?.rows ?? 0).toLocaleString()} held-out rows, scored inside {pd.engine}{pd.agree?.synthetic?.max_diff != null ? <> - and with Python on {pd.agree.synthetic.rows} made-up rows</> : null}.</>
                : <>The SQL and the model agree to {agree < 1e-12 ? "within 10⁻¹²" : agree.toExponential(1)} on {pd.agree?.rows} rows {pd.engine} scored during training.</>}
            </span>
          )}
        </div>
        {error && <div role="alert" className="rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-ui text-text">{error}</div>}
        {test && (
          <div className="rounded-card border border-border bg-base px-4 py-3.5 flex flex-col gap-3 min-w-0" data-ml-sql-result="">
            <div className="flex items-baseline gap-x-4 gap-y-1 flex-wrap">
              <span className="text-ui font-semibold text-text">
                {test.rows.toLocaleString()} rows scored in {test.engine}, {test.seconds} s
              </span>
              <span className="text-caption text-muted">
                read only · your access rules applied{test.scanned ? ` · ${compact(test.scanned / 1e6)} MB scanned` : ""} · checked {new Date(test.checked_at).toLocaleString()}
              </span>
            </div>
            {binary ? (
              <div className="flex flex-col gap-1.5" role="list" aria-label="How the scores spread">
                {(test.buckets || []).map((b) => (
                  <div key={b.from} role="listitem" className="grid grid-cols-[72px_minmax(0,1fr)_88px] items-center gap-3 text-caption">
                    <span className="font-mono text-muted tabular-nums">{Math.round(b.from * 100)}–{Math.round(b.to * 100)}%</span>
                    <span className="h-[10px] rounded-full bg-subtle overflow-hidden">
                      <span className="block h-full rounded-full" style={{ width: `${b.rows ? Math.max(1.5, (b.rows / maxB) * 100) : 0}%`, background: "rgb(var(--auto-do))" }} />
                    </span>
                    <span className="font-mono text-secondary tabular-nums text-right">{b.rows.toLocaleString()}</span>
                  </div>
                ))}
                <span className="text-caption text-muted pt-1">
                  Rows by their chance of {pd.out_column.replace(/^chance_/, "").replace(/_/g, " ")} · average {test.mean != null ? `${(test.mean * 100).toFixed(1)}%` : "—"}
                </span>
              </div>
            ) : (
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}>
                {[
                  ["Average", test.mean],
                  ["Lowest", test.min],
                  ["Highest", test.max],
                ].map(([l, v]) => (
                  <div key={String(l)} className="flex flex-col">
                    <span className="text-caption text-muted">{l}</span>
                    <span className="font-mono text-[18px] text-text tabular-nums">{compact(v as number)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

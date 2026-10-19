// R54: the Studio's canvas views - graph, data, plan editor, runs and settings.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { errorText } from "../api/initiatives";
import {
  Check, CheckResult, CleanOp, DAY, Flow, flowsApi, fmtCell, fmtNum, Person, REASON_WORD, Run, runWord, SourceOption, Spec, Step, timeOf, whenOf,
} from "../api/flows";
import { I } from "./icons";

type Act = (name: string, fn: () => Promise<any>, after?: (r: any) => void) => Promise<void>;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const q = (s: any) => `“${s}”`;

/* ------------------------------------------------------------ words ---- */

export function checkWords(c: Check): string {
  if (c.kind === "unique") return `No ${q(c.column)} counted twice`;
  if (c.kind === "not_empty") return `Every row has ${q(c.column)}`;
  if (c.kind === "min") return `${q(c.column)} never below ${c.value}`;
  if (c.kind === "max") return `${q(c.column)} never above ${c.value}`;
  return `Ready by ${c.time}`;
}

function labelOf(spec: Spec, alias: string) {
  return alias === "main" ? "the combined table" : spec.sources.find((s) => s.alias === alias)?.label || alias;
}

const OP_WORD: Record<CleanOp["op"], string> = {
  tidy_key: "Tidy (remove # and spaces)", to_number: "Turn into numbers", set_aside_missing: "Set aside rows with no",
  trim_text: "Trim spaces everywhere", dedupe: "Keep one row per",
};

function stepWords(spec: Spec, st: Step): { title: string; detail: string } {
  if (st.kind === "clean") {
    return { title: `Fix the mistakes in ${labelOf(spec, st.source)}`,
      detail: st.ops.map((o) => (o.op === "trim_text" ? OP_WORD.trim_text : `${OP_WORD[o.op]} ${q(o.column)}`)).join(" · ") };
  }
  if (st.kind === "combine") {
    return { title: `Match ${labelOf(spec, st.right)} to ${labelOf(spec, st.left)}`,
      detail: `${q(st.left_on)} = ${q(st.right_on)} · brings across ${st.right_columns.map(q).join(", ") || "every column"}` };
  }
  if (st.kind === "compute") {
    const sym = { "+": "+", "-": "−", "*": "×", "/": "÷" }[st.op];
    return { title: `Work out ${q(st.column)}`, detail: `= ${q(st.left)} ${sym} ${typeof st.right === "number" ? st.right : q(st.right)}${st.fill === 0 ? " · empty counts as 0" : ""}` };
  }
  if (st.kind === "keep") return { title: `Keep ${st.columns.length} columns`, detail: st.columns.map(q).join(", ") };
  if (st.kind === "rename") {
    return st.source
      ? { title: `Read the right columns from ${labelOf(spec, st.source)}`, detail: Object.entries(st.columns).map(([a, b]) => `use ${q(a)} as ${q(b)}`).join(", ") }
      : { title: "Rename columns", detail: Object.entries(st.columns).map(([a, b]) => `${q(a)} → ${q(b)}`).join(", ") };
  }
  return { title: "Step", detail: "" };
}

function columnsOf(flow: Flow, alias: string): string[] {
  return flow.profile?.sources.find((s) => s.alias === alias)?.columns.map((c) => c.name) || [];
}

function mainColumns(flow: Flow, spec: Spec): string[] {
  const comb = spec.steps.find((s) => s.kind === "combine") as Extract<Step, { kind: "combine" }> | undefined;
  let cols = comb ? [...columnsOf(flow, comb.left), ...comb.right_columns] : columnsOf(flow, spec.sources[0]?.alias);
  for (const st of spec.steps) {
    if (st.kind === "compute" && !cols.includes(st.column)) cols = [...cols, st.column];
    if (st.kind === "rename" && !st.source) cols = cols.map((c) => st.columns[c] || c);
  }
  return Array.from(new Set(cols));
}

/* ------------------------------------------------------------ checks ---- */

export function CheckList({ checks }: { checks: CheckResult[] }) {
  return (
    <div className="fl-card" style={{ overflow: "hidden" }} data-checks="">
      <div className="fl-hd"><span className="fl-h2">Checks</span><span className="sp" /><span className="fl-lbl">rows that fail are flagged, not dropped</span></div>
      {checks.map((c) => {
        const tone = c.status === "passed" ? "good" : c.status === "flagged" || c.status === "late" ? "warn" : c.status === "failed" ? "bad" : "muted";
        const word = c.status === "passed" ? "Passed" : c.status === "flagged" ? `${fmtNum(c.count)} row${c.count === 1 ? "" : "s"}` : c.status === "failed" ? "Failed" : c.status === "late" ? "Late" : "On scheduled runs";
        return (
          <div key={c.id} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "11px 16px", borderTop: "1px solid var(--fl-line)" }} data-check={c.kind} data-check-status={c.status}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13.5 }}>{c.label}{(c.detail || c.note) && <span className="fl-lbl" style={{ display: "block" }}>{c.detail || c.note}</span>}</span>
            <span className={`fl-chip ${tone}`}><i />{word}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------- graph ---- */

export function Graph({ flow, spec }: { flow: Flow; spec: Spec }) {
  const fixAlias = flow.pending_fix?.alias;
  const held = flow.last_status === "held" || flow.last_status === "failed";
  const rows = (a: string) => flow.profile?.sources.find((s) => s.alias === a)?.rows;
  const cleans = spec.steps.filter((s) => s.kind === "clean" && s.enabled !== false) as Extract<Step, { kind: "clean" }>[];
  const nFix = cleans.reduce((n, s) => n + s.ops.length, 0);
  const mids = spec.steps.filter((s) => s.kind !== "clean" && s.enabled !== false && !(s.kind === "rename" && s.source));
  const nChecks = spec.checks.filter((c) => c.enabled !== false).length;
  const two = spec.sources.length > 1;
  return (
    <div className="fl-graph" role="img" aria-label={`Flow: ${spec.sources.map((s) => s.label).join(" and ")}, ${nFix} fixes, ${mids.length} steps, ${nChecks} checks, saved to ${spec.output.name}`} data-flow-graph="">
      <div className="fl-gcol">
        {spec.sources.map((s) => (
          <div key={s.alias} className={`fl-node${fixAlias === s.alias ? " bad" : ""}`}><span className="k">Source</span><b title={s.label}>{s.label}</b><small>{rows(s.alias) != null ? `${fmtNum(rows(s.alias))} rows` : s.table || "table"}</small></div>
        ))}
      </div>
      {two ? (
        <div className="fl-join"><svg viewBox="0 0 26 140" preserveAspectRatio="none" aria-hidden="true"><path d="M0 35 C13 35 13 70 26 70 M0 105 C13 105 13 70 26 70" fill="none" stroke="rgb(var(--color-border-strong))" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg></div>
      ) : <span className="fl-arrow" />}
      {nFix > 0 && <><div className="fl-node"><span className="k">Fix</span><b>Fix the mistakes</b><small>{nFix} fix{nFix === 1 ? "" : "es"}</small></div><span className="fl-arrow" /></>}
      {mids.map((st) => {
        const w = stepWords(spec, st);
        return <span key={st.id} style={{ display: "contents" }}><div className="fl-node"><span className="k">{st.kind === "combine" ? "Combine" : st.kind === "compute" ? "Work out" : "Shape"}</span><b title={w.title}>{w.title.replace(/^Work out /, "")}</b><small title={w.detail}>{w.detail}</small></div><span className="fl-arrow" /></span>;
      })}
      <div className={`fl-node${held ? " bad" : ""}`}><span className="k">Check</span><b>{nChecks} check{nChecks === 1 ? "" : "s"}</b><small>stop if more than {spec.policy.hold_above} odd</small></div>
      <span className="fl-arrow" />
      <div className="fl-node out"><span className="k">Output</span><b>{spec.output.name}</b><small>{flow.output.exists ? "table in Data" : "made on the first real run"}</small></div>
    </div>
  );
}

/* -------------------------------------------------------------- data ---- */

export function DataTab({ flow, sources, act, busy }: { flow: Flow; sources: SourceOption[]; act: Act; busy: string }) {
  const p = flow.profile;
  const [pick, setPick] = useState<string[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileFor, setFileFor] = useState<string | null>(null);
  const kindOf = (id: string) => sources.find((o) => o.id === id)?.kind;
  if (!p) return <div className="fl-empty">GD360 hasn’t read the sources yet.</div>;
  const ids = flow.spec.sources.map((s) => s.datasource_id);
  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <h2 className="fl-h2" style={{ fontSize: 18 }}>What GD360 found in your data</h2>
        <span style={{ flex: 1 }} />
        {flow.can_edit && <>
          <button type="button" className="fl-btn sm" disabled={!!busy} onClick={() => act("replan", () => flowsApi.replan(flow.id))}>Read the sources again</button>
          <button type="button" className="fl-btn sm" onClick={() => setPick(pick ? null : ids)} aria-expanded={!!pick}>Change sources</button>
        </>}
      </div>
      {pick && (
        <div className="fl-card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }} data-source-picker="">
          <span className="fl-sub">Pick up to five sources. GD360 reads them again and rebuilds the plan (your schedule and alerts stay).</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", maxHeight: 200, overflowY: "auto" }}>
            {sources.filter((o) => !o.managed || ids.includes(o.id)).map((o) => (
              <button type="button" key={o.id} className={`fl-pill${pick.includes(o.id) ? " on" : ""}`} aria-pressed={pick.includes(o.id)}
                onClick={() => setPick(pick.includes(o.id) ? pick.filter((x) => x !== o.id) : [...pick, o.id].slice(0, 5))}>{o.name}<span className="fl-lbl">{o.kind.replace("_", " ")}</span></button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="fl-btn pri sm" disabled={!pick.length || !!busy} onClick={() => act("replan", () => flowsApi.replan(flow.id, pick), () => setPick(null))}>Rebuild the plan</button>
            <button type="button" className="fl-btn sm" onClick={() => setPick(null)}>Cancel</button>
          </div>
        </div>
      )}
      {p.link ? (
        <div className="fl-banner" style={{ borderColor: "rgb(var(--color-good) / .4)" }}>
          <span style={{ color: "var(--fl-good)", width: 16, height: 16, display: "inline-flex", flex: "0 0 auto" }}>{I.check}</span>
          <span>Linked by <b>{q(p.link.left_on)}</b> in {labelOf(flow.spec, p.link.left)} and <b>{q(p.link.right_on)}</b> in {labelOf(flow.spec, p.link.right)} - {Math.round(p.link.overlap * 100)}% of rows match once tidied.</span>
        </div>
      ) : flow.spec.sources.length > 1 ? <div className="fl-banner bad">No shared column found between these sources. Pick the columns to match in the Plan.</div> : null}
      <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          const ds = fileFor;
          e.target.value = "";
          if (file && ds) act("upload", () => flowsApi.replaceFile(ds, file));
        }} />
      {p.sources.map((s) => {
        const src = flow.spec.sources.find((x) => x.alias === s.alias);
        const kind = src ? kindOf(src.datasource_id) : undefined;
        const issues = p.issues.filter((i) => i.alias === s.alias);
        return (
          <div key={s.alias} className="fl-card" style={{ overflow: "hidden" }} data-source-card={s.alias}>
            <div className="fl-hd">
              <span style={{ width: 16, height: 16, display: "inline-flex", color: "var(--fl-3)" }}>{I.db}</span>
              <span className="fl-h2">{s.label}</span><span className="fl-lbl">{fmtNum(s.rows)} rows · {s.columns.length} columns{kind ? ` · ${kind.replace("_", " ")}` : ""}</span>
              <span className="sp" />
              {issues.length ? <span className="fl-chip warn"><i />{issues.length} kind{issues.length === 1 ? "" : "s"} of mistake</span> : <span className="fl-chip good"><i />Looks tidy</span>}
              {flow.can_edit && src && (kind === "csv" || kind === "excel") && (
                <button type="button" className="fl-btn sm" disabled={!!busy} onClick={() => { setFileFor(src.datasource_id); fileRef.current?.click(); }} data-upload-today="">{I.upload}Upload today’s file</button>
              )}
            </div>
            {issues.map((i, n) => (
              <div className="fl-issue" key={i.id} data-issue={i.kind}>
                <span className="ic">{n + 1}</span>
                <div style={{ minWidth: 0 }}>
                  <b style={{ fontSize: 13.5 }}>{i.title}</b> <span className="fl-lbl">· {q(i.column)}</span>
                  <div className="fl-sub" style={{ marginTop: 2 }}>{i.detail}</div>
                  <div>{(i.examples || []).map((e, k) => <span key={k} className="fl-ba"><s className="mono">{e.before}</s>→<b className="mono">{String(e.after)}</b></span>)}</div>
                  {i.rows && i.rows.length > 0 && <div className="fl-lbl" style={{ marginTop: 6 }}>{i.rows.map((r) => Object.values(r).slice(0, 4).map(fmtNum).join(" · ")).join("   |   ")}</div>}
                </div>
              </div>
            ))}
            {s.sample.length > 0 && (
              <div className="fl-tw" style={{ borderTop: "1px solid var(--fl-line)" }}>
                <table className="fl-t"><thead><tr>{Object.keys(s.sample[0]).slice(0, 8).map((k) => <th key={k}>{k}</th>)}</tr></thead><tbody>
                  {s.sample.map((r, i) => <tr key={i}>{Object.keys(s.sample[0]).slice(0, 8).map((k) => <td key={k} className={typeof r[k] === "number" ? "mono" : ""}>{fmtCell(k, r[k])}</td>)}</tr>)}
                </tbody></table>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/* -------------------------------------------------------------- plan ---- */

export function PlanTab({ flow, onSaved, setErr, act, busy }: { flow: Flow; onSaved: (f: Flow) => void; setErr: (s: string) => void; act: Act; busy: string }) {
  const [draft, setDraft] = useState<Spec>(() => clone(flow.spec));
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(clone(flow.spec)); }, [flow.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(draft) !== JSON.stringify(flow.spec);
  const edit = flow.can_edit;
  const setStep = (id: string, fn: (s: any) => void) => setDraft((d) => { const n = clone(d); const st = n.steps.find((x) => x.id === id); if (st) fn(st); return n; });
  const save = async () => {
    setSaving(true);
    try { onSaved(await flowsApi.saveSpec(flow.id, draft, "Edited the plan")); } catch (e) { setErr(errorText(e)); } finally { setSaving(false); }
  };
  const mainCols = useMemo(() => mainColumns(flow, draft), [flow, draft]);
  void act;
  void busy;
  let n = 1;
  return (
    <>
      <Graph flow={flow} spec={draft} />
      <div className="fl-card fl-plan" data-flow-plan="">
        <div>
          <span className="fl-num">{n++}</span>
          <span><b style={{ fontSize: 14 }}>Read {draft.sources.length} source{draft.sources.length === 1 ? "" : "s"}</b><span className="d">{draft.sources.map((s) => s.label).join(" · ")} · read-only, nothing in them is changed</span></span>
          <span />
        </div>
        {draft.steps.map((st) => {
          const w = stepWords(draft, st);
          const on = st.enabled !== false;
          const isOpen = open === st.id;
          return (
            <div key={st.id} data-step={st.kind}>
              <span className="fl-num" style={on ? undefined : { opacity: .4 }}>{n++}</span>
              <span className={on ? "" : "off"} style={{ minWidth: 0 }}>
                <b style={{ fontSize: 14 }}>{w.title}</b><span className="d">{w.detail}</span>
                {isOpen && edit && <StepEditor flow={flow} spec={draft} st={st} setStep={setStep} mainCols={mainCols} />}
              </span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {edit && st.kind !== "rename" && st.kind !== "keep" && <button type="button" className="fl-btn ghost sm" onClick={() => setOpen(isOpen ? null : st.id)} aria-expanded={isOpen}>{isOpen ? "Done" : "Edit"}</button>}
                {edit && st.kind === "compute" && <button type="button" className="fl-btn ghost sm" aria-label="Remove this step" onClick={() => setDraft((d) => ({ ...d, steps: d.steps.filter((x) => x.id !== st.id) }))}>{I.x}</button>}
                <button type="button" className="fl-sw" role="switch" aria-checked={on} aria-label={`${on ? "Turn off" : "Turn on"}: ${w.title}`} disabled={!edit}
                  onClick={() => setStep(st.id, (s) => { s.enabled = !on; })} />
              </span>
            </div>
          );
        })}
        <div>
          <span className="fl-num">{n++}</span>
          <span style={{ minWidth: 0 }}><b style={{ fontSize: 14 }}>Check, then save</b><span className="d">If more than {draft.policy.hold_above} rows look odd, nothing is saved and you’re told.</span>
            <ChecksEditor spec={draft} setSpec={setDraft} cols={mainCols} edit={edit} />
          </span>
          <span />
        </div>
        <div>
          <span className="fl-num">{n++}</span>
          <span style={{ minWidth: 0 }}><b style={{ fontSize: 14 }}>Save to {draft.output.name}</b><span className="d">A table in Data that dashboards, docs and questions can use. Rows that look odd get a note in “review_note”.</span>
            {edit && <div className="fl-edit"><label className="fl-lbl" htmlFor="fl-out">Table name</label><input id="fl-out" className="fl-in" value={draft.output.name} maxLength={60}
              onChange={(e) => setDraft((d) => ({ ...d, output: { name: e.target.value.replace(/[^A-Za-z0-9_]+/g, "_").toLowerCase() } }))} /></div>}
          </span>
          <span />
        </div>
      </div>
      {edit && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="fl-btn sm" onClick={() => {
            const cols = mainCols.filter(Boolean);
            const id = `calc_${Math.random().toString(36).slice(2, 7)}`;
            setDraft((d) => ({ ...d, steps: [...d.steps, { id, kind: "compute", column: "new_value", left: cols[0] || "", op: "-", right: cols[1] || 0, fill: 0, enabled: true }] }));
            setOpen(id);
          }}>{I.plus}Add a calculation</button>
          {draft.sources.filter((s) => !draft.steps.some((x) => x.kind === "clean" && x.source === s.alias)).map((s) => (
            <button key={s.alias} type="button" className="fl-btn sm" onClick={() => {
              const id = `clean_${s.alias}`.slice(0, 40);
              setDraft((d) => {
                const steps = [...d.steps];
                const at = steps.findIndex((x) => x.kind === "combine");
                steps.splice(at < 0 ? steps.length : at, 0, { id, kind: "clean", source: s.alias, ops: [{ op: "trim_text" }], enabled: true });
                return { ...d, steps };
              });
              setOpen(id);
            }}>{I.plus}Add a fix to {s.label}</button>
          ))}
        </div>
      )}
      {dirty && (
        <div className="fl-card" style={{ position: "sticky", bottom: 0, padding: "10px 14px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", boxShadow: "0 -10px 30px -18px rgb(0 0 0 / .5)" }} data-plan-dirty="">
          <span className="fl-sub" style={{ flex: 1 }}>Unsaved changes. Saving makes version {flow.version + 1}; you can go back any time. Test again after saving.</span>
          <button type="button" className="fl-btn sm" onClick={() => setDraft(clone(flow.spec))}>Discard</button>
          <button type="button" className="fl-btn pri sm" disabled={saving} onClick={save} data-plan-save="">Save changes</button>
        </div>
      )}
    </>
  );
}

function StepEditor({ flow, spec, st, setStep, mainCols }: { flow: Flow; spec: Spec; st: Step; setStep: (id: string, fn: (s: any) => void) => void; mainCols: string[] }) {
  const [addOp, setAddOp] = useState<CleanOp["op"]>("tidy_key");
  const [addCol, setAddCol] = useState("");
  if (st.kind === "clean") {
    const cols = columnsOf(flow, st.source);
    return (
      <div className="fl-edit">
        {st.ops.map((o, i) => (
          <span key={i} className="fl-chip">{o.op === "trim_text" ? OP_WORD.trim_text : `${OP_WORD[o.op]} ${q(o.column)}`}
            {st.ops.length > 1 && <button type="button" aria-label="Remove this fix" onClick={() => setStep(st.id, (s) => { s.ops.splice(i, 1); })}
              style={{ border: 0, background: "transparent", color: "inherit", cursor: "pointer", padding: 0, display: "inline-flex", width: 14, height: 14 }}>{I.x}</button>}
          </span>
        ))}
        <select className="fl-sel" value={addOp} onChange={(e) => setAddOp(e.target.value as CleanOp["op"])} aria-label="Kind of fix">
          {(Object.keys(OP_WORD) as CleanOp["op"][]).map((k) => <option key={k} value={k}>{OP_WORD[k]}</option>)}
        </select>
        {addOp !== "trim_text" && <select className="fl-sel" value={addCol} onChange={(e) => setAddCol(e.target.value)} aria-label="Column">
          <option value="">Column…</option>{cols.map((c) => <option key={c} value={c}>{c}</option>)}</select>}
        <button type="button" className="fl-btn sm" disabled={addOp !== "trim_text" && !addCol}
          onClick={() => setStep(st.id, (s) => { s.ops.push(addOp === "trim_text" ? { op: addOp } : { op: addOp, column: addCol }); })}>Add</button>
      </div>
    );
  }
  if (st.kind === "combine") {
    const L = columnsOf(flow, st.left), R = columnsOf(flow, st.right);
    return (
      <div className="fl-edit" style={{ flexDirection: "column", alignItems: "flex-start" }}>
        <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="fl-lbl">Match</span>
          <select className="fl-sel" value={st.left_on} onChange={(e) => setStep(st.id, (s) => { s.left_on = e.target.value; })} aria-label={`Column in ${labelOf(spec, st.left)}`}>{L.map((c) => <option key={c}>{c}</option>)}</select>
          <span className="fl-lbl">with</span>
          <select className="fl-sel" value={st.right_on} onChange={(e) => setStep(st.id, (s) => { s.right_on = e.target.value; })} aria-label={`Column in ${labelOf(spec, st.right)}`}>{R.map((c) => <option key={c}>{c}</option>)}</select>
          <select className="fl-sel" value={st.aggregate} onChange={(e) => setStep(st.id, (s) => { s.aggregate = e.target.value; })} aria-label="When a row matches more than once">
            <option value="sum">Add up repeats</option><option value="first">Keep the first</option><option value="count">Count them</option>
          </select>
        </span>
        <span className="fl-lbl">Bring across</span>
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {R.filter((c) => c !== st.right_on).map((c) => (
            <button key={c} type="button" className={`fl-pill${st.right_columns.includes(c) ? " on" : ""}`} aria-pressed={st.right_columns.includes(c)}
              onClick={() => setStep(st.id, (s) => { s.right_columns = s.right_columns.includes(c) ? s.right_columns.filter((x: string) => x !== c) : [...s.right_columns, c]; })}>{c}</button>
          ))}
        </span>
      </div>
    );
  }
  if (st.kind === "compute") {
    const numeric = typeof st.right === "number";
    return (
      <div className="fl-edit">
        <input className="fl-in" value={st.column} onChange={(e) => setStep(st.id, (s) => { s.column = e.target.value; })} aria-label="New column name" style={{ width: 140 }} />
        <span className="fl-lbl">=</span>
        <select className="fl-sel" value={st.left} onChange={(e) => setStep(st.id, (s) => { s.left = e.target.value; })} aria-label="First column">{mainCols.map((c) => <option key={c}>{c}</option>)}</select>
        <select className="fl-sel" value={st.op} onChange={(e) => setStep(st.id, (s) => { s.op = e.target.value; })} aria-label="Operation">
          <option value="+">+</option><option value="-">−</option><option value="*">×</option><option value="/">÷</option>
        </select>
        {numeric ? <input className="fl-in num" type="number" value={st.right as number} onChange={(e) => setStep(st.id, (s) => { s.right = Number(e.target.value); })} aria-label="Number" />
          : <select className="fl-sel" value={st.right as string} onChange={(e) => setStep(st.id, (s) => { s.right = e.target.value; })} aria-label="Second column">{mainCols.map((c) => <option key={c}>{c}</option>)}</select>}
        <button type="button" className="fl-btn ghost sm" onClick={() => setStep(st.id, (s) => { s.right = numeric ? (mainCols[0] || "") : 0; })}>{numeric ? "Use a column" : "Use a number"}</button>
        <label className="fl-lbl" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={st.fill === 0} onChange={(e) => setStep(st.id, (s) => { s.fill = e.target.checked ? 0 : null; })} />Empty counts as 0
        </label>
      </div>
    );
  }
  return null;
}

function ChecksEditor({ spec, setSpec, cols, edit }: { spec: Spec; setSpec: (fn: (s: Spec) => Spec) => void; cols: string[]; edit: boolean }) {
  const [kind, setKind] = useState<Check["kind"]>("unique");
  const [col, setCol] = useState("");
  const [val, setVal] = useState("0");
  const upd = (id: string, fn: (c: Check) => void) => setSpec((d) => { const n = clone(d); const c = n.checks.find((x) => x.id === id); if (c) fn(c); return n; });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
      {spec.checks.map((c) => (
        <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13.5 }} data-check-row={c.kind}>
          <button type="button" className="fl-sw" role="switch" aria-checked={c.enabled !== false} aria-label={`Check: ${checkWords(c)}`} disabled={!edit}
            onClick={() => upd(c.id, (x) => { x.enabled = x.enabled === false; })} />
          <span style={{ opacity: c.enabled === false ? .5 : 1 }}>{checkWords(c)}</span>
          {edit && (c.kind === "min" || c.kind === "max") && <input className="fl-in num" type="number" value={c.value ?? 0} aria-label="Limit" onChange={(e) => upd(c.id, (x) => { x.value = Number(e.target.value); })} />}
          {edit && c.kind === "ready_by" && <input className="fl-in" type="time" value={c.time} aria-label="Ready by" onChange={(e) => upd(c.id, (x) => { x.time = e.target.value; })} />}
          {edit && <button type="button" className="fl-btn ghost sm" aria-label={`Remove check: ${checkWords(c)}`} onClick={() => setSpec((d) => ({ ...d, checks: d.checks.filter((x) => x.id !== c.id) }))}>{I.x}</button>}
        </div>
      ))}
      {edit && (
        <div className="fl-edit">
          <select className="fl-sel" value={kind} onChange={(e) => setKind(e.target.value as Check["kind"])} aria-label="New check">
            <option value="unique">No duplicates in…</option><option value="not_empty">Never empty…</option><option value="min">At least…</option><option value="max">At most…</option>
          </select>
          <select className="fl-sel" value={col} onChange={(e) => setCol(e.target.value)} aria-label="Column"><option value="">Column…</option>{cols.map((c) => <option key={c}>{c}</option>)}</select>
          {(kind === "min" || kind === "max") && <input className="fl-in num" type="number" value={val} onChange={(e) => setVal(e.target.value)} aria-label="Limit" />}
          <button type="button" className="fl-btn sm" disabled={!col} onClick={() => {
            const c: Check = { id: `c_${Math.random().toString(36).slice(2, 7)}`, kind, column: col, enabled: true, ...(kind === "min" || kind === "max" ? { value: Number(val) || 0 } : {}) };
            setSpec((d) => ({ ...d, checks: [...d.checks.filter((x) => x.kind !== "ready_by"), c, ...d.checks.filter((x) => x.kind === "ready_by")] }));
            setCol("");
          }}>Add check</button>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- runs ---- */

export function RunsTab({ flow, fixCard }: { flow: Flow; fixCard: React.ReactNode }) {
  const runs = flow.runs;
  const [sel, setSel] = useState<string | null>(runs[0]?.id || null);
  const [run, setRun] = useState<Run | null>(null);
  useEffect(() => { if (!sel && runs[0]) setSel(runs[0].id); }, [runs, sel]);
  useEffect(() => {
    if (!sel) { setRun(null); return; }
    flowsApi.getRun(sel).then(setRun).catch(() => setRun(null));
  }, [sel, flow.last_run_at, flow.running?.id]);
  const maxSecs = Math.max(1, ...runs.map((r) => r.seconds || 0));
  const ordered = [...runs].reverse();
  return (
    <>
      {fixCard}
      <div className="fl-2col">
        <div className="fl-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="fl-lbl">Schedule</span>
          <b style={{ fontSize: 15 }}>{flow.enabled ? `${flow.schedule_text} · ${flow.spec.schedule.timezone}` : "Not running on its own"}</b>
          <span className="fl-sub">{flow.enabled ? `Next run ${flow.next_run_text || "soon"}.${flow.spec.schedule.on_change ? " Also runs when a source changes (checked every 10 minutes)." : ""}` : flow.status === "draft" ? "Test it, then turn it on." : "Turn it on to run it every day."}</span>
        </div>
        <div className="fl-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span className="fl-lbl">Last {runs.length} real runs</span><span className="fl-lbl">bar height = time taken</span></div>
          {runs.length ? (
            <div className="fl-hist" role="group" aria-label="Recent runs">
              {ordered.map((r) => (
                <button key={r.id} type="button" className={`${r.status}${sel === r.id ? " sel" : ""}`} style={{ height: `${Math.max(14, ((r.seconds || 0) / maxSecs) * 100)}%` }}
                  aria-label={`${REASON_WORD[r.reason] || r.reason} ${whenOf(r.started_at)}: ${runWord(r.reason, r.status)}`} title={`${whenOf(r.started_at)} · ${runWord(r.reason, r.status)}`} onClick={() => setSel(r.id)} />
              ))}
            </div>
          ) : <span className="fl-sub">No real runs yet.</span>}
          <span className="fl-lbl">{runs.filter((r) => r.status === "success").length} of {runs.length} saved{runs.some((r) => r.status === "held") ? ` · ${runs.filter((r) => r.status === "held").length} held` : ""}</span>
        </div>
      </div>
      {run && (
        <div className="fl-2col">
          <div className="fl-card" style={{ padding: "14px 16px" }} data-run-timeline="">
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
              <b style={{ fontSize: 14 }}>{REASON_WORD[run.reason] || run.reason} · {whenOf(run.started_at)}</b>
              <span className={`fl-chip ${run.status === "success" ? "good" : run.status === "running" ? "muted" : "bad"}`}><i />{runWord(run.reason, run.status)}</span>
            </div>
            <div className="fl-tl">
              {run.events.map((e, i) => <div key={i}><span className="t">{timeOf(e.at)}</span><i className={e.status === "ok" ? "" : e.status} /><span>{e.text}</span></div>)}
              {run.deliveries?.filter((d: any) => d.status === "sent").map((d: any, i: number) => (
                <div key={`d${i}`}><span className="t">{timeOf(run.finished_at)}</span><i /><span>Told {d.to} ({d.channel === "in_app" ? "in GD360" : d.channel})</span></div>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {run.checks.length > 0 && <CheckList checks={run.checks} />}
            {run.error && <div className="fl-banner bad">{run.error}</div>}
          </div>
        </div>
      )}
      {!runs.length && !fixCard && <div className="fl-empty">Real runs appear here with a timeline of what happened, minute by minute.</div>}
    </>
  );
}

/* ---------------------------------------------------------- settings ---- */

const ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "Australia/Sydney", "UTC"];

export function SettingsTab({ flow, people, onSaved, setErr, act, busy }: { flow: Flow; people: Person[]; onSaved: (f: Flow) => void; setErr: (s: string) => void; act: Act; busy: string }) {
  const navigate = useNavigate();
  const [d, setD] = useState<Spec>(() => clone(flow.spec));
  const [saving, setSaving] = useState(false);
  const [sure, setSure] = useState(false);
  useEffect(() => { setD(clone(flow.spec)); }, [flow.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(d) !== JSON.stringify(flow.spec);
  const edit = flow.can_edit;
  const sch = d.schedule, pol = d.policy;
  const zones = Array.from(new Set([sch.timezone, ...ZONES]));
  const setSch = (k: keyof Spec["schedule"], v: any) => setD((x) => ({ ...x, schedule: { ...x.schedule, [k]: v } }));
  const setPol = (k: keyof Spec["policy"], v: any) => setD((x) => ({ ...x, policy: { ...x.policy, [k]: v } }));
  const togglePerson = (k: "flag_to" | "alert_to", id: string) => setPol(k, pol[k].includes(id) ? pol[k].filter((x) => x !== id) : [...pol[k], id]);
  const save = async () => {
    setSaving(true);
    try { onSaved(await flowsApi.saveSpec(flow.id, d, "Changed the settings")); } catch (e) { setErr(errorText(e)); } finally { setSaving(false); }
  };
  const peopleList = people.length ? people : Object.entries(flow.people).map(([id, name]) => ({ id, name, email: "" }));
  return (
    <>
      <div className="fl-card fl-set" data-flow-settings="">
        <div><span className="l">Runs at</span>
          <input className="fl-in" type="time" value={sch.time} disabled={!edit} onChange={(e) => setSch("time", e.target.value)} aria-label="Run time" />
          <select className="fl-sel" value={sch.timezone} disabled={!edit} onChange={(e) => setSch("timezone", e.target.value)} aria-label="Time zone">{zones.map((z) => <option key={z}>{z}</option>)}</select>
        </div>
        <div><span className="l">On these days</span>
          <span className="fl-days">{DAY.map((w, i) => (
            <button key={w} type="button" aria-pressed={sch.days.includes(i)} disabled={!edit}
              onClick={() => setSch("days", sch.days.includes(i) ? (sch.days.length > 1 ? sch.days.filter((x) => x !== i) : sch.days) : [...sch.days, i].sort())}>{w}</button>
          ))}</span>
        </div>
        <div><span className="l">Also run when a source changes</span>
          <button type="button" className="fl-sw" role="switch" aria-checked={sch.on_change} disabled={!edit} onClick={() => setSch("on_change", !sch.on_change)} aria-label="Run when a source changes" />
          <span className="fl-lbl">Files, sheets and synced apps are checked every 10 minutes.</span>
        </div>
        <div><span className="l">Safety limit</span>
          <span className="fl-sub">If more than</span>
          <input className="fl-in num" type="number" min={0} value={pol.hold_above} disabled={!edit} onChange={(e) => setPol("hold_above", Math.max(0, Math.round(Number(e.target.value) || 0)))} aria-label="Safety limit (rows)" />
          <span className="fl-sub">rows look odd, don’t update anything and tell people below.</span>
        </div>
        <div><span className="l">Send rows that look odd to</span>
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{peopleList.map((p) => (
            <button key={p.id} type="button" className={`fl-pill${pol.flag_to.includes(p.id) ? " on" : ""}`} aria-pressed={pol.flag_to.includes(p.id)} disabled={!edit} onClick={() => togglePerson("flag_to", p.id)}>{p.name}</button>
          ))}</span>
        </div>
        <div><span className="l">Tell when a run is held or stops</span>
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{peopleList.map((p) => (
            <button key={p.id} type="button" className={`fl-pill${pol.alert_to.includes(p.id) ? " on" : ""}`} aria-pressed={pol.alert_to.includes(p.id)} disabled={!edit} onClick={() => togglePerson("alert_to", p.id)}>{p.name}</button>
          ))}</span>
          <span className="fl-lbl">In GD360 and by email.</span>
        </div>
        <div><span className="l">Daily “it’s ready” message</span>
          <button type="button" className="fl-sw" role="switch" aria-checked={pol.daily_summary} disabled={!edit} onClick={() => setPol("daily_summary", !pol.daily_summary)} aria-label="Daily message" />
          <span className="fl-lbl">Off = you only hear about problems.</span>
        </div>
      </div>
      {edit && dirty && (
        <div className="fl-card" style={{ position: "sticky", bottom: 0, padding: "10px 14px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span className="fl-sub" style={{ flex: 1 }}>Unsaved changes - saving makes version {flow.version + 1}.</span>
          <button type="button" className="fl-btn sm" onClick={() => setD(clone(flow.spec))}>Discard</button>
          <button type="button" className="fl-btn pri sm" disabled={saving} onClick={save} data-settings-save="">Save settings</button>
        </div>
      )}
      <div className="fl-card" style={{ padding: "14px 16px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ flex: 1, minWidth: 220 }}><b style={{ fontSize: 14 }}>Output table</b><span className="fl-sub" style={{ display: "block" }}>{flow.output.exists ? `${flow.output.name} is in Data. Deleting this flow keeps the table, but it stops updating.` : "Made on the first real run."}</span></span>
        {flow.output.exists && flow.output.datasource_id && <Link className="fl-btn sm" to={`/workspace/${flow.output.datasource_id}`}>{I.open}Open the table</Link>}
        {edit && (sure ? (
          <>
            <span className="fl-sub">Delete this flow and its history?</span>
            <button type="button" className="fl-btn danger sm" disabled={!!busy} onClick={async () => {
              try { await flowsApi.remove(flow.id); navigate("/automate"); } catch (e) { setErr(errorText(e)); }
            }}>Delete</button>
            <button type="button" className="fl-btn sm" onClick={() => setSure(false)}>Keep it</button>
          </>
        ) : <button type="button" className="fl-btn danger sm" onClick={() => setSure(true)}>Delete flow</button>)}
      </div>
    </>
  );
}

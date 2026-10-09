// Mission Control · Segments — build an audience from user attributes, see
// who matches live, save it, export it.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { errText, mcDelete, mcDownload, mcPost, useMC } from "../api";
import { ActionButton, ago, Card, Empty, ErrorBox, fmtN, fmtPct, Loading, PageHead, Pill, useCan } from "../ui";

type FieldType = "number" | "bool" | "text";
type Field = { key: string; label: string; type: FieldType };
type Rule = { field: string; op: string; value: string };

const NO_PERM = "Your role can't do this";
const OPS: Record<FieldType, [string, string][]> = {
  number: [["gte", "at least"], ["gt", "more than"], ["lte", "at most"], ["lt", "less than"], ["eq", "equals"], ["neq", "is not"]],
  bool: [["is_true", "is yes"], ["is_false", "is no"]],
  text: [["eq", "is"], ["neq", "is not"], ["contains", "contains"]],
};
const CHOICES: Record<string, string[]> = {
  lifecycle: ["Signed up", "Activated", "Engaged", "Dormant"],
  status: ["active", "new", "dormant", "locked", "suspended"],
  plan: ["Early access"],
};

const defaultValue = (f?: Field) => (!f ? "" : f.type === "bool" ? "true" : CHOICES[f.key]?.[0] ?? "");

/** Rules from the API (numbers / booleans) → editable rows (strings). */
function toRows(rules: any[], fields: Field[]): Rule[] {
  return (rules || []).map((r) => {
    const f = fields.find((x) => x.key === r.field);
    if (f?.type === "bool") {
      const off = r.op === "is_false" || ["false", "no", "0"].includes(String(r.value).toLowerCase());
      return { field: r.field, op: off ? "is_false" : "is_true", value: "true" };
    }
    return { field: r.field, op: r.op, value: r.value == null ? "" : String(r.value) };
  });
}

/** Editable rows → API rules; incomplete number rules are left out. */
function toApi(rows: Rule[], fields: Field[]) {
  const out: { field: string; op: string; value: any }[] = [];
  for (const r of rows) {
    const f = fields.find((x) => x.key === r.field);
    if (!f) continue;
    if (f.type === "bool") out.push({ field: r.field, op: r.op, value: true });
    else if (f.type === "number") {
      if (r.value.trim() === "" || Number.isNaN(Number(r.value))) continue;
      out.push({ field: r.field, op: r.op, value: Number(r.value) });
    } else out.push({ field: r.field, op: r.op, value: r.value });
  }
  return out;
}

function ruleText(r: any, fields: Field[]) {
  const f = fields.find((x) => x.key === r.field);
  if (!f) return r.field;
  const op = OPS[f.type].find(([k]) => k === r.op)?.[1] ?? r.op;
  return f.type === "bool" ? `${f.label} ${toRows([r], fields)[0].op === "is_false" ? "is no" : "is yes"}` : `${f.label} ${op} ${r.value}`;
}

export default function Segments() {
  const { data, error, loading, reload } = useMC<any>("/segments");
  const can = useCan();
  const fields: Field[] = data?.fields || [];
  const [rows, setRows] = useState<Rule[]>([]);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [pErr, setPErr] = useState("");
  const [pBusy, setPBusy] = useState(false);
  const seq = useRef(0);

  const apiRules = toApi(rows, fields);
  const rulesKey = JSON.stringify(apiRules);

  useEffect(() => {
    if (!data) return;
    const n = ++seq.current;
    setPBusy(true);
    const id = setTimeout(async () => {
      try {
        const r = await mcPost("/segments/preview", { rules: JSON.parse(rulesKey) });
        if (n === seq.current) { setPreview(r); setPErr(""); }
      } catch (e) {
        if (n === seq.current) setPErr(errText(e, "Couldn't preview this segment."));
      } finally {
        if (n === seq.current) setPBusy(false);
      }
    }, 400);
    return () => clearTimeout(id);
  }, [rulesKey, !!data]); // eslint-disable-line react-hooks/exhaustive-deps

  const setRule = (i: number, patch: Partial<Rule>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const changeField = (i: number, key: string) => {
    const f = fields.find((x) => x.key === key);
    setRule(i, { field: key, op: f ? OPS[f.type][0][0] : "eq", value: defaultValue(f) });
  };
  const addRule = () => {
    const f = fields[0];
    if (f) setRows([...rows, { field: f.key, op: OPS[f.type][0][0], value: defaultValue(f) }]);
  };
  const load = (rules: any[], n: string) => { setRows(toRows(rules, fields)); setName(n); };

  const saved: any[] = data?.saved || [];
  const templates: any[] = data?.templates || [];
  const share = preview && preview.of ? (preview.count / preview.of) * 100 : null;

  return (
    <div className="mc-page">
      <PageHead eyebrow="Customers" title="Segments" sub="Build an audience from usage and profile attributes. Every rule must match. Counts are live from GD360's own tables.">
        <button type="button" className="mc-btn" onClick={() => { setRows([]); setName(""); }}>New segment</button>
        <button type="button" className="mc-btn" onClick={reload}>Refresh</button>
      </PageHead>

      {error && <ErrorBox text={error} retry={reload} />}
      {loading && !data && <Loading rows={4} />}
      {data && (
        <div className="mc-row">
          <aside className="mc-col" style={{ flex: "1 1 300px", gap: 16 }} aria-label="Saved segments">
            <Card title={`SAVED · LIVE COUNTS · ${saved.length}`}>
              {saved.length === 0 ? <Empty>No saved segments yet. Build one on the right and save it.</Empty> : saved.map((s) => (
                <div key={s.id} style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 0", borderBottom: "1px solid var(--line0)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
                    <span style={{ fontWeight: 700, fontSize: 14, minWidth: 0, overflowWrap: "anywhere" }}>{s.name}</span>
                    <span className="mc-mono mc-num" style={{ fontSize: 16, fontWeight: 800, color: "var(--g)" }}>{fmtN(s.count)}</span>
                  </div>
                  <span className="mc-tip">{(s.rules || []).length ? (s.rules || []).map((r: any) => ruleText(r, fields)).join(" · ") : "Everyone"}</span>
                  <span className="mc-tip">{s.created_by} · {ago(s.created_at)}</span>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button type="button" className="mc-btn sm" onClick={() => load(s.rules, s.name)}>Load</button>
                    <ActionButton className="mc-btn sm" run={() => mcDownload(`/segments/${s.id}/export.csv`, `segment-${s.name.replace(/[^\w-]+/g, "-").toLowerCase()}.csv`)} done="CSV downloaded">Export CSV</ActionButton>
                    <ActionButton className="mc-btn sm d" run={async () => { await mcDelete(`/segments/${s.id}`); reload(); }} done="Segment deleted"
                      disabled={!can("segments.write")} title={can("segments.write") ? undefined : NO_PERM} confirm="Delete it?">Delete</ActionButton>
                  </div>
                </div>
              ))}
            </Card>
          </aside>

          <div className="mc-col" style={{ flex: "999 1 560px", gap: 16 }}>
            <Card title="RULES · ALL MUST MATCH" right={<span className="mc-tip">Start from a template or add rules</span>}>
              <div className="mc-chips">
                {templates.map((t) => (
                  <button key={t.name} type="button" className="mc-chip" onClick={() => load(t.rules, t.name)}>{t.name}</button>
                ))}
              </div>
              {rows.length === 0 && <span className="mc-tip">No rules yet — everyone matches.</span>}
              {rows.map((r, i) => {
                const f = fields.find((x) => x.key === r.field);
                const type: FieldType = f?.type || "text";
                return (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span className="mc-mono" style={{ width: 40, fontSize: 11, color: "var(--ink3)" }}>{i === 0 ? "WHERE" : "AND"}</span>
                    <select className="mc-select" aria-label="Field" style={{ flex: "1 1 200px" }} value={r.field} onChange={(e) => changeField(i, e.target.value)}>
                      {fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                    </select>
                    <select className="mc-select" aria-label="Operator" style={{ flex: "0 1 130px" }} value={r.op} onChange={(e) => setRule(i, { op: e.target.value })}>
                      {OPS[type].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                    {type === "number" && (
                      <input className="mc-input" type="number" aria-label="Value" style={{ flex: "0 1 120px", borderColor: r.value.trim() === "" ? "var(--amber)" : undefined }}
                        value={r.value} placeholder="number" onChange={(e) => setRule(i, { value: e.target.value })} />
                    )}
                    {type === "text" && (CHOICES[r.field] && r.op !== "contains" ? (
                      <select className="mc-select" aria-label="Value" style={{ flex: "0 1 160px" }} value={r.value} onChange={(e) => setRule(i, { value: e.target.value })}>
                        {CHOICES[r.field].map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    ) : (
                      <input className="mc-input" aria-label="Value" style={{ flex: "0 1 160px" }} value={r.value} placeholder={r.field === "domain" ? "acme.com" : "text"}
                        onChange={(e) => setRule(i, { value: e.target.value })} />
                    ))}
                    <button type="button" className="mc-btn sm" aria-label={`Remove rule ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
                  </div>
                );
              })}
              <div>
                <button type="button" className="mc-btn sm" onClick={addRule}>+ Add a rule</button>
              </div>
              {rows.length > apiRules.length && <span className="mc-tip" style={{ color: "var(--amber)" }}>Rules without a number are ignored until you fill them in.</span>}
            </Card>

            <Card title="AUDIENCE" right={pBusy ? <span className="mc-mono" style={{ fontSize: 11, color: "var(--ink3)" }}>UPDATING…</span> : undefined}>
              {pErr && <ErrorBox text={pErr} />}
              {!preview && !pErr && <div className="mc-skel" style={{ height: 80 }} />}
              {preview && (
                <>
                  <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span className="mc-lbl">PEOPLE</span>
                      <span className="mc-kpi-v mc-num" style={{ color: "var(--g)" }}>{fmtN(preview.count)}</span>
                      <span className="mc-sub">{fmtPct(share)} of {fmtN(preview.of)}</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span className="mc-lbl">ACCOUNTS</span>
                      <span className="mc-kpi-v mc-num">{fmtN(preview.accounts)}</span>
                      <span className="mc-sub">distinct accounts</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span className="mc-lbl">COMPANY EMAIL</span>
                      <span className="mc-kpi-v mc-num">{fmtN(preview.corporate)}</span>
                      <span className="mc-sub">on a company domain</span>
                    </div>
                  </div>
                  <div className="mc-bar"><div style={{ width: `${share ?? 0}%` }} /></div>
                </>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", borderTop: "1px solid var(--line)", paddingTop: 12 }}>
                <label htmlFor="seg-name" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Segment name</label>
                <input id="seg-name" className="mc-input" style={{ flex: "1 1 220px" }} value={name} maxLength={120} placeholder="Name this segment" onChange={(e) => setName(e.target.value)} />
                <ActionButton className="mc-btn p" done="Segment saved"
                  disabled={!can("segments.write") || !name.trim()}
                  title={!can("segments.write") ? NO_PERM : !name.trim() ? "Name it first" : "Save as a new segment"}
                  run={async () => { await mcPost("/segments", { name: name.trim(), rules: apiRules }); reload(); }}>Save segment</ActionButton>
              </div>
              <span className="mc-tip">Saving always creates a new segment, so loading and re-saving keeps the original.</span>
            </Card>

            {preview && (
              <Card title={`PREVIEW · TOP ${Math.min(preview.sample.length, 25)} BY QUESTIONS`} pad>
                {preview.sample.length === 0 ? <Empty>No one matches these rules. Loosen a rule to widen the audience.</Empty> : (
                  <div className="mc-tablewrap">
                    <table className="mc-table" style={{ minWidth: 640 }}>
                      <thead><tr><th>PERSON</th><th>STAGE</th><th>QUESTIONS 30D</th><th>SOURCES</th><th>LAST ACTIVE</th></tr></thead>
                      <tbody>
                        {preview.sample.map((p: any) => (
                          <tr key={p.id}>
                            <td>
                              <Link to={`/admin/people?q=${encodeURIComponent(p.email && !p.email.includes("•") ? p.email : p.name || "")}&open=${encodeURIComponent(p.id)}`} className="mc-rowbtn" style={{ color: "var(--ink)" }}>
                                <span style={{ fontWeight: 700 }}>{p.name || p.email}</span>
                                <span className="mc-tip">{p.email}</span>
                              </Link>
                            </td>
                            <td><Pill>{p.lifecycle}</Pill></td>
                            <td className="mc-mono mc-num">{fmtN(p.chats_30d)}</td>
                            <td className="mc-mono mc-num">{fmtN(p.sources)}</td>
                            <td className="mc-mono" style={{ fontSize: 12, color: "var(--ink2)" }}>{ago(p.last_active)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

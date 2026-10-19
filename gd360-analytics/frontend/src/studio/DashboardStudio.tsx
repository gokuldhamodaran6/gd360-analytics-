// 2026-10-19 (R56, Studio board "Dashboard, edit in place"): the dashboard on the canvas with the tools to change it
// directly - Edit layout (click a block: an edit bar floats above it), Add chart, Add filter, Text, Theme, Access,
// Undo, Versions - and ONE green button, Publish. A new dashboard is a draft only its owner sees until published.
// Every change is saved at once, outlined "Changed just now", and can be undone or restored from Versions.
import { useCallback, useEffect, useMemo, useState } from "react";
import { boardsApi, type Block, type BoardColumns, type BoardEdit, type BoardSummary, type BoardVersion, type PageRun } from "../api/boards";
import { BoardView } from "../board/BoardView";
import type { FrameBits } from "./AnalysisStudio";
import { ago, MenuButton, StudioFrame } from "./Frame";
import { Ic } from "./icons";

function blockRows(b: Block): { cols: string[]; rows: Record<string, unknown>[] } {
  if (b.columns && b.rows) return { cols: b.columns.map((c) => c.key), rows: b.rows };
  if (b.rows && b.rows.length && typeof b.rows[0] === "object") return { cols: Object.keys(b.rows[0]).filter((k) => !["small", "tags"].includes(k)), rows: b.rows };
  if (b.points) return { cols: ["label", "value", ...(b.points.some((p) => p.n != null) ? ["n"] : [])], rows: b.points as any };
  if (b.value !== undefined) return { cols: ["measure", "value"], rows: [{ measure: b.title, value: b.value }] };
  return { cols: [], rows: [] };
}

export function DashboardStudio({ id, name, frame, version = 0, onAsk, onPrefill, busy }: {
  id: string; name: string; frame: FrameBits; version?: number; onAsk: (q: string) => void; onPrefill: (q: string) => void; conversationId: string; busy: boolean;
}) {
  const [sum, setSum] = useState<BoardSummary | null>(null);
  const [v, setV] = useState(0);
  const [page, setPage] = useState<string>("home");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [run, setRun] = useState<PageRun | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [edit, setEdit] = useState(true);
  const [cols, setCols] = useState<BoardColumns | null>(null);
  const [versions, setVersions] = useState<BoardVersion[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<{ text: string; editing?: string } | null>(null);
  const [dataOf, setDataOf] = useState<Block | null>(null);
  const [dl, setDl] = useState<string | null>(null);

  const loadSum = useCallback(async () => { try { setSum(await boardsApi.get(id)); } catch (e: any) { setErr(e?.response?.data?.detail || "Couldn't open this dashboard."); } }, [id]);
  useEffect(() => { void loadSum(); }, [loadSum, version]);
  useEffect(() => { setV((x) => x + 1); }, [version]);

  const canEdit = sum?.can_edit !== false;
  const apply = async (fn: () => Promise<BoardEdit>, keepSel = true) => {
    setWorking(true); setErr(null);
    try {
      const r = await fn();
      setSum(r.summary); setMsg(r.change); setV((x) => x + 1); setVersions(null);
      if (!keepSel) setSel(null);
      return r;
    } catch (e: any) { setErr(e?.response?.data?.detail || "That change didn't apply."); return null; } finally { setWorking(false); }
  };
  const openCols = async () => { if (!cols) { try { setCols(await boardsApi.columns(id)); } catch { setCols({ dims: [], measures: [], outcome: false, filterable: [] }); } } };
  const openVersions = async () => { try { setVersions(await boardsApi.versions(id)); } catch { setVersions([]); } };
  const pageId = page === "home" ? (sum?.pages.find((p) => p.kind !== "home")?.id || null) : page;
  void run;

  const float = useCallback((b: Block) => (
    <div className="sd sd-float" onClick={(e) => e.stopPropagation()} data-sd-float="">
      <button type="button" className="sd-tool" onClick={() => void apply(() => boardsApi.layout(id, b.id, "narrower"))} title="Narrower" disabled={working}><Ic n="minus" />Narrower</button>
      <button type="button" className="sd-tool" onClick={() => void apply(() => boardsApi.layout(id, b.id, "wider"))} title="Wider" disabled={working} data-sd-wider=""><Ic n="wide" />Wider</button>
      <button type="button" className="sd-tool" onClick={() => void apply(() => boardsApi.layout(id, b.id, "left"))} title="Move earlier" aria-label="Move earlier" disabled={working}><Ic n="left" /></button>
      <button type="button" className="sd-tool" onClick={() => void apply(() => boardsApi.layout(id, b.id, "right"))} title="Move later" aria-label="Move later" disabled={working}><Ic n="right" /></button>
      <span className="sd-vr" />
      <button type="button" className="sd-tool" onClick={() => setDataOf(b)} data-sd-block-data=""><Ic n="db" />Data</button>
      <button type="button" className="sd-tool" onClick={() => onPrefill(`Change “${b.title || "this block"}” on the dashboard: `)}><Ic n="wand" />Ask</button>
      <MenuButton className="sd-tool" icon="more" caret={false} align="right" title="More">
        {(close) => <>
          {b.type === "note"
            ? <button type="button" onClick={() => { close(); setNote({ text: b.text || "", editing: b.id }); }}>Edit the note</button>
            : <button type="button" onClick={() => { close(); const t = window.prompt("Title for this block", b.title || ""); if (t && t.trim()) void apply(() => boardsApi.retitle(id, b.id, t.trim())); }}>Rename</button>}
          <span className="sep" />
          <button type="button" onClick={() => { close(); void apply(() => boardsApi.layout(id, b.id, "remove"), false); }} data-sd-remove-block=""><span>Remove from the dashboard</span><small>Undo brings it back</small></button>
        </>}
      </MenuButton>
    </div>
  ), [id, working, onPrefill]); // eslint-disable-line react-hooks/exhaustive-deps

  const access = sum?.access;
  const draft = access?.draft ?? sum?.draft;
  const status = working ? "Saving…" : msg ? `Saved · ${msg}` : sum ? (draft ? "Draft · only you" : `Published${sum.published_at ? ` ${ago(sum.published_at)}` : ""} · ${access?.people || 1} ${access?.people === 1 ? "person" : "people"}`) : "";
  const changed = useMemo(() => sum?.changed || {}, [sum]);
  const themes = sum ? Object.entries(sum.themes) : [];
  const download = async (kind: "xlsx" | "pptx") => { setDl(kind); try { await boardsApi.download(id, kind, filters, sum?.title); } catch { setErr("The download didn't build. Try again."); } finally { setDl(null); } };

  return (
    <StudioFrame kind="board" tabs={frame.tabs} addMenu={frame.addMenu} onClose={frame.onClose} status={status} bodyStyle={{ padding: 0, gap: 0, position: "relative" }}
      actions={<>
        <button type="button" className="sd-pill" onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}/boards/${id}`).catch(() => undefined); setMsg("link copied"); }} title="Copy the dashboard's link"><Ic n="share" />Share</button>
        <button type="button" className="sd-pill" onClick={() => onAsk(`Email the dashboard “${sum?.title || name}” every Monday at 9am`)} disabled={busy} title="Send it on a schedule" data-sd-schedule=""><Ic n="clock" />Schedule</button>
        {canEdit && (draft
          ? <button type="button" className="sd-btnp" onClick={() => void apply(() => boardsApi.publish(id, true))} disabled={working} data-sd-publish="">Publish</button>
          : <MenuButton className="sd-btnp" label="Published" align="right" data="published">
            {(close) => <>
              <span className="sd-note" style={{ padding: "6px 10px" }}>Everyone in the workspace can open it{access?.people ? ` · ${access.people} people` : ""}.</span>
              <button type="button" onClick={() => { close(); void apply(() => boardsApi.publish(id, false)); }} data-sd-unpublish=""><span>Back to a draft</span><small>only you can open it again</small></button>
            </>}
          </MenuButton>)}
      </>}
      tools={canEdit ? <>
        <button type="button" className={`sd-tool${edit ? " on" : ""}`} onClick={() => { setEdit((e) => !e); setSel(null); }} aria-pressed={edit} data-sd-edit-layout=""><Ic n="layout" />Edit layout</button>
        <span onMouseEnter={() => void openCols()} onFocus={() => void openCols()}>
          <MenuButton icon="plus" label="Add chart" data="add-chart">
            {(close) => <>
              {!cols && <span className="sd-note" style={{ padding: "6px 10px" }}>Reading the columns…</span>}
              {cols && cols.dims.length === 0 && <span className="sd-note" style={{ padding: "6px 10px" }}>No column to break this down by.</span>}
              {cols?.dims.slice(0, 14).map((d) => (
                <button key={d.column} type="button" onClick={() => { close(); void apply(() => boardsApi.addChart(id, pageId, d.column), false).then((r) => { if (r?.page_id) setPage(r.page_id); }); }} data-sd-add-col={d.column}>
                  <span>By {d.label}</span><small>{cols.outcome ? "the rate in each group" : `${cols.measures[0]?.label || "count"} in each group`}</small>
                </button>
              ))}
            </>}
          </MenuButton>
        </span>
        <span onMouseEnter={() => void openCols()} onFocus={() => void openCols()}>
          <MenuButton icon="filter" label="Add filter" data="add-filter">
            {(close) => <>
              {!cols && <span className="sd-note" style={{ padding: "6px 10px" }}>Reading the columns…</span>}
              {cols && cols.filterable.length === 0 && <span className="sd-note" style={{ padding: "6px 10px" }}>Every useful column is already a filter.</span>}
              {cols?.filterable.slice(0, 12).map((d) => <button key={d.column} type="button" onClick={() => { close(); void apply(() => boardsApi.addFilter(id, d.column)); }}>{d.label}</button>)}
              {(sum?.filters || []).filter((f) => !f.key.startsWith("__")).length > 0 && <span className="sep" />}
              {(sum?.filters || []).filter((f) => !f.key.startsWith("__")).map((f) => <button key={f.key} type="button" onClick={() => { close(); void apply(() => boardsApi.removeFilter(id, f.key)); }}><span>Remove “{f.label}”</span></button>)}
            </>}
          </MenuButton>
        </span>
        <button type="button" className={`sd-tool${note && !note.editing ? " on" : ""}`} onClick={() => setNote(note ? null : { text: "" })} data-sd-add-text=""><Ic n="text" />Text</button>
        <span className="sd-vr" />
        <MenuButton icon="palette" label={`Theme${sum ? `: ${sum.themes[sum.theme] || sum.theme}` : ""}`} data="theme">
          {(close) => <>{themes.map(([k, l]) => (
            <button key={k} type="button" onClick={async () => { close(); setWorking(true); try { setSum({ ...(await boardsApi.patch(id, { theme: k })), access: sum?.access }); setMsg(`theme set to ${l}`); setV((x) => x + 1); } catch { setErr("Couldn't change the theme."); } finally { setWorking(false); } }} data-sd-theme={k}>
              <span>{l}{sum?.theme === k ? " ✓" : ""}</span>
            </button>
          ))}</>}
        </MenuButton>
        <MenuButton icon="user" label={draft ? "Access: only you" : `Access: ${access?.people || 1} ${access?.people === 1 ? "person" : "people"}`} data="access">
          {(close) => <>
            <span className="sd-note" style={{ padding: "6px 10px", maxWidth: 280 }}>{draft ? "A draft: only you can open it. Publish to give everyone in this workspace access." : "Everyone in this workspace can open it. Data rules on the source still apply to each person."}</span>
            {!draft && <button type="button" onClick={() => { close(); void apply(() => boardsApi.publish(id, false)); }}>Make it a draft again</button>}
            {draft && access?.workspace && <button type="button" onClick={() => { close(); void apply(() => boardsApi.publish(id, true)); }}>Publish to the workspace</button>}
          </>}
        </MenuButton>
        <span className="sd-vr" />
        <button type="button" className="sd-tool" onClick={() => void apply(() => boardsApi.undo(id), false)} disabled={working || !sum?.can_undo} data-sd-undo=""><Ic n="undo" />Undo</button>
        <span onMouseEnter={() => void openVersions()}>
          <MenuButton icon="clock" label="Versions" data="versions">
            {(close) => <>
              {!versions && <span className="sd-note" style={{ padding: "6px 10px" }}>Reading the history…</span>}
              {versions && versions.length <= 1 && <span className="sd-note" style={{ padding: "6px 10px" }}>No earlier versions yet. Every change you make is kept here.</span>}
              {versions?.map((x) => (
                <button key={x.index} type="button" disabled={x.current} onClick={() => { close(); void apply(() => boardsApi.restore(id, x.index), false); }} data-sd-version={x.index}>
                  <span>{x.label}</span><small>{x.current ? "what you see now" : x.at ? ago(x.at) : ""}</small>
                </button>
              ))}
            </>}
          </MenuButton>
        </span>
        <span data-bd-download="" style={{ display: "inline-flex" }}><MenuButton icon="dl" label={dl ? "Building…" : "Download"} data="download">
          {(close) => <>
            <button type="button" onClick={() => { close(); void download("xlsx"); }} data-bd-xlsx=""><span>Excel</span><small>every page, totals as formulas</small></button>
            <button type="button" onClick={() => { close(); void download("pptx"); }} data-bd-pptx=""><span>PowerPoint</span><small>one slide per page, native charts</small></button>
          </>}
        </MenuButton></span>
      </> : undefined}>
      {err && <div className="sd-err" style={{ margin: "14px 20px 0" }}>{err}</div>}
      {note && (
        <form className="sd-card" style={{ margin: "14px 20px 0", padding: 14, display: "flex", gap: 8, flexWrap: "wrap" }} onSubmit={(e) => {
          e.preventDefault();
          const t = note.text.trim(); if (t.length < 2) return;
          void apply(() => (note.editing ? boardsApi.noteText(id, note.editing, t) : boardsApi.addNote(id, pageId, t))).then((r) => { if (r) { setNote(null); if (r.page_id) setPage(r.page_id); } });
        }} data-sd-note-form="">
          <textarea className="sd-in" style={{ flex: 1, minWidth: 260, height: 64, padding: "8px 12px", resize: "vertical" }} autoFocus value={note.text} onChange={(e) => setNote({ ...note, text: e.target.value })}
            placeholder="A note for the people who read this page: what changed, what to watch, who to ask." aria-label="Note" />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <button type="submit" className="sd-btnp" disabled={working || note.text.trim().length < 2}>{note.editing ? "Save the note" : "Add the note"}</button>
            <button type="button" className="sd-pill sm" onClick={() => setNote(null)}>Cancel</button>
          </div>
        </form>
      )}
      <BoardView key={id} id={id} embedded version={v} onAsk={onAsk}
        studio={{
          selected: edit ? sel : null, onSelect: (b) => setSel(b ? b.id : null), changed, float: canEdit ? float : undefined, editable: canEdit && edit,
          onPage: (p) => { setPage(p); setSel(null); }, onFilters: setFilters, onRun: setRun,
        }} />
      {dataOf && (() => {
        const { cols: dc, rows } = blockRows(dataOf);
        return (
          <div className="sd-card" style={{ margin: "0 20px 20px", overflow: "hidden" }} data-sd-data-drawer="">
            <div className="sd-cardh"><b>{dataOf.title || "Block"} · the numbers behind it</b><span className="x"><button type="button" className="sd-tool sm" onClick={() => setDataOf(null)}><Ic n="x" />Close</button></span></div>
            {dataOf.definition && <div className="sd-note" style={{ padding: "10px 16px 0" }}>{dataOf.definition}</div>}
            {dc.length ? (
              <div className="sd-tw" style={{ maxHeight: 320 }}>
                <table className="sd-t"><thead><tr>{dc.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>{rows.slice(0, 100).map((r, i) => <tr key={i}>{dc.map((c) => <td key={c} className={typeof r[c] === "number" ? "num" : undefined}>{typeof r[c] === "number" ? (r[c] as number).toLocaleString(undefined, { maximumFractionDigits: 2 }) : Array.isArray(r[c]) ? (r[c] as any[]).join(" · ") : String(r[c] ?? "")}</td>)}</tr>)}</tbody></table>
              </div>
            ) : <div className="sd-empty">This block has no rows of its own.</div>}
          </div>
        );
      })()}
    </StudioFrame>
  );
}

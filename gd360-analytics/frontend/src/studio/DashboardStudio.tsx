// 2026-10-19 (R56, Studio board "Dashboard, edit in place"): the dashboard on the canvas with the tools to change it
// directly. 2026-11-11 (R67): edited like a design tool - drag a block to move it, drag its corner to resize it, pick
// its chart style and colour from its bar; pages (add, rename, delete); a company's own brand colour; comments; one
// Share panel (only you, the workspace, named people, anyone with the link, the company's own domain); and a real
// picture of the dashboard for its card on the Dashboards list.
import { useCallback, useEffect, useMemo, useState } from "react";
import { boardsApi, type Block, type BoardColumns, type BoardEdit, type BoardShare, type BoardSummary, type BoardVersion, type PageRun } from "../api/boards";
import { BoardView } from "../board/BoardView";
import { BlockCommentChip, CommentsPanel, CommentsUiProvider, useComments, useCommentsUi } from "../dashboard/comments";
import type { FrameBits } from "./AnalysisStudio";
import { ago, MenuButton, StudioFrame } from "./Frame";
import { Ic } from "./icons";
import { captureThumbnail } from "../lib/snapshot";

function blockRows(b: Block): { cols: string[]; rows: Record<string, unknown>[] } {
  if (b.columns && b.rows) return { cols: b.columns.map((c) => c.key), rows: b.rows };
  if (b.rows && b.rows.length && typeof b.rows[0] === "object") return { cols: Object.keys(b.rows[0]).filter((k) => !["small", "tags"].includes(k)), rows: b.rows };
  if (b.points) return { cols: ["label", "value", ...(b.points.some((p) => p.n != null) ? ["n"] : [])], rows: b.points as any };
  if (b.value !== undefined) return { cols: ["measure", "value"], rows: [{ measure: b.title, value: b.value }] };
  return { cols: [], rows: [] };
}

const STYLES: Record<string, { key: string; label: string; hint: string }[]> = {
  bars: [{ key: "bars", label: "Bars", hint: "ranked, horizontal" }, { key: "columns", label: "Columns", hint: "vertical" },
    { key: "donut", label: "Donut", hint: "share of the whole" }, { key: "lollipop", label: "Lollipop", hint: "light, ranked" }],
  line: [{ key: "area", label: "Area", hint: "line with a soft fill" }, { key: "line", label: "Line", hint: "just the line" }, { key: "columns", label: "Columns", hint: "one bar a period" }],
  map: [{ key: "bubbles", label: "Bubbles", hint: "size = the number" }, { key: "heat", label: "Heat", hint: "where it concentrates" }, { key: "points", label: "Points", hint: "every location" }],
};
const SWATCHES = ["#2D5BFF", "#1F47E6", "#7C5CFF", "#0EA5E9", "#14B8A6", "#22C55E", "#F59E0B", "#F97316", "#EF4444", "#EC4899", "#0F172A", "#64748B"];

/** A company's own look: a brand colour on a light or dark ground. */
function BrandForm({ sum, onApply }: { sum: BoardSummary; onApply: (accent: string | null, mode?: "light" | "dark") => void }) {
  const [hex, setHex] = useState(sum.accent || sum.palette.accent || "#2D5BFF");
  const valid = /^#[0-9a-fA-F]{6}$/.test(hex);
  return (
    <div className="sd-brand" onClick={(e) => e.stopPropagation()}>
      <span className="sd-mlab">Your brand</span>
      <div className="sd-swatches">
        {SWATCHES.map((c) => <button key={c} type="button" className={`sd-sw${hex.toUpperCase() === c ? " on" : ""}`} style={{ background: c }} onClick={() => setHex(c)} aria-label={c} title={c} />)}
      </div>
      <div className="sd-hexrow">
        <input type="color" value={valid ? hex : "#2D5BFF"} onChange={(e) => setHex(e.target.value.toUpperCase())} aria-label="Pick a colour" />
        <input className="sd-in" value={hex} onChange={(e) => setHex(e.target.value.trim())} maxLength={7} aria-label="Brand colour, hex" spellCheck={false} />
        <button type="button" className="sd-btnp sm" disabled={!valid} onClick={() => onApply(hex.toUpperCase())} data-sd-brand-apply="">Apply</button>
      </div>
      <div className="sd-hexrow">
        <button type="button" className={`sd-pill sm${sum.palette.mode === "light" ? " on" : ""}`} onClick={() => onApply(null, "light")}>Light ground</button>
        <button type="button" className={`sd-pill sm${sum.palette.mode === "dark" ? " on" : ""}`} onClick={() => onApply(null, "dark")}>Dark ground</button>
        {sum.accent && <button type="button" className="sd-pill sm" onClick={() => onApply("")}>Reset colour</button>}
      </div>
    </div>
  );
}

/** One place for who can open it: you, the workspace, named people, anyone with the link, the company's domain. */
export function ShareDialog({ id, sum, onClose, onWorkspace, working }: {
  id: string; sum: BoardSummary; onClose: () => void; onWorkspace: (on: boolean) => void; working: boolean;
}) {
  const [st, setSt] = useState<BoardShare | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [domain, setDomain] = useState("");
  const [copied, setCopied] = useState(false);
  const load = useCallback(async () => { try { setSt(await boardsApi.share(id)); } catch (e: any) { setErr(e?.response?.data?.detail || "Couldn't read the sharing settings."); } }, [id]);
  useEffect(() => { void load(); }, [load]);
  const run = async (fn: () => Promise<BoardShare>) => {
    setBusy(true); setErr(null);
    try { setSt(await fn()); } catch (e: any) { setErr(e?.response?.data?.detail || "That didn't save. Try again."); } finally { setBusy(false); }
  };
  const draft = sum.access?.draft ?? sum.draft;
  const link = st?.link;
  const url = link?.slug ? `${window.location.origin}/d/${link.slug}` : null;
  const linkMode = link?.published ? link.mode : null;
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="sd-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} data-sd-share-dialog="">
      <div className="sd sd-modal" role="dialog" aria-label="Share the dashboard">
        <div className="sd-mh"><b>Share “{sum.title}”</b><button type="button" className="sd-close" onClick={onClose} aria-label="Close"><Ic n="x" s={14} /></button></div>
        {err && <div className="sd-err">{err}</div>}

        <section className="sd-shs">
          <div className="sd-shh"><Ic n="lock" /><div><b>Inside Euliv</b><small>who in your company can open it when signed in</small></div></div>
          <div className="sd-seg">
            <button type="button" className={draft ? "on" : ""} disabled={working} onClick={() => onWorkspace(false)} data-sd-share-private=""><b>Only you</b><small>a private draft</small></button>
            <button type="button" className={!draft ? "on" : ""} disabled={working || !sum.access?.workspace} onClick={() => onWorkspace(true)} data-sd-share-workspace="">
              <b>Your workspace</b><small>{sum.access?.workspace ? `${sum.access?.people || 1} ${sum.access?.people === 1 ? "person" : "people"} can open it` : "move it into a workspace first"}</small></button>
          </div>
        </section>

        <section className="sd-shs">
          <div className="sd-shh"><Ic n="globe" /><div><b>A link outside Euliv</b><small>for clients, partners or anyone without an account</small></div></div>
          <div className="sd-seg three">
            <button type="button" className={!linkMode ? "on" : ""} disabled={busy} onClick={() => void run(() => boardsApi.shareOff(id))} data-sd-link-off=""><b>Off</b><small>no outside link</small></button>
            <button type="button" className={linkMode === "private" ? "on" : ""} disabled={busy} onClick={() => void run(() => boardsApi.shareLink(id, "private", pw))} data-sd-link-people=""><b>Named people</b><small>only the emails below</small></button>
            <button type="button" className={linkMode === "public" ? "on" : ""} disabled={busy || st?.public_allowed === false} onClick={() => void run(() => boardsApi.shareLink(id, "public"))} data-sd-link-public="">
              <b>Anyone with the link</b><small>{st?.public_allowed === false ? "turned off by your admin" : "no sign-in"}</small></button>
          </div>
          {(linkMode === "private" || (link?.emails || []).length > 0) && (
            <div className="sd-people">
              <form className="sd-hexrow" onSubmit={(e) => { e.preventDefault(); const v = email.trim(); if (v) void run(() => boardsApi.shareEmail(id, v)).then(() => setEmail("")); }}>
                <input className="sd-in" type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email to give access" />
                <button type="submit" className="sd-btnp sm" disabled={busy || !email.trim()} data-sd-add-email="">Give access</button>
              </form>
              {(link?.emails || []).map((p) => (
                <div key={p.id} className="sd-person"><span className="av">{p.email[0]?.toUpperCase()}</span><span className="em">{p.email}</span>
                  <button type="button" className="sd-tool sm" onClick={() => void run(() => boardsApi.shareEmailOff(id, p.id))} aria-label={`Remove ${p.email}`}><Ic n="x" />Remove</button></div>
              ))}
              {(link?.emails || []).length === 0 && <span className="sd-note">Add the people who may open it. Each one confirms their email before the dashboard opens.</span>}
              <form className="sd-hexrow" onSubmit={(e) => { e.preventDefault(); void run(() => boardsApi.shareLink(id, "private", pw)); }}>
                <input className="sd-in" type="password" placeholder={link?.password ? "A password is set · type a new one to change it" : "Optional password on top"} value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Optional password" autoComplete="new-password" />
                <button type="submit" className="sd-pill sm" disabled={busy}>{link?.password ? "Update" : "Set"}</button>
              </form>
            </div>
          )}
          {url && linkMode && (
            <div className="sd-linkrow">
              <input className="sd-in" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="The dashboard's link" data-sd-link-url="" />
              <button type="button" className="sd-btnp sm" onClick={() => { void navigator.clipboard?.writeText(url).then(() => setCopied(true)).catch(() => undefined); setTimeout(() => setCopied(false), 1800); }}>{copied ? "Copied" : "Copy link"}</button>
              <a className="sd-pill sm" href={url} target="_blank" rel="noreferrer">Open</a>
            </div>
          )}
          {link?.published && <span className="sd-note">{link.views ? `Opened ${link.views.toLocaleString()} time${link.views === 1 ? "" : "s"} · ` : ""}Numbers stay live; each visit computes the page as you see it.</span>}
        </section>

        <section className="sd-shs">
          <div className="sd-shh"><Ic n="link" /><div><b>Your company's own domain</b><small>dashboards.yourcompany.com instead of our link</small></div></div>
          {link?.domain ? (
            <div className="sd-people">
              <div className="sd-person"><span className="em"><b>{link.domain}</b> · {link.domain_status === "live" ? "live" : link.domain_status === "pending_ssl" ? "issuing the certificate" : "waiting for your DNS record"}</span>
                <button type="button" className="sd-tool sm" disabled={busy} onClick={() => void run(() => boardsApi.shareDomainCheck(id))}><Ic n="refresh" />Check again</button>
                <button type="button" className="sd-tool sm" disabled={busy} onClick={() => void run(() => boardsApi.shareDomainOff(id))}><Ic n="x" />Remove</button></div>
              {link.domain_status !== "live" && <span className="sd-note">Add a CNAME record for <b>{link.domain}</b> pointing to <b>{window.location.hostname}</b> at your DNS provider; the certificate follows on its own.</span>}
              {link.domain_error && <span className="sd-err">{link.domain_error}</span>}
            </div>
          ) : (
            <form className="sd-hexrow" onSubmit={(e) => { e.preventDefault(); const v = domain.trim(); if (v) void run(() => boardsApi.shareDomain(id, v)); }}>
              <input className="sd-in" placeholder="dashboards.yourcompany.com" value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Your domain" disabled={!link?.published} />
              <button type="submit" className="sd-btnp sm" disabled={busy || !domain.trim() || !link?.published} data-sd-domain="">Connect</button>
            </form>
          )}
          {!link?.published && !link?.domain && <span className="sd-note">Turn on a link above first; the domain shows that same dashboard.</span>}
        </section>
      </div>
    </div>
  );
}

function CommentsToggle() {
  const ui = useCommentsUi();
  if (!ui || !ui.api.enabled) return null;
  const open = ui.api.threads.filter((t) => !t.resolved).length;
  return (
    <button type="button" className={`sd-tool${ui.panelOpen ? " on" : ""}`} onClick={() => (ui.panelOpen ? ui.closePanel() : ui.openPanel())} data-sd-comments="">
      <Ic n="cmt" />Comments{open ? <span className="sd-count">{open}</span> : null}
    </button>
  );
}

function CommentBlockButton({ blockId, close }: { blockId: string; close?: () => void }) {
  const ui = useCommentsUi();
  if (!ui || !ui.api.enabled) return null;
  return <button type="button" className="sd-tool" onClick={() => { close?.(); ui.openPanel({ blockId }); }} data-sd-block-comment=""><Ic n="cmt" />Comment</button>;
}

export function DashboardStudio({ id, name, frame, version = 0, onAsk, onPrefill, busy }: {
  id: string; name: string; frame: FrameBits; version?: number; onAsk: (q: string) => void; onPrefill: (q: string) => void; conversationId: string; busy: boolean;
}) {
  const [sum, setSum] = useState<BoardSummary | null>(null);
  const [v, setV] = useState(0);
  const [page, setPage] = useState<string | null>(null);
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
  const [sharing, setSharing] = useState(false);
  const comments = useComments(id);

  const loadSum = useCallback(async () => { try { setSum(await boardsApi.get(id)); } catch (e: any) { setErr(e?.response?.data?.detail || "Couldn't open this dashboard."); } }, [id]);
  useEffect(() => { void loadSum(); }, [loadSum, version]);
  useEffect(() => { setV((x) => x + 1); }, [version]);

  const canEdit = sum?.can_edit !== false;
  const apply = async (fn: () => Promise<BoardEdit>, keepSel = true) => {
    setWorking(true); setErr(null);
    try {
      const r = await fn();
      setSum((old) => ({ ...r.summary, source_info: r.summary.source_info ?? old?.source_info })); setMsg(r.change); setV((x) => x + 1); setVersions(null);
      if (!keepSel) setSel(null);
      return r;
    } catch (e: any) { setErr(e?.response?.data?.detail || "That change didn't apply."); return null; } finally { setWorking(false); }
  };
  const openCols = async () => { if (!cols) { try { setCols(await boardsApi.columns(id)); } catch { setCols({ dims: [], measures: [], outcome: false, filterable: [] }); } } };
  const openVersions = async () => { try { setVersions(await boardsApi.versions(id)); } catch { setVersions([]); } };
  const pageId = page || sum?.pages[0]?.id || null;
  const pageName = sum?.pages.find((p) => p.id === pageId)?.name || "this page";

  const addPage = () => {
    const nm = window.prompt("Name the new page", "New page");
    if (nm && nm.trim()) void apply(() => boardsApi.addPage(id, nm.trim()), false).then((r) => { if (r?.page_id) setPage(r.page_id); });
  };
  const pageMenu = (pid: string, action: "rename" | "delete") => {
    const p = sum?.pages.find((x) => x.id === pid);
    if (!p) return;
    if (action === "rename") {
      const nm = window.prompt("Rename the page", p.name);
      if (nm && nm.trim() && nm.trim() !== p.name) void apply(() => boardsApi.renamePage(id, pid, nm.trim()));
    } else if (window.confirm(`Remove the page “${p.name}”? Undo brings it back.`)) {
      void apply(() => boardsApi.deletePage(id, pid), false).then((r) => { if (r) setPage(null); });
    }
  };
  const snapshot = useCallback((el: HTMLElement) => { void captureThumbnail(el, id); }, [id]);

  const styleMenu = (b: Block) => {
    const opts = STYLES[b.type as string];
    if (!opts) return null;
    const cur = b.style || opts[0].key;
    return (
      <MenuButton className="sd-tool" icon="bar" label="Style" data="block-style">
        {(close) => <>{opts.map((o) => (
          <button key={o.key} type="button" onClick={() => { close(); void apply(() => boardsApi.setBlock(id, b.id, { style: o.key })); }} data-sd-style={o.key}>
            <span>{o.label}{cur === o.key ? " ✓" : ""}</span><small>{o.hint}</small>
          </button>
        ))}</>}
      </MenuButton>
    );
  };
  const colourMenu = (b: Block) => (
    <MenuButton className="sd-tool" icon="palette" label="Colour" data="block-colour" width={248}>
      {(close) => (
        <div className="sd-brand">
          <span className="sd-mlab">This block's colour</span>
          <div className="sd-swatches">
            {SWATCHES.map((c) => <button key={c} type="button" className={`sd-sw${(b.color || "").toUpperCase() === c ? " on" : ""}`} style={{ background: c }} aria-label={c} title={c}
              onClick={() => { close(); void apply(() => boardsApi.setBlock(id, b.id, { color: c })); }} />)}
          </div>
          <div className="sd-hexrow">
            <input type="color" defaultValue={b.color || "#2D5BFF"} aria-label="Any colour" onChange={(e) => { const c = e.target.value.toUpperCase(); void apply(() => boardsApi.setBlock(id, b.id, { color: c })); }} />
            {b.color && <button type="button" className="sd-pill sm" onClick={() => { close(); void apply(() => boardsApi.setBlock(id, b.id, { clear_color: true })); }}>Use the theme colour</button>}
          </div>
        </div>
      )}
    </MenuButton>
  );

  const float = useCallback((b: Block) => (
    <div className="sd sd-float" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} data-sd-float="">
      {styleMenu(b)}
      {b.type !== "note" && b.type !== "kpi" && colourMenu(b)}
      {(b.type === "bars" || b.type === "line") && (
        <button type="button" className={`sd-tool${b.labels !== false ? " on" : ""}`} aria-pressed={b.labels !== false} title={b.labels !== false ? "Hide the numbers on the chart" : "Show the numbers on the chart"}
          onClick={() => void apply(() => boardsApi.setBlock(id, b.id, { labels: b.labels === false }))} data-sd-labels=""><Ic n="h" />Labels</button>
      )}
      <span className="sd-vr" />
      <CommentBlockButton blockId={b.id} />
      <button type="button" className="sd-tool" onClick={() => setDataOf(b)} data-sd-block-data=""><Ic n="db" />Data</button>
      <button type="button" className="sd-tool" onClick={() => onPrefill(`Change “${b.title || "this block"}” on the dashboard: `)}><Ic n="wand" />Ask</button>
      <MenuButton className="sd-tool" icon="more" caret={false} align="right" title="More">
        {(close) => <>
          {b.type === "note"
            ? <button type="button" onClick={() => { close(); setNote({ text: b.text || "", editing: b.id }); }}>Edit the note</button>
            : <button type="button" onClick={() => { close(); const t = window.prompt("Title for this block", b.title || ""); if (t && t.trim()) void apply(() => boardsApi.retitle(id, b.id, t.trim())); }}>Rename</button>}
          <button type="button" onClick={() => { close(); void apply(() => boardsApi.setBlock(id, b.id, { span: 12 })); }}><span>Full width</span><small>or drag the corner</small></button>
          <button type="button" onClick={() => { close(); void apply(() => boardsApi.setBlock(id, b.id, { span: 6 })); }}><span>Half width</span></button>
          <span className="sep" />
          <button type="button" onClick={() => { close(); void apply(() => boardsApi.layout(id, b.id, "remove"), false); }} data-sd-remove-block=""><span>Remove from the dashboard</span><small>Undo brings it back</small></button>
        </>}
      </MenuButton>
    </div>
  ), [id, working, onPrefill]); // eslint-disable-line react-hooks/exhaustive-deps

  const access = sum?.access;
  const draft = access?.draft ?? sum?.draft;
  const status = working ? "Saving…" : msg ? `Saved · ${msg}` : sum ? (draft ? (sum.link ? "Draft · shared by link" : "Draft · only you") : `Published${sum.published_at ? ` ${ago(sum.published_at)}` : ""} · ${access?.people || 1} ${access?.people === 1 ? "person" : "people"}`) : "";
  const changed = useMemo(() => sum?.changed || {}, [sum]);
  const themes = sum ? Object.entries(sum.themes) : [];
  const download = async (kind: "xlsx" | "pptx") => { setDl(kind); setErr(null); try { await boardsApi.download(id, kind, filters, sum?.title); setMsg(`${kind === "xlsx" ? "Excel" : "PowerPoint"} downloaded`); } catch { setErr("The download didn't build. Try again."); } finally { setDl(null); } };
  const blocksInfo = useMemo(() => (run?.blocks || []).map((b) => ({ id: b.id, title: b.title || "Block", type: b.type, pageId: pageId || "", pageName })), [run, pageId, pageName]);

  return (
    <CommentsUiProvider api={comments} blocks={blocksInfo} activePageId={pageId} onOpenPage={(p) => setPage(p)}>
    <StudioFrame kind="board" tabs={frame.tabs} addMenu={frame.addMenu} onClose={frame.onClose} status={status} bodyStyle={{ padding: 0, gap: 0, position: "relative" }}
      actions={<>
        <button type="button" className="sd-pill" onClick={() => setSharing(true)} title="Who can open it" data-sd-share=""><Ic n="share" />Share</button>
        <button type="button" className="sd-pill" onClick={() => onAsk(`Email the dashboard “${sum?.title || name}” every Monday at 9am`)} disabled={busy} title="Send it on a schedule" data-sd-schedule=""><Ic n="clock" />Schedule</button>
        {canEdit && <button type="button" className="sd-btnp" onClick={() => setSharing(true)} disabled={working} data-sd-publish="">{draft ? "Publish" : "Published"}</button>}
      </>}
      tools={canEdit ? <>
        <button type="button" className={`sd-tool${edit ? " on" : ""}`} onClick={() => { setEdit((e) => !e); setSel(null); }} aria-pressed={edit} data-sd-edit-layout="" title="Drag blocks to move them, drag a corner to resize"><Ic n="layout" />Edit layout</button>
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
              <span className="sep" />
              <button type="button" onClick={() => { close(); onPrefill("Add a live map of "); }}><span>A live map…</span><small>ask for it: “add a live map of revenue by city”</small></button>
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
        <MenuButton icon="doc" label="Page" data="page">
          {(close) => <>
            <button type="button" onClick={() => { close(); addPage(); }} data-sd-add-page=""><span>Add a page</span><small>an empty page to fill</small></button>
            {pageId && <button type="button" onClick={() => { close(); pageMenu(pageId, "rename"); }}><span>Rename “{pageName}”</span></button>}
            {pageId && (sum?.pages.length || 0) > 1 && <button type="button" onClick={() => { close(); pageMenu(pageId, "delete"); }}><span>Remove “{pageName}”</span><small>Undo brings it back</small></button>}
          </>}
        </MenuButton>
        <span className="sd-vr" />
        <MenuButton icon="palette" label={`Theme${sum ? `: ${sum.accent ? "Your brand" : sum.themes[sum.theme] || sum.theme}` : ""}`} data="theme" width={272}>
          {(close) => <>
            <span className="sd-mlab" style={{ padding: "4px 10px 2px" }}>Euliv themes</span>
            {themes.map(([k, l]) => (
              <button key={k} type="button" onClick={async () => { close(); setWorking(true); try { const s2 = await boardsApi.patch(id, { theme: k }); setSum((old) => ({ ...s2, access: old?.access, source_info: old?.source_info })); setMsg(`theme set to ${l}`); setV((x) => x + 1); } catch { setErr("Couldn't change the theme."); } finally { setWorking(false); } }} data-sd-theme={k}>
                <span>{l}{sum?.theme === k && !sum?.accent ? " ✓" : ""}</span>
              </button>
            ))}
            <span className="sep" />
            {sum && <BrandForm sum={sum} onApply={(accent, mode) => { close(); void apply(() => boardsApi.brand(id, { accent: accent === null ? undefined : accent, mode })); }} />}
          </>}
        </MenuButton>
        <CommentsToggle />
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
        <span data-bd-download="" style={{ display: "inline-flex" }}><MenuButton icon="dl" label={dl ? "Building…" : "Download"} data="download" align="right">
          {(close) => <>
            <button type="button" onClick={() => { close(); void download("xlsx"); }} data-bd-xlsx=""><span>Excel</span><small>every page, totals as formulas</small></button>
            <button type="button" onClick={() => { close(); void download("pptx"); }} data-bd-pptx=""><span>PowerPoint</span><small>one slide per page, native charts</small></button>
          </>}
        </MenuButton></span>
      </> : <CommentsToggle />}>
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
          onPage: (p) => { setPage(p); setSel(null); }, onFilters: setFilters, onRun: setRun, page,
          onMove: (bid, to) => void apply(() => boardsApi.setBlock(id, bid, { to_index: to })),
          onResize: (bid, span, h) => void apply(() => boardsApi.setBlock(id, bid, { span, h })),
          onAddPage: canEdit ? addPage : undefined, onPageMenu: canEdit ? pageMenu : undefined,
          onSnapshot: canEdit ? (el) => void snapshot(el) : undefined,
          blockExtra: (b) => <BlockCommentChip blockId={b.id} />,
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
    <div className="sd-comments-dock"><CommentsPanel /></div>
    {sharing && sum && <ShareDialog id={id} sum={sum} working={working} onClose={() => { setSharing(false); void loadSum(); }}
      onWorkspace={(on) => void apply(() => boardsApi.publish(id, on))} />}
    </CommentsUiProvider>
  );
}

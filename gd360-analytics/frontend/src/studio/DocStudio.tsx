// 2026-10-19 (R56, Studio board "Doc studio"): the document on the canvas with a writer's toolbar - style, bold and
// italics while typing, insert a chart / heading / paragraph, Rewrite, live numbers that open where they came from,
// comments in the margin - and ONE green button, Export. What changed is highlighted in green; Undo takes it back.
import { useCallback, useEffect, useRef, useState } from "react";
import { docsApi, type Doc, type DocBlock, type DocComment, type DocSource } from "../api/docs";
import { DocView } from "../doc/DocView";
import type { FrameBits } from "./AnalysisStudio";
import { ago, MenuButton, StudioFrame } from "./Frame";
import { Ic } from "./icons";

const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]?.toUpperCase()).join("") || "?";
const textOf = (b: DocBlock) => ("text" in b ? (b.text || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^[“"']+|[”"']+$/g, "") : "");

/** Wrap the selected words of the open text editor in **bold** or *italics* (a controlled textarea, so the value is
 *  set through the native setter and an input event, the way React expects). */
function wrapSelection(marker: string): boolean {
  const el = document.querySelector<HTMLTextAreaElement>('[data-sd-canvas="doc"] [data-dc-edit="type"] textarea');
  if (!el) return false;
  const { selectionStart: a, selectionEnd: z, value } = el;
  if (a === z) return false;
  const next = value.slice(0, a) + marker + value.slice(a, z) + marker + value.slice(z);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  el.setSelectionRange(a + marker.length, z + marker.length);
  return true;
}

export function DocStudio({ id, frame, version = 0, onAsk, onPrefill, onSource, busy }: {
  id: string; frame: FrameBits; version?: number; onAsk: (q: string) => void; onPrefill: (q: string) => void; onSource?: (s: DocSource) => void; busy: boolean;
}) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [v, setV] = useState(0);
  const [selId, setSelId] = useState<string | null>(null);
  const [selBlock, setSelBlock] = useState<DocBlock | null>(null);
  const [changed, setChanged] = useState<Record<string, number>>({});
  const [comments, setComments] = useState<DocComment[]>([]);
  const [showCm, setShowCm] = useState(true);
  const [focusCm, setFocusCm] = useState<string | null>(null);
  const [newCm, setNewCm] = useState<{ block_id: string | null; quote: string | null; text: string } | null>(null);
  const [reply, setReply] = useState<Record<string, string>>({});
  const [insert, setInsert] = useState<{ kind: "heading" | "paragraph"; text: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; mode: "type" | "rewrite" } | null>(null);
  const [working, setWorking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const prev = useRef<Doc | null>(null);
  void onAsk;

  useEffect(() => { setV((x) => x + 1); }, [version]);
  const loadComments = useCallback(async () => { try { setComments(await docsApi.comments(id)); } catch { /* the margin stays empty */ } }, [id]);
  useEffect(() => { void loadComments(); }, [loadComments]);

  // what changed between two versions of the document: those blocks are green for a while
  const onDoc = useCallback((d: Doc) => {
    const p = prev.current;
    if (p && p.id === d.id) {
      const before = new Map(p.blocks.map((b) => [b.id, JSON.stringify(b)]));
      const now = Date.now();
      const ch: Record<string, number> = {};
      for (const b of d.blocks) if (before.get(b.id) !== JSON.stringify(b) && b.type !== "sources") ch[b.id] = now;
      if (Object.keys(ch).length) setChanged((c) => ({ ...c, ...ch }));
      // a change made inside the page (typing over a paragraph): the status line shows the new save, not an old message
      if (p.updated_at !== d.updated_at) setMsg("");
    }
    prev.current = d;
    setDoc(d);
  }, []);
  const act = async (fn: () => Promise<Doc | null | void>, done?: string) => {
    setWorking(true); setErr(null);
    try { const d = await fn(); if (d) onDoc(d); setV((x) => x + 1); if (done) setMsg(done); }
    catch (e: any) { setErr(e?.response?.data?.detail || "That didn't work. Try again."); }
    finally { setWorking(false); }
  };
  const ask = (instruction: string, done: string) => {
    if (!selId) { setErr("Click a paragraph first, then choose what to do with it."); return; }
    void act(async () => (await docsApi.editBlock(id, selId, instruction)).document, done);
  };
  const dl = async (kind: "docx" | "pdf" | "md") => { setWorking(true); try { await docsApi.download(id, kind, doc?.title); } catch { setErr("The download didn't build. Try again."); } finally { setWorking(false); } };

  const open = comments.filter((c) => !c.resolved);
  const counts: Record<string, number> = {};
  for (const c of open) if (c.block_id) counts[c.block_id] = (counts[c.block_id] || 0) + 1 + c.replies.length;
  const isText = !!selBlock && ["paragraph", "heading", "callout", "title"].includes(selBlock.type);
  const status = working ? "Saving…" : msg ? msg : doc ? `${doc.edited_by_person ? "Edited by you" : "Written by GD360"} · saved ${ago(doc.updated_at)}` : "";

  const aside = showCm ? (
    <aside className="dc-aside sd" data-sd-comments="">
      {newCm && (
        <form className="dc-cm on" onSubmit={(e) => { e.preventDefault(); if (!newCm.text.trim()) return; void docsApi.comment(id, { body: newCm.text.trim(), block_id: newCm.block_id, quote: newCm.quote }).then((c) => { setComments(c); setNewCm(null); }).catch(() => setErr("The comment didn't save.")); }} data-sd-new-comment="">
          {newCm.quote && <span className="qt">“{newCm.quote.length > 90 ? `${newCm.quote.slice(0, 88)}…` : newCm.quote}”</span>}
          <textarea autoFocus value={newCm.text} onChange={(e) => setNewCm({ ...newCm, text: e.target.value })} placeholder="Comment, or ask a teammate a question" aria-label="Comment" />
          <div style={{ display: "flex", gap: 6 }}>
            <button type="submit" className="sd-btnp" style={{ height: 30, fontSize: 12.5 }} disabled={!newCm.text.trim()}>Comment</button>
            <button type="button" className="sd-pill sm" onClick={() => setNewCm(null)}>Cancel</button>
          </div>
        </form>
      )}
      {open.length === 0 && !newCm && <div className="sd-note" style={{ padding: "4px 2px" }}>No comments. Select a part of the page and press Comment to start one.</div>}
      {open.map((c) => (
        <div key={c.id} className={`dc-cm${focusCm === c.block_id && c.block_id ? " on" : ""}`} data-sd-comment={c.id}>
          <div className="hd"><span className="av">{initials(c.author.name)}</span><span className="nm">{c.author.me ? "You" : c.author.name}</span><span className="tm">{ago(c.created_at)}</span>
            <span className="sd-sp" />
            <button type="button" className="sd-tool sm" onClick={() => void docsApi.resolve(id, c.id).then(setComments)} title="Resolve" aria-label="Resolve"><Ic n="check" /></button>
          </div>
          {c.quote && <span className="qt">“{c.quote.length > 90 ? `${c.quote.slice(0, 88)}…` : c.quote}”</span>}
          <div>{c.body}</div>
          {c.block_id && (
            <button type="button" className="sd-pill sm" style={{ alignSelf: "flex-start" }} disabled={working}
              onClick={() => { setSelId(c.block_id); void act(async () => (await docsApi.editBlock(id, c.block_id!, c.body)).document, "GD360 changed the part this comment is on"); }} data-sd-cm-ask="">
              <Ic n="wand" s={14} />Ask GD360 to do it</button>
          )}
          {c.replies.map((r) => <div key={r.id} className="rp"><span className="tm"><b style={{ color: "rgb(var(--color-text))" }}>{r.author.me ? "You" : r.author.name}</b> · {ago(r.created_at)}</span><span>{r.body}</span></div>)}
          <form onSubmit={(e) => { e.preventDefault(); const t = (reply[c.id] || "").trim(); if (!t) return; void docsApi.comment(id, { body: t, parent_id: c.id }).then((x) => { setComments(x); setReply({ ...reply, [c.id]: "" }); }); }}>
            <input className="sd-in" style={{ width: "100%", height: 32, fontSize: 13 }} value={reply[c.id] || ""} onChange={(e) => setReply({ ...reply, [c.id]: e.target.value })} placeholder="Reply" aria-label="Reply" />
          </form>
        </div>
      ))}
    </aside>
  ) : undefined;

  return (
    <StudioFrame kind="doc" tabs={frame.tabs} addMenu={frame.addMenu} onClose={frame.onClose} bodyStyle={{ padding: 0, gap: 0 }}
      status={<span data-dc-bar="">{open.length ? `${open.length} comment${open.length === 1 ? "" : "s"} · ` : ""}{status}</span>}
      actions={<>
        <button type="button" className="sd-pill" onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}/docs/${id}`).catch(() => undefined); setMsg("Link copied"); }} data-dc-share=""><Ic n="share" />Share</button>
        <span data-dc-download="" style={{ display: "inline-flex" }}>
          <MenuButton className="sd-btnp" icon="dl" label="Export" align="right" data="export">
            {(close) => <>
              <button type="button" onClick={() => { close(); void dl("docx"); }} data-dc-dl="docx"><span>Word</span><small>.docx · figures included</small></button>
              <button type="button" onClick={() => { close(); void dl("pdf"); }} data-dc-dl="pdf"><span>PDF</span><small>A4 · ready to send</small></button>
              <button type="button" onClick={() => { close(); void dl("md"); }} data-dc-dl="md"><span>Markdown</span><small>for pasting anywhere</small></button>
            </>}
          </MenuButton>
        </span>
      </>}
      tools={<>
        <MenuButton label={selBlock?.type === "heading" ? "Heading 2" : selBlock?.type === "title" ? "Title" : "Paragraph"} data="style">
          {(close) => <>
            {!selBlock && <span className="sd-note" style={{ padding: "6px 10px" }}>Click a part of the page first.</span>}
            {selBlock && (selBlock.type === "paragraph" || selBlock.type === "heading") && <>
              <button type="button" onClick={() => { close(); void act(() => docsApi.style(id, selBlock.id, "heading"), "Made it a heading"); }} data-sd-style="heading">Heading 2</button>
              <button type="button" onClick={() => { close(); void act(() => docsApi.style(id, selBlock.id, "paragraph"), "Made it a paragraph"); }} data-sd-style="paragraph">Paragraph</button>
            </>}
            {selBlock && !(selBlock.type === "paragraph" || selBlock.type === "heading") && <span className="sd-note" style={{ padding: "6px 10px" }}>This part keeps its style.</span>}
          </>}
        </MenuButton>
        <span className="sd-vr" />
        <button type="button" className="sd-tool" title="Bold - select words while typing" aria-label="Bold" onMouseDown={(e) => e.preventDefault()} onClick={() => { if (!wrapSelection("**")) setErr("Choose Edit text on a paragraph, select words, then press B."); }} data-sd-bold=""><Ic n="bold" /></button>
        <button type="button" className="sd-tool" title="Italics - select words while typing" aria-label="Italics" onMouseDown={(e) => e.preventDefault()} onClick={() => { if (!wrapSelection("*")) setErr("Choose Edit text on a paragraph, select words, then press I."); }}><Ic n="ital" /></button>
        <button type="button" className="sd-tool" disabled={!isText} onClick={() => selId && setEditing({ id: selId, mode: "type" })} data-sd-type=""><Ic n="text" />Edit text</button>
        <span className="sd-vr" />
        <MenuButton icon="plus" label="Insert" data="insert">
          {(close) => <>
            <button type="button" disabled={selBlock?.type !== "paragraph"} onClick={() => { close(); ask("Add a graph for this below", "Added a chart below"); }} data-sd-insert="chart"><span>A chart for this paragraph</span><small>drawn to scale from the data behind it</small></button>
            <button type="button" onClick={() => { close(); setInsert({ kind: "heading", text: "" }); }} data-sd-insert="heading"><span>A heading</span><small>{selId ? "after the selected part" : "before the sources"}</small></button>
            <button type="button" onClick={() => { close(); setInsert({ kind: "paragraph", text: "" }); }} data-sd-insert="paragraph"><span>A paragraph</span><small>your own words</small></button>
          </>}
        </MenuButton>
        <button type="button" className="sd-tool" disabled={selBlock?.type !== "paragraph" || working} onClick={() => ask("Add a graph for this below", "Added a chart below")} data-sd-chart=""><Ic n="bar" />Chart</button>
        <MenuButton icon="wand" label="Rewrite" data="rewrite">
          {(close) => <>
            {!(selBlock && (selBlock.type === "paragraph" || selBlock.type === "callout")) && <span className="sd-note" style={{ padding: "6px 10px" }}>Click a paragraph first.</span>}
            {selBlock && (selBlock.type === "paragraph" || selBlock.type === "callout") && <>
              <button type="button" onClick={() => { close(); ask("make it shorter", "Made it shorter"); }} data-sd-rewrite="shorter"><span>Shorter</span><small>keeps the numbers</small></button>
              <button type="button" onClick={() => { close(); ask("Use plainer words for a busy reader", "Rewrote it in plainer words"); }}><span>Plainer words</span></button>
              <button type="button" onClick={() => { close(); ask("Rewrite it for the CEO: the decision first, then the reason", "Rewrote it for the CEO"); }}><span>For the CEO</span><small>the decision first</small></button>
              <button type="button" onClick={() => { close(); if (selId) setEditing({ id: selId, mode: "rewrite" }); }}><span>Say how…</span></button>
            </>}
          </>}
        </MenuButton>
        <span className="sd-vr" />
        <button type="button" className="sd-tool" disabled={!doc?.can_undo || working} onClick={() => void act(async () => (await docsApi.undo(id)).document, "Undid the last change")} data-dc-undo=""><Ic n="undo" />Undo</button>
        <button type="button" className={`sd-tool${showCm ? " on" : ""}`} onClick={() => setShowCm((x) => !x)} aria-pressed={showCm} data-sd-comments-toggle=""><Ic n="cmt" />Comments{open.length ? ` · ${open.length}` : ""}</button>
        <button type="button" className="sd-tool" onClick={() => { setShowCm(true); setNewCm({ block_id: selId, quote: selBlock ? textOf(selBlock).slice(0, 120) : null, text: "" }); }} data-sd-comment=""><Ic n="plus" />Comment</button>
        <span className="sd-vr" />
        <button type="button" className="sd-tool" onClick={() => onPrefill("In the document, ")} disabled={busy}><Ic n="chat" />Ask</button>
      </>}>
      {err && <div className="sd-err" style={{ margin: "14px 22px 0" }}>{err}</div>}
      {insert && (
        <form className="sd-card" style={{ margin: "14px 22px 0", padding: 14, display: "flex", gap: 8, flexWrap: "wrap" }} onSubmit={(e) => {
          e.preventDefault(); const t = insert.text.trim(); if (!t) return;
          void act(async () => (await docsApi.insert(id, selId, insert.kind, t)).document, `Added a ${insert.kind}`).then(() => setInsert(null));
        }} data-sd-insert-form="">
          {insert.kind === "heading"
            ? <input className="sd-in" style={{ flex: 1, minWidth: 240 }} autoFocus value={insert.text} onChange={(e) => setInsert({ ...insert, text: e.target.value })} placeholder="Heading" aria-label="Heading" />
            : <textarea className="sd-in" style={{ flex: 1, minWidth: 240, height: 70, padding: "8px 12px" }} autoFocus value={insert.text} onChange={(e) => setInsert({ ...insert, text: e.target.value })} placeholder="Your paragraph. Numbers you type are checked against the data when you export." aria-label="Paragraph" />}
          <button type="submit" className="sd-btnp" disabled={!insert.text.trim() || working}>Add</button>
          <button type="button" className="sd-pill" onClick={() => setInsert(null)}>Cancel</button>
        </form>
      )}
      <DocView id={id} embedded version={v} onSource={onSource}
        studio={{
          onSelect: (bid, b) => { setSelId(bid); setSelBlock(b); if (bid) setFocusCm(bid); setEditing(null); }, changed, aside, comments: counts,
          onComment: (bid) => { setShowCm(true); setFocusCm(bid); }, onDoc, editing,
        }} />
    </StudioFrame>
  );
}

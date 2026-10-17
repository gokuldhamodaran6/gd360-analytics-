// 2026-10-15 (R51, mockup board 05): a block document on the canvas or full page. Every paragraph is a block you can
// click: add a graph for it below, make it shorter, rewrite it, type over it, remove it. Figures are drawn to scale
// from the table; each paragraph carries chips naming the step its numbers came from. History undoes, Download gives
// Word, PDF or Markdown built from the same blocks, Share copies the page's link.
import { Fragment, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { docsApi, type Doc, type DocBlock, type DocSource } from "../api/docs";
import "./doc.css";

const I = {
  undo: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2" /></svg>,
  copy: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></svg>,
  down: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 4v11M6 10l6 6 6-6M4 20h16" /></svg>,
  plus: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>,
  check: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>,
  back: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" /></svg>,
  send: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>,
};

export function Rich({ text }: { text: string }) {
  const parts = (text || "").split(/\*\*(.+?)\*\*/g);
  return <>{parts.map((p, i) => (i % 2 ? <b key={i}>{p}</b> : <Fragment key={i}>{p}</Fragment>))}</>;
}
const plain = (t: string) => (t || "").replace(/\*\*(.+?)\*\*/g, "$1");

function when(iso: string): string {
  const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  const mins = (Date.now() - d.getTime()) / 60000;
  if (mins < 1.5) return "just now";
  if (mins < 60) return `${Math.round(mins)} min ago`;
  if (mins < 60 * 24) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

function Chips({ cites, sources, onSource }: { cites?: string[]; sources: DocSource[]; onSource?: (s: DocSource) => void }) {
  const list = (cites || []).map((c) => sources.find((s) => s.id === c)).filter(Boolean) as DocSource[];
  if (!list.length) return null;
  return (
    <>
      {list.map((s) => (
        <button key={s.id} type="button" className="dc-src" title={s.label} data-dc-src={s.kind}
          onClick={(e) => { e.stopPropagation(); if (s.url) window.open(s.url, "_blank", "noopener"); else onSource?.(s); }}>
          <i aria-hidden="true" />{s.label.length > 46 ? `${s.label.slice(0, 44)}…` : s.label}
        </button>
      ))}
    </>
  );
}

export function DocFigure({ b }: { b: Extract<DocBlock, { type: "figure" }> }) {
  const bars = b.bars || [];
  const W = 720, left = 210, right = 70, rowH = 46, top = 34;
  const H = top + rowH * bars.length + 34;
  const vmaxRaw = Math.max(...bars.map((x) => x.value), b.baseline?.value ?? 0, 1e-9);
  const step = vmaxRaw > 30 ? 10 : vmaxRaw > 10 ? 5 : 1;
  const vmax = (Math.floor(vmaxRaw / step) + 1) * step;
  const pw = W - left - right;
  const xs = (v: number) => left + (pw * v) / vmax;
  const ticks: number[] = [];
  for (let k = 0; k <= vmax; k += step) ticks.push(k);
  const tone = (t?: string) => (t === "bad" ? "var(--dc-bad)" : t === "good" ? "var(--dc-good)" : "var(--dc-neutral)");
  const bottom = top + rowH * bars.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${b.title}: ${bars.map((x) => `${x.label} ${x.value}${b.unit || ""}`).join(", ")}`} className="dc-fig-svg">
      {ticks.map((k) => <line key={k} x1={xs(k)} x2={xs(k)} y1={top - 6} y2={bottom} className="gr" />)}
      {bars.map((x, i) => {
        const y = top + i * rowH + 10;
        return (
          <g key={x.label}>
            <text x={left - 12} y={y + 15} textAnchor="end" className="lab">{x.label.length > 30 ? `${x.label.slice(0, 29)}…` : x.label}</text>
            <rect x={left} y={y} width={Math.max(3, xs(x.value) - left)} height={24} rx={5} fill={tone(x.tone)} />
            <text x={xs(x.value) + 8} y={y + 16} className="val">{x.value}</text>
          </g>
        );
      })}
      {b.baseline && (
        <>
          <line x1={xs(b.baseline.value)} x2={xs(b.baseline.value)} y1={top - 18} y2={bottom} className="base" />
          <text x={Math.min(xs(b.baseline.value) + 6, W - 160)} y={top - 22} className="val">{b.baseline.label}</text>
        </>
      )}
      <line x1={left} x2={left + pw} y1={bottom} y2={bottom} className="ax" />
      {ticks.map((k) => <text key={k} x={xs(k)} y={bottom + 18} textAnchor="middle" className="tick">{k}</text>)}
    </svg>
  );
}

type Sel = { id: string; mode: "menu" | "rewrite" | "type" } | null;

export function DocView({ id, embedded = false, version = 0, onSource, onChanged }: {
  id: string; embedded?: boolean; version?: number; onSource?: (s: DocSource) => void; onChanged?: (d: Doc) => void;
}) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState<"text" | "link" | null>(null);
  const noteT = useRef<number>();

  const load = useCallback(async () => {
    try { setDoc(await docsApi.get(id)); setErr(null); } catch (e: any) { setErr(e?.response?.status === 404 ? "This document isn't here, or isn't shared with you." : "Couldn't open the document."); }
  }, [id]);
  useEffect(() => { void load(); }, [load, version]);
  const flash = (text: string, tone: "ok" | "bad" = "ok") => {
    setNote({ text, tone });
    window.clearTimeout(noteT.current);
    noteT.current = window.setTimeout(() => setNote(null), 6000);
  };
  const apply = (d: Doc) => { setDoc(d); onChanged?.(d); };
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try { await f(); } catch (e: any) { flash(e?.response?.data?.detail || "That didn't work. Try again.", "bad"); } finally { setBusy(false); }
  };
  const ask = (blockId: string, instruction: string) => run(async () => {
    const out = await docsApi.editBlock(id, blockId, instruction);
    apply(out.document); setSel(null); setDraft("");
    flash(`${out.change.change.charAt(0).toUpperCase()}${out.change.change.slice(1)}.`);
  });
  const typeOver = (blockId: string) => run(async () => { apply(await docsApi.typeBlock(id, blockId, draft)); setSel(null); setDraft(""); flash("Saved your words."); });
  const undo = () => run(async () => { const out = await docsApi.undo(id); apply(out.document); setSel(null); flash(`Undid ${out.undid}.`); });
  const accept = (blockId: string) => run(async () => { apply(await docsApi.accept(id, blockId)); });
  const copyText = async () => {
    if (!doc) return;
    const text = doc.blocks.map((b) => ("text" in b ? plain(b.text) : b.type === "figure" ? `${b.title}: ${b.bars.map((x) => `${x.label} ${x.value}${b.unit || ""}`).join("; ")}` : b.type === "table" ? b.rows.map((r) => b.columns.map((c) => r[c.key]).join("\t")).join("\n") : "")).filter(Boolean).join("\n\n");
    try { await navigator.clipboard.writeText(text); setCopied("text"); setTimeout(() => setCopied(null), 1500); } catch { flash("Copy isn't allowed here; select the text instead.", "bad"); }
  };
  const share = async () => {
    try { await navigator.clipboard.writeText(`${window.location.origin}/docs/${id}`); setCopied("link"); setTimeout(() => setCopied(null), 1800); } catch { flash(`Link: ${window.location.origin}/docs/${id}`); }
  };
  const dl = (kind: "docx" | "pdf" | "md") => run(async () => { setMenu(false); await docsApi.download(id, kind, doc?.title); });

  useEffect(() => {
    if (!sel) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { setSel(null); setDraft(""); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sel]);

  if (err) return <div className="dc-wrap"><div className="c2-err">{err}</div></div>;
  if (!doc) return <div className="dc-wrap"><span className="c2-working"><span className="c2-spin" /> Opening the document…</span></div>;
  const editable = doc.can_edit !== false;
  const pick = (b: DocBlock) => { if (!editable || b.type === "sources" || b.type === "figure" || b.type === "table") return; setSel(sel?.id === b.id ? null : { id: b.id, mode: "menu" }); setDraft("text" in b ? plain(b.text) : ""); };
  const onKey = (e: KeyboardEvent, b: DocBlock) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(b); } };

  const renderPop = (b: DocBlock) => {
    if (!sel || sel.id !== b.id) return null;
    const isText = b.type === "paragraph" || b.type === "callout" || b.type === "heading" || b.type === "title" || b.type === "byline";
    if (sel.mode === "type" || sel.mode === "rewrite") {
      return (
        <form className="dc-edit" onClick={(e) => e.stopPropagation()} data-dc-edit={sel.mode}
          onSubmit={(e) => { e.preventDefault(); if (sel.mode === "type") void typeOver(b.id); else void ask(b.id, draft); }}>
          {sel.mode === "type"
            ? <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(10, Math.max(2, Math.ceil(draft.length / 80)))} autoFocus aria-label="Edit the text" />
            : <input value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus placeholder="How should it change? e.g. “say it for a sales team”" aria-label="How should it change" />}
          <div className="row">
            <button type="submit" className="c2-btn dark" disabled={busy || !draft.trim()}>{busy ? "Working…" : sel.mode === "type" ? "Save" : "Rewrite"}</button>
            <button type="button" className="c2-btn ghost" onClick={() => { setSel(null); setDraft(""); }}>Cancel</button>
            {sel.mode === "rewrite" && <span className="hint">Numbers stay as they are; a rewrite that changes one is refused.</span>}
          </div>
        </form>
      );
    }
    return (
      <div className="dc-pop" role="toolbar" aria-label="Change this part" onClick={(e) => e.stopPropagation()} data-dc-pop="">
        {b.type === "paragraph" && <button type="button" className="lead" disabled={busy} onClick={() => void ask(b.id, "Add a graph for this below")} data-dc-act="graph">{I.plus}Add a graph for this below</button>}
        {(b.type === "paragraph" || b.type === "callout") && <button type="button" disabled={busy} onClick={() => void ask(b.id, "make it shorter")} data-dc-act="shorter">Shorter</button>}
        {(b.type === "paragraph" || b.type === "callout") && <button type="button" disabled={busy} onClick={() => { setSel({ id: b.id, mode: "rewrite" }); setDraft(""); }} data-dc-act="rewrite">Rewrite…</button>}
        {isText && <button type="button" disabled={busy} onClick={() => { setSel({ id: b.id, mode: "type" }); setDraft("text" in b ? plain(b.text) : ""); }} data-dc-act="type">Edit text</button>}
        {b.type !== "title" && <button type="button" disabled={busy} onClick={() => void ask(b.id, "remove")} data-dc-act="remove">Remove</button>}
        {busy && <span className="c2-spin" aria-label="Working" />}
      </div>
    );
  };

  return (
    <div className={`dc-wrap${embedded ? " embedded" : ""}`} data-dc-doc={doc.id} onClick={() => sel?.mode === "menu" && setSel(null)}>
      <div className="dc-bar" data-dc-bar="">
        <div className="tt">
          <span className="t" title={doc.title}>{doc.title}</span>
          <span className="m">Created {when(doc.created_at)}{doc.edited_by_person ? " · edited by you" : ""} · {doc.pages} page{doc.pages !== 1 ? "s" : ""} · {doc.figures} figure{doc.figures !== 1 ? "s" : ""}</span>
        </div>
        <span style={{ flex: 1 }} />
        <button type="button" className="dc-ib" onClick={() => void undo()} disabled={!doc.can_undo || busy || !editable} aria-label={doc.history.length ? `Undo: ${doc.history[doc.history.length - 1].label}` : "Nothing to undo"} title={doc.history.length ? `Undo: ${doc.history[doc.history.length - 1].label}` : "Nothing to undo"} data-dc-undo="">{I.undo}</button>
        <button type="button" className="dc-ib" onClick={() => void copyText()} aria-label="Copy the text" title={copied === "text" ? "Copied" : "Copy the text"}>{copied === "text" ? I.check : I.copy}</button>
        <span style={{ position: "relative" }}>
          <button type="button" className="dc-ib" onClick={() => setMenu((m) => !m)} aria-label="Download" aria-expanded={menu} data-dc-download="">{I.down}</button>
          {menu && (
            <div className="dc-menu" role="menu" onClick={(e) => e.stopPropagation()}>
              <button type="button" role="menuitem" onClick={() => void dl("docx")} data-dc-dl="docx"><span>Word</span><small>.docx · figures included</small></button>
              <button type="button" role="menuitem" onClick={() => void dl("pdf")} data-dc-dl="pdf"><span>PDF</span><small>A4 · ready to send</small></button>
              <button type="button" role="menuitem" onClick={() => void dl("md")} data-dc-dl="md"><span>Markdown</span><small>for pasting anywhere</small></button>
            </div>
          )}
        </span>
        <button type="button" className="gx-sc gx-hide-sm" onClick={() => void dl("docx")} data-dc-word="">Open in Word</button>
        <button type="button" className="gx-sc dark" onClick={() => void share()} data-dc-share="">{copied === "link" ? "Link copied" : "Share doc"}</button>
      </div>
      {note && <div className={`dc-note ${note.tone}`} role="status" data-dc-note="">{note.text}{note.tone === "ok" && doc.can_undo && <button type="button" onClick={() => void undo()}>Undo</button>}</div>}
      <div className="dc-scroll">
        <article className="dc-page" data-dc-page="">
          {doc.blocks.map((b) => {
            const selected = sel?.id === b.id;
            const common = { key: b.id, "data-dc-block": b.type, "data-dc-id": b.id } as any;
            if (b.type === "title") {
              return <div {...common} className={`dc-b dc-title${selected ? " on" : ""}`} role={editable ? "button" : undefined} tabIndex={editable ? 0 : undefined} onClick={(e) => { e.stopPropagation(); pick(b); }} onKeyDown={(e) => onKey(e, b)}>{renderPop(b)}<h1>{b.text}</h1></div>;
            }
            if (b.type === "byline") return <p {...common} className="dc-byline">{b.text}</p>;
            if (b.type === "heading") {
              return <div {...common} className={`dc-b${selected ? " on" : ""}`} role={editable ? "button" : undefined} tabIndex={editable ? 0 : undefined} onClick={(e) => { e.stopPropagation(); pick(b); }} onKeyDown={(e) => onKey(e, b)}>{renderPop(b)}<h2>{plain(b.text)}</h2></div>;
            }
            if (b.type === "paragraph") {
              return (
                <div {...common} className={`dc-b dc-p${selected ? " on" : ""}`} role={editable ? "button" : undefined} tabIndex={editable ? 0 : undefined} aria-pressed={editable ? selected : undefined}
                  onClick={(e) => { e.stopPropagation(); pick(b); }} onKeyDown={(e) => onKey(e, b)}>
                  {renderPop(b)}
                  <p><Rich text={b.text} /> <Chips cites={b.cites} sources={doc.sources} onSource={onSource} /></p>
                </div>
              );
            }
            if (b.type === "callout") {
              return (
                <div {...common} className={`dc-b dc-call${selected ? " on" : ""}`} role={editable ? "button" : undefined} tabIndex={editable ? 0 : undefined} onClick={(e) => { e.stopPropagation(); pick(b); }} onKeyDown={(e) => onKey(e, b)}>
                  {renderPop(b)}
                  <p><b>{b.label || "Note"}.</b> {plain(b.text)}</p>
                </div>
              );
            }
            if (b.type === "figure") {
              return (
                <figure {...common} className={`dc-fig${b.pending ? " pending" : ""}`}>
                  <figcaption><span className="t">{b.title}</span>{b.subtitle && <span className="s">{b.subtitle}</span>}</figcaption>
                  <DocFigure b={b} />
                  <div className="foot">
                    <span><Chips cites={b.cites} sources={doc.sources} onSource={onSource} /></span>
                    {b.pending && editable && (
                      <span className="pend" data-dc-pending="">
                        <button type="button" className="gx-sc" onClick={() => void accept(b.id)} disabled={busy} data-dc-ok="">{I.check}OK</button>
                        <button type="button" className="gx-sc ghost" onClick={() => void undo()} disabled={busy} data-dc-fig-undo="">{I.back}Undo</button>
                      </span>
                    )}
                    {!b.pending && editable && <button type="button" className="dc-x" onClick={() => void ask(b.id, "remove")} disabled={busy} aria-label={`Remove ${b.title}`}>Remove</button>}
                  </div>
                </figure>
              );
            }
            if (b.type === "table") {
              return (
                <div {...common} className="dc-tablewrap">
                  <table className="dc-table">
                    <thead><tr>{b.columns.map((c) => <th key={c.key} style={c.align === "right" ? { textAlign: "right" } : undefined}>{c.label}</th>)}</tr></thead>
                    <tbody>{b.rows.map((r, i) => <tr key={i}>{b.columns.map((c) => <td key={c.key} className={c.align === "right" ? "n" : undefined}>{String(r[c.key] ?? "")}</td>)}</tr>)}</tbody>
                  </table>
                  {(b.cites || []).length > 0 && <div className="foot"><Chips cites={b.cites} sources={doc.sources} onSource={onSource} /></div>}
                </div>
              );
            }
            if (b.type === "sources") {
              return (
                <footer {...common} className="dc-sources">
                  <span>Sources: {doc.sources.map((s, i) => <Fragment key={s.id}>{i ? " · " : ""}{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.label}</a> : s.label}</Fragment>)}</span>
                  <span data-dc-checked="">{doc.flagged.length ? `${doc.flagged.length} figure${doc.flagged.length !== 1 ? "s" : ""} not found in the data: ${doc.flagged.join(", ")}` : `Every figure re-checked against the data · ${doc.checked}`}</span>
                </footer>
              );
            }
            return null;
          })}
        </article>
      </div>
    </div>
  );
}

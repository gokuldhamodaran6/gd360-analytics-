// 2026-10-14 (R46): the canvas beside the conversation - a dashboard (live, in its own frame, with the
// chat's chrome), a document (editable text with a download), or the method behind an answer.
import { useEffect, useRef, useState } from "react";
import type { Artifact, Turn } from "../api/v2";
import { api } from "../api/client";
import { layoutSql } from "../project/RunPanels";
import { Markdown } from "./Markdown";

export type CanvasItem =
  | { type: "dashboard"; id: string; name: string; url: string; pageId?: string | null }
  | { type: "document"; id: string; turnId: string; title: string; markdown: string; conversationId: string; flagged?: string[] }
  | { type: "method"; turn: Turn };

export function canvasFromArtifact(a: Artifact, turn: Turn, conversationId: string): CanvasItem | null {
  if (a.type === "dashboard") return { type: "dashboard", id: a.id, name: a.name || "Dashboard", url: a.url || `/dashboard-builder/${a.id}`, pageId: a.page_id };
  if (a.type === "document" && turn.document) return { type: "document", id: a.id, turnId: turn.id, title: turn.document.title, markdown: turn.document.markdown, conversationId, flagged: turn.document.flagged };
  return null;
}

export function Canvas({ item, onClose }: { item: CanvasItem; onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.type === "document" ? item.markdown : "");
  const [copied, setCopied] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const [frameKey, setFrameKey] = useState(0);
  useEffect(() => { if (item.type === "document") { setText(item.markdown); setEditing(false); } }, [item]);
  const title = item.type === "dashboard" ? item.name : item.type === "document" ? item.title : `How I worked it out · ${item.turn.question}`;
  const download = async () => {
    if (item.type !== "document") return;
    const safe = item.title.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "document";
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `${safe}.md`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    void api; // the server copy stays at /v2/conversations/{id}/documents/{turn}.md for integrations
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* fine */ }
  };
  return (
    <aside className="c2-canvas" aria-label="Canvas" data-c2-canvas={item.type}>
      <div className="chrome">
        <button type="button" onClick={onClose} aria-label="Close canvas" title="Close">×</button>
        <span className="t" title={title}>{title}</span>
        {item.type === "dashboard" && <span style={{ color: "rgb(var(--color-muted))" }}>· live</span>}
        <span style={{ flex: 1 }} />
        {item.type === "dashboard" && (
          <>
            <button type="button" onClick={() => setFrameKey((k) => k + 1)} title="Refresh">↺</button>
            <a href={`${item.url}`} target="_blank" rel="noreferrer" title="Open full-screen">Open ⤡</a>
          </>
        )}
        {item.type === "document" && (
          <>
            <button type="button" onClick={() => setEditing((e) => !e)}>{editing ? "Preview" : "Edit"}</button>
            <button type="button" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
            <button type="button" onClick={() => void download()} title="Download as Markdown">Download</button>
          </>
        )}
      </div>
      <div className="pane">
        {item.type === "dashboard" && (
          <iframe key={frameKey} ref={frame} title={item.name} src={`${item.url}${item.url.includes("?") ? "&" : "?"}embed=1${item.pageId ? `&page=${item.pageId}` : ""}`} />
        )}
        {item.type === "document" && (
          editing ? (
            <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck
              style={{ width: "100%", minHeight: "100%", border: 0, outline: 0, resize: "none", padding: "28px 36px", font: "inherit", fontSize: 15, lineHeight: 1.65, background: "transparent", color: "rgb(var(--color-text))", fontFamily: "Geist Mono, ui-monospace, monospace" }} />
          ) : (
            <div className="c2-doc" data-c2-document="">
              <Markdown text={text} />
            </div>
          )
        )}
        {item.type === "method" && (
          <div className="c2-doc">
            <h1 style={{ fontSize: 24 }}>How I worked it out</h1>
            <p style={{ color: "rgb(var(--color-secondary))" }}>{item.turn.question}</p>
            {(item.turn.trail || []).length === 0 && <p>No steps were recorded for this answer.</p>}
            {(item.turn.trail || []).map((t, i) => (
              <div key={i} style={{ marginBottom: 18 }}>
                <h3 style={{ margin: "0 0 4px" }}>{i + 1}. {t.label}{t.status ? <span style={{ fontWeight: 400, color: "rgb(var(--color-muted))", fontSize: 13 }}> · {t.status}</span> : null}{t.ms ? <span style={{ fontWeight: 400, color: "rgb(var(--color-muted))", fontSize: 13 }}> · {(t.ms / 1000).toFixed(1)} s</span> : null}</h3>
                {t.sql && <pre className="c2-mono" style={{ whiteSpace: "pre-wrap", fontSize: 12.5, lineHeight: 1.5, background: "rgb(var(--color-surface))", borderRadius: 12, padding: "12px 14px", overflow: "auto", margin: 0 }}>{layoutSql(t.sql)}</pre>}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

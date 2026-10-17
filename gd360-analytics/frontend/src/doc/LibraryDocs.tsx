// 2026-10-17 (R52): Library > Documents - every document you wrote, newest first, opened full page (/docs/:id) or
// in its conversation. Documents are made by asking in a conversation; this is where they are found again.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { docsApi, type DocRow } from "../api/docs";
import { Shell } from "../chat/Shell";
import TopNav from "../components/TopNav";
import "./doc.css";

function ago(iso: string): string {
  const t = new Date(iso.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`).getTime();
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} day${d === 1 ? "" : "s"} ago` : new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export default function LibraryDocs() {
  const navigate = useNavigate();
  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { let live = true; docsApi.list().then((d) => live && setDocs(d)).catch(() => live && setErr("Your documents didn't load. Refresh to try again.")); return () => { live = false; }; }, []);
  const shown = useMemo(() => (docs || []).filter((d) => !q.trim() || `${d.title} ${d.conversation_title || ""}`.toLowerCase().includes(q.trim().toLowerCase())), [docs, q]);
  return (
    <Shell>
      <div style={{ flex: 1, minWidth: 0, minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        <TopNav breadcrumb={[{ label: "Library", to: "/library" }, { label: "Documents" }]} />
        <div className="ld-page" data-ld-page="">
          <div className="ld-head">
            <div>
              <h1>Documents</h1>
              <p>Briefs and memos written from your conversations. Every figure in them links back to the step that produced it.</p>
            </div>
            <div className="ld-tabs" role="tablist" aria-label="Library">
              <Link to="/library" role="tab" aria-selected="false">Conversations</Link>
              <span role="tab" aria-selected="true" className="on">Documents{docs ? ` ${docs.length}` : ""}</span>
            </div>
          </div>
          {err && <div className="c2-err">{err}</div>}
          {docs && docs.length > 0 && <input className="ld-search" placeholder="Search documents…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search documents" />}
          {docs && docs.length === 0 && (
            <div className="ld-empty" data-ld-empty="">
              <b>No documents yet</b>
              <span>Ask for one in any conversation: “write a one-page brief for the board from this analysis”.</span>
              <button type="button" className="c2-nx dark sm" onClick={() => navigate("/chat")}>New conversation</button>
            </div>
          )}
          {docs && shown.length > 0 && (
            <div className="ld-list" data-ld-list="">
              {shown.map((d) => (
                <div key={d.id} className="ld-row" data-ld-row={d.id}>
                  <Link to={`/docs/${d.id}`} className="ld-main">
                    <span className="ld-ico" aria-hidden="true">▤</span>
                    <span className="ld-t">
                      <b>{d.title}</b>
                      <span>{d.pages} page{d.pages === 1 ? "" : "s"} · {d.figures} figure{d.figures === 1 ? "" : "s"}{d.edited_by_person ? " · edited by you" : ""} · {ago(d.updated_at)}</span>
                    </span>
                  </Link>
                  {d.conversation_id && <Link to={`/chat/${d.conversation_id}`} className="c2-nx sm ghost ld-conv" title={d.conversation_title || undefined}>Conversation</Link>}
                </div>
              ))}
            </div>
          )}
          {docs && docs.length > 0 && shown.length === 0 && <div className="ld-empty"><span>Nothing matches “{q}”.</span></div>}
          {!docs && !err && <div className="c2-working"><span className="c2-spin" /> Loading…</div>}
        </div>
      </div>
    </Shell>
  );
}

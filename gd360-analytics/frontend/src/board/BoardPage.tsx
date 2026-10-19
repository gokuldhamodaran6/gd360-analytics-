// 2026-10-15 (R49): a designed dashboard full-screen, inside the same shell as the conversation.
// 2026-10-19 (R56, list board "Dashboard"): the reader's view - "Dashboards / <name>", Schedule, Share and Edit (which
// opens it on its canvas beside the conversation it was made in), the pages and filters in one bar, the blocks below.
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { boardsApi, type BoardSummary } from "../api/boards";
import { ListPage } from "../studio/Page";
import { Ic } from "../studio/icons";
import { BoardView } from "./BoardView";

export default function BoardPage() {
  const { boardId = "" } = useParams();
  const navigate = useNavigate();
  const [sum, setSum] = useState<BoardSummary | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { let live = true; boardsApi.get(boardId).then((b) => live && setSum(b)).catch(() => undefined); return () => { live = false; }; }, [boardId]);
  const conv = sum?.conversation_id;
  return (
    <ListPage data="board" crumbs={[{ label: "Dashboards", to: "/dashboards" }, { label: sum?.name || "Dashboard" }]} mainClass="sdp-board"
      actions={<>
        {sum?.draft && <span className="sd-chip">Draft · only you</span>}
        {conv && <button type="button" className="sd-pill" onClick={() => navigate(`/chat/${conv}?ask=${encodeURIComponent(`Email the dashboard “${sum?.title || sum?.name}” every Monday at 9am`)}`)} title="Send it on a schedule"><Ic n="clock" />Subscribe</button>}
        <button type="button" className="sd-pill" onClick={() => { void navigator.clipboard?.writeText(window.location.href).catch(() => undefined); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }}><Ic n="share" />{copied ? "Link copied" : "Share"}</button>
        {conv && sum?.can_edit !== false ? <Link to={`/chat/${conv}`} className="sd-btnp" data-board-edit="">Edit</Link> : null}
      </>}>
      <div data-bd-page-full="" className="sdp-full">
        <BoardView key={boardId} id={boardId} studio={{ selected: null, onSelect: () => undefined, changed: {}, editable: false }} />
      </div>
    </ListPage>
  );
}

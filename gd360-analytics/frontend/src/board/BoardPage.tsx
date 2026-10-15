// 2026-10-15 (R49): a designed dashboard full-screen, inside the same shell as the conversation.
// R50: under the one top bar - "Workspace / Dashboards / <its name>".
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { boardsApi } from "../api/boards";
import { Shell } from "../chat/Shell";
import TopNav from "../components/TopNav";
import { BoardView } from "./BoardView";

export default function BoardPage() {
  const { boardId = "" } = useParams();
  const [name, setName] = useState<string>("");
  useEffect(() => { let live = true; boardsApi.get(boardId).then((b) => live && setName(b.name)).catch(() => undefined); return () => { live = false; }; }, [boardId]);
  return (
    <Shell active="chat">
      <div style={{ flex: 1, minWidth: 0, minHeight: "100vh", display: "flex", flexDirection: "column" }} data-bd-page-full="">
        <TopNav breadcrumb={[{ label: "Dashboards", to: "/dashboards" }, { label: name || "Dashboard" }]} />
        <BoardView key={boardId} id={boardId} />
      </div>
    </Shell>
  );
}

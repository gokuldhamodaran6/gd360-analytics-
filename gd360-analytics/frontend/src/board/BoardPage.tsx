// 2026-10-15 (R49): a designed dashboard full-screen, inside the same shell as the conversation.
import { useParams } from "react-router-dom";
import { Shell } from "../chat/Shell";
import { BoardView } from "./BoardView";

export default function BoardPage() {
  const { boardId = "" } = useParams();
  return (
    <Shell active="chat">
      <div style={{ flex: 1, minWidth: 0, minHeight: "100vh", display: "flex", flexDirection: "column" }} data-bd-page-full="">
        <BoardView key={boardId} id={boardId} />
      </div>
    </Shell>
  );
}

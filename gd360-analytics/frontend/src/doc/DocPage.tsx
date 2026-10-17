// 2026-10-15 (R51): a document full page - the link "Share doc" copies - inside the one shell.
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { docsApi } from "../api/docs";
import { Shell } from "../chat/Shell";
import TopNav from "../components/TopNav";
import { DocView } from "./DocView";

export default function DocPage() {
  const { docId = "" } = useParams();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [conv, setConv] = useState<string | null>(null);
  useEffect(() => { let live = true; docsApi.get(docId).then((d) => { if (live) { setTitle(d.title); setConv(d.conversation_id); } }).catch(() => undefined); return () => { live = false; }; }, [docId]);
  return (
    <Shell active="chat">
      <div style={{ flex: 1, minWidth: 0, minHeight: "100vh", display: "flex", flexDirection: "column" }} data-dc-page-full="">
        <TopNav breadcrumb={[{ label: "Library", to: "/library" }, { label: title || "Document" }]}
          actions={conv ? <button type="button" className="gx-sc gx-hide-sm" onClick={() => navigate(`/chat/${conv}`)} data-dc-open-conv="">Open conversation</button> : undefined} />
        <DocView key={docId} id={docId} onChanged={(d) => setTitle(d.title)}
          onSource={(s) => { if (conv) navigate(`/chat/${conv}`); void s; }} />
      </div>
    </Shell>
  );
}

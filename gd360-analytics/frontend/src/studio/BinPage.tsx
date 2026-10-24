// 2026-10-24 (R61): the Bin - answers, dashboards, reports, models and pipelines that were deleted. Each one can be
// restored for 7 days; then it is deleted for good (services/bin.py on the server). "Delete forever" and "Empty the
// Bin" ask once, on the page, before anything is removed.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { Ic } from "./icons";
import { fmtWhen, ListPage, PageHead } from "./Page";

type Item = { kind: "answer" | "dashboard" | "report" | "model" | "pipeline"; type_label: string; id: string; name: string;
  trashed_at: string | null; deleted_for_good_at: string | null; days_left: number | null };
const ICON: Record<Item["kind"], string> = { answer: "chat", dashboard: "grid", report: "doc", model: "chip", pipeline: "flow" };
const LINK = (i: Item) => i.kind === "answer" ? `/chat/${i.id}` : i.kind === "dashboard" ? `/boards/${i.id}` : i.kind === "report" ? `/docs/${i.id}`
  : i.kind === "model" ? `/models/${i.id}` : `/automate/${i.id}`;

export default function BinPage() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [ask, setAsk] = useState<Item | "all" | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get("/v2/bin").then((r) => setItems(r.data.items)).catch((e) => { setErr(e?.response?.data?.detail || "Couldn't open the Bin."); setItems([]); });
  useEffect(() => { void load(); }, []);

  const restore = async (i: Item) => {
    setBusy(true);
    try {
      await api.post(`/v2/bin/${i.kind}/${i.id}/restore`);
      setItems((xs) => (xs || []).filter((x) => !(x.id === i.id && x.kind === i.kind)));
      setNote(`“${i.name}” is back in the Library.`); setErr("");
    } catch (e: any) { setErr(e?.response?.data?.detail || "Couldn't restore it."); }
    setBusy(false);
  };
  const forGood = async () => {
    if (!ask) return;
    setBusy(true);
    try {
      if (ask === "all") { const r = await api.delete("/v2/bin"); setItems([]); setNote(`${r.data.deleted_for_good} item${r.data.deleted_for_good === 1 ? "" : "s"} deleted for good.`); }
      else { await api.delete(`/v2/bin/${ask.kind}/${ask.id}`); setItems((xs) => (xs || []).filter((x) => !(x.id === ask.id && x.kind === ask.kind))); setNote(`“${ask.name}” was deleted for good.`); }
      setErr("");
    } catch (e: any) { setErr(e?.response?.data?.detail || "Couldn't delete it."); }
    setAsk(null); setBusy(false);
  };

  return (
    <ListPage data="bin" crumbs={[{ label: "Library", to: "/library" }, { label: "Bin" }]}>
      <PageHead title="Bin" sub="Deleted answers, dashboards, reports, models and pipelines stay here for 7 days. Restore one to put it back where it was; after 7 days it is deleted for good."
        actions={<>
          <Link to="/library" className="sd-pill"><Ic n="left" />Library</Link>
          {!!items?.length && <button type="button" className="sd-pill bin-danger" onClick={() => setAsk("all")} data-bin-empty=""><Ic n="trash" />Empty the Bin</button>}
        </>} />
      {err && <div className="sd-err" role="alert">{err}</div>}
      {note && !err && <div className="ws-binnote" role="status" data-bin-note="">{note}</div>}
      {ask && (
        <div className="bin-ask" role="alertdialog" aria-label="Delete for good?" data-bin-ask="">
          <div><b>{ask === "all" ? `Delete all ${items?.length || 0} item${items?.length === 1 ? "" : "s"} for good?` : `Delete “${ask.name}” for good?`}</b>
            <span>This can't be undone - {ask === "all" ? "they" : "it"} can't be restored after this.</span></div>
          <span className="sd-sp" />
          <button type="button" className="sd-pill" onClick={() => setAsk(null)} disabled={busy}>Keep in the Bin</button>
          <button type="button" className="sd-btnp bin-danger-solid" onClick={() => void forGood()} disabled={busy} data-bin-confirm="">Delete for good</button>
        </div>
      )}
      <div className="sd-card" style={{ overflow: "hidden" }}>
        <div className="sd-tw">
          <table className="sd-t" data-bin-table="">
            <thead><tr><th>Name</th><th>Type</th><th>Deleted</th><th>Deleted for good</th><th className="r" aria-label="Actions" /></tr></thead>
            <tbody>
              {!items && <tr><td colSpan={5}><span className="c2-working" style={{ opacity: .5 }}>…</span></td></tr>}
              {items?.map((i) => (
                <tr key={`${i.kind}:${i.id}`} data-bin-row={i.kind}>
                  <td style={{ maxWidth: 420, fontWeight: 500 }}>{i.name}</td>
                  <td><span className="sdp-type"><i><Ic n={ICON[i.kind] as any} s={12} /></i>{i.type_label}</span></td>
                  <td className="sd-sub" style={{ fontSize: 13.5 }}>{fmtWhen(i.trashed_at)}</td>
                  <td className="sd-sub" style={{ fontSize: 13.5 }}>{i.days_left === null ? "—" : i.days_left <= 1 ? "Within a day" : `In ${i.days_left} days`}</td>
                  <td className="r" style={{ whiteSpace: "nowrap" }}>
                    <button type="button" className="sd-tool sm" onClick={() => void restore(i)} disabled={busy} data-bin-restore=""><Ic n="undo" s={13} />Restore</button>
                    <button type="button" className="sd-tool sm bin-danger" onClick={() => setAsk(i)} disabled={busy} data-bin-forever="">Delete forever</button>
                  </td>
                </tr>
              ))}
              {items && !items.length && (
                <tr><td colSpan={5}><div className="sd-empty"><Ic n="trash" s={22} />The Bin is empty. Anything you delete stays here for 7 days, so you can bring it back.</div></td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="sdp-tfoot"><span>Restored items go back to the Library, with everything they had. Open one after restoring it: {items?.[0] ? <Link to={LINK(items[0])}>its link</Link> : "its link"} works again.</span></div>
      </div>
    </ListPage>
  );
}

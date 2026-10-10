import { useMemo, useState } from "react";
import { errorText, Initiative, initiativesApi, Item } from "../api/initiatives";
import { Banner, Field, fmtDate, Section, Sheet } from "./ui";

type Props = { i: Initiative; reload: () => void; onError: (s: string) => void };

const TRACKERS = ["Jira", "Linear", "Asana", "ClickUp", "Trello", "monday.com", "Notion", "Greenhouse", "Spreadsheet"];

export default function BoardTab({ i, reload, onError }: Props) {
  const [open, setOpen] = useState<Item | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [group, setGroup] = useState("");
  const closed = i.board.stages.filter((s) => ["Rejected", "Dropped", "Lost"].includes(s));
  const live = i.board.stages.filter((s) => !closed.includes(s));
  const groups = useMemo(() => Array.from(new Set(i.items.map((x) => x.group).filter(Boolean))) as string[], [i.items]);
  const items = i.items.filter((x) => !group || x.group === group);

  const move = async (it: Item, stage: string) => {
    if (it.stage === stage) return;
    try { await initiativesApi.patchItem(i.id, it.id, { stage }); reload(); } catch (e) { onError(errorText(e)); }
  };

  const noun = i.kind === "hiring" ? "candidate" : i.kind === "product" ? "card" : ["event", "webinar", "campaign", "abm"].includes(i.kind) ? "account" : "card";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap text-ui text-secondary">
          <span>{i.items.length} {noun}{i.items.length === 1 ? "" : "s"}</span>
          {groups.length > 0 && (
            <select className="input !w-auto !py-1.5 text-caption" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group">
              <option value="">All {i.kind === "hiring" ? "roles" : "groups"}</option>
              {groups.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          )}
        </div>
        {i.can_edit && (
          <div className="flex gap-2">
            <button type="button" className="btn-secondary text-sm" onClick={() => setImporting(true)} data-board-import="">Import from a tracker</button>
            <button type="button" className="btn-primary text-sm" onClick={() => setAdding(true)} data-board-add="">Add {noun}</button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0 pb-2">
        <div className="flex gap-3 min-w-max" data-board="">
          {[...live, ...closed].map((stage) => {
            const cards = items.filter((x) => x.stage === stage).sort((a, b) => a.position - b.position);
            const isClosed = closed.includes(stage);
            return (
              <div key={stage} data-column={stage}
                onDragOver={(e) => { if (i.can_edit) { e.preventDefault(); setOver(stage); } }} onDragLeave={() => setOver(null)}
                onDrop={(e) => { e.preventDefault(); setOver(null); const it = i.items.find((x) => x.id === drag); if (it) move(it, stage); setDrag(null); }}
                className={`w-[260px] shrink-0 rounded-card border p-2.5 flex flex-col gap-2 transition-colors ${over === stage ? "border-primary bg-tint" : isClosed ? "border-border bg-base opacity-80" : "border-border bg-surface"}`}>
                <div className="flex items-center justify-between px-1 pt-0.5">
                  <span className="text-caption font-semibold text-text uppercase tracking-caps">{stage}</span>
                  <span className="text-caption text-muted tabular-nums">{cards.length}</span>
                </div>
                {cards.map((c) => (
                  <div key={c.id} draggable={i.can_edit} onDragStart={() => setDrag(c.id)} data-card={c.id}
                    className="rounded-ctl border border-border bg-base p-3 flex flex-col gap-1.5 cursor-grab active:cursor-grabbing hover:border-border-strong">
                    <button type="button" className="ui-focus text-left text-ui text-text font-medium leading-snug" onClick={() => setOpen(c)}>{c.title}</button>
                    {(c.subtitle || c.group) && <span className="text-caption text-muted truncate">{[c.group, c.subtitle].filter(Boolean).join(" · ")}</span>}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-caption text-secondary truncate">{c.owner_name || ""}</span>
                      {c.link && <a href={c.link} target="_blank" rel="noreferrer" className="text-caption text-primary hover:underline shrink-0">Open ↗</a>}
                    </div>
                    {i.can_edit && (
                      <select className="input !py-1 !px-2 text-caption sm:hidden" value={c.stage} onChange={(e) => move(c, e.target.value)} aria-label="Move to">
                        {i.board.stages.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    )}
                  </div>
                ))}
                {cards.length === 0 && <div className="text-caption text-muted px-1 py-3 text-center">{i.can_edit ? "Drop here" : "Empty"}</div>}
              </div>
            );
          })}
        </div>
      </div>

      {i.kind === "product" && (
        <p className="m-0 text-caption text-muted">Your engineers don't need to change tools: keep Jira, Linear, Asana or whatever they use, re-import its export whenever you like (cards are matched, only moves are applied), or paste each card's link so anyone can jump to the source.</p>
      )}

      {adding && <ItemSheet i={i} onClose={() => setAdding(false)} reload={reload} onError={onError} noun={noun} />}
      {open && <ItemSheet i={i} item={open} onClose={() => setOpen(null)} reload={reload} onError={onError} noun={noun} />}
      {importing && <ImportSheet i={i} onClose={() => setImporting(false)} reload={reload} />}
    </div>
  );
}

function ItemSheet({ i, item, onClose, reload, onError, noun }: { i: Initiative; item?: Item; onClose: () => void; reload: () => void; onError: (s: string) => void; noun: string }) {
  const [f, setF] = useState({ title: item?.title || "", subtitle: item?.subtitle || "", group: item?.group || "", stage: item?.stage || i.board.stages[0],
    email: item?.email || "", link: item?.link || "", owner_name: item?.owner_name || "", notes: item?.notes || "" });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (item) await initiativesApi.patchItem(i.id, item.id, f);
      else await initiativesApi.addItem(i.id, f);
      reload(); onClose();
    } catch (e) { onError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title={item ? item.title : `Add ${noun}`}
      footer={i.can_edit ? (<>
        {item && <button type="button" className="btn-secondary text-sm !text-danger" disabled={busy} onClick={async () => { try { await initiativesApi.deleteItem(i.id, item.id); reload(); onClose(); } catch (e) { onError(errorText(e)); } }}>Delete</button>}
        <button type="button" className="btn-primary text-sm" disabled={busy || !f.title.trim()} onClick={save}>{item ? "Save" : "Add"}</button>
      </>) : undefined}>
      <Field label={i.kind === "hiring" ? "Candidate name" : "Title"}><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} disabled={!i.can_edit} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={i.kind === "hiring" ? "Role" : i.kind === "product" ? "Milestone / sprint" : "Group"}><input className="input" value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })} disabled={!i.can_edit} /></Field>
        <Field label="Stage"><select className="input" value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })} disabled={!i.can_edit}>{i.board.stages.map((s) => <option key={s}>{s}</option>)}</select></Field>
        <Field label={i.kind === "hiring" ? "Interviewer / owner" : "Owner"}><input className="input" value={f.owner_name} onChange={(e) => setF({ ...f, owner_name: e.target.value })} disabled={!i.can_edit} /></Field>
        <Field label={i.kind === "hiring" ? "Current company / source" : "Subtitle"}><input className="input" value={f.subtitle} onChange={(e) => setF({ ...f, subtitle: e.target.value })} disabled={!i.can_edit} /></Field>
        {i.kind === "hiring" && <Field label="Email"><input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} disabled={!i.can_edit} /></Field>}
        <Field label={i.kind === "hiring" ? "CV / profile link" : "Link (ticket, design, doc)"}><input className="input" value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })} disabled={!i.can_edit} /></Field>
      </div>
      <Field label="Notes"><textarea className="input min-h-[100px]" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} disabled={!i.can_edit} /></Field>
      {item?.stage_changed_at && <span className="text-caption text-muted">In “{item.stage}” since {fmtDate(item.stage_changed_at)}{item.data?.source ? ` · imported from ${item.data.source}` : ""}</span>}
    </Sheet>
  );
}

function ImportSheet({ i, onClose, reload }: { i: Initiative; onClose: () => void; reload: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState("Jira");
  const [preview, setPreview] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async (commit: boolean, f = file) => {
    if (!f) return;
    setBusy(true); setErr("");
    try {
      const r = await initiativesApi.importItems(i.id, f, source, commit);
      if (commit) { setResult(r); reload(); } else setPreview(r);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title="Import from a tracker" wide
      footer={<>{preview && !result && <button type="button" className="btn-primary text-sm" disabled={busy} onClick={() => go(true)}>Import {preview.rows} cards</button>}
        {result && <button type="button" className="btn-primary text-sm" onClick={onClose}>Done</button>}</>}>
      <p className="m-0 text-ui text-secondary">Export issues or tasks as CSV from your tracker and drop the file here. Titles, statuses, assignees and sprints are matched automatically; statuses become board stages. Importing again only moves cards that changed.</p>
      <Field label="From"><select className="input" value={source} onChange={(e) => setSource(e.target.value)}>{TRACKERS.map((t) => <option key={t}>{t}</option>)}</select></Field>
      <input type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0] || null; setFile(f); setPreview(null); setResult(null); if (f) go(false, f); }} aria-label="CSV file" data-board-file="" />
      {err && <Banner kind="error">{err}</Banner>}
      {preview && !result && (
        <div className="flex flex-col gap-3">
          <div className="text-ui text-text">{preview.rows} rows · columns matched: {Object.entries(preview.mapping).map(([k, v]) => `${k} ← ${v}`).join(", ")}</div>
          <div className="flex gap-2 flex-wrap">{Object.entries(preview.stages).map(([s, n]) => <span key={s} className="text-caption px-2.5 h-[26px] inline-flex items-center rounded-full bg-surface2 text-secondary">{s}: {String(n)}</span>)}</div>
          <table className="w-full text-caption"><thead><tr className="text-muted text-left"><th className="py-1 font-medium">Title</th><th className="font-medium">Their status</th><th className="font-medium">Stage here</th></tr></thead>
            <tbody>{preview.sample.map((r: any, k: number) => <tr key={k} className="border-t border-border"><td className="py-1.5 pr-2">{r.title}</td><td className="text-secondary">{r.status}</td><td className="text-text">{r.stage}</td></tr>)}</tbody></table>
        </div>
      )}
      {result && <Banner kind="good">Imported: {result.created || 0} new, {result.moved || 0} moved, {result.unchanged || 0} unchanged.</Banner>}
    </Sheet>
  );
}

export { Section };

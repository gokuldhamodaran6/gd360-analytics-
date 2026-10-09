// 2026-10-09 (round 15): create or edit a Space - its name, colour,
// description, which sources it holds and who can see it - and delete it
// (confirmed in place). Deleting a Space never touches the sources in it.
import { useEffect, useMemo, useState } from "react";
import BrandTile from "../components/BrandTile";
import { DataSourceSummary, workspaceApi, WorkspaceMember } from "../api/client";
import { Space, SpaceAccess, SPACE_COLORS, spacesApi } from "../api/spaces";
import { connectionKindMeta } from "../components/DataSourceForm";
import { chipClass, CloseButton, errorText, ErrorNote, Overlay } from "./shared";

export default function SpaceEditor({
  space,
  sources,
  workspaceId,
  isPersonalWorkspace,
  onClose,
  onSaved,
  onDeleted,
}: {
  space: Space | null;
  sources: DataSourceSummary[] | null;
  workspaceId?: string | null;
  isPersonalWorkspace?: boolean;
  onClose: () => void;
  onSaved: (s: Space) => void;
  onDeleted: (id: string) => void;
}) {
  const editing = !!space;
  const [name, setName] = useState(space?.name || "");
  const [color, setColor] = useState(space?.color || SPACE_COLORS[0]);
  const [description, setDescription] = useState(space?.description || "");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(space?.source_ids || []));
  const [access, setAccess] = useState<SpaceAccess>(space?.access || "private");
  const [memberIds, setMemberIds] = useState<Set<string>>(() => new Set(space?.member_ids || []));
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!workspaceId || isPersonalWorkspace) {
      setMembers([]);
      return;
    }
    workspaceApi
      .get(workspaceId)
      .then((d) => setMembers(d.members || []))
      .catch(() => setMembers([]));
  }, [workspaceId, isPersonalWorkspace]);

  const canChoosePeople = (members?.length || 0) > 1 || access === "members";

  const list = useMemo(() => {
    const all = sources || [];
    const n = filter.trim().toLowerCase();
    return n ? all.filter((s) => s.name.toLowerCase().includes(n) || connectionKindMeta(s.kind).label.toLowerCase().includes(n)) : all;
  }, [sources, filter]);

  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    const nm = name.trim();
    if (!nm) {
      setError("Give the Space a name.");
      return;
    }
    if (access === "members" && memberIds.size === 0) {
      setError("Choose at least one person, or pick another option under “Who can see it”.");
      return;
    }
    setBusy(true);
    setError("");
    const body = {
      name: nm,
      color,
      description: description.trim() || null,
      access,
      member_ids: access === "members" ? Array.from(memberIds) : [],
      source_ids: Array.from(picked),
    };
    try {
      const out = editing ? await spacesApi.update(space!.id, body) : await spacesApi.create({ ...body, workspace_id: workspaceId || null });
      onSaved(out);
    } catch (e: any) {
      setError(errorText(e, editing ? "Couldn't save the Space. Please try again." : "Couldn't create the Space. Please try again."));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!space) return;
    setBusy(true);
    setError("");
    try {
      await spacesApi.remove(space.id);
      onDeleted(space.id);
    } catch (e: any) {
      setError(errorText(e, "Couldn't delete the Space. Please try again."));
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  const accessOpts: { v: SpaceAccess; n: string }[] = [
    { v: "private", n: "Only me" },
    { v: "workspace", n: "Everyone in this workspace" },
    ...(canChoosePeople ? [{ v: "members" as SpaceAccess, n: "Chosen people" }] : []),
  ];

  const title = editing ? `Edit ${space!.name}` : "New space";

  return (
    <Overlay label={title} onClose={onClose}>
      <div className="p-5 sm:p-7 flex flex-col gap-[22px]">
        <div className="flex justify-between items-center gap-3">
          <h2 className="m-0 text-[22px] font-semibold text-text truncate">{title}</h2>
          <CloseButton onClick={onClose} />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="space-name" className="text-[13px] text-secondary">Name</label>
          <input id="space-name" className="input h-11 text-[15px]" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Social media" autoComplete="off" />
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[13px] text-secondary" id="space-colour">Colour</span>
          <div className="flex gap-2.5 flex-wrap" role="group" aria-labelledby="space-colour">
            {SPACE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Colour ${c}`}
                aria-pressed={color.toUpperCase() === c.toUpperCase()}
                onClick={() => setColor(c)}
                className="ui-focus w-8 h-8 rounded-[10px] border-2"
                style={{ background: c, borderColor: color.toUpperCase() === c.toUpperCase() ? "rgb(var(--color-text))" : "transparent" }}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="space-desc" className="text-[13px] text-secondary">
            Description <span className="text-muted">(optional)</span>
          </label>
          <input id="space-desc" className="input h-11" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} placeholder="Social pages, ads, web and search" />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex justify-between items-center gap-3 flex-wrap">
            <span className="text-[13px] text-secondary" id="space-sources">Sources · {picked.size} chosen</span>
            {(sources?.length || 0) > 8 && (
              <>
                <label htmlFor="space-source-filter" className="sr-only">Filter sources</label>
                <input
                  id="space-source-filter"
                  type="search"
                  className="input h-9 text-[13px] w-full sm:w-56"
                  placeholder="Filter sources"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </>
            )}
          </div>
          {sources === null ? (
            <span className="text-[13px] text-muted">Loading your sources…</span>
          ) : sources.length === 0 ? (
            <span className="text-[13px] text-muted">No sources in this workspace yet — you can add them to the Space later.</span>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[300px] overflow-y-auto pr-0.5" role="group" aria-labelledby="space-sources">
              {list.map((s) => {
                const on = picked.has(s.id);
                return (
                  <label
                    key={s.id}
                    className={`flex items-center gap-2.5 px-3 py-2.5 rounded-[11px] border bg-surface cursor-pointer min-w-0 ${on ? "border-primary/50" : "border-border hover:border-border-strong"}`}
                  >
                    <input type="checkbox" className="w-4 h-4 shrink-0" checked={on} onChange={() => toggle(s.id)} />
                    <BrandTile kind={s.kind} name={s.name} size={28} />
                    <span className="text-[13.5px] text-text truncate">{s.name}</span>
                  </label>
                );
              })}
              {list.length === 0 && <span className="text-[13px] text-muted">No source matches “{filter.trim()}”.</span>}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[13px] text-secondary" id="space-access">Who can see it</span>
          <div className="flex gap-2 flex-wrap" role="group" aria-labelledby="space-access">
            {accessOpts.map((o) => (
              <button key={o.v} type="button" aria-pressed={access === o.v} onClick={() => setAccess(o.v)} className={chipClass(access === o.v)}>
                {o.n}
              </button>
            ))}
          </div>
          {access === "members" && (
            <div className="flex flex-col gap-1.5 mt-1">
              {members === null && <span className="text-[13px] text-muted">Loading people…</span>}
              {members?.map((m) => (
                <label key={m.user_id} className="flex items-center gap-2.5 px-3 py-2 rounded-[10px] border border-border bg-surface cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-4 h-4 shrink-0"
                    checked={memberIds.has(m.user_id)}
                    onChange={() =>
                      setMemberIds((p) => {
                        const next = new Set(p);
                        if (next.has(m.user_id)) next.delete(m.user_id);
                        else next.add(m.user_id);
                        return next;
                      })
                    }
                  />
                  <span className="flex flex-col min-w-0">
                    <span className="text-[13.5px] text-text truncate">{m.full_name || m.email}</span>
                    {m.full_name && <span className="text-[12px] text-muted truncate">{m.email}</span>}
                  </span>
                </label>
              ))}
            </div>
          )}
          <span className="text-[12.5px] text-muted">Row and column rules from the Trust Center still apply inside every Space.</span>
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}

        {confirmDelete ? (
          <div className="flex flex-col gap-3 p-4 rounded-[12px] border border-danger-border bg-danger-fill" role="alert">
            <span className="text-[13.5px] text-text">
              Delete {space?.name}? The sources stay connected — only this grouping goes, along with its place in the sidebar.
            </span>
            <div className="flex gap-2 flex-wrap">
              <button type="button" className="btn-secondary text-sm !text-danger" onClick={remove} disabled={busy}>
                {busy ? "Deleting…" : "Delete for good"}
              </button>
              <button type="button" className="btn-secondary text-sm" onClick={() => setConfirmDelete(false)} disabled={busy}>
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <div className="flex justify-between items-center gap-2.5 flex-wrap">
            {editing ? (
              <button type="button" className="ui-focus text-[13.5px] text-danger hover:underline" onClick={() => setConfirmDelete(true)} disabled={busy}>
                Delete space
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-2.5 ml-auto">
              <button type="button" className="btn-secondary h-10 text-[14px]" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn-primary h-10 text-[14px]" onClick={save} disabled={busy || !name.trim()}>
                {busy ? (editing ? "Saving…" : "Creating…") : editing ? "Save changes" : "Create space"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Overlay>
  );
}

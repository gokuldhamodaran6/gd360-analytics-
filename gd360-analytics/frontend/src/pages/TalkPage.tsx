// 2026-10-11 (round 24): a saved talk with Euliv (/v/:id) - Library › Talks.
//
// Every turn, both ways, with its time; the read-backs as they were agreed;
// each answer right here (its numbers, and the whole result one tap away).
// "Continue talking" opens Euliv with this talk loaded - same data, same
// numbers - and it greets you with "Welcome back". Words only: no audio is
// ever recorded. Only the person who talked can see it.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import { assistantApi, type Talk } from "../api/assistant";
import { cardFromSaved, EulivCardView } from "../components/EulivCards";
import { OrbGlyph, openEuliv } from "../components/Euliv";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { Spinner } from "../thread/parts";

function clock(at: string): string {
  const d = new Date(at.endsWith("Z") || at.includes("+") ? at : at + "Z");
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function when(at: string): string {
  const d = new Date(at.endsWith("Z") || at.includes("+") ? at : at + "Z");
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  const day = same ? "Today" : d.toDateString() === y.toDateString() ? "Yesterday" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return `${day}, ${clock(at)}`;
}

export default function TalkPage() {
  const { talkId = "" } = useParams();
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [talk, setTalk] = useState<Talk | null>(null);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    let alive = true;
    setTalk(null);
    setError("");
    assistantApi
      .talk(talkId)
      .then((t) => alive && (setTalk(t), setTitle(t.title)))
      .catch((e) => alive && setError(e?.response?.status === 404 ? "This talk doesn't exist, or it isn't yours." : "Couldn't load this talk. Please try again."));
    // a talk carried on in Euliv adds turns here: reload when it closes
    const reload = () => assistantApi.talk(talkId).then((t) => alive && setTalk(t)).catch(() => undefined);
    window.addEventListener("focus", reload);
    const iv = window.setInterval(reload, 8000);
    return () => {
      alive = false;
      window.removeEventListener("focus", reload);
      window.clearInterval(iv);
    };
  }, [talkId]);

  const answers = useMemo(
    () => (talk?.messages || []).filter((m) => m.card?.type === "answer" && m.card.status === "done"),
    [talk],
  );
  const explains = useMemo(() => (talk?.messages || []).filter((m) => m.card?.type === "explain"), [talk]);

  const saveTitle = async () => {
    const t = title.trim();
    setRenaming(false);
    if (!talk || !t || t === talk.title) return setTitle(talk?.title || "");
    try {
      const r = await assistantApi.renameTalk(talk.id, t);
      setTalk({ ...talk, title: r.title });
    } catch {
      setTitle(talk.title);
    }
  };

  const remove = async () => {
    if (!talk) return;
    try {
      await assistantApi.deleteTalk(talk.id);
      navigate("/library?type=talk");
    } catch {
      setError("Couldn't delete this talk. Please try again.");
    }
  };

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="px-4 sm:px-8 pt-16 lg:pt-6 pb-5 border-b border-border flex flex-wrap items-center gap-4" data-talk-header="">
          <span className="w-11 h-11 rounded-full gd-orb shrink-0" aria-hidden="true" />
          <div className="flex-1 min-w-[220px] flex flex-col gap-1">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
              <Link to="/library" className="hover:text-text">Library</Link> / <Link to="/library?type=talk" className="hover:text-text">Talks</Link>
            </span>
            <div className="flex items-center gap-2.5 flex-wrap">
              {renaming ? (
                <input
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={saveTitle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveTitle();
                    if (e.key === "Escape") { setTitle(talk?.title || ""); setRenaming(false); }
                  }}
                  maxLength={80}
                  aria-label="Talk name"
                  className="h-10 min-w-[260px] rounded-ctl border border-border-strong bg-base px-3 text-[20px] font-semibold text-text outline-none focus:border-kind-answer-border"
                />
              ) : (
                <h1 className="m-0 text-[22px] sm:text-[24px] font-semibold tracking-tight text-text" data-talk-title="">{talk?.title || "Talk"}</h1>
              )}
              <span className="inline-flex items-center gap-1.5 h-[22px] px-2 rounded-full border border-kind-analysis-border bg-kind-analysis-fill text-[11.5px] font-semibold text-text">
                <OrbGlyph size={10} /> Talk
              </span>
            </div>
            {talk && (
              <span className="text-[13px] text-secondary">
                Talked with Euliv · {when(talk.created_at)}
                {talk.questions ? ` · ${talk.questions} question${talk.questions === 1 ? "" : "s"}` : ""}
                {talk.sources.length ? ` · ${talk.sources.join(", ")}` : ""} · only you
              </span>
            )}
          </div>
          {talk && (
            <div className="flex items-center gap-2 flex-wrap">
              <button type="button" onClick={() => openEuliv(undefined, { talkId: talk.id })}
                className="ui-focus h-11 pl-1.5 pr-4 rounded-full bg-kind-answer text-[rgb(var(--color-base))] text-[14px] font-semibold inline-flex items-center gap-2.5 transition-transform hover:scale-[1.02] active:scale-[0.98]"
                data-talk-continue="">
                <span className="w-8 h-8 rounded-full bg-[rgb(var(--color-base))] text-kind-answer grid place-items-center" aria-hidden="true">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" /></svg>
                </span>
                Continue talking
              </button>
              <div className="relative">
                <button type="button" onClick={() => setMenu((v) => !v)} aria-label="More: rename, delete" aria-expanded={menu}
                  className="ui-focus w-11 h-11 rounded-full border border-border-strong text-secondary hover:text-text grid place-items-center" data-talk-menu="">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
                </button>
                {menu && (
                  <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-52 rounded-[14px] border border-border bg-surface p-1.5 shadow-[0_20px_50px_-20px_rgb(0_0_0/0.7)]" role="menu">
                    {!confirmDelete ? (
                      <>
                        <button type="button" role="menuitem" onClick={() => { setMenu(false); setRenaming(true); }} className="w-full text-left h-9 px-3 rounded-[9px] text-ui text-text hover:bg-subtle">Rename</button>
                        <button type="button" role="menuitem" onClick={() => setConfirmDelete(true)} className="w-full text-left h-9 px-3 rounded-[9px] text-ui text-danger hover:bg-danger-fill">Delete talk…</button>
                      </>
                    ) : (
                      <div className="p-2 flex flex-col gap-2">
                        <span className="text-[12.5px] text-secondary leading-snug">Delete this talk? Its answers stay in Library.</span>
                        <div className="flex gap-2">
                          <button type="button" onClick={remove} className="h-8 px-3 rounded-[8px] bg-danger text-white text-[12.5px] font-medium" data-talk-delete="">Delete</button>
                          <button type="button" onClick={() => { setConfirmDelete(false); setMenu(false); }} className="h-8 px-3 rounded-[8px] text-[12.5px] text-secondary hover:bg-subtle">Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </header>

        <main className="px-4 sm:px-8 py-7 pb-24 grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px] items-start">
          {error && <div role="alert" className="lg:col-span-2 rounded-card border border-danger-border bg-danger-fill p-4 text-ui text-danger">{error}</div>}
          {!talk && !error && <div className="flex items-center gap-2 text-ui text-secondary"><Spinner /> Loading the talk…</div>}
          {talk && (
            <section aria-label="The conversation" className="flex flex-col gap-5 min-w-0 max-w-[860px]" data-talk-log="">
              {talk.messages.map((m) => {
                if (m.card?.type === "working") return null;
                const card = cardFromSaved(m.card);
                return m.role === "user" ? (
                  <div key={m.id} className="flex items-start justify-end gap-3">
                    <span className="max-w-[78%] rounded-[18px] rounded-br-[6px] bg-subtle px-4 py-2.5 text-[15px] leading-snug text-text" data-talk-you="">{m.text}</span>
                    <time className="w-12 shrink-0 pt-2.5 font-mono text-[11px] text-faint text-right">{clock(m.at)}</time>
                  </div>
                ) : (
                  <div key={m.id} className="flex items-start gap-3">
                    <time className="w-12 shrink-0 pt-1 font-mono text-[11px] text-faint">{clock(m.at)}</time>
                    <div className="flex-1 min-w-0 flex flex-col gap-3" data-talk-euliv="">
                      <p className="m-0 text-[16px] leading-[1.55] text-text text-pretty">{m.text}</p>
                      {card && <EulivCardView card={card} h={{ onPick: () => undefined, readOnly: true }} />}
                    </div>
                  </div>
                );
              })}
              <div className="flex items-center gap-3 pt-2 text-[12px] text-faint">
                <span className="flex-1 h-px bg-border" />
                <button type="button" onClick={() => openEuliv(undefined, { talkId: talk.id })} className="ui-focus inline-flex items-center gap-2 rounded-full px-3 h-8 text-secondary hover:text-text hover:bg-subtle/60">
                  <OrbGlyph size={12} /> Carry on where you left off
                </button>
                <span className="flex-1 h-px bg-border" />
              </div>
            </section>
          )}
          {talk && (
            <aside aria-label="About this talk" className="flex flex-col gap-4 lg:sticky lg:top-6">
              <div className="rounded-card border border-border bg-surface p-4 flex flex-col gap-2.5">
                <b className="text-[14px] text-text">In this talk</b>
                {answers.length === 0 && explains.length === 0 && <span className="text-[13px] text-muted">No answers yet.</span>}
                {answers.map((m) => (
                  <Link key={m.id} to={m.card.link} className="flex items-center gap-2.5 px-3 py-2.5 rounded-[12px] border border-kind-answer-border bg-kind-answer-fill/50 text-[13px] text-text hover:brightness-110">
                    <span className="h-[20px] px-1.5 rounded-md bg-kind-answer-fill text-kind-answer text-[11px] font-semibold inline-flex items-center shrink-0">Answer</span>
                    <span className="truncate">{m.card.card?.headline || m.card.card?.question || "Answer"}</span>
                  </Link>
                ))}
                {explains.map((m) => (
                  <div key={m.id} className="flex items-center gap-2.5 px-3 py-2.5 rounded-[12px] border border-border text-[13px] text-secondary">
                    <span className="h-[20px] px-1.5 rounded-md bg-kind-analysis-fill text-kind-analysis text-[11px] font-semibold inline-flex items-center shrink-0">Explained</span>
                    <span className="truncate">{m.card.headline || "Explanation"}</span>
                  </div>
                ))}
              </div>
              {talk.sources.length > 0 && (
                <div className="rounded-card border border-border bg-surface p-4 flex flex-col gap-2 text-[13px] text-secondary">
                  <b className="text-[14px] text-text">Data used</b>
                  {talk.sources.map((s) => <span key={s}>{s}</span>)}
                </div>
              )}
              <div className="rounded-card border border-border bg-surface p-4 flex flex-col gap-2">
                <b className="text-[14px] text-text">Continue talking picks up here</b>
                <span className="text-[13px] leading-snug text-secondary">Euliv opens with this talk loaded - same data, same numbers - and greets you with “Welcome back”.</span>
              </div>
              <div className="rounded-card border border-kind-answer-border bg-kind-answer-fill/50 p-3.5 text-[12.5px] leading-snug text-secondary">
                <b className="text-text">Words only.</b> No audio was recorded. Only you can see this talk. Turn saving off in Euliv settings › “Keep a written record”.
              </div>
            </aside>
          )}
        </main>
      </div>
    </div>
  );
}

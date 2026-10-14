// 2026-10-10: what Mission Control publishes into the app for signed-in
// people: live announcements (a banner or a modal, per audience) and
// a "Help" button that opens a support ticket with the GD360 team.
// 2026-10-13 (R45): the banner is a small card at the top right (under the
// page header), never over the question box at the bottom; it follows the
// light/dark theme tokens, and a dismissed announcement stays dismissed on
// this device even before the server hears about it.
import { FormEvent, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, errorDetailText } from "../api/client";
import { useAuth } from "../api/AuthContext";
import { useFocusTrap } from "../thread/a11y";

type Ann = { id: string; kind: "banner" | "modal"; title: string; body?: string; cta_label?: string; cta_url?: string };

const HIDDEN_ON = ["/admin", "/pricing", "/about", "/start", "/register", "/login", "/admin-login", "/help", "/public", "/d/", "/invite", "/privacy", "/connect/", "/e/", "/w/", "/a/", "/r/", "/staff/", "/t/", "/sp/", "/f/", "/x/", "/sign/"];

const DISMISSED_KEY = "gd360_dismissed_announcements";

function readDismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rememberDismissed(id: string) {
  try {
    const next = [...readDismissed().filter((x) => x !== id), id].slice(-50);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked - the server still records it */
  }
}

const BTN_P = "ui-focus h-9 px-3.5 rounded-full bg-primary text-on-primary text-[13px] font-semibold hover:opacity-95 disabled:opacity-60";
const BTN = "ui-focus h-9 px-3.5 rounded-full border border-border-strong text-[13px] font-semibold text-text hover:bg-subtle";
const FIELD = "rounded-[10px] border border-border-strong bg-base text-text px-2.5 text-[14px] placeholder:text-faint focus:outline-none focus:border-kind-answer-border";

export default function InAppMessages() {
  const { user } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const [anns, setAnns] = useState<Ann[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [state, setState] = useState<"" | "sending" | "sent">("");
  const [err, setErr] = useState("");
  const hidden = !user || HIDDEN_ON.some((p) => loc.pathname.startsWith(p));
  const modalRef = useRef<HTMLDivElement>(null);
  const helpRef = useRef<HTMLFormElement>(null);

  // 2026-10-10: the help form opens from the sidebar's "Help & support"
  // (no floating button over every page).
  useEffect(() => {
    const open = () => { setHelpOpen(true); setState(""); setErr(""); };
    window.addEventListener("gd360:open-help", open);
    return () => window.removeEventListener("gd360:open-help", open);
  }, []);

  useEffect(() => {
    if (hidden) return;
    let alive = true;
    api.get("/inapp/announcements").then(({ data }) => {
      if (!alive) return;
      const gone = new Set(readDismissed());
      const list = ((data?.announcements || []) as Ann[]).filter((a) => a && a.id && !gone.has(a.id));
      setAnns(list);
      list.forEach((a) => api.post(`/inapp/announcements/${a.id}/seen`).catch(() => {}));
    }).catch(() => {});
    return () => { alive = false; };
  }, [hidden, user?.id]);

  const modal = hidden ? undefined : anns.find((a) => a.kind === "modal");
  const banner = hidden ? undefined : anns.find((a) => a.kind === "banner");
  useFocusTrap(Boolean(modal), modalRef);
  useFocusTrap(helpOpen, helpRef);
  useEffect(() => {
    if (!modal && !helpOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (helpOpen) setHelpOpen(false);
      else if (modal) dismiss(modal);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal, helpOpen]);

  if (hidden) return null;
  function dismiss(a: Ann) {
    rememberDismissed(a.id);
    setAnns((xs) => xs.filter((x) => x.id !== a.id));
    api.post(`/inapp/announcements/${a.id}/dismiss`).catch(() => {});
  }
  const click = (a: Ann) => {
    rememberDismissed(a.id);
    api.post(`/inapp/announcements/${a.id}/click`).catch(() => {});
    setAnns((xs) => xs.filter((x) => x.id !== a.id));
    if (a.cta_url?.startsWith("/")) nav(a.cta_url);
    else if (a.cta_url) window.open(a.cta_url, "_blank", "noopener");
  };
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    setState("sending");
    try {
      const { data } = await api.post("/inapp/support", { subject, body });
      setState("sent");
      setSubject("");
      setBody(`Ticket #${data.number} — we'll reply by email.`);
    } catch (ex: any) {
      setErr(errorDetailText(ex?.response?.data?.detail) || "Couldn't send. Try again.");
      setState("");
    }
  };

  return (
    <>
      {banner && !modal && (
        <div
          role="status"
          data-inapp-banner=""
          className="fixed z-[55] right-3 top-[72px] sm:right-5 w-[min(400px,calc(100vw-24px))] rounded-[16px] border border-border-strong bg-surface text-text shadow-pop p-3.5 flex flex-col gap-2.5"
        >
          <div className="flex items-start gap-2.5">
            <span className="mt-[6px] w-2 h-2 rounded-full bg-kind-answer shrink-0" aria-hidden="true" />
            <span className="flex-1 min-w-0 text-[13.5px] leading-[1.45] text-secondary">
              <b className="text-text font-semibold">{banner.title}</b>{banner.body ? ` ${banner.body}` : ""}
            </span>
            <button type="button" onClick={() => dismiss(banner)} aria-label="Dismiss announcement" className="ui-focus -mt-1 -mr-1 w-7 h-7 rounded-[8px] grid place-items-center text-muted hover:text-text hover:bg-subtle shrink-0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
          {banner.cta_label && banner.cta_url && (
            <div className="flex justify-end">
              <button type="button" className={BTN_P} onClick={() => click(banner)}>{banner.cta_label}</button>
            </div>
          )}
        </div>
      )}
      {modal && (
        <div className="fixed inset-0 z-[80] bg-[rgb(3_5_6/0.7)] grid place-items-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) dismiss(modal); }}>
          <div ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="inapp-modal-title" className="outline-none w-[min(460px,100%)] rounded-[22px] border border-border-strong bg-surface text-text shadow-pop p-6 sm:p-[26px] flex flex-col gap-3">
            <span className="font-mono text-[11px] tracking-[0.14em] text-kind-answer">FROM THE GD360 TEAM</span>
            <h2 id="inapp-modal-title" className="m-0 text-[24px] font-extrabold tracking-[-0.03em]">{modal.title}</h2>
            {modal.body && <p className="m-0 text-secondary text-[15px] leading-relaxed">{modal.body}</p>}
            <div className="flex gap-2 mt-1">
              {modal.cta_label && modal.cta_url && <button type="button" className={BTN_P} onClick={() => click(modal)}>{modal.cta_label}</button>}
              <button type="button" className={BTN} onClick={() => dismiss(modal)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {helpOpen && (
        <div className="fixed inset-0 z-[81] bg-[rgb(3_5_6/0.6)] grid place-items-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) setHelpOpen(false); }}>
          <form ref={helpRef} onSubmit={send} role="dialog" aria-modal="true" aria-labelledby="inapp-help-title" className="outline-none w-[min(480px,100%)] rounded-[22px] border border-border-strong bg-surface text-text shadow-pop p-[22px] flex flex-col gap-3">
            <h2 id="inapp-help-title" className="m-0 text-[20px] font-extrabold">Message the GD360 team</h2>
            <p className="m-0 text-secondary text-[13.5px]">A real person replies by email, usually within a working day.</p>
            {state === "sent" ? (
              <p className="m-0 text-good text-[14px]">Sent. {body}</p>
            ) : (
              <>
                <label className="flex flex-col gap-1.5 text-[12.5px] text-secondary">Subject
                  <input required minLength={3} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="What do you need help with?" className={`h-10 ${FIELD}`} />
                </label>
                <label className="flex flex-col gap-1.5 text-[12.5px] text-secondary">Details
                  <textarea required minLength={5} rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What happened, and what did you expect?" className={`py-2.5 leading-normal resize-y ${FIELD}`} />
                </label>
                {err && <span role="alert" className="text-danger text-[13px]">{err}</span>}
              </>
            )}
            <div className="flex gap-2">
              {state !== "sent" && <button type="submit" className={BTN_P} disabled={state === "sending"}>{state === "sending" ? "Sending…" : "Send"}</button>}
              <button type="button" className={BTN} onClick={() => setHelpOpen(false)}>Close</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

// 2026-10-11 (Explain & Alerts, canvas B4): the GD360 bell.
//
// An alert reaches people the moment GD360 sees it - never held for office
// hours. Here that means:
//   - NotificationCenter (mounted once in App.tsx) asks for anything new
//     every 20 seconds while a GD360 tab is open (and at once when the tab
//     comes back into view), shows it as a toast, and - when the person
//     turned desktop alerts on and the tab is in the background - as a
//     desktop notification;
//   - NotificationBell (in the top bar) lists them, with Explain why, Open
//     dashboard and Snooze a week (snoozing is for you only).
// The same alert also goes by email, from the server, in the same run.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../api/AuthContext";
import { AppNotification, notificationsApi, WhyOut } from "../api/alerts";

const POLL_MS = 20000;
const HIDDEN_ON = ["/admin", "/pricing", "/about", "/start", "/register", "/login", "/admin-login", "/help", "/public", "/d/", "/invite", "/privacy", "/connect/", "/e/", "/w/", "/a/", "/r/"];
const DESKTOP_KEY = "gd360_desktop_alerts";

// ---- a tiny shared store (the bell and the poller read the same state) --------

type State = { unread: number; items: AppNotification[] | null; toasts: AppNotification[]; since: string | null };
let state: State = { unread: 0, items: null, toasts: [], since: null };
const listeners = new Set<() => void>();
const emit = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useNotifications = () => useSyncExternalStore(subscribe, () => state);

export async function refreshNotifications() {
  try {
    const r = await notificationsApi.list();
    emit({ items: r.items, unread: r.unread });
  } catch {
    /* the next poll tries again */
  }
}

function desktopOn(): boolean {
  try {
    return typeof Notification !== "undefined" && Notification.permission === "granted" && localStorage.getItem(DESKTOP_KEY) === "1";
  } catch {
    return false;
  }
}

function timeAgo(iso: string): string {
  const t = new Date(iso.endsWith("Z") ? iso : `${iso}Z`).getTime();
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

// ---- icons ---------------------------------------------------------------------

const Svg = ({ children, size = 16, w = 2 }: { children: React.ReactNode; size?: number; w?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
export const BellIcon = ({ size = 17 }: { size?: number }) => (
  <Svg size={size}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></Svg>
);
const KindIcon = ({ n }: { n: AppNotification }) => {
  const down = n.kind === "alert" && /below|down|fell/i.test(n.title);
  if (n.kind === "alert")
    return (
      <span className="w-8 h-8 shrink-0 rounded-[9px] bg-danger-fill text-danger grid place-items-center">
        <Svg size={15} w={2.2}>{down ? <path d="M12 5v14M19 12l-7 7-7-7" /> : <path d="M12 19V5M5 12l7-7 7 7" />}</Svg>
      </span>
    );
  if (n.kind === "reminder")
    return <span className="w-8 h-8 shrink-0 rounded-[9px] bg-warning-fill text-warning grid place-items-center"><Svg size={15}><circle cx="12" cy="12" r="8" /><path d="M12 8v4l2.5 2" /></Svg></span>;
  if (n.kind === "failed")
    return <span className="w-8 h-8 shrink-0 rounded-[9px] bg-danger-fill text-danger grid place-items-center"><Svg size={15}><path d="M12 8v5M12 16h.01" /><circle cx="12" cy="12" r="9" /></Svg></span>;
  return <span className="w-8 h-8 shrink-0 rounded-[9px] bg-kind-alert-fill text-kind-alert grid place-items-center"><Svg size={14} w={2.4}><path d="m5 12 5 5 9-10" /></Svg></span>;
};

// ---- the poller (mounted once) -----------------------------------------------------

export function NotificationCenter() {
  const { user } = useAuth();
  const loc = useLocation();
  const navigate = useNavigate();
  const hidden = !user || HIDDEN_ON.some((p) => loc.pathname.startsWith(p));
  const { toasts } = useNotifications();

  const poll = useCallback(async () => {
    try {
      const r = await notificationsApi.unread(state.since);
      const fresh = state.since ? r.latest : [];
      const known = new Set((state.items || []).map((n) => n.id).concat(state.toasts.map((t) => t.id)));
      const newOnes = fresh.filter((n) => !known.has(n.id));
      emit({ unread: r.unread, since: r.now, toasts: [...newOnes.slice(0, 2), ...state.toasts].slice(0, 3) });
      if (newOnes.length) {
        refreshNotifications();
        if (desktopOn() && document.visibilityState === "hidden") {
          for (const n of newOnes.slice(0, 3)) {
            try {
              const d = new Notification(n.title, { body: n.body || n.data?.source || "GD360", tag: n.id });
              d.onclick = () => {
                window.focus();
                if (n.link) navigate(n.link);
                d.close();
              };
            } catch {
              /* some browsers only allow this from a service worker */
            }
          }
        }
      }
    } catch {
      /* signed out or offline - the next poll tries again */
    }
  }, [navigate]);

  useEffect(() => {
    if (hidden) return;
    poll();
    const t = window.setInterval(poll, POLL_MS);
    const vis = () => document.visibilityState === "visible" && poll();
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [hidden, poll]);

  if (hidden || !toasts.length) return null;
  return (
    <div className="fixed z-[70] right-4 sm:right-6 top-[68px] flex flex-col gap-2.5 w-[min(400px,calc(100vw-32px))]" aria-live="polite" data-alert-toasts="">
      {toasts.map((n) => (
        <Toast key={n.id} n={n} onClose={() => emit({ toasts: state.toasts.filter((t) => t.id !== n.id) })} />
      ))}
    </div>
  );
}

function Toast({ n, onClose }: { n: AppNotification; onClose: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onClose, 14000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div role="status" className="rounded-[16px] border border-kind-alert-border bg-surface shadow-[0_24px_60px_-20px_rgb(0_0_0/0.85)] p-3.5 flex gap-3" data-alert-toast={n.id}>
      <KindIcon n={n} />
      <div className="min-w-0 flex-1 flex flex-col gap-1.5">
        <span className="text-ui text-text font-semibold leading-snug">{n.title}</span>
        {n.body && <span className="text-caption text-secondary leading-snug line-clamp-2">{n.body}</span>}
        <div className="flex items-center gap-2 pt-0.5">
          {n.link && (
            <Link to={n.link} onClick={onClose} className="ui-focus h-7 px-2.5 rounded-[8px] bg-primary text-on-primary text-[12px] font-semibold inline-flex items-center">
              Open
            </Link>
          )}
          <button
            type="button"
            className="ui-focus h-7 px-2.5 rounded-[8px] text-[12px] text-muted hover:text-text"
            onClick={() => {
              window.dispatchEvent(new Event("gd360:open-notifications"));
              onClose();
            }}
          >
            All notifications
          </button>
        </div>
      </div>
      <button type="button" onClick={onClose} aria-label="Dismiss" className="ui-focus self-start w-7 h-7 rounded-[8px] grid place-items-center text-muted hover:text-text">
        <Svg size={14}><path d="M6 6l12 12M18 6 6 18" /></Svg>
      </button>
    </div>
  );
}

// ---- the bell ---------------------------------------------------------------

export function NotificationBell() {
  const { user } = useAuth();
  const { unread, items } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const show = () => {
      setOpen(true);
      refreshNotifications();
      emit({ toasts: [] });
    };
    window.addEventListener("gd360:open-notifications", show);
    return () => window.removeEventListener("gd360:open-notifications", show);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") setOpen(false);
        return;
      }
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (!user) return null;
  const label = unread ? `Notifications, ${unread} new` : "Notifications";
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={() => {
          setOpen((o) => !o);
          if (!open) {
            refreshNotifications();
            emit({ toasts: [] }); // the panel shows them
          }
        }}
        className={`ui-focus relative w-9 h-9 rounded-ctl border grid place-items-center transition-colors ${
          open ? "border-kind-alert-border bg-kind-alert-fill text-kind-alert" : "border-border text-muted hover:text-text hover:border-border-strong"
        }`}
        data-notification-bell=""
      >
        <BellIcon />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[17px] h-[17px] px-1 rounded-full bg-danger text-[10px] font-bold text-[rgb(var(--color-base))] grid place-items-center" data-unread={unread}>
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && <Panel items={items} unread={unread} onClose={() => setOpen(false)} />}
    </div>
  );
}

function Panel({ items, unread, onClose }: { items: AppNotification[] | null; unread: number; onClose: () => void }) {
  const [desktop, setDesktop] = useState(desktopOn());
  const supported = typeof Notification !== "undefined";
  return (
    <section
      role="dialog"
      aria-label="Notifications"
      className="absolute right-0 top-[calc(100%+8px)] z-[60] w-[min(440px,calc(100vw-24px))] rounded-[20px] border border-border-strong bg-surface shadow-[0_30px_80px_-20px_rgb(0_0_0/0.9)] flex flex-col max-h-[min(640px,calc(100vh-96px))]"
      data-notification-panel=""
    >
      <div className="px-4 py-3.5 border-b border-border flex items-center gap-3">
        <b className="flex-1 text-[15px] text-text">Notifications</b>
        {unread > 0 && (
          <button
            type="button"
            className="ui-focus text-caption text-muted hover:text-text"
            onClick={async () => {
              try {
                const r = await notificationsApi.read();
                emit({ unread: r.unread, items: (state.items || []).map((n) => ({ ...n, read: true })) });
              } catch {
                /* ignore */
              }
            }}
          >
            Mark all read
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {items === null && <div className="p-6 text-ui text-muted">Loading…</div>}
        {items && items.length === 0 && (
          <div className="p-6 flex flex-col gap-2 text-ui text-secondary">
            <span className="text-text font-medium">Nothing yet</span>
            <span>Open any dashboard, press <b className="text-text">Ask AI</b> and say what to watch - “Alert me if profit margin goes below 20%”. You'll hear about it here and by email the moment it happens.</span>
          </div>
        )}
        {(items || []).map((n) => <Item key={n.id} n={n} onNavigate={onClose} />)}
      </div>
      {supported && (
        <div className="px-4 py-3 border-t border-border flex items-center gap-3 text-caption text-muted">
          <span className="flex-1">
            {desktop ? "Desktop alerts are on for this browser." : "Get a desktop alert the moment one fires, even when GD360 is in another tab."}
          </span>
          {!desktop ? (
            <button
              type="button"
              className="ui-focus h-8 px-3 rounded-[9px] border border-kind-alert-border text-kind-alert text-[12px] font-semibold hover:bg-kind-alert-fill"
              onClick={async () => {
                try {
                  const p = await Notification.requestPermission();
                  if (p === "granted") {
                    localStorage.setItem(DESKTOP_KEY, "1");
                    setDesktop(true);
                  }
                } catch {
                  /* blocked by the browser */
                }
              }}
            >
              Turn on
            </button>
          ) : (
            <button
              type="button"
              className="ui-focus h-8 px-3 rounded-[9px] text-[12px] text-muted hover:text-text"
              onClick={() => {
                try {
                  localStorage.removeItem(DESKTOP_KEY);
                } catch {
                  /* ignore */
                }
                setDesktop(false);
              }}
            >
              Turn off
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function Item({ n, onNavigate }: { n: AppNotification; onNavigate: () => void }) {
  const navigate = useNavigate();
  const [why, setWhy] = useState<WhyOut | null>(null);
  const [busy, setBusy] = useState<"" | "why" | "snooze">("");
  const [snoozed, setSnoozed] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const isAlert = n.kind === "alert" || n.kind === "reminder";
  const markRead = () => {
    if (n.read) return;
    notificationsApi.read([n.id]).then((r) => emit({ unread: r.unread, items: (state.items || []).map((x) => (x.id === n.id ? { ...x, read: true } : x)) })).catch(() => undefined);
  };
  return (
    <article className={`px-4 py-4 border-b border-border last:border-b-0 flex gap-3 ${n.read ? "" : "bg-kind-alert-fill/60"}`} data-notification={n.id}>
      <KindIcon n={n} />
      <div className="min-w-0 flex-1 flex flex-col gap-2">
        <span className="text-ui text-text leading-snug">
          <b className="font-semibold">{n.title}</b>
        </span>
        <span className="text-caption text-muted">
          {[n.data?.source, timeAgo(n.created_at)].filter(Boolean).join(" · ")}
        </span>
        {n.body && !why && <span className="text-caption text-secondary leading-snug">{n.body}</span>}
        {why && (
          <div className="rounded-[12px] border border-kind-answer-border bg-kind-answer-fill/50 p-3 flex flex-col gap-1.5" data-why="">
            {why.current && (
              <span className="text-ui text-text">
                <b>{why.current.label}</b> is <b className="font-mono">{why.current.display}</b> over {why.current.window_text}
                {why.current.formula ? <span className="text-muted"> · {why.current.formula}</span> : null}
              </span>
            )}
            <span className="text-caption text-secondary leading-snug">{why.why || "It moved without one clear reason in the tiles it is built from."}</span>
            <span className="text-[11px] text-faint">Explained from the dashboard's own numbers - nothing new was set up.</span>
          </div>
        )}
        {err && <span className="text-caption text-danger">{err}</span>}
        {isAlert && (
          <div className="flex gap-1.5 flex-wrap">
            {!why && (
              <button
                type="button"
                disabled={busy !== ""}
                className="ui-focus h-[30px] px-2.5 rounded-[9px] bg-primary text-on-primary text-[12px] font-semibold disabled:opacity-60"
                onClick={async () => {
                  setBusy("why");
                  setErr("");
                  try {
                    setWhy(await notificationsApi.why(n.id));
                    markRead();
                  } catch {
                    setErr("Couldn't read the dashboard just now.");
                  } finally {
                    setBusy("");
                  }
                }}
              >
                {busy === "why" ? "Reading…" : "Explain why"}
              </button>
            )}
            {n.link && (
              <button
                type="button"
                className="ui-focus h-[30px] px-2.5 rounded-[9px] border border-border-strong text-[12px] text-text hover:bg-subtle"
                onClick={() => {
                  markRead();
                  onNavigate();
                  navigate(n.link!);
                }}
              >
                Open dashboard
              </button>
            )}
            {n.automation_id && (
              snoozed ? (
                <span className="inline-flex items-center gap-2 h-[30px] text-[12px] text-muted">
                  Snoozed for you until {new Date(snoozed).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                  <button
                    type="button"
                    className="underline hover:text-text"
                    onClick={async () => {
                      try {
                        await notificationsApi.unsnooze(n.id);
                        setSnoozed(null);
                      } catch {
                        /* ignore */
                      }
                    }}
                  >
                    Undo
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busy !== ""}
                  className="ui-focus h-[30px] px-2.5 rounded-[9px] text-[12px] text-secondary hover:text-text"
                  title="Stop this alert reaching you for a week - everyone else still gets it"
                  onClick={async () => {
                    setBusy("snooze");
                    try {
                      const r = await notificationsApi.snooze(n.id, 7);
                      setSnoozed(r.until);
                      markRead();
                    } catch {
                      setErr("Couldn't snooze it just now.");
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  Snooze a week
                </button>
              )
            )}
          </div>
        )}
        {!isAlert && n.link && (
          <Link to={n.link} onClick={() => { markRead(); onNavigate(); }} className="self-start text-caption text-kind-alert hover:underline">
            Open →
          </Link>
        )}
      </div>
    </article>
  );
}

// 2026-10-10: what Mission Control publishes into the app for signed-in
// people: live announcements (a bottom banner or a modal, per audience) and
// a "Help" button that opens a support ticket with the GD360 team.
import { FormEvent, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, errorDetailText } from "../api/client";
import { useAuth } from "../api/AuthContext";

type Ann = { id: string; kind: "banner" | "modal"; title: string; body?: string; cta_label?: string; cta_url?: string };

const HIDDEN_ON = ["/admin", "/pricing", "/about", "/start", "/register", "/login", "/admin-login", "/help", "/public", "/d/", "/invite", "/privacy", "/connect/"];

const S = {
  card: { background: "#0B0F10", border: "1px solid #24413A", color: "#E8EEEC", fontFamily: "Geist, 'Helvetica Neue', system-ui, sans-serif", boxShadow: "0 30px 80px -30px rgba(0,0,0,.8)" } as const,
  btnP: { height: 36, padding: "0 14px", border: 0, borderRadius: 999, background: "#43E5A0", color: "#04140D", fontWeight: 700, fontSize: 13, cursor: "pointer" } as const,
  btn: { height: 36, padding: "0 14px", border: "1px solid #2A3436", borderRadius: 999, background: "transparent", color: "#E8EEEC", fontWeight: 600, fontSize: 13, cursor: "pointer" } as const,
};

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
      setAnns(data.announcements || []);
      (data.announcements || []).forEach((a: Ann) => api.post(`/inapp/announcements/${a.id}/seen`).catch(() => {}));
    }).catch(() => {});
    return () => { alive = false; };
  }, [hidden, user?.id]);

  if (hidden) return null;
  const dismiss = (a: Ann) => {
    setAnns((xs) => xs.filter((x) => x.id !== a.id));
    api.post(`/inapp/announcements/${a.id}/dismiss`).catch(() => {});
  };
  const click = (a: Ann) => {
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
  const modal = anns.find((a) => a.kind === "modal");
  const banner = anns.find((a) => a.kind === "banner");

  return (
    <>
      {banner && !modal && (
        <div role="status" style={{ ...S.card, position: "fixed", left: "50%", bottom: 18, transform: "translateX(-50%)", zIndex: 55, width: "min(720px, calc(100% - 24px))", borderRadius: 16, padding: "12px 14px", display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <span style={{ width: 8, height: 8, borderRadius: 8, background: "#43E5A0", flex: "none" }} />
          <span style={{ flex: "1 1 260px", fontSize: 13.5, lineHeight: 1.45 }}><b>{banner.title}</b>{banner.body ? ` ${banner.body}` : ""}</span>
          {banner.cta_label && banner.cta_url && <button type="button" style={S.btnP} onClick={() => click(banner)}>{banner.cta_label}</button>}
          <button type="button" style={S.btn} onClick={() => dismiss(banner)} aria-label="Dismiss announcement">Dismiss</button>
        </div>
      )}
      {modal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(3,5,6,.7)", display: "grid", placeItems: "center", padding: 16 }} onClick={() => dismiss(modal)}>
          <div role="dialog" aria-modal="true" aria-label={modal.title} onClick={(e) => e.stopPropagation()} style={{ ...S.card, width: "min(460px,100%)", borderRadius: 22, padding: 26, display: "flex", flexDirection: "column", gap: 12 }}>
            <span style={{ fontFamily: "'Geist Mono', monospace", fontSize: 11, letterSpacing: ".14em", color: "#43E5A0" }}>FROM THE GD360 TEAM</span>
            <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em" }}>{modal.title}</h2>
            {modal.body && <p style={{ margin: 0, color: "#A3B0AC", fontSize: 15, lineHeight: 1.6 }}>{modal.body}</p>}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              {modal.cta_label && modal.cta_url && <button type="button" style={S.btnP} onClick={() => click(modal)}>{modal.cta_label}</button>}
              <button type="button" style={S.btn} onClick={() => dismiss(modal)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {helpOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 81, background: "rgba(3,5,6,.6)", display: "grid", placeItems: "center", padding: 16 }} onClick={() => setHelpOpen(false)}>
          <form onSubmit={send} role="dialog" aria-modal="true" aria-label="Message the GD360 team" onClick={(e) => e.stopPropagation()} style={{ ...S.card, width: "min(480px,100%)", borderRadius: 22, padding: 22, display: "flex", flexDirection: "column", gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Message the GD360 team</h2>
            <p style={{ margin: 0, color: "#A3B0AC", fontSize: 13.5 }}>A real person replies by email, usually within a working day.</p>
            {state === "sent" ? (
              <p style={{ margin: 0, color: "#43E5A0", fontSize: 14 }}>Sent. {body}</p>
            ) : (
              <>
                <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, color: "#A3B0AC" }}>Subject
                  <input required minLength={3} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="What do you need help with?" style={{ height: 40, borderRadius: 10, border: "1px solid #2A3436", background: "#07090A", color: "#E8EEEC", padding: "0 10px", fontSize: 14 }} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, color: "#A3B0AC" }}>Details
                  <textarea required minLength={5} rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What happened, and what did you expect?" style={{ borderRadius: 10, border: "1px solid #2A3436", background: "#07090A", color: "#E8EEEC", padding: 10, fontSize: 14, lineHeight: 1.5, resize: "vertical" }} />
                </label>
                {err && <span role="alert" style={{ color: "#FF7A6B", fontSize: 13 }}>{err}</span>}
              </>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              {state !== "sent" && <button type="submit" style={S.btnP} disabled={state === "sending"}>{state === "sending" ? "Sending…" : "Send"}</button>}
              <button type="button" style={S.btn} onClick={() => setHelpOpen(false)}>Close</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

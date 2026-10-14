// 2026-10-14 (R46, GD360 2.0): the chat-first shell - a 64px rail, a Spaces sidebar (never a chat list),
// and the column the page renders into. Light-first; the theme toggle is in every header.
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../api/AuthContext";
import { useTheme } from "../api/ThemeContext";
import { v2Api, type Home } from "../api/v2";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { openEuliv } from "../components/Euliv";
import "./chat.css";

type HomeCtx = { home: Home | null; reload: () => Promise<void>; workspaceId: string; spaceId: string | null; setSpaceId: (id: string | null) => void };
const Ctx = createContext<HomeCtx>({ home: null, reload: async () => {}, workspaceId: "", spaceId: null, setSpaceId: () => {} });
export const useHome = () => useContext(Ctx);

const I = {
  plus: <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>,
  chat: <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H8l-5 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z" /></svg>,
  lib: <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>,
  grid: <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>,
  db: <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></svg>,
  bolt: <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" /></svg>,
  mic: <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>,
  sun: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>,
  moon: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>,
  side: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></svg>,
  user: <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>,
};

export function ThemeButton() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button type="button" className="c2-nx sm" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light" : "Switch to dark"} title={theme === "dark" ? "Light" : "Dark"} data-c2-theme-toggle="">
      {theme === "dark" ? I.sun : I.moon}
    </button>
  );
}

const SIDE_KEY = "gd360_c2_sidebar";

export function Shell({ children, active = "chat" }: { children: ReactNode; active?: "chat" | "home" }) {
  const { user } = useAuth();
  const { setTheme } = useTheme();
  const { activeWorkspaceId } = useWorkspaceNav();
  const [home, setHome] = useState<Home | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [open, setOpen] = useState<boolean>(() => { try { return localStorage.getItem(SIDE_KEY) !== "closed"; } catch { return true; } });
  const navigate = useNavigate();

  useEffect(() => {
    // light-first, like the conversation design: only until the person picks a theme themselves
    try { if (!localStorage.getItem("gd360_theme_v2")) setTheme("light"); } catch { /* fine */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(async () => {
    try { setHome(await v2Api.home(activeWorkspaceId || null)); } catch { /* the page shows what it can */ }
  }, [activeWorkspaceId]);
  useEffect(() => { void reload(); }, [reload]);

  const toggle = () => { setOpen((o) => { try { localStorage.setItem(SIDE_KEY, o ? "closed" : "open"); } catch { /* fine */ } return !o; }); };
  const spaces = home?.spaces || [];
  const countFor = (sid: string | null) => (home?.conversations || []).filter((c) => !sid || c.space_id === sid).length;

  return (
    <Ctx.Provider value={{ home, reload, workspaceId: activeWorkspaceId || "", spaceId, setSpaceId }}>
      <div className={`c2 c2-shell ${open ? "" : "sidebar-closed"}`} data-c2-shell="">
        <nav className="c2-rail" aria-label="Main">
          <Link to="/chat" className="c2-logo" aria-label="GD360 home">G</Link>
          <Link to="/chat" aria-label="New conversation" title="New conversation" className={active === "home" ? "on" : ""}>{I.plus}</Link>
          <button type="button" aria-label="Spaces" title="Spaces" className={active === "chat" ? "on" : ""} onClick={toggle}>{I.chat}</button>
          <Link to="/library" aria-label="Library" title="Library">{I.lib}</Link>
          <Link to="/dashboards" aria-label="Dashboards" title="Dashboards">{I.grid}</Link>
          <Link to="/data" aria-label="Data" title="Data">{I.db}</Link>
          <Link to="/automations" aria-label="Automations" title="Automations">{I.bolt}</Link>
          <button type="button" aria-label="Talk to EuLiv" title="Talk to EuLiv" onClick={() => openEuliv()}>{I.mic}</button>
          <span style={{ flex: 1 }} />
          <Link to="/profile" aria-label="Account" title={user?.email || "Account"}>{I.user}</Link>
        </nav>
        <aside className="c2-side" aria-label="Spaces" aria-hidden={!open}>
          <div className="c2-side-in">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 10px 6px" }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>{home?.user?.first_name ? `${home.user.first_name}'s GD360` : "GD360"}</span>
              <button type="button" className="c2-nx ghost sm" onClick={toggle} aria-label="Hide sidebar" style={{ padding: "0 6px" }}>{I.side}</button>
            </div>
            <span className="c2-eb hd">Spaces</span>
            <button type="button" className={`c2-sp ${spaceId === null ? "on" : ""}`} onClick={() => setSpaceId(null)}>
              <span className="dot" style={{ background: "rgb(var(--color-text))" }} /><span className="t">Everything</span><span className="c">{countFor(null)}</span>
            </button>
            {spaces.map((s) => (
              <button key={s.id} type="button" className={`c2-sp ${spaceId === s.id ? "on" : ""}`} onClick={() => setSpaceId(spaceId === s.id ? null : s.id)} title={s.name}>
                <span className="dot" style={{ background: s.color || "rgb(var(--color-primary))" }} /><span className="t">{s.name}</span><span className="c">{countFor(s.id)}</span>
              </button>
            ))}
            <Link to="/data?tab=spaces" className="c2-sp" style={{ color: "rgb(var(--color-muted))" }}><span style={{ width: 9 }}>+</span><span className="t">New Space</span></Link>
            {spaces.length === 0 && (
              <span style={{ padding: "6px 10px", fontSize: 13, color: "rgb(var(--color-muted))", lineHeight: 1.5 }}>A Space is a team's room: its data, its glossary, its library.</span>
            )}
            <span className="c2-eb hd">Library</span>
            <Link to="/library" className="c2-sp"><span className="t">Conversations</span><span className="c">{home?.conversations.length ?? ""}</span></Link>
            <Link to="/dashboards" className="c2-sp"><span className="t">Dashboards</span><span className="c">{home?.spaces.reduce((n, s) => n + (s.stats?.dashboards || 0), 0) || ""}</span></Link>
            <Link to="/automations" className="c2-sp"><span className="t">Automations</span></Link>
            <Link to="/data" className="c2-sp"><span className="t">Data</span><span className="c">{home?.sources.length ?? ""}</span></Link>
            <span className="c2-eb hd">Team</span>
            <Link to="/accounts" className="c2-sp"><span className="t">People and access</span><span className="c">Invite</span></Link>
            {home?.plan && (
              <div style={{ marginTop: "auto", padding: "14px 10px 4px" }}>
                <button type="button" className="c2-meter" style={{ width: "100%", background: "transparent", border: 0, textAlign: "left", cursor: "pointer", padding: 0, font: "inherit" }} onClick={() => navigate("/chat?plan=1")} title="Plan and usage">
                  <span>{home.plan.label} plan · {home.plan.all_features ? "every feature" : ""}</span>
                  {home.plan.meters.filter((m) => m.key === "questions_per_day").map((m) => (
                    <span key={m.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span>{m.used}{m.limit ? ` of ${m.limit}` : ""} questions today</span>
                      {m.limit ? <span className="bar"><i style={{ width: `${Math.min(100, (100 * m.used) / m.limit)}%` }} /></span> : null}
                    </span>
                  ))}
                </button>
              </div>
            )}
          </div>
        </aside>
        <div className="c2-main">{children}</div>
      </div>
    </Ctx.Provider>
  );
}

export const Icons = I;

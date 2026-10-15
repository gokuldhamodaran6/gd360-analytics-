// 2026-10-14 (R46, GD360 2.0): the chat-first shell - a 64px rail, a Spaces sidebar (never a chat list),
// and the column the page renders into. Light-first; the theme toggle is in every header.
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { useTheme } from "../api/ThemeContext";
import { v2Api, type Home } from "../api/v2";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import AppSidebar from "../components/AppSidebar";
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

// 2026-10-15 (R50): the chat surface renders the same rail and top bar as every other page (components/AppSidebar.tsx,
// components/TopNav.tsx). The 248 px Spaces sidebar is gone: Spaces are on Home, with their real counts.
export function Shell({ children }: { children: ReactNode; active?: "chat" | "home" }) {
  const { setTheme } = useTheme();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [home, setHome] = useState<Home | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(null);

  useEffect(() => {
    // light-first, like the conversation design: only until the person picks a theme themselves
    try { if (!localStorage.getItem("gd360_theme_v2")) setTheme("light"); } catch { /* fine */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(async () => {
    try { setHome(await v2Api.home(activeWorkspaceId || null)); } catch { /* the page shows what it can */ }
  }, [activeWorkspaceId]);
  useEffect(() => { void reload(); }, [reload]);

  return (
    <Ctx.Provider value={{ home, reload, workspaceId: activeWorkspaceId || "", spaceId, setSpaceId }}>
      <div className="c2 gx-frame" data-c2-shell="">
        <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={(id) => switchWorkspace(id)}
          onWorkspaceCreated={(ws) => handleWorkspaceCreated(ws)} />
        <div className="c2-main gx-main">{children}</div>
      </div>
    </Ctx.Provider>
  );
}

export const Icons = I;

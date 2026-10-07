import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light";

type ThemeContextType = {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;
  // 2026-10-07 (identity-colour round): a theme shown WITHOUT being saved
  // as this browser's preference - a published dashboard opening in the
  // theme its owner chose (appearance.theme_default). The visitor's own
  // toggle still wins and is saved as before; null clears the override.
  setTransientTheme: (t: Theme | null) => void;
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const STORAGE_KEY = "gd360_theme";

function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage unavailable - fall through to system preference.
  }
  if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.classList.toggle("dark", theme === "dark");
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [stored, setThemeState] = useState<Theme>(getInitialTheme);
  const [transient, setTransient] = useState<Theme | null>(null);
  const theme = transient ?? stored;

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, stored);
    } catch {
      // Non-fatal - theme just will not persist across visits.
    }
  }, [stored]);

  const setTheme = (t: Theme) => { setTransient(null); setThemeState(t); };
  // Toggling flips what is ON SCREEN (the override, when one is shown) and
  // makes that the saved preference.
  const toggleTheme = () => { const next: Theme = theme === "dark" ? "light" : "dark"; setTransient(null); setThemeState(next); };
  const setTransientTheme = useCallback((t: Theme | null) => setTransient(t), []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme, setTransientTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

/** "light" | "dark" for code that must work with or without a
 *  ThemeProvider above it (the chart theme): the provider's theme, else
 *  the document's data-theme attribute, else light. */
export function useThemeMode(): Theme {
  const ctx = useContext(ThemeContext);
  if (ctx) return ctx.theme;
  if (typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark") return "dark";
  return "light";
}

/** The transient-theme setter, or a no-op outside a ThemeProvider. */
export function useTransientTheme(): (t: Theme | null) => void {
  const ctx = useContext(ThemeContext);
  return ctx ? ctx.setTransientTheme : NOOP;
}
const NOOP = () => undefined;

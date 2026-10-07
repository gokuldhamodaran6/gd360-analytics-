import { useTheme } from "../api/ThemeContext";
import { Button, MoonIcon, SunIcon } from "../ui";

// 2026-10-06 (design-system kit): the same toggle, now a kit icon button
// (36 px, secondary) so it sits flush with the top bar's search field and
// the page's own Share/primary buttons.
export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <Button
      variant="secondary"
      size="sm"
      iconOnly
      onClick={toggleTheme}
      aria-label="Toggle color theme"
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      icon={isDark ? <SunIcon size={16} className="text-accent" /> : <MoonIcon size={16} className="text-primary" />}
    >
      {isDark ? "Switch to light mode" : "Switch to dark mode"}
    </Button>
  );
}

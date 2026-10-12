import { cn } from "../../ui";

// 2026-10-12 (round 38, team comments): every person has their own colour -
// the same on their pins, their avatar in a thread, the chart card's chip
// and the bell - so a reader sees WHO is talking on a chart before reading
// a word. Light tones that hold dark initials on both themes; picked from
// the name (the bell has no ids), so it never changes between screens.

const TONES = ["#F2A65A", "#7AA7FF", "#C792EA", "#43E5A0", "#FF8FA3", "#5ED6E8", "#E8D35E", "#A3E37A"];

export function personColor(name?: string | null): string {
  const s = (name || "").trim().toLowerCase();
  if (!s) return TONES[3];
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return TONES[h % TONES.length];
}

const SIZE = { xs: "h-5 w-5 text-[8.5px]", sm: "h-6 w-6 text-[9.5px]", md: "h-7 w-7 text-[10.5px]", lg: "h-8 w-8 text-[11px]" } as const;

export function PersonAvatar({ name, initials, size = "md", ring = false, className, title }: { name?: string | null; initials?: string | null; size?: keyof typeof SIZE; ring?: boolean; className?: string; title?: string }) {
  const ini = (initials || (name || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2) || "?").toUpperCase();
  return (
    <span
      aria-hidden={title ? undefined : true}
      title={title}
      className={cn("inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold tracking-tight text-[#07090A]", SIZE[size], ring && "shadow-[0_0_0_2px_rgb(var(--color-surface))]", className)}
      style={{ background: personColor(name) }}
      data-person-avatar=""
    >
      {ini}
    </span>
  );
}

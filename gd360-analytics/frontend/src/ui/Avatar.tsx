import { cn } from "./cn";

// The "GO" circle in the top bar and comment threads: initials on brand,
// 28 px (sm) / 32 px (md). Pass a full name or an email.

export function initialsOf(nameOrEmail: string): string {
  const trimmed = (nameOrEmail || "").trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

export type AvatarProps = {
  name: string;
  size?: "xs" | "sm" | "md";
  tone?: "brand" | "tint";
  className?: string;
  title?: string;
};

const SIZE = { xs: "h-6 w-6 text-[10px]", sm: "h-7 w-7 text-[11px]", md: "h-8 w-8 text-caption" };

export function Avatar({ name, size = "sm", tone = "brand", className, title }: AvatarProps) {
  return (
    <span
      title={title ?? name}
      aria-label={name}
      role="img"
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold",
        SIZE[size],
        tone === "brand" ? "bg-primary text-on-primary" : "bg-tint text-brand-ink border border-tint-border",
        className
      )}
    >
      {initialsOf(name)}
    </span>
  );
}

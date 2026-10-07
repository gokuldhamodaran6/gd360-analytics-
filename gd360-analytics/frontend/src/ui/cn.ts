// Tiny class-name joiner (the app has no clsx dependency and doesn't need
// one for this). Accepts strings, falsy values and nested arrays.
export type ClassValue = string | number | null | undefined | false | ClassValue[];

export function cn(...parts: ClassValue[]): string {
  const out: string[] = [];
  const walk = (p: ClassValue) => {
    if (!p && p !== 0) return;
    if (Array.isArray(p)) { p.forEach(walk); return; }
    out.push(String(p));
  };
  parts.forEach(walk);
  return out.join(" ");
}

// 2026-10-13 (R45): what a person reads when something goes wrong. Raw
// engine text (SQL, binder/parser errors, Python tracebacks, driver names)
// never reaches the page - it becomes one human sentence, and the raw text is
// kept as `details` for the "Details" disclosure editors can open.
// Pure functions, no React (tested with esbuild + node).

export type Friendly = { text: string; details: string | null; technical: boolean };

const TECH = [
  /\b(select|insert|update|delete)\b[\s\S]{0,400}\bfrom\b/i,
  /\b(binder|parser|catalog|conversion|syntax|programming|operational|integrity|internal|runtime|invalid input|out of range)\s+error\b/i,
  /\btraceback \(most recent call last\)/i,
  /\bFile "[^"]+", line \d+/,
  /\b(KeyError|ValueError|TypeError|AttributeError|IndexError|ZeroDivisionError|NameError|RuntimeError|MemoryError|AssertionError|Exception)\b/,
  /\b(psycopg2?|sqlalchemy|duckdb|pandas|numpy|pyarrow|snowflake\.connector|google\.api_core|bigquery|clickhouse|pymysql|sqlite3|openpyxl|calamine)\b/i,
  /\bLINE \d+:/,
  /\bat \S+ \([^)]*:\d+:\d+\)/, // JS stack frame
  /\b0x[0-9a-f]{6,}\b/i,
  /\bReferenced column\b|\bCandidate bindings\b/i,
  /\bSQLSTATE\b|\bORA-\d{4,}\b|\bERROR \d{4}\b/,
  /<[a-z_]+ object at 0x/i,
  /\bdtype\b|\bNoneType\b|\bobject of type\b/,
];

const KINDS: [RegExp, string][] = [
  [/\b(time(d)? ?out|timeout|statement timeout|deadline exceeded|took too long)\b/i, "Your data took too long to answer. Try a narrower question or a shorter period."],
  [/\b(permission denied|access denied|not authori[sz]ed|forbidden|insufficient privilege)\b/i, "GD360 doesn't have permission to read part of this data. Ask the person who connected it to check its access."],
  [/\b(connection (refused|reset|closed)|could not connect|unable to connect|name or service not known|network is unreachable|host .* not found|ssl)\b/i, "GD360 couldn't reach your data source. Check that it's online, then try again."],
  [/\b(referenced column|no such column|column .* (does not exist|not found)|does not have a column|unknown column|KeyError)\b/i, "A column this needed isn't in your data. Try asking with the column names your data uses."],
  [/\b(no such table|table .* (does not exist|not found)|relation .* does not exist|catalog error)\b/i, "A table this needed isn't in your data any more. It may have been renamed or removed."],
  [/\b(division by zero|divide by zero|ZeroDivisionError)\b/i, "A calculation divided by zero - a period or group in your data may be empty."],
  [/\b(out of memory|MemoryError|memory limit|cannot allocate)\b/i, "This needed more memory than is available. Try a narrower question or a shorter period."],
  [/\b(could not convert|conversion error|invalid input syntax|cannot cast|could not parse)\b/i, "Some values in your data aren't in the format this needed (for example text in a number column)."],
  [/\b(rate limit|too many requests|quota)\b/i, "Too many requests right now. Wait a minute, then try again."],
  [/\b(binder error|parser error|syntax error|programming error)\b/i, "GD360 wrote a query your data couldn't run. Asking again usually fixes it - or rephrase the question."],
];

/** Pull a string out of whatever an error carried (string, FastAPI detail list, {msg}, Error). */
export function errorString(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (raw instanceof Error) return raw.message || "";
  if (Array.isArray(raw)) return raw.map(errorString).filter(Boolean).join(" ");
  if (typeof raw === "object") {
    const o = raw as any;
    if (typeof o.msg === "string") return o.msg.replace(/^Value error,\s*/i, "");
    if (typeof o.message === "string") return o.message;
    if (typeof o.detail !== "undefined") return errorString(o.detail);
    try { return JSON.stringify(raw); } catch { return ""; }
  }
  return String(raw);
}

export function isTechnical(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (TECH.some((rx) => rx.test(t))) return true;
  // long single blobs with code-ish punctuation read as a dump, not a sentence
  return t.length > 280 && /[{}[\];=]|::|->/.test(t);
}

/** One human sentence for an error, plus the raw text (for "Details") when it was technical. */
export function friendlyError(raw: unknown, fallback = "Something went wrong while working this out. Please try again."): Friendly {
  const text = errorString(raw).trim();
  if (!text) return { text: fallback, details: null, technical: false };
  if (!isTechnical(text)) {
    // already written for a person - keep it, but never a wall of text
    const clean = text.replace(/\s+/g, " ");
    return clean.length > 320
      ? { text: `${clean.slice(0, 300).replace(/\s+\S*$/, "")}…`, details: text, technical: false }
      : { text: clean, details: null, technical: false };
  }
  const hit = KINDS.find(([rx]) => rx.test(text));
  return { text: hit ? hit[1] : fallback, details: text, technical: true };
}

/** Cut at a word boundary with "…" (never mid-word); `max` counts characters. */
export function truncateWords(text: string, max: number): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  const base = at > max * 0.5 ? cut.slice(0, at) : cut;
  return `${base.replace(/[\s,;:.\-–—]+$/, "")}…`;
}

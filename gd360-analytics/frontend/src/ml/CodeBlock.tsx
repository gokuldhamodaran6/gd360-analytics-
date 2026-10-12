// 2026-10-12 (round 39): the real code behind an ML run's step - the SQL the
// data layer ran and the Python of the model that won - with light syntax
// colouring, a copy button and, for the data step, Edit.
import { useState } from "react";
import type { CodeEntry } from "../api/mlStudio";
import { formatSql } from "./formatSql";
import { CheckIcon, CopyIcon, EditIcon } from "../ui";

const SQL_KW = /\b(SELECT|FROM|WHERE|GROUP|BY|ORDER|LIMIT|WITH|AS|AND|OR|NOT|IN|IS|NULL|JOIN|LEFT|RIGHT|INNER|OUTER|ON|USING|CASE|WHEN|THEN|ELSE|END|DISTINCT|CREATE|OR REPLACE|TEMP|TABLE|VIEW|SAMPLE|REPEATABLE|ROWS|OVER|PARTITION|DESC|ASC|NULLS|LAST|FIRST|UNION|ALL|EXCLUDE|INTERVAL|CROSS|HAVING|COUNT|SUM|AVG|MAX|MIN|TRY_CAST|CAST|ROW_NUMBER|reservoir|hash|date_trunc|date_diff|approx_count_distinct|mode)\b/gi;
const PY_KW = /\b(import|from|as|def|return|for|in|if|else|elif|not|and|or|None|True|False|with|class|lambda|print)\b/g;

type Tok = { t: string; c?: string };

function tokenize(code: string, lang: string): Tok[] {
  const out: Tok[] = [];
  const kw = lang === "python" ? PY_KW : lang === "sql" ? SQL_KW : null;
  // comments and strings first, the rest split on keywords
  const re = lang === "python" ? /(#[^\n]*|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g : /(--[^\n]*|'(?:[^']|'')*')/g;
  let last = 0;
  const push = (text: string) => {
    if (!kw) return out.push({ t: text });
    let i = 0;
    text.replace(kw, (m, _g, off: number) => {
      if (off > i) out.push({ t: text.slice(i, off) });
      out.push({ t: m, c: "text-[rgb(var(--auto-tell))]" });
      i = off + m.length;
      return m;
    });
    if (i < text.length) out.push({ t: text.slice(i) });
  };
  code.replace(re, (m, _g, off: number) => {
    if (off > last) push(code.slice(last, off));
    out.push({ t: m, c: m.startsWith("--") || m.startsWith("#") ? "text-muted italic" : "text-[rgb(var(--auto-do))]" });
    last = off + m.length;
    return m;
  });
  if (last < code.length) push(code.slice(last));
  return out;
}

export default function CodeBlock({ entry, onEdit }: { entry: CodeEntry; onEdit?: () => void }) {
  const [copied, setCopied] = useState(false);
  const code = entry.lang === "sql" ? formatSql(entry.code) : entry.code;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* the text stays selectable */
    }
  };
  const meta = [entry.engine, entry.rows != null ? `${Number(entry.rows).toLocaleString()} rows` : "", entry.seconds != null ? `${entry.seconds} s` : ""].filter(Boolean);
  return (
    <section className="rounded-card border border-border bg-base overflow-hidden min-w-0" aria-label={entry.title}>
      <header className="flex items-center gap-2 px-3.5 py-2 border-b border-border bg-surface flex-wrap">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] px-1.5 py-0.5 rounded bg-subtle text-secondary">{entry.lang}</span>
        <span className="text-ui font-medium text-text min-w-0 truncate">{entry.title}</span>
        <span className="text-caption text-muted">{meta.join(" · ")}</span>
        <span className="flex-1" />
        {entry.editable && onEdit && (
          <button type="button" className="h-7 px-2.5 rounded-ctl text-caption text-text border border-border hover:border-border-strong inline-flex items-center gap-1.5" onClick={onEdit}>
            <EditIcon size={13} /> Edit and train again
          </button>
        )}
        <button
          type="button"
          className="h-7 px-2.5 rounded-ctl text-caption text-secondary hover:text-text inline-flex items-center gap-1.5"
          onClick={copy}
          aria-label={`Copy the ${entry.lang} code`}
        >
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />} {copied ? "Copied" : "Copy"}
        </button>
      </header>
      <pre className="m-0 px-4 py-3.5 overflow-auto max-h-[420px] font-mono text-[12.5px] leading-[1.65] text-text whitespace-pre">
        <code>
          {tokenize(code, entry.lang).map((tk, i) => (tk.c ? <span key={i} className={tk.c}>{tk.t}</span> : <span key={i}>{tk.t}</span>))}
        </code>
      </pre>
    </section>
  );
}

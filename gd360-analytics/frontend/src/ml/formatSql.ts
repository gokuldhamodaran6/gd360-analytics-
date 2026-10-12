// 2026-10-12 (round 39): lay out one-line SQL (as an LLM often writes it) so
// a person can read it - a new line before each clause, one CTE and one
// selected column per line, sub-queries indented. Strings are left untouched,
// and SQL that already has line breaks is returned as it is.
const CLAUSES = ["WITH", "SELECT", "FROM", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN", "CROSS JOIN", "JOIN", "WHERE", "GROUP BY", "HAVING", "QUALIFY", "WINDOW", "ORDER BY", "LIMIT", "UNION ALL", "UNION", "EXCEPT", "INTERSECT"];
const CLAUSE_RE = new RegExp(`^(${CLAUSES.map((c) => c.replace(" ", "\\s+")).join("|")})\\b`, "i");
const LIST_CLAUSES = new Set(["SELECT", "GROUP BY", "ORDER BY"]);

type Frame = { block: boolean; clause: string; indent: number };

export function formatSql(sql: string): string {
  const src = (sql || "").trim();
  if (!src || src.includes("\n") || src.length < 90) return src;
  let out = "";
  let i = 0;
  // one frame per open bracket; blocks are sub-queries / CTE bodies
  const stack: Frame[] = [{ block: true, clause: "", indent: 0 }];
  const block = () => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].block) return stack[k];
    return stack[0];
  };
  const newline = (extra = 0) => {
    out = out.replace(/[ \t]+$/, "");
    if (out && !out.endsWith("\n")) out += "\n";
    out += "  ".repeat(block().indent + extra);
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < src.length && !(src[j] === ch && src[j + 1] !== ch)) j += src[j] === ch ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "(") {
      out += ch;
      i += 1;
      const rest = src.slice(i).trimStart();
      if (/^(SELECT|WITH)\b/i.test(rest)) {
        stack.push({ block: true, clause: "", indent: block().indent + 1 });
        i = src.length - rest.length;
      } else {
        stack.push({ block: false, clause: "", indent: 0 });
      }
      continue;
    }
    if (ch === ")") {
      const f = stack.length > 1 ? stack.pop()! : stack[0];
      if (f.block) newline();
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "," && stack[stack.length - 1].block) {
      const b = block();
      out += ch;
      i += 1;
      if (b.clause === "WITH") {
        while (src[i] === " ") i += 1;
        newline();
      } else if (LIST_CLAUSES.has(b.clause)) {
        while (src[i] === " ") i += 1;
        newline(1);
      }
      continue;
    }
    const prev = i === 0 ? " " : src[i - 1];
    if (/[\s(]/.test(prev) && stack[stack.length - 1].block) {
      const m = src.slice(i).match(CLAUSE_RE);
      if (m) {
        const word = m[1].replace(/\s+/g, " ").toUpperCase();
        if (out && !/\(\s*$/.test(out)) newline();
        else if (/\($/.test(out)) newline();
        block().clause = word;
        out += word;
        i += m[1].length;
        continue;
      }
    }
    out += ch === "\n" ? " " : ch;
    i += 1;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
}

/** The same SQL, layout aside. */
export function sameSql(a: string, b: string): boolean {
  // keyword case and layout don't matter; text inside quotes does
  const norm = (s: string) =>
    (s || "")
      .trim()
      .replace(/;\s*$/, "")
      .split(/('(?:[^']|'')*'|"(?:[^"]|"")*")/)
      .map((part, k) => (k % 2 ? part : part.replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1").toLowerCase()))
      .join("")
      .trim();
  return norm(a) === norm(b);
}

// 2026-10-14 (R46): a small markdown renderer for documents written by GD360 (headings, paragraphs,
// lists, tables, quotes, bold/italic/code). No HTML passthrough, so nothing a model writes can inject markup.
import { Fragment, ReactNode } from "react";

function inline(text: string, key = 0): ReactNode {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={`${key}-${i++}`}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={`${key}-${i++}`}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[")) {
      const t = tok.slice(1, tok.indexOf("]"));
      out.push(<a key={`${key}-${i++}`} href={m[2]} target="_blank" rel="noreferrer">{t}</a>);
    } else out.push(<em key={`${key}-${i++}`}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = (text || "").replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0, k = 0;
  const para: string[] = [];
  const flush = () => {
    if (para.length) { blocks.push(<p key={k++}>{inline(para.join(" "), k)}</p>); para.length = 0; }
  };
  while (i < lines.length) {
    const ln = lines[i];
    if (!ln.trim()) { flush(); i++; continue; }
    const h = ln.match(/^(#{1,3})\s+(.*)$/);
    if (h) { flush(); const T = (`h${h[1].length}`) as "h1" | "h2" | "h3"; blocks.push(<T key={k++}>{inline(h[2], k)}</T>); i++; continue; }
    if (/^\s*>/.test(ln)) {
      flush(); const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      blocks.push(<blockquote key={k++}>{inline(q.join(" "), k)}</blockquote>); continue;
    }
    if (/^\s*[-*]\s+/.test(ln) || /^\s*\d+[.)]\s+/.test(ln)) {
      flush(); const ordered = /^\s*\d+[.)]\s+/.test(ln); const items: string[] = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i]))) { items.push(lines[i].replace(/^\s*([-*]|\d+[.)])\s+/, "")); i++; }
      const L = ordered ? "ol" : "ul";
      blocks.push(<L key={k++}>{items.map((it, j) => <li key={j}>{inline(it, k * 100 + j)}</li>)}</L>); continue;
    }
    if (/^\s*\|/.test(ln) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush(); const rows: string[][] = [];
      const cells = (s: string) => s.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(ln); i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      blocks.push(
        <div key={k++} style={{ overflowX: "auto" }}>
          <table><thead><tr>{head.map((c, j) => <th key={j}>{inline(c, k * 100 + j)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j} style={/^[-−$€£₹]?\s*[\d,.]+%?$/.test(c) ? { fontVariantNumeric: "tabular-nums", textAlign: "right" } : undefined}>{inline(c, k * 1000 + ri * 10 + j)}</td>)}</tr>)}</tbody></table>
        </div>,
      );
      continue;
    }
    para.push(ln.trim()); i++;
  }
  flush();
  return <Fragment>{blocks}</Fragment>;
}

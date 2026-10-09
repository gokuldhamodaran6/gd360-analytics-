// 2026-10-09 (round 15): the generic ML Studio results renderer. Every kind's
// results carry a headline, a KPI row and a list of sections (table / bars /
// line / matrix / text, see backend ml_studio_methods.sec_*); this draws them
// all the same way. Charts use one y-axis, text in text colours (never the
// series colour), a legend for two or more series, and theme tokens so they
// read in dark and light.
import { useEffect, useMemo, useRef, useState } from "react";
import type { BarsSection, Kpi, LineSection, MatrixSection, Section, TableSection } from "../api/mlStudio";
import { fmtValue, isNumericFormat, niceTicks } from "./format";

const CARD = "rounded-card border border-border bg-surface p-4 sm:p-5 flex flex-col gap-3 min-w-0";

export default function ResultSections({ headline, kpis, sections }: { headline?: string | null; kpis?: Kpi[] | null; sections?: Section[] | null }) {
  return (
    <div className="flex flex-col gap-4 min-w-0">
      {headline && <Headline text={headline} />}
      {kpis && kpis.length > 0 && <KpiRow kpis={kpis} />}
      {(sections || []).map((s, i) => (
        <SectionView key={`${s.type}-${i}-${s.title}`} s={s} />
      ))}
    </div>
  );
}

export function Headline({ text }: { text: string }) {
  return (
    <p
      className="m-0 rounded-card border px-4 sm:px-5 py-4 text-[15.5px] sm:text-[16.5px] leading-relaxed text-text text-pretty"
      style={{ borderColor: "rgb(var(--auto-do-border))", background: "rgb(var(--auto-do-fill) / 0.35)" }}
    >
      {text}
    </p>
  );
}

export function KpiRow({ kpis }: { kpis: Kpi[] }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))" }}>
      {kpis.map((k) => (
        <div key={k.label} className="rounded-card border border-border bg-surface px-[18px] py-4 flex flex-col gap-1 min-w-0">
          <span className="text-ui text-muted">{k.label}</span>
          <span className="font-mono text-[24px] sm:text-kpi leading-tight tracking-tight text-text break-words">{k.display || "—"}</span>
          {k.note && (
            <span className="text-caption text-muted leading-snug line-clamp-2" title={k.note}>
              {k.note}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function SectionView({ s }: { s: Section }) {
  if (s.type === "text") {
    return (
      <section className={CARD} aria-label={s.title}>
        <h2 className="m-0 text-[17px] font-semibold text-text">{s.title}</h2>
        <p className="m-0 text-ui text-secondary leading-relaxed whitespace-pre-line">{s.body}</p>
      </section>
    );
  }
  return (
    <section className={CARD} aria-label={s.title}>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[17px] font-semibold text-text text-balance">{s.title}</h2>
        {s.note && <p className="m-0 text-caption text-muted leading-snug">{s.note}</p>}
      </div>
      {s.type === "table" && <TableView s={s} />}
      {s.type === "bars" && <BarsView s={s} />}
      {s.type === "line" && <LineView s={s} />}
      {s.type === "matrix" && <MatrixView s={s} />}
    </section>
  );
}

// ------------------------------------------------------------------ table ----

function TableView({ s }: { s: TableSection }) {
  const [all, setAll] = useState(false);
  const rows = s.rows || [];
  const shown = all ? rows : rows.slice(0, 50);
  if (!rows.length) return <p className="m-0 text-ui text-muted">Nothing to show.</p>;
  return (
    <>
      <div className="overflow-x-auto -mx-1 max-h-[560px] overflow-y-auto">
        <table className="w-full text-ui border-collapse" style={{ minWidth: Math.min(1100, Math.max(360, s.columns.length * 120)) }}>
          <thead className="sticky top-0 bg-surface">
            <tr className="text-left">
              {s.columns.map((c) => (
                <th
                  key={c.name}
                  scope="col"
                  className={`font-mono text-[11px] uppercase tracking-[0.08em] text-muted font-medium px-2 py-2 border-b border-border whitespace-nowrap ${isNumericFormat(c.format) ? "text-right" : ""}`}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className="border-b border-border last:border-b-0">
                {s.columns.map((c) => {
                  const num = isNumericFormat(c.format);
                  const v = r[c.name];
                  return (
                    <td
                      key={c.name}
                      className={`px-2 py-2 align-top ${num ? "font-mono text-right text-text whitespace-nowrap" : "text-secondary max-w-[360px] break-words"}`}
                    >
                      {fmtValue(v, c.format)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 50 && (
        <button type="button" className="self-start text-caption text-muted underline hover:text-text" onClick={() => setAll(!all)}>
          {all ? "Show the first 50" : `Show all ${rows.length.toLocaleString()} rows`}
        </button>
      )}
    </>
  );
}

// ------------------------------------------------------------------- bars ----

const TONE: Record<string, string> = {
  up: "rgb(var(--auto-do))",
  down: "rgb(var(--color-series-2))",
  neutral: "rgb(var(--auto-tell))",
};

function BarsView({ s }: { s: BarsSection }) {
  const items = s.items || [];
  const vals = items.map((i) => (typeof i.value === "number" && Number.isFinite(i.value) ? i.value : 0));
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const range = hi - lo || 1;
  const zero = (-lo / range) * 100;
  const tones = new Set(items.map((i) => i.tone || "neutral"));
  const toneLegend = tones.has("up") || tones.has("down");
  if (!items.length) return <p className="m-0 text-ui text-muted">Nothing to show.</p>;
  return (
    <>
      {toneLegend && (
        <div className="flex gap-4 flex-wrap text-caption text-secondary" aria-label="Legend">
          {tones.has("up") && <LegendSwatch color={TONE.up} label="Pushes it up" />}
          {tones.has("down") && <LegendSwatch color={TONE.down} label="Pushes it down" />}
          {tones.has("neutral") && <LegendSwatch color={TONE.neutral} label="Mixed" />}
        </div>
      )}
      <ul className="m-0 p-0 list-none flex flex-col gap-2.5">
        {items.map((it, i) => {
          const v = vals[i];
          const left = v >= 0 ? zero : zero - (Math.abs(v) / range) * 100;
          const width = Math.max(v === 0 ? 0 : 0.8, (Math.abs(v) / range) * 100);
          return (
            <li
              key={`${it.label}-${i}`}
              className="grid gap-x-3 gap-y-1 items-center grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(120px,32%)_minmax(0,1fr)_auto]"
              title={`${it.label}: ${it.display}${it.note ? ` - ${it.note}` : ""}`}
            >
              <span className="flex flex-col min-w-0">
                <span className="text-ui text-text truncate">{it.label}</span>
                {it.note && <span className="text-caption text-muted truncate">{it.note}</span>}
              </span>
              <span className="relative h-[10px] rounded-full bg-subtle overflow-hidden col-span-2 sm:col-span-1 order-3 sm:order-none" aria-hidden="true">
                {lo < 0 && <span className="absolute top-0 bottom-0 w-px bg-border-strong" style={{ left: `${zero}%` }} />}
                <span
                  className="absolute top-0 bottom-0 rounded-full"
                  style={{ left: `${left}%`, width: `${width}%`, background: TONE[it.tone || "neutral"] || TONE.neutral }}
                />
              </span>
              <span className="font-mono text-ui text-secondary text-right whitespace-nowrap">{it.display}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function LegendSwatch({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {dashed ? (
        <svg width="18" height="8" aria-hidden="true">
          <line x1="0" x2="18" y1="4" y2="4" stroke={color} strokeWidth="2" strokeDasharray="4 3" />
        </svg>
      ) : (
        <span className="inline-block w-3 h-[3px] rounded-full" style={{ background: color }} aria-hidden="true" />
      )}
      {label}
    </span>
  );
}

// ------------------------------------------------------------------- line ----

const SERIES_TOKEN = [1, 2, 3, 4, 5, 6].map((i) => `--color-series-${i}`);
const OTHER = "rgb(var(--color-faint))";

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((ents) => {
      const cw = Math.round(ents[0].contentRect.width);
      if (cw > 0) setW(cw);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function LineView({ s }: { s: LineSection }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const x = s.x || [];
  const series = s.series || [];
  const single = series.length === 1;
  // fixed order, never cycled: past six series the rest share one muted colour
  const tokenOf = (i: number) => (single ? "--auto-do" : series.length > 6 && i >= 5 ? "--color-faint" : SERIES_TOKEN[i]);
  const colorOf = (i: number) => `rgb(var(${tokenOf(i)}))`;
  const bandFill = `rgb(var(${tokenOf(0)}) / 0.16)`;
  const H = W < 480 ? 200 : 240;
  const padL = 52;
  const padR = 12;
  const padT = 10;
  const padB = 26;

  const { lo, hi, ticks } = useMemo(() => {
    const all: number[] = [];
    series.forEach((se) => se.values.forEach((v) => typeof v === "number" && Number.isFinite(v) && all.push(v)));
    (s.band?.lo || []).forEach((v) => typeof v === "number" && Number.isFinite(v) && all.push(v));
    (s.band?.hi || []).forEach((v) => typeof v === "number" && Number.isFinite(v) && all.push(v));
    let l = all.length ? Math.min(...all) : 0;
    const h = all.length ? Math.max(...all) : 1;
    if (l >= 0 && l < h * 0.5) l = 0;
    const t = niceTicks(l, h, 4);
    return { lo: t[0], hi: t[t.length - 1], ticks: t };
  }, [s, series]);

  const n = Math.max(2, x.length);
  const px = (i: number) => padL + (i / (n - 1)) * (W - padL - padR);
  const py = (v: number) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
  const path = (vals: (number | null)[]) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)} `;
      pen = true;
    });
    return d;
  };
  const bandPath = (() => {
    const b = s.band;
    if (!b || !b.lo?.length || !b.hi?.length) return "";
    const idx = b.hi.map((_, i) => i).filter((i) => typeof b.hi[i] === "number" && typeof b.lo[i] === "number");
    if (idx.length < 2) return "";
    return (
      idx.map((i, k) => `${k ? "L" : "M"}${px(i).toFixed(1)},${py(b.hi[i] as number).toFixed(1)}`).join(" ") +
      " " +
      [...idx].reverse().map((i) => `L${px(i).toFixed(1)},${py(b.lo[i] as number).toFixed(1)}`).join(" ") +
      " Z"
    );
  })();
  const maxLabels = Math.max(2, Math.floor((W - padL) / 74));
  const every = Math.max(1, Math.ceil(x.length / maxLabels));
  const xShown: number[] = [];
  for (let i = 0; i < x.length; i += every) xShown.push(i);
  const lastI = x.length - 1;
  if (lastI > 0 && xShown[xShown.length - 1] !== lastI) {
    if (lastI - xShown[xShown.length - 1] >= every * 0.6) xShown.push(lastI);
    else xShown[xShown.length - 1] = lastI;
  }
  const fmt = (v: number) => fmtValue(v, s.format, { pctDigits: 0 });

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const rel = ((e.clientX - r.left) / r.width) * (W - padL - padR);
    const i = Math.round((rel / (W - padL - padR)) * (n - 1));
    setHover(Math.max(0, Math.min(x.length - 1, i)));
  };

  if (!x.length || !series.length) return <p className="m-0 text-ui text-muted">Nothing to show.</p>;
  return (
    <div className="flex flex-col gap-2 min-w-0">
      {series.length >= 2 && (
        <div className="flex gap-x-4 gap-y-1 flex-wrap text-caption text-secondary" aria-label="Legend">
          {series.slice(0, series.length > 6 ? 5 : 6).map((se, i) => (
            <LegendSwatch key={se.name} color={colorOf(i)} label={se.name} dashed={se.dashed} />
          ))}
          {series.length > 6 && <LegendSwatch color={OTHER} label={`${series.length - 5} more (grey)`} />}
          {s.band && <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-2 rounded-sm" style={{ background: bandFill }} />Range</span>}
        </div>
      )}
      <div ref={ref} className="relative w-full min-w-0 overflow-hidden">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${s.title}: ${series.map((se) => se.name).join(", ")} over ${x[0]} to ${x[x.length - 1]}`} className="block">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={W - padR} y1={py(t)} y2={py(t)} stroke="rgb(var(--chart-grid))" strokeWidth="1" />
              <text x={padL - 8} y={py(t) + 4} fontSize="11" textAnchor="end" fill="rgb(var(--color-muted))" fontFamily="Geist Mono, monospace">
                {fmt(t)}
              </text>
            </g>
          ))}
          {bandPath && <path d={bandPath} fill={bandFill} />}
          {series.map((se, i) => (
            <path
              key={se.name}
              d={path(se.values)}
              fill="none"
              stroke={colorOf(i)}
              strokeWidth={series.length > 6 && i >= 5 ? 1.25 : 2}
              strokeDasharray={se.dashed ? "6 4" : undefined}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {xShown.map((i) => (
            <text
              key={i}
              x={px(i)}
              y={H - 8}
              fontSize="11"
              textAnchor={px(i) < padL + 34 ? "start" : px(i) > W - padR - 34 ? "end" : "middle"}
              fill="rgb(var(--color-muted))"
              fontFamily="Geist Mono, monospace"
            >
              {x[i].length > 12 ? `${x[i].slice(0, 11)}…` : x[i]}
            </text>
          ))}
          {hover != null && (
            <g pointerEvents="none">
              <line x1={px(hover)} x2={px(hover)} y1={padT} y2={H - padB} stroke="rgb(var(--color-border-strong))" strokeWidth="1" />
              {series.map((se, i) => {
                const v = se.values[hover];
                return typeof v === "number" && Number.isFinite(v) ? (
                  <circle key={se.name} cx={px(hover)} cy={py(v)} r="4" fill={colorOf(i)} stroke="rgb(var(--color-surface))" strokeWidth="2" />
                ) : null;
              })}
            </g>
          )}
          <rect
            x={padL}
            y={padT}
            width={Math.max(1, W - padL - padR)}
            height={Math.max(1, H - padT - padB)}
            fill="transparent"
            onPointerMove={onMove}
            onPointerDown={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hover != null && (
          <div
            className="absolute top-1 z-10 pointer-events-none rounded-ctl border border-border-strong bg-surface shadow-pop px-2.5 py-2 text-caption flex flex-col gap-0.5 min-w-[140px] max-w-[240px]"
            style={px(hover) > W / 2 ? { right: W - px(hover) + 10 } : { left: px(hover) + 10 }}
            role="status"
          >
            <span className="font-mono text-muted">{x[hover]}</span>
            {series.slice(0, 8).map((se, i) => (
              <span key={se.name} className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 text-secondary min-w-0">
                  <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: colorOf(i) }} />
                  <span className="truncate">{se.name}</span>
                </span>
                <span className="font-mono text-text">{fmtValue(se.values[hover], s.format)}</span>
              </span>
            ))}
            {s.band && typeof s.band.lo?.[hover] === "number" && (
              <span className="text-muted font-mono">
                range {fmtValue(s.band.lo[hover], s.format)} – {fmtValue(s.band.hi[hover], s.format)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- matrix ----

function MatrixView({ s }: { s: MatrixSection }) {
  const flat = (s.values || []).flat().filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const lo = flat.length ? Math.min(...flat) : 0;
  const hi = flat.length ? Math.max(...flat) : 1;
  const step = (v: number) => (hi === lo ? 4 : 1 + Math.min(5, Math.floor(((v - lo) / (hi - lo)) * 6)));
  const digits = (s.col_labels || []).length > 8 ? 0 : 1;
  if (!flat.length) return <p className="m-0 text-ui text-muted">Nothing to show.</p>;
  return (
    <>
      <div className="overflow-x-auto -mx-1">
        <table className="border-separate text-caption" style={{ borderSpacing: 2 }}>
          <thead>
            <tr>
              <th className="sticky left-0 bg-surface" />
              {s.col_labels.map((c) => (
                <th key={c} scope="col" className="font-mono text-[11px] text-muted font-medium px-1.5 py-1 text-center whitespace-nowrap">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.row_labels.map((r, ri) => (
              <tr key={`${r}-${ri}`}>
                <th scope="row" className="sticky left-0 z-[1] bg-surface text-left font-mono text-[11px] text-secondary font-normal pr-2 whitespace-nowrap max-w-[160px] truncate">
                  {r}
                </th>
                {s.col_labels.map((c, ci) => {
                  const v = s.values?.[ri]?.[ci];
                  const ok = typeof v === "number" && Number.isFinite(v);
                  const k = ok ? step(v as number) : 0;
                  return (
                    <td
                      key={c}
                      title={ok ? `${r} · ${c}: ${fmtValue(v, s.format)}` : `${r} · ${c}: no value`}
                      className="min-w-[48px] h-[30px] px-1.5 text-center font-mono rounded-[4px]"
                      style={
                        ok
                          ? { background: `rgb(var(--color-seq-${k}))`, color: k >= 4 ? "rgb(var(--color-base))" : "rgb(var(--color-text))" }
                          : { background: "rgb(var(--color-subtle) / 0.5)" }
                      }
                    >
                      {ok ? fmtValue(v, s.format, { pctDigits: digits }) : ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 text-caption text-muted" aria-label="Colour scale">
        <span className="font-mono">{fmtValue(lo, s.format, { pctDigits: digits })}</span>
        <span className="flex gap-[2px]" aria-hidden="true">
          {[1, 2, 3, 4, 5, 6].map((k) => (
            <span key={k} className="w-5 h-2.5 rounded-[2px]" style={{ background: `rgb(var(--color-seq-${k}))` }} />
          ))}
        </span>
        <span className="font-mono">{fmtValue(hi, s.format, { pctDigits: digits })}</span>
      </div>
    </>
  );
}

// ------------------------------------------------------------ joins line ----

type JoinLike = { table: string; base_key?: string; key?: string; match_rate: number; source?: string };

/** "Learned from 3 tables joined on customer_id - 92.4% matched". */
export function joinsSentence(joins: JoinLike[] | null | undefined, verb = "Learned from"): string {
  if (!joins || !joins.length) return "";
  const keys = Array.from(new Set(joins.map((j) => j.base_key || j.key).filter(Boolean)));
  const rates =
    joins.length === 1
      ? `${(joins[0].match_rate * 100).toFixed(1)}% matched`
      : `matched: ${joins.map((j) => `${j.table} ${(j.match_rate * 100).toFixed(1)}%`).join(", ")}`;
  return `${verb} ${joins.length + 1} tables joined on ${keys.join(", ") || "a shared key"} — ${rates}`;
}

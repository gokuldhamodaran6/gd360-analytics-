// 2026-10-11 (round 24): "Before I start" - GD360 reads a question back
// before answering it, the way a good analyst would.
//
// Shown under the Home box only when something needs the person (backend
// services/question_check.py says `ready: false`):
//   - a date that can't be right ("January 20258") - pick the year meant;
//   - the data: every source that could answer, each with a plain verdict
//     ("has revenue by date, Nov 2025 – Oct 2026" / "no dates" / "only covers
//     Feb 2024 – Jan 2025" / "no city column"), the best fit picked for you;
//     tick more, untick, or "Show all my data";
//   - data that can't answer at all: use its latest window, other data,
//     connect an app, upload a file.
// The read-back sentence at the top always says exactly what will run.
// Enter = Go ahead, Esc = back to the question.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { CheckCandidate, CheckIssue, CheckOption, CheckPeriod, ProjectSource, QuestionCheck as Check, RunBrief } from "../api/projects";
import { projectsApi } from "../api/projects";
import { Spinner } from "../thread/parts";

export type ChoiceRow = { id: string; name: string; label?: string; says?: string; fit?: string; recommended?: boolean };

const FIT_TEXT: Record<string, string> = {
  good: "Fits",
  no_dates: "No dates",
  out_of_range: "Outside your dates",
  weak: "Missing a column",
  none: "Nothing readable",
};

export function FitBadge({ fit, covered }: { fit?: string; covered?: boolean }) {
  if (!fit || fit === "unknown") return null;
  const ok = fit === "good";
  return (
    <span
      className={`inline-flex items-center gap-1 h-[20px] px-1.5 rounded-md text-[11px] font-semibold whitespace-nowrap ${
        ok ? "bg-good-fill text-good" : "bg-warning-fill text-warning"
      }`}
      data-fit={fit}
    >
      {ok ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M12 8v5M12 16.5h.01" /></svg>
      )}
      {ok ? (covered ? "Covers it" : FIT_TEXT.good) : FIT_TEXT[fit] || "Check"}
    </span>
  );
}

/** The data to use: one row per source, ticked = used. Numbered for Euliv ("say one and three"). */
export function SourceChoiceList({
  rows, selected, onToggle, numbered = false, disabled = false, compact = false,
}: {
  rows: ChoiceRow[];
  selected: string[];
  onToggle?: (id: string) => void;
  numbered?: boolean;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <ul className="m-0 p-0 list-none flex flex-col gap-1.5" role="group" aria-label="Data to use" data-choice-list="">
      {rows.map((r, i) => {
        const on = selected.includes(r.id);
        const warn = r.fit && r.fit !== "good" && r.fit !== "unknown";
        return (
          <li key={r.id}>
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={disabled || !onToggle}
              onClick={() => onToggle?.(r.id)}
              className={`ui-focus w-full text-left flex items-start gap-3 rounded-[14px] border transition-[background-color,border-color] duration-150 ${
                compact ? "px-3 py-2.5" : "px-3.5 py-3"
              } ${
                on
                  ? "border-kind-answer-border bg-kind-answer-fill/60"
                  : "border-border bg-base/30 hover:border-border-strong hover:bg-subtle/40"
              } disabled:cursor-default`}
              data-choice={r.id}
              data-on={on ? "1" : "0"}
            >
              <span
                className={`mt-[1px] w-[22px] h-[22px] rounded-[7px] grid place-items-center shrink-0 border text-[11px] font-mono font-semibold ${
                  on ? "bg-kind-answer border-kind-answer text-[rgb(var(--color-base))]" : "border-border-strong text-muted"
                }`}
                aria-hidden="true"
              >
                {on ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
                ) : numbered ? (
                  i + 1
                ) : null}
              </span>
              <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="flex items-center gap-2 flex-wrap">
                  {numbered && on && <span className="font-mono text-[11px] text-muted">{i + 1}</span>}
                  <span className="text-[14.5px] font-semibold text-text truncate max-w-full">{r.name}</span>
                  {r.label && <span className="text-[11.5px] text-muted">{r.label}</span>}
                  {r.recommended && (
                    <span className="h-[20px] px-1.5 rounded-md bg-kind-analysis-fill text-kind-analysis text-[11px] font-semibold inline-flex items-center">Best fit</span>
                  )}
                  <span className="ml-auto"><FitBadge fit={r.fit} covered={Boolean(r.says && /\(/.test(r.says))} /></span>
                </span>
                {r.says && (
                  <span className={`text-[12.5px] leading-snug ${warn ? "text-warning/90" : "text-secondary"}`}>
                    {r.says.startsWith(r.name) ? r.says.slice(r.name.length).trim().replace(/^./, (c) => c.toUpperCase()) : r.says}
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function rowOf(c: CheckCandidate, recommended = false): ChoiceRow {
  return { id: c.id, name: c.name, label: c.label, says: c.says || c.why, fit: c.fit, recommended };
}

function restate(check: Check, period: CheckPeriod | null, chosen: ChoiceRow[]): string {
  const what = (check.what || "the answer").replace(/^./, (c) => c.toUpperCase());
  let s = what;
  if (period) s += ` for ${period.label}${period.label !== period.text ? ` (${period.text})` : ""}`;
  else if (check.needs_time) s += " over all the dates in the data";
  if (chosen.length) {
    const names = chosen.map((c) => c.name);
    s += ", from " + (names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
  } else s += ", looking across all your data";
  return s + ".";
}

export type CheckGo = { question: string; source_ids?: string[]; brief?: RunBrief };

/**
 * The card. `onFixDate` re-checks the question with a corrected year
 * (the data's fit depends on the dates); `onGo` runs it.
 */
export default function QuestionCheckCard({
  check, workspaceId, busy, onGo, onEdit, onFixDate,
}: {
  check: Check;
  workspaceId?: string;
  busy?: boolean;
  onGo: (go: CheckGo) => void;
  onEdit: () => void;
  onFixDate: (fixedQuestion: string) => void;
}) {
  const dateIssue = check.issues.find((i) => i.kind === "year_typo" || i.kind === "month_typo" || i.kind === "future_year");
  const dataIssue = check.issues.find((i) => ["choose", "swap", "confirm_pick", "cant_answer"].includes(i.kind));
  const byId = useMemo(() => new Map(check.candidates.map((c) => [c.id, c])), [check.candidates]);

  // the rows: the issue's sources in its order, then the other candidates
  const baseRows = useMemo<ChoiceRow[]>(() => {
    const rows: ChoiceRow[] = [];
    const seen = new Set<string>();
    for (const o of dataIssue?.options || []) {
      const c = byId.get(o.value);
      if (c && !seen.has(c.id)) {
        rows.push(rowOf(c, Boolean(o.recommended)));
        seen.add(c.id);
      }
    }
    for (const c of check.candidates) {
      if (!seen.has(c.id) && (c.fit === "good" || rows.length < 3) && c.score > 0) {
        rows.push(rowOf(c));
        seen.add(c.id);
      }
    }
    return rows.slice(0, 8);
  }, [check, dataIssue, byId]);

  const [extra, setExtra] = useState<ChoiceRow[]>([]);
  const [showingAll, setShowingAll] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const rows = useMemo(() => [...baseRows, ...extra], [baseRows, extra]);
  const [selected, setSelected] = useState<string[]>(() => check.picked || []);
  const shift = dataIssue?.options.find((o) => o.id === "shift");
  const [useShift, setUseShift] = useState<boolean>(Boolean(shift));
  const [period, setPeriod] = useState<CheckPeriod | null>(check.period);
  const [year, setYear] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelected(shift && useShift ? [shift.value] : check.picked || []);
    setPeriod(check.period);
    setExtra([]);
    setShowingAll(false);
    setYear(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [check]);

  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [check]);

  const effectivePeriod = shift && useShift ? shift.period || period : period;
  const chosen = rows.filter((r) => selected.includes(r.id));
  const needsPick = Boolean(dataIssue && dataIssue.kind === "cant_answer" && !useShift);
  const canGo = !dateIssue && !busy && (!needsPick || chosen.length > 0);
  const anyWarn = chosen.some((r) => r.fit && r.fit !== "good" && r.fit !== "unknown");

  const toggle = (id: string) => {
    if (shift && useShift) setUseShift(false);
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };

  const showAll = async () => {
    if (showingAll) return;
    setLoadingAll(true);
    try {
      const all: ProjectSource[] = await projectsApi.sources(workspaceId);
      const have = new Set(rows.map((r) => r.id));
      setExtra(all.filter((s) => !have.has(s.id)).map((s: any) => ({ id: s.id, name: s.name, label: s.label || s.kind, fit: "unknown" })));
      setShowingAll(true);
    } catch {
      /* the list stays as it is */
    } finally {
      setLoadingAll(false);
    }
  };

  const go = () => {
    if (!canGo) return;
    const ids = shift && useShift ? [shift.value] : selected;
    onGo({
      question: check.question,
      source_ids: ids.length ? ids : undefined,
      brief: { period: effectivePeriod, restated: restate(check, effectivePeriod, rows.filter((r) => ids.includes(r.id))) },
    });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onEdit();
    } else if (e.key === "Enter" && !e.shiftKey && (e.target as HTMLElement).tagName !== "BUTTON") {
      e.preventDefault();
      go();
    }
  };

  const actionOpts = (dataIssue?.options || []).filter((o) => o.action === "connect" || o.action === "upload");

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      onKeyDown={onKey}
      className="gd-euliv-in w-full text-left rounded-[24px] border border-border-strong bg-surface shadow-[0_30px_80px_-40px_rgb(0_0_0/0.85)] outline-none overflow-hidden"
      role="region"
      aria-label="Before I start"
      data-question-check=""
    >
      <div className="px-5 sm:px-6 pt-5 pb-4 flex flex-col gap-2 border-b border-border">
        <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
          <span className="w-[7px] h-[7px] rounded-full bg-kind-analysis" aria-hidden="true" />
          Before I start · here's what I understood
        </span>
        <p className="m-0 text-[17px] sm:text-[18px] leading-[1.45] font-medium text-text text-pretty" data-check-restated="">
          {dateIssue ? <>“{check.question}”</> : restate(check, effectivePeriod, chosen)}
        </p>
      </div>

      <div className="px-5 sm:px-6 py-5 flex flex-col gap-6">
        {dateIssue && <DateFix issue={dateIssue} chosen={year} busy={busy} onPick={(v) => {
          setYear(v);
          const from = dateIssue.fix?.from || dateIssue.said || "";
          onFixDate(from && v !== from ? check.question.replace(new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), v) : check.question);
        }} />}

        {!dateIssue && (check.period_options || []).length > 1 && (
          <section className="flex flex-col gap-2.5" aria-label="Period">
            <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">Period</span>
            <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2">
              {(check.period_options || []).map((p) => {
                const on = !useShift && period?.start === p.start && period?.end === p.end;
                return (
                  <button key={p.key || p.start} type="button" onClick={() => { setUseShift(false); setPeriod(p); }} aria-pressed={on}
                    className={`ui-focus min-h-10 py-2 px-3.5 rounded-[14px] sm:rounded-full border text-[13.5px] inline-flex items-center justify-between sm:justify-start gap-x-2 gap-y-0.5 flex-wrap text-left ${on ? "border-kind-answer-border bg-kind-answer-fill text-text" : "border-border text-secondary hover:text-text hover:border-border-strong"}`}
                    data-period={p.key}>
                    <span className="font-medium whitespace-nowrap">{p.text}</span>
                    <span className="text-[12px] text-muted whitespace-nowrap">{p.label}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {!dateIssue && (dataIssue || rows.length > 0) && (
          <section className="flex flex-col gap-3" aria-label="Data">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">Data to use</span>
              <span className="text-[12px] text-muted">{chosen.length ? `${chosen.length} selected` : "Pick at least one"}</span>
            </div>
            {dataIssue && <p className="m-0 text-[14px] leading-relaxed text-secondary" data-check-issue={dataIssue.kind}>{dataIssue.text}</p>}
            {shift && (
              <button type="button" onClick={() => setUseShift(true)} aria-pressed={useShift}
                className={`ui-focus w-full text-left flex items-center gap-3 rounded-[14px] border px-3.5 py-3 ${useShift ? "border-kind-answer-border bg-kind-answer-fill/60" : "border-border hover:border-border-strong"}`}
                data-check-shift="">
                <span className={`w-[22px] h-[22px] rounded-full grid place-items-center border shrink-0 ${useShift ? "bg-kind-answer border-kind-answer" : "border-border-strong"}`} aria-hidden="true">
                  {useShift && <span className="w-2 h-2 rounded-full bg-[rgb(var(--color-base))]" />}
                </span>
                <span className="flex flex-col">
                  <span className="text-[14.5px] font-semibold text-text">{shift.label}</span>
                  <span className="text-[12.5px] text-secondary">The same length of time, ending where the data ends</span>
                </span>
              </button>
            )}
            <SourceChoiceList rows={rows} selected={shift && useShift ? [] : selected} onToggle={toggle} />
            <div className="flex flex-wrap items-center gap-2">
              {!showingAll && (
                <button type="button" onClick={showAll} className="ui-focus h-9 px-3 rounded-full text-[13px] text-secondary hover:text-text hover:bg-subtle/60 inline-flex items-center gap-2" data-check-showall="">
                  {loadingAll ? <Spinner className="w-3.5 h-3.5" /> : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                  )}
                  Show all my data
                </button>
              )}
              {actionOpts.map((o) => (
                <Link key={o.id} to={o.value} target="_blank" rel="noopener" className="ui-focus h-9 px-3 rounded-full border border-border text-[13px] text-secondary hover:text-text hover:border-border-strong inline-flex items-center">
                  {o.label}
                </Link>
              ))}
            </div>
            {anyWarn && (
              <p className="m-0 text-[12.5px] text-warning" data-check-warn="">
                Some of the data you picked can't fully answer this - the answer will say what it couldn't use.
              </p>
            )}
          </section>
        )}
      </div>

      <div className="px-5 sm:px-6 py-4 border-t border-border bg-base/30 flex items-center gap-3 flex-wrap">
        <button type="button" onClick={go} disabled={!canGo}
          className="ui-focus h-11 px-5 rounded-full bg-primary text-on-primary text-[14.5px] font-semibold inline-flex items-center gap-2 disabled:opacity-40 transition-transform hover:scale-[1.02] active:scale-[0.98]"
          data-check-go="">
          {busy ? <Spinner /> : null}
          Go ahead
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </button>
        <button type="button" onClick={onEdit} className="ui-focus h-11 px-4 rounded-full text-[14px] text-secondary hover:text-text hover:bg-subtle/60" data-check-edit="">
          Edit the question
        </button>
        <span className="ml-auto hidden sm:inline text-[12px] text-faint">Enter to go ahead · Esc to edit</span>
      </div>
    </div>
  );
}

function DateFix({ issue, chosen, busy, onPick }: { issue: CheckIssue; chosen: string | null; busy?: boolean; onPick: (v: string) => void }) {
  return (
    <section className="flex flex-col gap-3 rounded-[16px] border border-warning-border bg-warning-fill/60 p-4" aria-label="Check the date" data-check-date={issue.kind}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 w-7 h-7 rounded-full bg-warning/15 text-warning grid place-items-center shrink-0" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="5" width="18" height="16" rx="2.5" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
        </span>
        <span className="flex flex-col gap-0.5">
          <b className="text-[15px] text-text">{issue.title}</b>
          <span className="text-[13.5px] text-secondary leading-snug">{issue.text}</span>
        </span>
      </div>
      <div className="flex flex-wrap gap-2 pl-10">
        {issue.options.map((o: CheckOption) => (
          <button key={o.id} type="button" disabled={busy} onClick={() => onPick(o.value)} aria-pressed={chosen === o.value}
            className={`ui-focus h-10 px-4 rounded-full border text-[14px] font-medium inline-flex items-center gap-2 ${chosen === o.value ? "border-kind-answer bg-kind-answer text-[rgb(var(--color-base))]" : "border-border-strong bg-surface text-text hover:border-kind-answer-border"}`}
            data-check-year={o.value}>
            {busy && chosen === o.value ? <Spinner className="w-3.5 h-3.5" /> : null}
            {o.label}
          </button>
        ))}
      </div>
    </section>
  );
}

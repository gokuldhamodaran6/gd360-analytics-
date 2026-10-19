// 2026-10-14 (R46): the one box. Quick answer / Step by step / Auto, the data scope, dictation, send.
// 2026-10-19 (R55, Studio mockup): the three-way switch became one "Deep" toggle (step by step on, Auto off).
// 2026-10-19 (R57): "Deep" was unclear - a two-way switch, Quick answer / Guided analysis, here and on Home.
import { KeyboardEvent, ReactNode, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import type { Mode } from "../api/v2";
import { MicButton, useDictation } from "../thread/Dictation";

export function ModeSwitch({ mode, onMode, disabled }: { mode: Mode; onMode: (m: Mode) => void; disabled?: boolean }) {
  const opts: { k: Mode; l: string; t: string }[] = [
    { k: "quick", l: "Quick answer", t: "The result in one go, with the checks; the steps stay behind “Worked for…”." },
    { k: "guided", l: "Step by step", t: "Every step shown and paused; change a definition or a filter and it re-runs from there." },
    { k: "auto", l: "Auto", t: "Quick for lookups and comparisons; step by step when a definition is uncertain." },
  ];
  return (
    <span className="c2-mode" role="radiogroup" aria-label="How to answer" data-c2-mode={mode}>
      {opts.map((o) => (
        <button key={o.k} type="button" role="radio" aria-checked={mode === o.k} className={mode === o.k ? "on" : ""} title={o.t} disabled={disabled} onClick={() => onMode(o.k)}>
          {o.l}
        </button>
      ))}
    </span>
  );
}

/** R57 ("ask flow fixes" board 1): how GD360 answers, as a plain two-way switch - Quick answer or Guided analysis
 * ("auto" is the quick side: a lookup answers straight away, a bigger question still gets its steps). */
export function ModeSeg({ mode, onMode, disabled, short = false }: { mode: Mode; onMode: (m: Mode) => void; disabled?: boolean; short?: boolean }) {
  const guided = mode === "guided";
  return (
    <span className="c2-seg" role="radiogroup" aria-label="How to answer" data-c2-mode-seg={guided ? "guided" : "quick"}>
      <button type="button" role="radio" aria-checked={!guided} className={!guided ? "on" : ""} disabled={disabled} onClick={() => onMode("auto")} data-c2-mode-opt="quick"
        title="The number, a chart and the reason in about 20 seconds">{short ? "Quick" : <>Quick<span className="c2-seg-x"> answer</span></>}</button>
      <button type="button" role="radio" aria-checked={guided} className={guided ? "on" : ""} disabled={disabled} onClick={() => onMode("guided")} data-c2-mode-opt="guided"
        title="GD360 plans the steps, shows each step's numbers and waits for your OK before going on">{short ? "Guided" : <>Guided<span className="c2-seg-x"> analysis</span></>}</button>
    </span>
  );
}

export function Composer({
  value, onChange, onSubmit, mode, onMode, busy = false, placeholder = "Ask anything…", scope, context, autoFocus = false, sourcesLabel, compact = false,
}: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; mode: Mode; onMode: (m: Mode) => void; busy?: boolean;
  placeholder?: string; scope?: ReactNode; context?: ReactNode; autoFocus?: boolean; sourcesLabel?: string | null;
  /** R56 (Studio): one line - add, the text, send - under the thread beside the canvas */
  compact?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const dict = useDictation({ getText: () => value, setText: onChange });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
  }, [value]);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (value.trim() && !busy) onSubmit(); }
  };
  const sendBtn = (
    <button type="button" className="c2-send" onClick={onSubmit} disabled={!value.trim() || busy} aria-label="Send" data-c2-send="">
      {busy ? <span className="c2-spin" style={{ borderColor: "rgb(var(--color-base))", borderTopColor: "transparent" }} />
        : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>}
    </button>
  );
  if (compact) {
    // R57: the studio's follow-up box - the text, then its own source picker and the Quick / Guided switch
    return (
      <div className="c2-comp compact" data-c2-composer="" data-c2-mode={mode}>
        {context}
        <label htmlFor="c2-ask" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Message</label>
        <textarea id="c2-ask" ref={ref} rows={1} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onKeyDown={key} />
        <div className="bar">
          {scope || (sourcesLabel ? <span className="c2-nx sm ghost" style={{ cursor: "default" }}>{sourcesLabel}</span> : null)}
          <ModeSeg mode={mode} onMode={onMode} disabled={busy} short />
          <span style={{ flex: 1 }} />
          {sendBtn}
        </div>
      </div>
    );
  }
  return (
    <div className="c2-comp" data-c2-composer="">
      {context}
      <label htmlFor="c2-ask" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Message</label>
      <textarea id="c2-ask" ref={ref} rows={1} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onKeyDown={key} disabled={busy && false} />
      {dict.error && <span style={{ fontSize: 12.5, color: "rgb(var(--color-danger))" }}>{dict.error}</span>}
      <div className="bar">
        <Link to="/data" className="c2-nx sm ghost" title="Attach a file or connect data" aria-label="Add data">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </Link>
        {scope || (sourcesLabel ? <span className="c2-nx sm ghost" style={{ cursor: "default" }}>{sourcesLabel}</span> : null)}
        <ModeSeg mode={mode} onMode={onMode} disabled={busy} />
        <span style={{ flex: 1 }} />
        {dict.supported && <MicButton listening={dict.listening} onClick={dict.toggle} size="sm" />}
        <button type="button" className="c2-send" onClick={onSubmit} disabled={!value.trim() || busy} aria-label="Send" data-c2-send="">
          {busy ? <span className="c2-spin" style={{ borderColor: "rgb(var(--color-base))", borderTopColor: "transparent" }} />
            : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>}
        </button>
      </div>
    </div>
  );
}

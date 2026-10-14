// 2026-10-14 (R46): the one box. Quick answer / Step by step / Auto, the data scope, dictation, send.
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

export function Composer({
  value, onChange, onSubmit, mode, onMode, busy = false, placeholder = "Ask anything…", scope, context, autoFocus = false, sourcesLabel,
}: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; mode: Mode; onMode: (m: Mode) => void; busy?: boolean;
  placeholder?: string; scope?: ReactNode; context?: ReactNode; autoFocus?: boolean; sourcesLabel?: string | null;
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
        <ModeSwitch mode={mode} onMode={onMode} disabled={busy} />
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

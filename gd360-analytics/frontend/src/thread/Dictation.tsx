// 2026-10-11: speak instead of typing - the mic in the Home box and in every
// thread's follow-up box.
//
// Uses the browser's own speech recognition (Chrome, Edge, Safari; Web
// Speech API). The words appear in the box as they are spoken; a short
// pause, the mic again, or Esc finishes. Nothing is sent by itself - the
// person reads it and presses Enter. Where the browser can't do it (Firefox)
// the mic is not shown.
//
// 2026-10-11 (Euliv round): the mic now checks itself. Next to recognition it
// opens the microphone (thread/voice.ts MicMonitor) and reads its level, so
// it can say what's actually wrong instead of waiting in silence:
//   blocked / no microphone / busy in another app / muted  -> said at once;
//   no sound at all for 4 s   -> "I can't hear you - check your microphone"
//                               (and the device it's listening to);
//   sound but no words for 7 s -> "I can hear sound but no words";
//   still nothing at 9 s       -> stops, with the same advice.
// The bars in the listening strip move with the real level.
import { useCallback, useEffect, useRef, useState } from "react";
import { claimMic, meterUseful, MIC_HELP, MicMonitor, type MicProblem, type Rec, recognitionClass, releaseMic, SOUND_LEVEL, speechLang } from "./voice";

export const dictationSupported = () => recognitionClass() !== null;

const SILENCE_MS = 2200; // a pause this long finishes the question
const MAX_MS = 60000; // one question, not a monologue
const CANT_HEAR_MS = 4000; // no sound at all -> say so
const NO_WORDS_MS = 7000; // sound, but nothing understood -> say so
const GIVE_UP_MS = 9000; // still no sound -> stop

const ERRORS: Record<string, string> = {
  "not-allowed": MIC_HELP.blocked,
  "service-not-allowed": MIC_HELP.blocked,
  "audio-capture": MIC_HELP["no-device"],
  network: "Voice typing needs an internet connection. Please type your question.",
  "language-not-supported": "Voice typing isn't available for your browser's language yet.",
};

export type MicHint = { kind: "cant-hear" | "no-words" | "muted" | "device"; text: string } | null;

function joinText(base: string, spoken: string): string {
  const s = spoken.replace(/\s+/g, " ").trim();
  if (!s) return base;
  const said = base ? s : s.charAt(0).toUpperCase() + s.slice(1);
  return base ? `${base} ${said}` : said;
}

export function deviceText(label: string): string {
  const l = (label || "").replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "").trim();
  return l ? ` (listening to: ${l})` : "";
}

let seq = 0;

/**
 * Voice typing into a text box.
 *  - `getText` reads the box when listening starts (spoken words are added after it);
 *  - `setText` receives the box's new text as words arrive.
 */
export function useDictation({ getText, setText, onDone }: { getText: () => string; setText: (t: string) => void; onDone?: (text: string) => void }) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const [heard, setHeard] = useState(false);
  const [level, setLevel] = useState(0);
  const [hint, setHint] = useState<MicHint>(null);
  const rec = useRef<Rec | null>(null);
  const mon = useRef<MicMonitor | null>(null);
  const timers = useRef<{ silence?: number; max?: number; tick?: number }>({});
  const last = useRef("");
  const id = useRef(`dictation-${++seq}`);
  const supported = dictationSupported();

  const clear = () => {
    window.clearTimeout(timers.current.silence);
    window.clearTimeout(timers.current.max);
    window.clearInterval(timers.current.tick);
  };
  const stopMonitor = () => {
    mon.current?.stop();
    mon.current = null;
    setLevel(0);
  };

  const stop = useCallback(() => {
    clear();
    try {
      rec.current?.stop();
    } catch {
      /* already stopped */
    }
  }, []);

  const fail = useCallback((msg: string) => {
    setError(msg);
    clear();
    try {
      rec.current?.abort();
    } catch {
      /* ignore */
    }
  }, []);

  const start = useCallback(() => {
    const Cls = recognitionClass();
    if (!Cls || rec.current) return;
    setError("");
    setHint(null);
    setHeard(false);
    const base = getText().replace(/\s+$/, "");
    last.current = base;
    let r: Rec;
    try {
      r = new Cls();
    } catch {
      setError("Voice typing isn't available in this browser.");
      return;
    }
    if (!claimMic(id.current, () => stop(), 2)) return;
    r.lang = speechLang();
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    let gotWords = false;
    let meterProblem: MicProblem | null = null; // what the meter found - a hint; recognition has the last word
    r.onresult = (e: any) => {
      let spoken = "";
      for (let i = 0; i < e.results.length; i++) spoken += e.results[i][0]?.transcript || "";
      const text = joinText(base, spoken);
      last.current = text;
      if (spoken.trim()) {
        gotWords = true;
        setHint(null);
      }
      setHeard(true);
      setText(text);
      window.clearTimeout(timers.current.silence);
      timers.current.silence = window.setTimeout(() => {
        try {
          r.stop();
        } catch {
          /* ignore */
        }
      }, SILENCE_MS);
    };
    r.onerror = (e: any) => {
      const code = e?.error;
      if (code === "aborted") return;
      if (code === "no-speech") {
        const m = mon.current;
        const label = deviceText(m?.label || "");
        setError(
          meterProblem && meterProblem !== "failed" && meterProblem !== "unsupported"
            ? MIC_HELP[meterProblem]
            : m?.measuring && m.loudest >= SOUND_LEVEL
            ? "I could hear sound but couldn't make out any words. Try again a little closer to your microphone."
            : `I can't hear you. Check your microphone is connected and not muted${label}, then try again.`,
        );
        return;
      }
      setError(ERRORS[code] || "Voice typing stopped - please try again, or type your question.");
    };
    r.onend = () => {
      clear();
      stopMonitor();
      rec.current = null;
      releaseMic(id.current);
      setListening(false);
      setHint(null);
      onDone?.(last.current);
    };
    rec.current = r;
    try {
      r.start();
      setListening(true);
      timers.current.max = window.setTimeout(() => {
        try {
          r.stop();
        } catch {
          /* ignore */
        }
      }, MAX_MS);
    } catch {
      rec.current = null;
      releaseMic(id.current);
      setError("Couldn't start the microphone. Please try again.");
      return;
    }

    // ---- the mic's own check, next to recognition -----------------------
    if (!meterUseful()) return;
    const m = new MicMonitor((p: MicProblem) => {
      meterProblem = p;
      if (!gotWords) setHint({ kind: p === "muted" ? "muted" : "device", text: MIC_HELP[p] });
    });
    mon.current = m;
    const t0 = Date.now();
    m.start().then((problem) => {
      if (mon.current !== m) return m.stop();
      if (problem && problem !== "failed" && problem !== "unsupported") {
        meterProblem = problem;
        if (!gotWords) setHint({ kind: problem === "muted" ? "muted" : "device", text: MIC_HELP[problem] });
      }
      if (!m.measuring) return; // no meter here - recognition's own errors still cover the rest
      timers.current.tick = window.setInterval(() => {
        const lvl = m.level();
        setLevel(lvl);
        if (gotWords) return;
        const ms = Date.now() - t0;
        const label = deviceText(m.label);
        if (m.loudest < SOUND_LEVEL) {
          if (ms > GIVE_UP_MS) fail(meterProblem === "muted" ? MIC_HELP.muted : `I can't hear you. Check your microphone is connected and not muted${label}, then try again.`);
          else if (ms > CANT_HEAR_MS) setHint({ kind: "cant-hear", text: `Can't hear you - check your mic${label}` });
        } else if (ms > NO_WORDS_MS) {
          setHint({ kind: "no-words", text: "I hear sound but no words - speak a little closer" });
        } else if (ms > CANT_HEAR_MS) setHint((h) => (h?.kind === "cant-hear" ? null : h));
      }, 110);
    });
  }, [getText, setText, onDone, stop, fail]);

  const toggle = useCallback(() => (rec.current ? stop() : start()), [start, stop]);

  // Esc finishes; leaving the page never leaves the mic on
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [listening, stop]);
  useEffect(
    () => () => {
      clear();
      mon.current?.stop();
      mon.current = null;
      try {
        rec.current?.abort();
      } catch {
        /* ignore */
      }
      rec.current = null;
      releaseMic(id.current);
    },
    [],
  );

  return { supported, listening, heard, level, hint, error, clearError: () => setError(""), start, stop, toggle };
}

export function MicIcon({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 ${className}`}>
      <rect x="9" y="2.5" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3.5" />
    </svg>
  );
}

/** The round mic button. Off: a quiet outline; listening: mint, with a soft pulse. */
export function MicButton({
  listening, onClick, disabled = false, size = "lg",
}: {
  listening: boolean;
  onClick: () => void;
  disabled?: boolean;
  size?: "lg" | "sm";
}) {
  const box = size === "lg" ? "w-12 h-12" : "w-9 h-9";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={listening}
      aria-label={listening ? "Stop listening" : "Speak your question"}
      title={listening ? "Stop listening (Esc)" : "Speak instead of typing"}
      className={`ui-focus relative ${box} rounded-full grid place-items-center shrink-0 transition-[background-color,color,border-color,transform] duration-200 disabled:opacity-35 ${
        listening
          ? "bg-kind-answer text-[rgb(var(--color-base))] border border-kind-answer gd-mic-live"
          : "border border-border-strong text-secondary hover:text-text hover:bg-subtle/60 active:scale-[0.96]"
      }`}
      data-mic={listening ? "on" : "off"}
    >
      <MicIcon size={size === "lg" ? 19 : 16} />
    </button>
  );
}

const BAR_SHAPE = [0.55, 0.85, 1, 0.8, 0.5];

/** Five bars: the real mic level when it can be read, else a gentle loop. */
export function LevelBars({ level, live = true, className = "bg-kind-answer" }: { level?: number; live?: boolean; className?: string }) {
  const metered = typeof level === "number" && level >= 0 && live;
  return (
    <span className="flex items-center gap-[3px] h-4" aria-hidden="true" data-level={metered ? Math.round((level || 0) * 100) : undefined}>
      {BAR_SHAPE.map((k, i) =>
        metered ? (
          <span key={i} className={`w-[3px] rounded-full ${className} transition-[height] duration-100`} style={{ height: `${Math.max(3, Math.min(16, 3 + (level || 0) * 26 * k))}px` }} />
        ) : (
          <span key={i} className={`w-[3px] rounded-full ${className} gd-mic-bar`} style={{ animationDelay: `${i * 110}ms` }} />
        ),
      )}
    </span>
  );
}

/** "Listening…" with a moving level. It takes the place of the box's own
 *  controls while the mic is on, so the box never changes height. When the
 *  mic can't hear anything it says so here, in amber. */
export function ListeningStrip({ heard, onStop, size = "lg", level, hint = null }: { heard: boolean; onStop: () => void; size?: "lg" | "sm"; level?: number; hint?: MicHint }) {
  const warn = !!hint;
  return (
    <div
      className={`flex-1 min-w-0 flex items-center gap-3 rounded-full transition-colors duration-200 ${
        warn ? "bg-warning/10 text-warning" : "bg-kind-answer-fill/80 text-kind-answer"
      } ${size === "lg" ? "h-11 pl-4 pr-1.5 text-[14px]" : "h-9 pl-3 pr-1 text-[13px]"}`}
      role="status"
      aria-live="polite"
      data-listening=""
      data-mic-hint={hint?.kind || undefined}
    >
      {warn ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="shrink-0">
          <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        </svg>
      ) : (
        <LevelBars level={level} live={!!level && level > 0} />
      )}
      <span className="flex-1 min-w-0 truncate" title={hint?.text}>
        {hint ? hint.text : heard ? "Listening - pause when you're done" : "Listening… ask your question"}
        {!hint && <span className="hidden sm:inline opacity-60"> · Esc to stop</span>}
      </span>
      <button type="button" onClick={onStop} className={`ui-focus rounded-full font-medium ${warn ? "text-warning hover:bg-warning/15" : "text-kind-answer hover:bg-kind-answer/10"} ${size === "lg" ? "h-8 px-3 text-[13px]" : "h-7 px-2.5 text-[12px]"}`}>
        Done
      </button>
    </div>
  );
}

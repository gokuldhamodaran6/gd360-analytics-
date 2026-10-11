// 2026-10-11: speak instead of typing - the mic in the Home box and in every
// thread's follow-up box.
//
// Uses the browser's own speech recognition (Chrome, Edge, Safari; Web
// Speech API). The words appear in the box as they are spoken; a short
// pause, the mic again, or Esc finishes. Nothing is sent by itself - the
// person reads it and presses Enter. Audio is handled by the browser; GD360
// only ever receives the typed-out words when the question is sent.
// Where the browser can't do it (Firefox) the mic is not shown.
import { useCallback, useEffect, useRef, useState } from "react";

type Rec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
};

function recognitionClass(): (new () => Rec) | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export const dictationSupported = () => recognitionClass() !== null;

const SILENCE_MS = 2200; // a pause this long finishes the question
const MAX_MS = 60000; // one question, not a monologue

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone is blocked - allow it for GD360 in your browser's address bar, then try again.",
  "service-not-allowed": "Microphone is blocked - allow it for GD360 in your browser's address bar, then try again.",
  "audio-capture": "No microphone was found. Plug one in, or type your question.",
  "no-speech": "I didn't hear anything - tap the mic and try again.",
  network: "Voice typing needs an internet connection. Please type your question.",
  "language-not-supported": "Voice typing isn't available for your browser's language yet.",
};

function joinText(base: string, spoken: string): string {
  const s = spoken.replace(/\s+/g, " ").trim();
  if (!s) return base;
  const said = base ? s : s.charAt(0).toUpperCase() + s.slice(1);
  return base ? `${base} ${said}` : said;
}

/**
 * Voice typing into a text box.
 *  - `getText` reads the box when listening starts (spoken words are added after it);
 *  - `setText` receives the box's new text as words arrive.
 */
export function useDictation({ getText, setText, onDone }: { getText: () => string; setText: (t: string) => void; onDone?: (text: string) => void }) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const [heard, setHeard] = useState(false);
  const rec = useRef<Rec | null>(null);
  const timers = useRef<{ silence?: number; max?: number }>({});
  const last = useRef("");
  const supported = dictationSupported();

  const clear = () => {
    window.clearTimeout(timers.current.silence);
    window.clearTimeout(timers.current.max);
  };

  const stop = useCallback(() => {
    clear();
    try {
      rec.current?.stop();
    } catch {
      /* already stopped */
    }
  }, []);

  const start = useCallback(() => {
    const Cls = recognitionClass();
    if (!Cls || rec.current) return;
    setError("");
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
    r.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (e: any) => {
      let spoken = "";
      for (let i = 0; i < e.results.length; i++) spoken += e.results[i][0]?.transcript || "";
      const text = joinText(base, spoken);
      last.current = text;
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
      if (e?.error === "aborted") return;
      setError(ERRORS[e?.error] || "Voice typing stopped - please try again, or type your question.");
    };
    r.onend = () => {
      clear();
      rec.current = null;
      setListening(false);
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
      setError("Couldn't start the microphone. Please try again.");
    }
  }, [getText, setText, onDone]);

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
      try {
        rec.current?.abort();
      } catch {
        /* ignore */
      }
      rec.current = null;
    },
    [],
  );

  return { supported, listening, heard, error, clearError: () => setError(""), start, stop, toggle };
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

/** "Listening…" with a moving level. It takes the place of the box's own
 *  controls while the mic is on, so the box never changes height. */
export function ListeningStrip({ heard, onStop, size = "lg" }: { heard: boolean; onStop: () => void; size?: "lg" | "sm" }) {
  return (
    <div
      className={`flex-1 min-w-0 flex items-center gap-3 rounded-full bg-kind-answer-fill/80 text-kind-answer ${size === "lg" ? "h-11 pl-4 pr-1.5 text-[14px]" : "h-9 pl-3 pr-1 text-[13px]"}`}
      role="status"
      aria-live="polite"
      data-listening=""
    >
      <span className="flex items-center gap-[3px] h-4" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="w-[3px] rounded-full bg-kind-answer gd-mic-bar" style={{ animationDelay: `${i * 110}ms` }} />
        ))}
      </span>
      <span className="flex-1 min-w-0 truncate">
        {heard ? "Listening - pause when you're done" : "Listening… ask your question"}
        <span className="hidden sm:inline text-kind-answer/60"> · Esc to stop</span>
      </span>
      <button type="button" onClick={onStop} className={`ui-focus rounded-full font-medium text-kind-answer hover:bg-kind-answer/10 ${size === "lg" ? "h-8 px-3 text-[13px]" : "h-7 px-2.5 text-[12px]"}`}>
        Done
      </button>
    </div>
  );
}

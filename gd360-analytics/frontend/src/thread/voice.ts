// 2026-10-11: the voice engine behind the mic (thread/Dictation.tsx) and
// Euliv, the voice assistant (components/Euliv.tsx).
//
//  - recognition:  the browser's speech-to-text (Web Speech API). Only ONE
//                  recognition may run at a time in a page, so every user
//                  claims the mic through `claimMic` - the wake word, voice
//                  typing and Euliv hand it over instead of fighting for it.
//  - MicMonitor:   the real microphone, opened next to recognition, to tell
//                  "nobody is speaking" from "the mic is muted / unplugged /
//                  in use by another app / blocked" - recognition alone can't
//                  tell them apart (it just hears nothing).
//  - speak():      Euliv's voice (speechSynthesis), sentence by sentence so
//                  long answers are not cut off and can be interrupted.
//  - settings:     per-person preferences in this browser (wake word, voice,
//                  speed, speak answers).
//
// Privacy: GD360 never records or stores audio. The level meter reads the
// microphone's loudness inside this page only; the browser's speech service
// turns speech into words, and only the words reach GD360.

// ---- recognition ----------------------------------------------------------------

export type Rec = {
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
  onaudiostart?: (() => void) | null;
  onsoundstart?: (() => void) | null;
  onspeechstart?: (() => void) | null;
};

export function recognitionClass(): (new () => Rec) | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export const speechInputSupported = () => recognitionClass() !== null;
export const speechOutputSupported = () => typeof window !== "undefined" && "speechSynthesis" in window && typeof (window as any).SpeechSynthesisUtterance === "function";

export function speechLang(): string {
  const s = loadSettings();
  if (s.lang) return s.lang;
  return (typeof navigator !== "undefined" && navigator.language) || "en-US";
}

/** Phones and tablets: no always-on wake word (battery, and mobile browsers chime on every restart). */
export function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(pointer: fine)").matches;
  } catch {
    return false;
  }
}

// ---- one mic at a time ------------------------------------------------------------

type Owner = { id: string; release: () => void; priority: number };
let owner: Owner | null = null;
const ownerListeners = new Set<(id: string | null) => void>();

/**
 * Take the mic. Whoever had it is told to let go (`release`), unless it has a
 * higher priority (Euliv > voice typing > the wake word) - then this returns false.
 */
export function claimMic(id: string, release: () => void, priority = 1): boolean {
  if (owner && owner.id !== id) {
    if (owner.priority > priority) return false;
    const prev = owner;
    owner = null;
    try {
      prev.release();
    } catch {
      /* ignore */
    }
  }
  owner = { id, release, priority };
  ownerListeners.forEach((f) => f(id));
  return true;
}

export function releaseMic(id: string) {
  if (owner?.id === id) {
    owner = null;
    ownerListeners.forEach((f) => f(null));
  }
}

export const micOwner = () => owner?.id || null;

export function onMicOwner(f: (id: string | null) => void): () => void {
  ownerListeners.add(f);
  return () => ownerListeners.delete(f);
}

// ---- the microphone itself --------------------------------------------------------------

export type MicProblem =
  | "insecure" // not https - browsers never give the mic
  | "unsupported"
  | "blocked" // permission denied
  | "no-device" // nothing plugged in
  | "in-use" // another app holds it (Zoom, Teams ...) or the OS refused
  | "muted" // the device or the OS mutes it
  | "ended" // unplugged while listening
  | "failed";

export const MIC_HELP: Record<MicProblem, string> = {
  insecure: "The microphone only works on a secure (https) page.",
  unsupported: "This browser can't use a microphone here. Try Chrome or Edge, or type instead.",
  blocked: "The microphone is blocked for GD360. Click the lock or mic icon in your browser's address bar, allow the microphone, then try again.",
  "no-device": "No microphone was found. Plug one in (or connect your headset), then try again.",
  "in-use": "Your microphone is busy - another app (like Zoom, Teams or Meet) may be using it. Close it and try again.",
  muted: "Your microphone is muted. Check the mute switch on your headset or your computer's sound settings.",
  ended: "Your microphone was disconnected. Plug it back in and try again.",
  failed: "Couldn't start the microphone. Check it's connected, then try again.",
};

export function micProblemOf(err: unknown): MicProblem {
  const name = (err as any)?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "blocked";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "no-device";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "in-use";
  return "failed";
}

export async function micPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  try {
    const p = await (navigator as any).permissions?.query({ name: "microphone" });
    return (p?.state as any) || "unknown";
  } catch {
    return "unknown";
  }
}

/** How loud the room is, 0..1 - and whether the mic can be heard at all. */
export class MicMonitor {
  stream: MediaStream | null = null;
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  buf: Float32Array | null = null;
  label = "";
  problem: MicProblem | null = null;
  private onProblem?: (p: MicProblem) => void;
  private peak = 0;
  private stopped = false;

  constructor(onProblem?: (p: MicProblem) => void) {
    this.onProblem = onProblem;
  }

  /** Opens the mic. Resolves null when it works, else what is wrong. */
  async start(): Promise<MicProblem | null> {
    if (typeof window === "undefined") return "unsupported";
    if (!window.isSecureContext) return (this.problem = "insecure");
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return (this.problem = "unsupported");
    try {
      const stream = await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return null;
      }
      this.stream = stream;
      const track = stream.getAudioTracks()[0];
      this.label = track?.label || "";
      if (track) {
        track.onmute = () => this.flag("muted");
        track.onended = () => this.flag("ended");
        if (track.muted) this.problem = "muted";
      }
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (AC) {
        this.ctx = new AC();
        const src = this.ctx!.createMediaStreamSource(stream);
        this.analyser = this.ctx!.createAnalyser();
        this.analyser.fftSize = 1024;
        this.analyser.smoothingTimeConstant = 0.6;
        src.connect(this.analyser);
        this.buf = new Float32Array(this.analyser.fftSize);
        if (this.ctx!.state === "suspended") this.ctx!.resume().catch(() => undefined);
      }
      return this.problem;
    } catch (e) {
      return (this.problem = micProblemOf(e));
    }
  }

  private flag(p: MicProblem) {
    if (this.stopped) return;
    this.problem = p;
    this.onProblem?.(p);
  }

  /** The current loudness, 0..1 (speech is usually 0.05 - 0.4). */
  level(): number {
    if (!this.analyser || !this.buf) return 0;
    this.analyser.getFloatTimeDomainData(this.buf as any);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    const lvl = Math.min(1, rms * 6);
    if (lvl > this.peak) this.peak = lvl;
    return lvl;
  }

  /** The loudest moment so far. */
  get loudest() {
    return this.peak;
  }

  /** True when the meter could be read at all (so silence really means silence). */
  get measuring() {
    return !!this.analyser;
  }

  stop() {
    this.stopped = true;
    try {
      this.stream?.getTracks().forEach((t) => {
        t.onmute = null;
        t.onended = null;
        t.stop();
      });
    } catch {
      /* ignore */
    }
    try {
      this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
  }
}

/**
 * Whether to open the meter next to recognition. Not on iPhone / iPad: there
 * a second capture can stop Safari's recognition. Everywhere else the meter's
 * findings are hints - recognition's own result always wins.
 */
export function meterUseful(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iOS = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && (navigator as any).maxTouchPoints > 1);
  return !iOS;
}

/** Above this the mic is picking something up; below, silence (or a dead mic). */
export const SOUND_LEVEL = 0.035;

// ---- speaking -----------------------------------------------------------------------

let voicesCache: SpeechSynthesisVoice[] = [];

export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!speechOutputSupported()) return Promise.resolve([]);
  const now = window.speechSynthesis.getVoices();
  if (now.length) {
    voicesCache = now;
    return Promise.resolve(now);
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      voicesCache = window.speechSynthesis.getVoices();
      resolve(voicesCache);
    };
    try {
      window.speechSynthesis.addEventListener("voiceschanged", finish, { once: true } as any);
    } catch {
      /* old Safari */
    }
    window.setTimeout(finish, 1200);
  });
}

const NICE = [/natural/i, /neural/i, /premium/i, /enhanced/i, /google/i, /samantha/i, /aria/i, /jenny/i, /serena/i, /daniel/i, /karen/i, /moira/i];

/** The voice Euliv uses: the person's choice, else the most natural one in their language. */
export function pickVoice(voices = voicesCache): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  const s = loadSettings();
  if (s.voice) {
    const chosen = voices.find((v) => v.voiceURI === s.voice);
    if (chosen) return chosen;
  }
  const lang = speechLang().toLowerCase();
  const base = lang.split("-")[0];
  const same = voices.filter((v) => v.lang.toLowerCase() === lang);
  const near = voices.filter((v) => v.lang.toLowerCase().startsWith(base));
  const pool = same.length ? same : near.length ? near : voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  for (const re of NICE) {
    const v = pool.find((x) => re.test(x.name));
    if (v) return v;
  }
  return pool.find((v) => v.localService) || pool[0] || voices[0] || null;
}

/** Split for speaking: one sentence (or a short group) at a time - Chrome stops long utterances around 15 s. */
export function chunks(text: string): string[] {
  const parts = (text || "").replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]*\s*/g) || [];
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    if (t.length > 220) {
      // a very long sentence: break at commas
      let cur = "";
      for (const piece of t.split(/,\s+/).map((x, k, all) => (k < all.length - 1 ? x + "," : x))) {
        if ((cur + " " + piece).length > 200 && cur) {
          out.push(cur.trim());
          cur = piece;
        } else cur = (cur + " " + piece).trim();
      }
      if (cur) out.push(cur.trim());
    } else out.push(t);
  }
  return out;
}

let speakToken = 0;
let keepAlive: number | undefined;

export function cancelSpeech() {
  speakToken++;
  window.clearInterval(keepAlive);
  if (speechOutputSupported()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
}

export const isSpeaking = () => speechOutputSupported() && window.speechSynthesis.speaking;

/**
 * Says `text` out loud. Resolves when finished ("done"), interrupted
 * ("cancelled") or when the browser can't speak ("failed" - the words are on
 * screen anyway). `onChunk` reports which sentence is being spoken.
 */
export function speak(text: string, opts: { onChunk?: (i: number, total: number) => void } = {}): Promise<"done" | "cancelled" | "failed"> {
  if (!speechOutputSupported() || !text.trim()) return Promise.resolve("failed");
  cancelSpeech();
  const token = ++speakToken;
  const synth = window.speechSynthesis;
  const parts = chunks(text);
  const s = loadSettings();
  const voice = pickVoice();
  // Chrome pauses long speech on its own after ~15 s - nudge it on
  keepAlive = window.setInterval(() => {
    if (synth.speaking && !synth.paused) return;
    if (synth.paused) synth.resume();
  }, 5000);
  return new Promise((resolve) => {
    let i = 0;
    const finish = (r: "done" | "cancelled" | "failed") => {
      window.clearInterval(keepAlive);
      resolve(r);
    };
    const next = () => {
      if (token !== speakToken) return finish("cancelled");
      if (i >= parts.length) return finish("done");
      const u = new SpeechSynthesisUtterance(parts[i]);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      } else u.lang = speechLang();
      u.rate = s.rate || 1;
      u.pitch = 1;
      opts.onChunk?.(i, parts.length);
      let settled = false;
      // a voice that never starts (no audio device, OS speech off): don't hang
      const guard = window.setTimeout(() => {
        if (!settled && !synth.speaking) {
          settled = true;
          finish(i === 0 ? "failed" : "done");
        }
      }, 4000);
      u.onstart = () => window.clearTimeout(guard);
      u.onend = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(guard);
        i++;
        next();
      };
      u.onerror = (e: any) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(guard);
        if (e?.error === "interrupted" || e?.error === "canceled") return finish("cancelled");
        finish(i === 0 ? "failed" : "done");
      };
      try {
        synth.speak(u);
      } catch {
        settled = true;
        window.clearTimeout(guard);
        finish("failed");
      }
    };
    next();
  });
}

// ---- settings (this browser) --------------------------------------------------------------

export type EulivSettings = {
  wake: boolean; // listen for "Hi Euliv" while a GD360 tab is open
  speak: boolean; // say answers out loud
  voice: string | null; // voiceURI
  rate: number;
  lang: string | null;
  handsFree: boolean; // listen again after each reply
};

const KEY = "gd360.euliv";
const DEFAULTS: EulivSettings = { wake: false, speak: true, voice: null, rate: 1, lang: null, handsFree: true };
const settingsListeners = new Set<(s: EulivSettings) => void>();
let settingsCache: EulivSettings | null = null;

export function loadSettings(): EulivSettings {
  if (settingsCache) return settingsCache;
  let s = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) s = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* private window - defaults */
  }
  settingsCache = s;
  return s;
}

export function saveSettings(patch: Partial<EulivSettings>) {
  const s = { ...loadSettings(), ...patch };
  settingsCache = s;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* kept for this visit only */
  }
  settingsListeners.forEach((f) => f(s));
}

export function onSettings(f: (s: EulivSettings) => void): () => void {
  settingsListeners.add(f);
  return () => settingsListeners.delete(f);
}

// ---- the name ---------------------------------------------------------------------------------

// How recognisers write "Euliv" (not a dictionary word). Exact spellings count
// alone; the look-alikes only right after "hi / hey / hello / ok".
const EXACT = "e+u+\\s?li+ve?|eu\\s?leave|yu+li+ve?|ju+li+ve?|ew+li+ve?";
const LOOSE = "you\\s?li+ve?|you\\s?leave|u\\s?li+ve?|o\\s?li+ve?|olive|yuli|julie|you'?ll\\s?live|ulysses?|you\\s?lift";
const GREET = "hi|hey|hello|hiya|ok|okay|hai|hay";
const WAKE_RE = new RegExp(`(?:^|\\s)(?:(?:${GREET})[\\s,!.]+(?:${EXACT}|${LOOSE})|(?:${EXACT}))\\b[\\s,.!?:;-]*`, "i");

/** "hey Euliv, how is marketing" -> { woke: true, rest: "how is marketing" } */
export function wakeIn(text: string): { woke: boolean; rest: string } {
  const m = WAKE_RE.exec(text || "");
  if (!m) return { woke: false, rest: "" };
  return { woke: true, rest: (text.slice(m.index + m[0].length) || "").trim() };
}

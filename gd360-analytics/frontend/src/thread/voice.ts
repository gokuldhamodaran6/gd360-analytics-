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

/** Round 30: the Englishes the browser's recognizer knows. Matching the speaker's accent is the
 *  single biggest step up in what Euliv hears right (an Indian accent read as US English loses words). */
export const ENGLISHES: [string, string][] = [
  ["en-IN", "India"], ["en-GB", "United Kingdom"], ["en-US", "United States"], ["en-AU", "Australia"],
  ["en-CA", "Canada"], ["en-IE", "Ireland"], ["en-NZ", "New Zealand"], ["en-SG", "Singapore"],
  ["en-ZA", "South Africa"], ["en-NG", "Nigeria"], ["en-KE", "Kenya"], ["en-GH", "Ghana"],
  ["en-PK", "Pakistan"], ["en-PH", "Philippines"], ["en-TZ", "Tanzania"],
];

const TZ_ENGLISH: [RegExp, string][] = [
  [/^Asia\/(Kolkata|Calcutta)$/, "en-IN"], [/^Asia\/Karachi$/, "en-PK"], [/^Asia\/Singapore$/, "en-SG"],
  [/^Asia\/Manila$/, "en-PH"], [/^Europe\/(London|Belfast|Guernsey|Jersey|Isle_of_Man)$/, "en-GB"], [/^Europe\/Dublin$/, "en-IE"],
  [/^Australia\//, "en-AU"], [/^Pacific\/(Auckland|Chatham)$/, "en-NZ"], [/^Africa\/Lagos$/, "en-NG"],
  [/^Africa\/Johannesburg$/, "en-ZA"], [/^Africa\/Nairobi$/, "en-KE"], [/^Africa\/Accra$/, "en-GH"],
  [/^Africa\/Dar_es_Salaam$/, "en-TZ"],
  [/^America\/(Toronto|Vancouver|Edmonton|Winnipeg|Halifax|St_Johns|Regina|Montreal|Moncton|Whitehorse|Yellowknife)$/, "en-CA"],
];

/** The English this person most likely speaks: a regional English the browser lists wins; a plain
 *  en-US / en-GB (the default on most computers) gives way to the region of the computer's clock. */
export function autoEnglish(): string {
  if (typeof navigator === "undefined") return "en-US";
  const langs = (navigator.languages?.length ? navigator.languages : [navigator.language]).filter(Boolean);
  let zone = "";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    /* ignore */
  }
  const byZone = TZ_ENGLISH.find(([re]) => re.test(zone))?.[1];
  const english = langs.filter((l) => /^en(-|$)/i.test(l));
  if (byZone && english.some((l) => l.toLowerCase() === byZone.toLowerCase())) return byZone;
  const regional = english.find((l) => !/^en(-us|-gb)?$/i.test(l));
  if (regional) return regional;
  if (byZone) return byZone;
  return english[0] || "en-US";
}

/** What Euliv LISTENS for (speech to text). */
export function speechLang(): string {
  const s = loadSettings();
  if (s.lang) return s.lang;
  return autoEnglish();
}

/** The language of Euliv's own VOICE: the computer's language, as before - the accent setting is
 *  about hearing the person and never swaps the voice they're used to. */
export function voiceLang(): string {
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
  blocked: "The microphone is blocked for Euliv. Click the lock or mic icon in your browser's address bar, allow the microphone, then try again.",
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
  const lang = voiceLang().toLowerCase();
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

// ---- Euliv hearing itself (rounds 27-28) ----------------------------------------------------
// On speakers (no headset) the mic hears Euliv's own voice, and browsers' echo cancellation does
// not cover the computer's speech voice. Left alone, Euliv "hears" itself, answers that, hears
// the answer ... a loop. Round 28: Euliv no longer listens WHILE it talks unless the person wears
// headphones (or turned "talk over Euliv" on), and everything heard is still checked against what
// Euliv said lately - its framing words ("so I'll look at", "shall I go ahead") separately from the
// person's own question it quoted back (“…”), so a person refining their question isn't mistaken for echo.
const words = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const unquote = (s: string) => (s || "").replace(/[“"][^“”"]*[”"]/g, " ");
const quoted = (s: string) => ((s || "").match(/[“"][^“”"]*[”"]/g) || []).join(" ");
const STOPWORDS = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "it", "i", "you", "your",
  "my", "me", "that", "this", "can", "could", "would", "should", "do", "did", "be", "with", "from", "at", "by", "so", "s", "t", "ll", "ve",
  "what", "which", "how", "shall", "will", "just", "here", "have", "has", "if", "as", "all", "there", "m", "d", "re"]);
const content = (s: string) => words(s).split(" ").filter((w) => w && !STOPWORDS.has(w));
/** Word set with neighbours joined too ("e commerce" also as "ecommerce") - recognisers split and join words differently. */
const vocab = (s: string) => {
  const ws = words(s).split(" ").filter(Boolean);
  const out = new Set(ws);
  for (let i = 0; i + 1 < ws.length; i++) out.add(ws[i] + ws[i + 1]);
  return out;
};
const ANSWER_WORDS = new Set(["yes", "yeah", "yep", "yup", "sure", "okay", "ok", "correct", "perfect", "stop", "wait", "no", "nope",
  "cancel", "first", "second", "third", "fourth", "number", "both", "none", "instead", "great", "exactly", "right", "actually"]);
const ASK_START = /^(?:no|yes|yeah|ok|okay|actually|wait|and|also|now|so)?\s*(?:what|whats|how|why|which|who|when|where|show|give|tell|compare|list|can|could|break|split|pull|find)\b/;
// Euliv's own phrases - a person doesn't say these to it
const OWN_PHRASES = [
  "didn t catch that", "say it again", "which data should i use", "here s what you have", "how can i help", "shall i go ahead",
  "to hear them", "talk soon", "just to confirm", "in your sources", "pick one a few", "i couldn t find", "one moment",
  "working it out", "the data from your last answer", "anything else i can look at", "i m not sure what you d like",
  "would you like to change the question", "so i ll look at", "i ll stay with", "anything to add",
];

/**
 * Is this Euliv's own voice coming back through the mic?
 * `recent`: what Euliv said in the last few seconds. `speaking`: heard while Euliv was still talking.
 */
export function heardEuliv(heard: string, recent: string[], speaking = false): boolean {
  const h = words(heard);
  if (!h) return true;
  if (OWN_PHRASES.some((p) => ` ${h} `.includes(` ${p} `))) return true;
  const said = recent.filter(Boolean);
  if (!said.length) return false;
  const full = ` ${said.map(words).join(" | ")} `; // everything Euliv said, the quoted question included
  const frame = ` ${said.map((x) => words(unquote(x))).join(" | ")} `; // only Euliv's own words
  const hw = h.split(" ");
  // the whole of it is something Euliv just said
  if (full.includes(` ${h} `) && (speaking || hw.length >= 3)) return true;
  const mineAll = vocab(said.join(" "));
  const mineFrame = vocab(said.map(unquote).join(" "));
  const quote = vocab(said.map(quoted).join(" "));
  // 4 of Euliv's own words in a row - not the person's own question words it repeated back
  for (let i = 0; i + 4 <= hw.length; i++) {
    const gram = hw.slice(i, i + 4);
    if (frame.includes(` ${gram.join(" ")} `) && gram.some((w) => !quote.has(w) && !STOPWORDS.has(w))) return true;
  }
  const cw = content(heard);
  if (!cw.length) return speaking || full.includes(` ${h} `); // filler ("how") while it talks or right after it said it
  if (speaking) {
    // a word only a person answering would say, that Euliv didn't: the person ("yes", "stop", "first")
    if (cw.some((w) => !mineAll.has(w) && ANSWER_WORDS.has(w))) return false;
    return cw.filter((w) => mineAll.has(w)).length / cw.length > 0.5;
  }
  // after Euliv finished: a question or an answer from the person is the person
  if (ASK_START.test(h) || cw.some((w) => ANSWER_WORDS.has(w) && !mineFrame.has(w))) return false;
  const novel = cw.filter((w) => !mineAll.has(w) && !quote.has(w)).length;
  const framing = cw.filter((w) => mineFrame.has(w)).length / cw.length;
  return cw.length >= 4 && novel <= (cw.length >= 8 ? 1 : 0) && framing >= 0.5;
}

/** Back-compat: one sentence being spoken. */
export const isEcho = (heard: string, speaking: string) => heardEuliv(heard, [speaking], true);

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
      } else u.lang = voiceLang();
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
  keep: boolean; // keep a written record of each talk in Library (round 24)
  wakeAsked?: boolean; // the "Turn on Hi Euliv" offer was answered (round 25)
  talkOver?: boolean; // round 28: listen while Euliv speaks, so the person can just talk over it (best with headphones)
};

const KEY = "gd360.euliv";
const DEFAULTS: EulivSettings = { wake: false, speak: true, voice: null, rate: 1, lang: null, handsFree: true, keep: true };
const settingsListeners = new Set<(s: EulivSettings) => void>();
let settingsCache: EulivSettings | null = null;

/**
 * Round 28: are the computer's sounds going to headphones? Then Euliv's voice can't reach the mic,
 * and the person can safely talk over it. Read from the default output device's name (known once
 * the mic has been allowed); unknown = speakers, the safe answer.
 */
export async function headphonesOn(): Promise<boolean> {
  try {
    const devs = await navigator.mediaDevices?.enumerateDevices?.();
    const outs = (devs || []).filter((d) => d.kind === "audiooutput");
    const def = outs.find((d) => d.deviceId === "default") || outs[0];
    const label = (def?.label || "").toLowerCase();
    return /head ?(phone|set)|airpods|earbuds|ear ?pods|\bbuds\b|earphone|in-ear|bose|jabra|beats|wh-?1000|wf-?1000|plantronics|poly |sennheiser|galaxy buds|pixel buds|nothing ear/.test(label);
  } catch {
    return false;
  }
}

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

// ---- hearing the name (round 25) ------------------------------------------
//
// Speech recognisers write "Euliv" (not a dictionary word) in many ways, and
// people say it in many ways: "hiii euliv", "heyyy you live", "hello olive",
// "hai yuliv", "hi Liv", "okay eulive". Instead of a list of spellings the name
// is matched by sound:
//   1. letters stretched out are squeezed ("hiiii" -> "hi", "heyyy" -> "hey");
//   2. a greeting (hi / hey / hello / hai / hiya / ok / yo ...), then the next one
//      to three words joined ("you live" -> "youlive") are compared with the
//      name's spoken shapes (euliv, uliv, youliv, olive, alive ...) allowing a
//      couple of letters' difference, or by their consonant skeleton (L then V);
//   3. without a greeting only a near-exact "Euliv" at the very start counts,
//      so everyday words ("olive oil", "you live in") never wake it.

// ---- "Hi Euliv": the name by its sound --------------------------------------------------
// Round 27. People say it their own way - "hi Euliv", "hiiii Eliveee", "hey you-leave", "hello Uli",
// "I live" (the recogniser drops the h of "hi") - and the recogniser spells it a dozen ways. So the
// name is matched by SOUND, generously, but only where a person would say it: right after a greeting,
// or as the whole thing said. Everyday sentences ("I live in London", "hey, I love it") don't wake it.
const GREETING_WORDS = new Set(["hi", "hey", "hello", "helo", "hallo", "hullo", "hiya", "heya", "hai", "hay", "hy", "hye", "ok", "okay",
  "yo", "ola", "hola", "oye", "hie", "aye", "ey", "hei", "heyy", "namaste", "vanakkam", "hallo"]);
// words a recogniser writes for a quick "hi": a wake only when the name is all that follows ("I live" / "high Euliv")
const WEAK_GREETINGS = new Set(["i", "a", "ay", "high", "eh", "oh", "ah", "hm", "huh"]);
// "Euliv" = a vowel sound (eu / you / u / o / e / ju), then L, then a short i / ee / ea, then V (or F / B)
const NAME_SOUND = /^h?(?:[yj]?[aeiouw]{1,3}|[yj])l(?:[iey]|ea|ie|ei)(?:v|f|ph|b|w)e?$/;
const CORE_SHAPES = ["euliv", "eulive", "yuliv", "yulive", "uliv", "ulive", "euleav", "euleave"];
const BARE_NAMES = new Set(["liv", "leev", "lif", "leef"]); // "hi Liv" - the "eu" went into the "hi"
const STRICT_SHAPES = ["euliv", "eulive", "yuliv", "yulive", "uliv", "euleev", "euleve"];

function squeeze(w: string): string {
  return w.replace(/(.)\1+/g, "$1");
}

function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 9;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

function clean(w: string): string {
  return squeeze((w || "").toLowerCase().replace(/[^a-z]/g, ""));
}

/** The consonant outline: whatever the vowels and the accent, Euliv is "L-V" (or just "L" when the V is soft). */
function outline(w: string): { core: string; skel: string } {
  const core = w.replace(/^[hyjw]+/, "");
  const skel = squeeze(core.replace(/ph/g, "v").replace(/[aeiouy]/g, "").replace(/[fbw]/g, "v"));
  return { core, skel };
}

/**
 * Does this (joined) word sound like "Euliv"?
 * strict: nothing before it (only near-exact spellings). loose: after a greeting - also
 * "you live", "Olive", "Eli V", "Uli", "Yulia", "Julie" (soft V), "live".
 */
export function soundsLikeEuliv(word: string, strict = false): boolean {
  const w = clean(word);
  if (strict) return w.length >= 4 && w.length <= 10 && STRICT_SHAPES.some((x) => lev(w, x) <= 1);
  if (w.length < 3 || w.length > 11) return false;
  if (BARE_NAMES.has(w) || NAME_SOUND.test(w)) return true;
  if (w.length >= 5 && CORE_SHAPES.some((x) => lev(w, x) <= 1)) return true;
  const { core, skel } = outline(w);
  if (skel === "lv") return core.length <= 8; // live, leave, olive, alive, eliv, ulif, olivia, you-live
  if (skel === "l") return /^[aeiou]/.test(core) && core.length <= 6; // eli, ellie, uli, yuli, yulia, julie, ollie
  return false;
}

function isGreeting(word: string): boolean {
  const w = clean(word);
  return GREETING_WORDS.has(w) || /^h+e+y+$|^h+i+$|^he+l+o+$|^h+a+i+$/.test(word.toLowerCase().replace(/[^a-z]/g, ""));
}

const isWeakGreeting = (word: string) => WEAK_GREETINGS.has(clean(word));
const OBJECT_WORDS = new Set(["it", "that", "this", "them", "those", "these", "me", "him", "her", "us", "alone", "here", "there",
  "with", "in", "on", "at", "for", "to", "out", "off", "up", "forever", "is", "was", "and", "of"]);
const QUESTION_START = new Set(["what", "whats", "how", "show", "why", "which", "who", "when", "where", "can", "could", "give", "tell",
  "are", "did", "do", "does", "compare", "list", "open", "pull", "find", "please"]);
/** Spelled close to the name itself (not just its outline): "eulive", "you live", "eliv" */
const nearName = (w: string) => {
  const c = clean(w);
  return NAME_SOUND.test(c) || BARE_NAMES.has(c) || (c.length >= 5 && CORE_SHAPES.some((x) => lev(c, x) <= 1));
};

/** "hey Euliv, how is marketing" -> { woke: true, rest: "how is marketing" } */
export function wakeIn(text: string): { woke: boolean; rest: string } {
  const raw = (text || "").trim();
  if (!raw) return { woke: false, rest: "" };
  const parts = raw.split(/\s+/);
  const restFrom = (k: number) => parts.slice(k).join(" ").replace(/^[\s,.!?:;-]+/, "").trim();
  const fits = (i: number, n: number, strict: boolean): boolean => {
    if (i + n > parts.length) return false;
    // "I live", "a live demo", "the leave": a word of its own, never the start of the name
    if (n > 1 && ["i", "a", "the", "to", "my", "our"].includes(clean(parts[i]))) return false;
    const joined = parts.slice(i, i + n).join("");
    if (clean(joined).length > 11 || !soundsLikeEuliv(joined, strict)) return false;
    const next = clean(parts[i + n] || "");
    if (!strict && !nearName(joined)) {
      // a verb, not the name: "leave it there", "love that", "life is good"
      if (OBJECT_WORDS.has(next)) return false;
      // "live", "life", "leave" (no vowel sound before the L): the name only when nothing - or a question - follows
      if (/^l/.test(clean(joined).replace(/^[hyjw]+/, "")) && next && !QUESTION_START.has(next)) return false;
    }
    return true;
  };
  const nameAt = (i: number, strict: boolean): number => {
    // a close spelling of the name wins at its own length ("Euliv, I want ..." is not "Euliv I");
    // otherwise the longest reading ("eli v" is one name)
    const top = strict ? 1 : 3;
    for (let n = 1; n <= top; n++) if (fits(i, n, strict) && nearName(parts.slice(i, i + n).join(""))) return n;
    for (let n = top; n >= 1; n--) if (fits(i, n, strict)) return n;
    return 0;
  };
  for (let i = 0; i < Math.min(parts.length, 4); i++) {
    if (isGreeting(parts[i])) {
      // "hi euliv", "hey there euliv", "hello hello euliv", "hi hi eulive"
      for (let j = i + 1; j <= Math.min(i + 2, parts.length - 1); j++) {
        if (["i", "a", "the", "my"].includes(clean(parts[j]))) break; // "hey I live in ..." is a sentence
        const n = nameAt(j, false);
        if (n) return { woke: true, rest: restFrom(j + n) };
        if (!isGreeting(parts[j]) && clean(parts[j]) !== "there") break;
      }
    }
  }
  // a quick "hi" written as "I" / "high": only when the name is all that was said ("I live", "high Eliv")
  if (parts.length >= 2 && isWeakGreeting(parts[0])) {
    const n = nameAt(1, false);
    if (n && 1 + n === parts.length) return { woke: true, rest: "" };
  }
  // the name on its own: "Euliv", "Eulive what is revenue", or just "you live" / "Olive" said alone
  const n0 = nameAt(0, true);
  if (n0) return { woke: true, rest: restFrom(n0) };
  if (parts.length <= 2) {
    const j = clean(parts.join(""));
    if (/^[aeiouyj]/.test(j) && j.length >= 4 && soundsLikeEuliv(j, false) && outline(j).skel === "lv") return { woke: true, rest: "" };
  }
  return { woke: false, rest: "" };
}

/** Any of the recogniser's guesses (it offers a few) waking Euliv - the best one isn't always the right one. */
export function wakeInAny(alternatives: string[]): { woke: boolean; rest: string } {
  for (const t of alternatives) {
    const w = wakeIn(t);
    if (w.woke) return w;
  }
  return { woke: false, rest: "" };
}

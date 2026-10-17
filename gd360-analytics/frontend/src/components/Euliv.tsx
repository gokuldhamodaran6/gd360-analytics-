// 2026-10-11: Euliv - talk to GD360.
//
// "Talk to Euliv" (Home, and the orb in the top bar), or - when switched on
// in Euliv's settings - just say "Hi Euliv" / "Euliv" while a GD360 tab is
// open. Euliv greets you ("Hi Gokul, how can I help you?"), listens, and
// answers out loud from your data:
//   - more than one source fits?  it asks which ("Google Ads, Meta Ads, or both?")
//     and remembers the choice for that topic;
//   - nothing connected for it?   it offers to connect it, opens the connect
//     page in a new tab and carries on by itself once it's connected;
//   - the answer:                 the same engine as typed questions - said in
//     a sentence or two, with the numbers on a card and a link to the full answer;
//   - follow-ups ("why?")         are explained from the same numbers.
// It keeps the conversation going hands-free (listen -> answer -> listen),
// can be interrupted any time (tap the orb, or Space), and says plainly when
// it can't hear you and why (blocked / no mic / muted / busy / silence).
//
// The brain is backend routers/assistant.py; speech in and out is the
// browser's (thread/voice.ts). Only words reach GD360 - never audio.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../api/AuthContext";
import { assistantApi, type EulivAnswer, type EulivConnect, type EulivMemory, type EulivState, type EulivTurn } from "../api/assistant";
import type { CheckPeriod } from "../api/projects";
import { type Card, cardFromSaved, EulivCardView } from "./EulivCards";
import { periodWords } from "./QuestionCheck";
import { ACTIVE_WORKSPACE_KEY } from "../lib/useWorkspaceNav";
import { deviceText, LevelBars } from "../thread/Dictation";
import {
  cancelSpeech, claimMic, headphonesOn, heardEuliv, isSpeaking, isTouchDevice, loadSettings, loadVoices, meterUseful, MIC_HELP, MicMonitor, type MicProblem, micOwner, onMicOwner,
  onSettings, type Rec, recognitionClass, releaseMic, saveSettings, SOUND_LEVEL, speak, speechInputSupported,
  speechLang, speechOutputSupported, voiceLang, wakeInAny, autoEnglish, ENGLISHES, type EulivSettings,
} from "../thread/voice";

const HIDDEN_ON = ["/admin", "/pricing", "/about", "/start", "/register", "/login", "/admin-login", "/help", "/public", "/d/", "/invite", "/privacy", "/connect/", "/e/", "/w/", "/a/", "/r/", "/staff/", "/t/", "/sp/", "/f/", "/x/", "/sign/"];
const OPEN_EVENT = "gd360:euliv";

/** Opens Euliv from anywhere (Home, the top bar, the command palette ...). */
export function openEuliv(first?: string, opts: { talkId?: string } = {}) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { first, talkId: opts.talkId } }));
}

export const eulivAvailable = () => speechInputSupported() || speechOutputSupported();

function workspaceId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_WORKSPACE_KEY) || null;
  } catch {
    return null;
  }
}

function errText(e: any): string {
  if (!e?.response) return "I can't reach GD360 right now - check your internet connection and try again.";
  const d = e.response?.data?.detail;
  return typeof d === "string" ? d : "Something went wrong on my side. Please try again.";
}

// ---- listening once -----------------------------------------------------------------

type Heard = { text: string; alts?: string[]; reason: "ok" | "silent" | "unclear" | "stopped" | "network" | "unsupported" | MicProblem; label: string };

/** Whole-sentence readings: the best one, then each phrase swapped for the recognizer's next guess. */
function readings(segs: string[][], best: string): string[] {
  const out: string[] = [];
  const base = segs.map((a) => a[0] || "");
  segs.forEach((alts, j) => {
    alts.slice(1).forEach((alt) => {
      if (!alt.trim()) return;
      const t = base.map((b, i) => (i === j ? alt : b)).join(" ").replace(/\s+/g, " ").trim();
      if (t && t.toLowerCase() !== best.toLowerCase() && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    });
  });
  return out.slice(0, 6);
}

function listenOnce(o: {
  onInterim: (t: string) => void;
  onLevel: (l: number) => void;
  control: { current: { finish?: () => void } };
  silentMs: number;
  unclearMs: number;
}): Promise<Heard> {
  return new Promise((resolve) => {
    const Cls = recognitionClass();
    if (!Cls) return resolve({ text: "", reason: "unsupported", label: "" });
    let finals = "";
    let interim = "";
    // round 30: the recognizer's other readings of each finished phrase - the server keeps the one that fits
    let segs: string[][] = [];
    let settled = false;
    let gotWords = false;
    let meterProblem: MicProblem | null = null; // the meter's finding - used to explain silence
    const t0 = Date.now();
    const t: { silence?: number; tick?: number; cap?: number } = {};
    const mon = new MicMonitor((p) => (meterProblem = p));
    let r: Rec;
    const said = () => `${finals} ${interim}`.replace(/\s+/g, " ").trim();
    function end(reason: Heard["reason"]) {
      if (settled) return;
      settled = true;
      window.clearTimeout(t.silence);
      window.clearInterval(t.tick);
      window.clearTimeout(t.cap);
      mon.stop();
      try {
        r?.abort();
      } catch {
        /* ignore */
      }
      releaseMic("euliv");
      o.onLevel(0);
      const text = said();
      const explained = meterProblem && meterProblem !== "failed" && meterProblem !== "unsupported" ? meterProblem : null;
      const why = text ? "ok" : (reason === "silent" || reason === "unclear") && explained ? explained : reason;
      resolve({ text, alts: interim.trim() ? [] : readings(segs, text), reason: why, label: mon.label });
    }
    o.control.current = { finish: () => end("stopped") };
    try {
      r = new Cls();
    } catch {
      return resolve({ text: "", reason: "unsupported", label: "" });
    }
    if (!claimMic("euliv", () => end("stopped"), 3)) return resolve({ text: "", reason: "in-use", label: "" });
    r.lang = speechLang();
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 4;
    r.onresult = (e: any) => {
      let f = "";
      let i2 = "";
      const sg: string[][] = [];
      for (let i = 0; i < e.results.length; i++) {
        const tr = e.results[i][0]?.transcript || "";
        if (e.results[i].isFinal) {
          f += tr;
          const all: string[] = [];
          for (let k = 0; k < Math.min(4, e.results[i].length || 1); k++) all.push(String(e.results[i][k]?.transcript || ""));
          sg.push(all);
        } else i2 += tr;
      }
      finals = f;
      interim = i2;
      segs = sg;
      if (said()) gotWords = true;
      o.onInterim(said());
      window.clearTimeout(t.silence);
      // a pause after words finishes the turn. Round 30: a little more room - people who think
      // mid-sentence, or speak English as a second language, were being cut off
      t.silence = window.setTimeout(() => end("ok"), i2 ? 2000 : 1400);
    };
    r.onerror = (e: any) => {
      const c = e?.error;
      if (c === "aborted") return;
      if (c === "not-allowed" || c === "service-not-allowed") return end("blocked");
      if (c === "audio-capture") return end("no-device");
      if (c === "network") return end("network");
      if (c === "no-speech") return end(mon.measuring && mon.loudest >= SOUND_LEVEL ? "unclear" : "silent");
      end("unclear");
    };
    r.onend = () => end(mon.measuring && mon.loudest >= SOUND_LEVEL ? "unclear" : "silent");
    try {
      r.start();
    } catch {
      releaseMic("euliv");
      settled = true;
      return resolve({ text: "", reason: "failed", label: "" });
    }
    t.cap = window.setTimeout(() => end("ok"), 30000);
    if (!meterUseful()) return;
    mon.start().then((problem) => {
      if (settled) return mon.stop();
      if (problem) meterProblem = problem;
      if (!mon.measuring) return;
      t.tick = window.setInterval(() => {
        o.onLevel(mon.level());
        if (gotWords) return;
        const ms = Date.now() - t0;
        if (mon.loudest < SOUND_LEVEL && ms > o.silentMs) end("silent");
        else if (mon.loudest >= SOUND_LEVEL && ms > o.unclearMs) end("unclear");
      }, 90);
    });
  });
}

// ---- talking over Euliv (round 26) ---------------------------------------------------------
// While Euliv speaks, the mic stays open. The moment the person starts talking (words that
// aren't Euliv's own voice coming back), Euliv stops mid-sentence and listens - "one", "go ahead",
// "stop", a new question - like a person would. No waiting for a list of options to finish.

type Barge = { stop: () => void; hearing: () => boolean; heard: Promise<string | null> };

/** Round 31: on speakers Euliv can't tell its own voice from yours in a full sentence, so - like
 *  "Hey Siri" - it listens while it talks only for a short interrupt: its name, "wait", "stop", "no",
 *  "yes", "change it", a number... Anything longer, or anything it is saying itself, is ignored. */
const INTERRUPT = /\b(euliv|eliv|olive|stop|wait|hold on|hang on|pause|cancel|enough|quiet|no|nope|yes|yeah|yep|okay|ok|go ahead|proceed|change|edit|wrong|one|two|three|four|five|first|second|third|all|both|none|repeat|again|sorry|excuse me|hey)\b/i;
export const isInterrupt = (t: string) => t.trim().split(/\s+/).length <= 5 && INTERRUPT.test(t);

function bargeListen(o: { echoOf: () => string[]; onStart: () => void; onInterim: (t: string) => void; gate?: (t: string) => boolean }): Barge | null {
  const Cls = recognitionClass();
  if (!Cls) return null;
  let r: Rec | null = null;
  let stopped = false;
  let started = false;
  let last = "";
  let quiet: number | undefined;
  let done: (t: string | null) => void = () => {};
  const heard = new Promise<string | null>((res) => (done = res));
  const finish = (t: string | null) => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(quiet);
    const cur = r;
    r = null;
    if (cur) {
      cur.onend = null;
      cur.onresult = null;
      try {
        cur.abort();
      } catch {
        /* ignore */
      }
    }
    releaseMic("euliv");
    done(t);
  };
  const start = () => {
    if (stopped) return;
    let rec: Rec;
    try {
      rec = new Cls();
    } catch {
      return;
    }
    if (!claimMic("euliv", () => finish(started ? last || null : null), 3)) return;
    rec.lang = speechLang();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e: any) => {
      for (let i = e.resultIndex || 0; i < e.results.length; i++) {
        const tr = String(e.results[i][0]?.transcript || "").trim();
        // Euliv's own voice through the speakers is not the person (round 27: checked on every result, final too)
        if (!tr || heardEuliv(tr, o.echoOf(), true)) continue;
        // speakers: only a short interrupt counts until the person has the floor
        if (!started && o.gate && !o.gate(tr)) continue;
        last = tr;
        if (!started) {
          started = true;
          o.onStart();
        }
        o.onInterim(tr);
        if (e.results[i].isFinal) return finish(tr);
        // a pause after words: that's what they said
        window.clearTimeout(quiet);
        quiet = window.setTimeout(() => finish(last || null), 1600);
      }
    };
    rec.onerror = () => {};
    rec.onend = () => {
      r = null;
      if (stopped) return;
      if (started) return finish(last || null);
      window.setTimeout(start, 200); // the browser ended it on its own while Euliv still talks: open it again
    };
    r = rec;
    try {
      rec.start();
    } catch {
      r = null;
    }
  };
  start();
  return { stop: () => finish(null), hearing: () => started, heard };
}

// ---- "Hi Euliv" ----------------------------------------------------------------------------

/** Listens for the name while switched on, the tab is visible, and nobody else has the mic. */
function useWakeWord(on: boolean, onWake: (rest: string) => void) {
  const [active, setActive] = useState(false);
  const [problem, setProblem] = useState<string>("");
  const wakeRef = useRef(onWake);
  wakeRef.current = onWake;

  useEffect(() => {
    if (!on) {
      setActive(false);
      return;
    }
    const Cls = recognitionClass();
    if (!Cls) return;
    let r: Rec | null = null;
    let alive = true;
    let backoff = 400;
    let restartT: number | undefined;
    let pending: { at: number; rest: string } | null = null;
    let pendingT: number | undefined;

    const fire = (rest: string) => {
      pending = null;
      window.clearTimeout(pendingT);
      stopRec();
      wakeRef.current(rest);
    };
    const stopRec = () => {
      const cur = r;
      r = null;
      setActive(false);
      if (cur) {
        cur.onend = null;
        try {
          cur.abort();
        } catch {
          /* ignore */
        }
      }
      releaseMic("wake");
    };
    const schedule = (ms: number) => {
      window.clearTimeout(restartT);
      restartT = window.setTimeout(startRec, ms);
    };
    function startRec() {
      if (!alive || r || document.visibilityState !== "visible" || micOwner()) return;
      let rec: Rec;
      try {
        rec = new Cls!();
      } catch {
        return;
      }
      if (!claimMic("wake", () => stopRec(), 0)) return;
      rec.lang = speechLang();
      rec.continuous = true;
      rec.interimResults = true;
      // round 27: the recogniser's other guesses too - for an accent its first guess is often "Julie" or "I live"
      rec.maxAlternatives = 5;
      rec.onresult = (e: any) => {
        for (let i = e.resultIndex || 0; i < e.results.length; i++) {
          const res = e.results[i];
          const alts: string[] = [];
          for (let k = 0; k < (res.length || 1); k++) if (res[k]?.transcript) alts.push(res[k].transcript);
          // "hi" and the name can land in two pieces ("hi" … "Eliv"): read them together too
          const prev = i > 0 ? e.results[i - 1][0]?.transcript || "" : "";
          if (prev) alts.push(...alts.slice(0, 2).map((a) => `${prev} ${a}`));
          const w = wakeInAny(alts);
          if (!w.woke) continue;
          if (e.results[i].isFinal) return fire(w.rest);
          // heard the name mid-sentence: wait for the end of what they're saying
          pending = { at: Date.now(), rest: w.rest };
          window.clearTimeout(pendingT);
          pendingT = window.setTimeout(() => pending && fire(pending.rest), 2200);
        }
      };
      rec.onerror = (e: any) => {
        const c = e?.error;
        if (c === "not-allowed" || c === "service-not-allowed") {
          setProblem(MIC_HELP.blocked);
          saveSettings({ wake: false });
          alive = false;
        } else if (c === "network") backoff = Math.min(8000, backoff * 2);
        else if (c === "audio-capture") {
          setProblem(MIC_HELP["no-device"]);
          backoff = 30000;
        }
      };
      rec.onend = () => {
        r = null;
        setActive(false);
        releaseMic("wake");
        if (pending) return fire(pending.rest);
        if (alive) schedule(backoff);
        backoff = Math.min(backoff, 5000);
      };
      r = rec;
      try {
        rec.start();
        setActive(true);
        setProblem("");
        backoff = 400;
      } catch {
        r = null;
        releaseMic("wake");
        schedule(3000);
      }
    }
    const onVis = () => (document.visibilityState === "visible" ? schedule(300) : stopRec());
    const offOwner = onMicOwner((id) => {
      if (id === null) schedule(600);
    });
    document.addEventListener("visibilitychange", onVis);
    schedule(500);
    return () => {
      alive = false;
      window.clearTimeout(restartT);
      window.clearTimeout(pendingT);
      document.removeEventListener("visibilitychange", onVis);
      offOwner();
      stopRec();
    };
  }, [on]);

  return { active, problem };
}

// ---- pieces ----------------------------------------------------------------------------------

export function OrbGlyph({ size = 18 }: { size?: number }) {
  return <span className="gd-orb rounded-full shrink-0 inline-block" style={{ width: size, height: size }} aria-hidden="true" />;
}

function WaveIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" aria-hidden="true">
      <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />
    </svg>
  );
}

/** "Talk to Euliv": `icon` (top bar), `round` (Home composer, next to the mic). */
export function TalkButton({ variant = "round", className = "" }: { variant?: "round" | "icon"; className?: string }) {
  if (!eulivAvailable()) return null;
  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={() => openEuliv()}
        aria-label="Talk to Euliv"
        title="Talk to Euliv"
        className={`ui-focus w-9 h-9 rounded-full grid place-items-center hover:bg-subtle/70 transition-colors ${className}`}
        data-euliv-open="topbar"
      >
        <OrbGlyph size={18} />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => openEuliv()}
      aria-label="Talk to Euliv"
      title="Talk to Euliv - a conversation, out loud"
      className={`ui-focus relative w-12 h-12 rounded-full grid place-items-center shrink-0 text-[rgb(var(--color-base))] gd-orb transition-transform hover:scale-[1.05] active:scale-[0.96] ${className}`}
      data-euliv-open="home"
    >
      <WaveIcon size={19} />
    </button>
  );
}

/** The read-back sentence after a tap (the same words the server would use). */
function restateLocal(plan: { restated: string; what?: string | null; needs_time?: boolean; mode?: string | null; options: { id: string; name: string }[]; needs_pick?: boolean }, selected: string[], period: CheckPeriod | null): string {
  if (plan.mode === "follow") {
    const names = plan.options.filter((o) => selected.includes(o.id)).map((o) => o.name);
    return `Your follow-up, answered from ${names.join(", ") || "the same data"}${period ? ` for ${period.text}` : ""}.`;
  }
  // the server's own pieces when it sent them (round 25b) - no guessing where the period starts in the sentence
  const base = plan.what
    ? plan.what.replace(/^./, (c) => c.toUpperCase())
    : plan.restated.split(/, (?:from|looking across|comparing)/)[0].replace(/ for [^,]+$/, "").replace(/\.$/, "");
  let s = base;
  if (period) s += periodWords(period);
  else if (plan.what && plan.needs_time) s += " over all the dates in the data";
  const names = plan.options.filter((o) => selected.includes(o.id)).map((o) => o.name);
  if (names.length) s += ", from " + (names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
  else if (!plan.needs_pick) s += ", looking across all your data";
  return s + ".";
}

type Msg = { id: number; who: "you" | "euliv"; text: string; card?: Card; working?: string };
type Phase = "idle" | "listening" | "thinking" | "working" | "speaking";

const PHASE_TEXT: Record<Phase, string> = {
  idle: "Tap to talk",
  listening: "Listening…",
  thinking: "Thinking…",
  working: "Working it out…",
  speaking: "Speaking - just talk to interrupt",
};

// ---- the conversation ---------------------------------------------------------------------------

export default function EulivProvider() {
  const { user } = useAuth();
  const loc = useLocation();
  const hiddenRoute = !user || HIDDEN_ON.some((p) => loc.pathname.startsWith(p));
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<EulivSettings>(loadSettings);
  const firstRef = useRef<string | undefined>(undefined);
  const talkRef = useRef<string | undefined>(undefined);
  const [openSeq, setOpenSeq] = useState(0);

  useEffect(() => onSettings(setSettings), []);
  useEffect(() => {
    const on = (e: Event) => {
      firstRef.current = (e as CustomEvent).detail?.first || undefined;
      talkRef.current = (e as CustomEvent).detail?.talkId || undefined;
      setOpen(true);
      setOpenSeq((n) => n + 1);
    };
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, []);
  useEffect(() => {
    if (hiddenRoute) setOpen(false);
  }, [hiddenRoute]);

  // 2026-10-12 (round 33): "Hi Euliv" listens on Home only. Its pill is the honest sign that the mic is
  // listening, so it can't simply be hidden elsewhere - the listening stops off Home too, and the
  // pill no longer sits over every page's bottom-left corner. Euliv itself still opens anywhere.
  const onHome = loc.pathname === "/" || loc.pathname === "/home";
  const wakeOn = !!settings.wake && onHome && !hiddenRoute && !open && !isTouchDevice() && speechInputSupported();
  const wake = useWakeWord(wakeOn, (rest) => openEuliv(rest || undefined));

  if (hiddenRoute) return null;
  return (
    <>
      {wake.active && !open && (
        <button
          type="button"
          onClick={() => openEuliv()}
          className="hidden sm:inline-flex fixed left-4 bottom-4 z-[60] items-center gap-2 h-8 pl-2 pr-3 rounded-full border border-border bg-surface/90 backdrop-blur text-[12px] text-secondary hover:text-text shadow-[0_10px_30px_-12px_rgb(0_0_0/0.6)]"
          title="Euliv is listening for its name in this tab. Turn this off in Euliv's settings."
          data-euliv-wake=""
        >
          <OrbGlyph size={14} /> Say “Hi Euliv”
        </button>
      )}
      {open && <EulivPanel key={openSeq} first={firstRef.current} talkId={talkRef.current} settings={settings} wakeProblem={wake.problem} onClose={() => setOpen(false)} />}
    </>
  );
}

function EulivPanel({ first, talkId, settings, wakeProblem, onClose }: { first?: string; talkId?: string; settings: EulivSettings; wakeProblem: string; onClose: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [level, setLevel] = useState(0);
  const [caption, setCaption] = useState("");
  const [typed, setTyped] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [topicLine, setTopicLine] = useState("");
  // round 24: this talk, saved in Library as it happens
  const [talk, setTalk] = useState<{ id: string; title: string } | null>(null);
  const [wide, setWide] = useState(false);
  const greeting = useRef("");
  const state = useRef<EulivState>({});
  const alive = useRef(true);
  const session = useRef(0);
  const control = useRef<{ finish?: () => void }>({});
  const proven = useRef(false); // the mic has heard this person in this conversation
  const typedLast = useRef(false); // R52: the person's last turn was typed or tapped, not spoken
  // round 28: talking over Euliv only when its voice can't reach the mic (headphones), or when turned on
  const [headset, setHeadset] = useState(false);
  const headsetRef = useRef(false);
  useEffect(() => {
    const check = () => void headphonesOn().then((v) => { headsetRef.current = v; setHeadset(v); });
    check();
    const md = navigator.mediaDevices;
    md?.addEventListener?.("devicechange", check);
    return () => md?.removeEventListener?.("devicechange", check);
  }, []);
  const talkOver = () => Boolean(settingsRef.current.talkOver || headsetRef.current);
  const unclear = useRef(0);
  const micTrouble = useRef(false); // the last listen hit a mic problem - don't re-listen by itself (typing still works)
  const idSeq = useRef(0);
  const handleRef = useRef<((t: string, alts?: string[]) => unknown) | null>(null);
  // round 27: what Euliv said lately - anything the mic hears that matches it is its own voice, not the person
  const spokenLog = useRef<{ text: string; ended: number | null }[]>([]);
  const echoes = useRef(0);
  const recentEuliv = (ms: number) =>
    spokenLog.current.filter((u) => u.ended === null || Date.now() - u.ended < ms).map((u) => u.text).reverse();
  const scroller = useRef<HTMLDivElement>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const canListen = speechInputSupported();

  const lastReply = useRef("");
  const push = useCallback((m: Omit<Msg, "id">) => {
    const id = ++idSeq.current;
    if (m.who === "euliv" && m.text) lastReply.current = m.text;
    // one connect card at a time: a newer one replaces the older
    const strip = m.card?.type === "connect";
    setMsgs((cur) => [
      ...cur.slice(-40).map((x) => {
        if (strip && x.card?.type === "connect") return { ...x, card: undefined };
        // a newer turn: the earlier read-back is settled - it stays, read-only
        if (m.who === "euliv" && x.card && (x.card.type === "plan" || x.card.type === "fix_date" || x.card.type === "rephrase" || x.card.type === "question") && x.card.live) return { ...x, card: { ...x.card, live: false } };
        return x;
      }),
      { ...m, id },
    ]);
    return id;
  }, []);
  const patch = useCallback((id: number, p: Partial<Msg>) => setMsgs((cur) => cur.map((m) => (m.id === id ? { ...m, ...p } : m))), []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [msgs, caption]);

  /** Euliv says something: on screen always, out loud when speaking is on.
   *  true = said; false = couldn't speak (the words are on screen); null =
   *  interrupted or closed - the caller stops, something newer has taken over. */
  const say = useCallback(async (text: string, spoken?: string, card?: Card): Promise<boolean | null> => {
    const s = session.current;
    push({ who: "euliv", text, card });
    if (!settingsRef.current.speak || !speechOutputSupported()) return true;
    setPhase("speaking");
    const words = spoken || text;
    const entry = { text: `${text} ${words}`, ended: null as number | null };
    spokenLog.current = [...spokenLog.current.slice(-5), entry];
    // round 26: the person can talk over Euliv - it stops and listens
    // round 28: on speakers Euliv does NOT listen while it talks - its own voice would come back as "you".
    // Interrupt with a tap / Space; with headphones (or "talk over Euliv" on) just talk.
    // round 31: speakers too - but only for a short interrupt ("wait", "Euliv", "no", "change it"), like "Hey Siri"
    const barge = settingsRef.current.handsFree && canListen && !micTrouble.current && !typedLast.current
      ? bargeListen({
          gate: talkOver() ? undefined : isInterrupt,
          // everything Euliv is saying now, and said in the last few seconds - its echo isn't the person
          echoOf: () => recentEuliv(4000),
          onStart: () => {
            if (s !== session.current) return;
            cancelSpeech();
            setPhase("listening");
          },
          onInterim: (t) => s === session.current && setCaption(t),
        })
      : null;
    const r = await speak(words);
    entry.ended = Date.now();
    if (barge) {
      if (barge.hearing()) {
        const heardText = await barge.heard;
        setCaption("");
        if (s !== session.current || !alive.current) return null;
        if (heardText) {
          proven.current = true;
          void handleRef.current?.(heardText);
          return null; // what they said is the next step
        }
        return true; // a cough, not words: carry on as if Euliv had finished
      }
      barge.stop();
    }
    if (s !== session.current || !alive.current || r === "cancelled") return null;
    return true; // "failed" (no voice available) still carries on - the words are on screen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push]);

  const listen = useCallback(async (): Promise<void> => {
    const s = session.current;
    if (!canListen) {
      setPhase("idle");
      return;
    }
    setPhase("listening");
    setCaption("");
    typedLast.current = false;
    const heard = await listenOnce({
      onInterim: (t) => s === session.current && setCaption(t),
      onLevel: (l) => s === session.current && setLevel(l),
      control,
      silentMs: proven.current ? 9000 : 6000,
      unclearMs: 9000,
    });
    if (s !== session.current || !alive.current) return;
    setCaption("");
    // round 27: Euliv's own voice caught by the mic (speakers, no headset) is never taken as the person.
    // Long echoes are checked against the last 15 s of what it said; short ones only right after it spoke.
    if (heard.text && (heardEuliv(heard.text, recentEuliv(2500)) || heardEuliv(heard.text, recentEuliv(15000)) && heard.text.split(/\s+/).length >= 5)) {
      if (echoes.current++ < 2) return listen(); // keep listening for the person
      echoes.current = 0;
      setPhase("idle");
      return;
    }
    echoes.current = 0;
    if (heard.text) {
      proven.current = true;
      typedLast.current = false;
      micTrouble.current = false;
      unclear.current = 0;
      return handle(heard.text, heard.alts);
    }
    if (heard.reason === "stopped") {
      setPhase("idle");
      return;
    }
    // round 25: Euliv only asks again when it is waiting on an answer from the person;
    // after an answer, silence or background noise (or its own voice's echo) just goes quiet
    const waitingOnPerson = ["plan", "fix_date", "connect", "rephrase", "question"].includes(state.current.awaiting || "");
    if (heard.reason === "silent" && proven.current) {
      setPhase("idle"); // they've finished - no need to nag
      return;
    }
    if (heard.reason === "unclear" && proven.current && !waitingOnPerson) {
      setPhase("idle");
      return;
    }
    if (heard.reason === "unclear") {
      if (unclear.current++ < 1) {
        const ok = await say("Sorry, I didn't catch that. Could you say it again?");
        if (ok === null) return;
        return listen();
      }
      unclear.current = 0;
      if ((await say("I'm having trouble understanding. Try again a little closer to your microphone - or type below.")) === null) return;
      setPhase("idle");
      return;
    }
    // can't hear you: say exactly why
    micTrouble.current = true;
    const label = deviceText(heard.label);
    const text =
      heard.reason === "silent"
        ? `I can't hear you. Please check your microphone is connected and not muted${label}.`
        : heard.reason === "network"
        ? "I can't reach the speech service - check your internet connection. You can type below meanwhile."
        : heard.reason === "unsupported"
        ? "This browser can't listen. Try Chrome, Edge or Safari - or type below."
        : MIC_HELP[heard.reason as MicProblem] || MIC_HELP.failed;
    if ((await say(text, undefined, { type: "mic", reason: heard.reason, label: heard.label })) === null) return;
    setPhase("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canListen, say]);

  const afterReply = useCallback(async (spokeOk: boolean | null) => {
    if (!alive.current || spokeOk === null) return;
    if (spokeOk && settingsRef.current.handsFree && canListen && !micTrouble.current && !typedLast.current) {
      // a breath after speaking, so the tail of Euliv's own voice isn't heard as the person
      // (round 27: and never while the computer's voice is still playing)
      const s = session.current;
      for (let i = 0; i < 30 && isSpeaking(); i++) await new Promise((r) => window.setTimeout(r, 100));
      await new Promise((r) => window.setTimeout(r, settingsRef.current.speak ? 600 : 0));
      if (s !== session.current || !alive.current) return;
      return listen();
    }
    setPhase("idle");
  }, [canListen, listen]);

  /** Waits for an answer. It keeps going if the person talks meanwhile; the
   *  answer is then added quietly instead of spoken over them. */
  const pollAnswer = useCallback(async (runId: string, msgId: number, intro?: Promise<unknown>) => {
    const s = session.current;
    const t0 = Date.now();
    let lastStage = "";
    let failures = 0;
    const deliver = async (text: string, spoken: string | undefined, card?: Card) => {
      if (intro) await intro; // let "Okay, looking at …" finish first
      setMsgs((cur) => cur.filter((m) => m.id !== msgId)); // the "working" line makes way for the answer
      if (s !== session.current) {
        push({ who: "euliv", text, card }); // they've moved on - show it, don't talk over them
        return;
      }
      const ok = await say(text, spoken, card);
      if (card?.type === "answer" && card.data.status === "done") return afterReply(ok);
      if (ok !== null) setPhase("idle");
    };
    while (alive.current && Date.now() - t0 < 5 * 60000) {
      await new Promise((r) => window.setTimeout(r, 1200));
      if (!alive.current) return;
      let a: EulivAnswer;
      try {
        a = await assistantApi.answer(runId, state.current.talk_id);
        failures = 0;
      } catch (e) {
        if (++failures >= 4) return deliver(errText(e), undefined);
        continue;
      }
      if (a.status === "working") {
        if (a.stage && a.stage !== lastStage) {
          lastStage = a.stage;
          patch(msgId, { working: a.stage });
        }
        continue;
      }
      if (a.status === "needs_input") {
        // "these sources can't answer that": say why, then offer other data
        setMsgs((cur) => cur.filter((m) => m.id !== msgId));
        if (intro) await intro;
        if (s !== session.current) return;
        return turnWith("", "needs_input", runId);
      }
      return deliver(a.say || (a.status === "done" ? "Here's what I found." : "That didn't finish."), a.speak, { type: "answer", data: a, runId });
    }
    if (alive.current) await deliver("This one is taking longer than usual. It keeps running - open it from your Library when it's ready.", undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patch, push, say, afterReply]);

  const watching = useRef(false);
  // round 25b: the app being waited on - a second offer ("connect Shopify" after Google Ads) retargets the running watch
  const watchTarget = useRef<{ c: EulivConnect; since: string } | null>(null);
  /** Waits (up to 15 min) for the source Euliv offered to be connected - in
   *  the other tab - then carries on with the question that needed it. */
  const watchConnect = useCallback(async (c: EulivConnect) => {
    // a minute of slack for clock differences between this computer and the server
    const prev = watchTarget.current;
    watchTarget.current = { c, since: prev && prev.c.kind === c.kind ? prev.since : new Date(Date.now() - 60000).toISOString() };
    if (watching.current) return;
    watching.current = true;
    const t0 = Date.now();
    let focusHit = false;
    const onFocus = () => (focusHit = true);
    window.addEventListener("focus", onFocus);
    try {
      while (alive.current && Date.now() - t0 < 15 * 60000) {
        await new Promise((r) => window.setTimeout(r, focusHit ? 400 : 3000));
        focusHit = false;
        if (!alive.current || state.current.awaiting !== "connecting") return;
        try {
          const tgt = watchTarget.current || { c, since: new Date(t0 - 60000).toISOString() };
          const st = await assistantApi.connected(tgt.c.kind, workspaceId(), tgt.since);
          if (st.connected) {
            setMsgs((cur) => cur.map((m) => (m.card?.type === "connect" ? { ...m, card: { ...m.card, done: true } } : m)));
            interrupt();
            return turnWith("", "connected");
          }
        } catch {
          /* try again */
        }
      }
    } finally {
      watching.current = false;
      watchTarget.current = null;
      window.removeEventListener("focus", onFocus);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The connect button was tapped (it opens the tab itself): wait for the source, then carry on. */
  const connectTapped = (c: EulivConnect) => {
    interrupt();
    setPhase("idle");
    if (state.current.awaiting !== "connecting" || state.current.connect?.kind !== c.kind) {
      state.current = { ...state.current, awaiting: "connecting", connect: c };
      void watchConnect(c);
    }
  };

  const react = useCallback(async (out: EulivTurn) => {
    state.current = out.state || {};
    if (out.talk_id) {
      state.current.talk_id = out.talk_id;
      setTalk({ id: out.talk_id, title: out.talk_title || "Talk with Euliv" });
    }
    if (out.plan) setTopicLine(out.plan.restated.replace(/\.$/, ""));
    switch (out.action) {
      case "plan": {
        const ok = await say(out.say, out.speak, out.plan ? { type: "plan", plan: out.plan, live: true } : undefined);
        return afterReply(ok);
      }
      case "fix_date": {
        const ok = await say(out.say, out.speak, out.issue ? { type: "fix_date", issue: out.issue, live: true } : undefined);
        return afterReply(ok);
      }
      case "question": {
        // round 29: the question first, tidied - "Your question: “…” Is that right?"
        // round 31: the card shows the question - the line above it doesn't repeat it; the voice still says it all
        const ok = await say(out.show || out.say, out.speak, { type: "question", question: out.question || "", said: out.said || "", notes: out.notes || [], live: true });
        return afterReply(ok);
      }
      case "rephrase": {
        const ok = await say(out.say, out.speak, { type: "rephrase", question: (out as any).question || out.state?.pending_question || "", live: true });
        return afterReply(ok);
      }
      case "run": {
        if (out.sources?.length) setTopicLine(out.sources.map((x) => x.name).join(" · "));
        // "Okay, looking at Google Ads" is said while the work starts - no waiting for it
        const s = session.current;
        const intro = say(out.say, out.speak);
        const id = push({ who: "euliv", text: "", working: "Working out which data to use" });
        void intro.then((r) => r !== null && s === session.current && setPhase("working"));
        if (!settingsRef.current.speak || !speechOutputSupported()) setPhase("working");
        return pollAnswer(out.run_id!, id, intro);
      }
      case "connect_offer": {
        const ok = await say(out.say, out.speak, out.connect ? { type: "connect", connect: out.connect, opened: false } : undefined);
        return afterReply(ok);
      }
      case "connect": {
        const c = out.connect!;
        // browsers only open a tab from a tap - after a spoken "yes" it would be
        // blocked, so Euliv asks for one tap on the button and waits
        void watchConnect(c);
        const ok = await say(
          `Tap “Connect ${c.label}” to open it in a new tab. Connect it there and come back - I'll carry on by myself.`,
          undefined,
          { type: "connect", connect: c, opened: false },
        );
        if (ok !== null) setPhase("idle");
        return;
      }
      case "explain": {
        const ok = await say(out.say, out.speak, out.explain ? { type: "explain", data: out.explain } : undefined);
        return afterReply(ok);
      }
      case "ignore": {
        // round 27: the server recognised Euliv's own words coming back - drop them, keep listening
        setMsgs((cur) => {
          const k = [...cur].reverse().findIndex((m) => m.who === "you");
          return k < 0 ? cur : cur.filter((_, idx) => idx !== cur.length - 1 - k);
        });
        return afterReply(true);
      }
      case "end": {
        if ((await say(out.say, out.speak)) === null) return;
        if (alive.current) onClose();
        return;
      }
      default: {
        const ok = await say(out.say, out.speak);
        return afterReply(ok);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [say, push, pollAnswer, afterReply, watchConnect, onClose]);

  const turnWith = useCallback(async (text: string, event?: string, runId?: string, alts?: string[], youId?: number) => {
    setPhase("thinking");
    let out: EulivTurn;
    const s = session.current;
    try {
      out = await assistantApi.turn({
        text, state: state.current, workspace_id: workspaceId(), event, run_id: runId,
        save: settingsRef.current.keep !== false, greeting: greeting.current || undefined,
        // round 28: what Euliv just said - the server drops a "you" that is only Euliv's own voice coming back
        // newest first - keep the start, so the line just said is never the part cut off
        last_said: recentEuliv(20000).join(" | ").slice(0, 3000) || undefined,
        // round 30: Euliv's last line on screen - the same fallback is never said twice in a row
        last_reply: lastReply.current.slice(0, 500) || undefined,
        alts: alts?.length ? alts : undefined,
      });
    } catch (e) {
      if (s !== session.current) return;
      if ((await say(errText(e))) === null) return;
      setPhase("idle");
      return;
    }
    if (s !== session.current || !alive.current) return;
    // round 30: the server picked a better reading of what was said ("thank you", not "think you")
    if (youId && out.heard && out.heard !== text) patch(youId, { text: out.heard });
    return react(out);
  }, [say, afterReply, react, patch]);

  const handle = useCallback(async (text: string, alts?: string[]) => {
    const id = push({ who: "you", text });
    return turnWith(text, undefined, undefined, alts, id);
  }, [push, turnWith]);
  handleRef.current = handle;

  /** Stop whatever is happening (speech, listening, a wait) - a new step follows. */
  const interrupt = useCallback(() => {
    session.current++;
    cancelSpeech();
    control.current.finish?.();
  }, []);

  // start: the greeting, or straight to the question said with the name
  useEffect(() => {
    alive.current = true;
    void loadVoices();
    (async () => {
      if (talkId) {
        // carrying on a saved talk: its turns, its state, then "Welcome back"
        try {
          const t = await assistantApi.talk(talkId);
          if (!alive.current) return;
          state.current = { ...(t.state || {}), talk_id: t.id, awaiting: null, brief: null };
          setTalk({ id: t.id, title: t.title });
          for (const m of t.messages.slice(-30)) {
            const card = cardFromSaved(m.card);
            if (m.card?.type === "working") continue;
            push({ who: m.role === "user" ? "you" : "euliv", text: m.text, card });
          }
        } catch {
          /* start fresh */
        }
      }
      if (first) return handle(first);
      let hello = "Hi, how can I help you?";
      try {
        hello = (await assistantApi.hello(talkId)).say;
      } catch {
        /* the greeting still works offline */
      }
      if (!alive.current) return;
      if (!talkId) greeting.current = hello;
      const ok = await say(hello);
      afterReply(ok);
    })();
    return () => {
      alive.current = false;
      session.current++;
      cancelSpeech();
      control.current.finish?.();
      releaseMic("euliv");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tapOrb = useCallback(() => {
    if (phase === "listening") {
      control.current.finish?.(); // done talking - use what was heard
      return;
    }
    if (phase === "thinking" || phase === "working") return;
    interrupt();
    unclear.current = 0;
    micTrouble.current = false;
    void listen();
  }, [phase, interrupt, listen]);

  // keys: Esc closes, Space talks / interrupts (outside the text box)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (showSettings) setShowSettings(false);
        else onClose();
        return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === " " && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT" && tag !== "BUTTON") {
        e.preventDefault();
        tapOrb();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tapOrb, onClose, showSettings]);

  const sendTyped = (text: string) => {
    const t = text.trim();
    if (!t || phase === "thinking") return;
    typedLast.current = true; // R52: a typed talk stays typed - Euliv doesn't open the microphone after it answers
    interrupt();
    setTyped("");
    void handle(t);
  };

  const pick = (text: string) => {
    if (phase === "thinking") return;
    typedLast.current = true;
    interrupt();
    void handle(text);
  };

  /** A tap on a data row: the live read-back changes in place (no round trip). */
  const toggleSource = (id: string) => {
    const b = state.current.brief;
    if (!b) return;
    const cur = b.selected || [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    state.current = { ...state.current, brief: { ...b, selected: next, chosen: true, mode: null } };
    setMsgs((all) => all.map((m) => (m.card?.type === "plan" && m.card.live ? { ...m, card: { ...m.card, plan: { ...m.card.plan, selected: next, mode: null, restated: restateLocal(m.card.plan, next, m.card.plan.period) } } } : m)));
    if (phase === "listening" || phase === "speaking") {
      interrupt();
      setPhase("idle");
    }
  };
  const choosePeriod = (p: CheckPeriod) => {
    const b = state.current.brief;
    if (!b) return;
    state.current = { ...state.current, brief: { ...b, period: p } };
    setMsgs((all) => all.map((m) => (m.card?.type === "plan" && m.card.live ? { ...m, card: { ...m.card, plan: { ...m.card.plan, period: p, restated: restateLocal(m.card.plan, m.card.plan.selected, p) } } } : m)));
  };
  /** The question edited in the read-back: checked again from the start - nothing runs yet. */
  const rephrase = (text: string) => {
    if (phase === "thinking") return;
    interrupt();
    push({ who: "you", text });
    void turnWith(text, "rephrase");
  };
  const goAhead = () => {
    if (phase === "thinking") return;
    interrupt();
    void turnWith("", "confirm");
  };

  const orbScale = phase === "listening" ? 1 + Math.min(0.28, level * 0.9) : 1;
  const status = phase === "listening" && caption ? "" : phase === "speaking" && !(settings.handsFree && canListen && (settings.talkOver || headset)) ? (settings.handsFree && canListen ? "Speaking - say “wait” or tap to interrupt" : "Speaking - tap to interrupt") : PHASE_TEXT[phase];

  return (
    <div className="fixed inset-0 z-[90] flex items-stretch sm:items-center justify-center bg-[rgb(var(--color-base)/0.78)] backdrop-blur-md" role="dialog" aria-modal="true" aria-label="Euliv" data-euliv="" data-phase={phase}>
      <div className={`gd-euliv-in relative w-full ${wide ? "sm:w-[min(1080px,calc(100vw-48px))]" : "sm:w-[min(780px,calc(100vw-48px))]"} h-full sm:h-[min(860px,calc(100vh-48px))] transition-[width] duration-300 sm:rounded-[28px] sm:border border-border bg-surface flex flex-col overflow-hidden shadow-[0_40px_120px_-40px_rgb(0_0_0/0.9)]`}>
        <header className="flex items-center gap-3 px-4 sm:px-6 h-16 border-b border-border shrink-0">
          <OrbGlyph size={28} />
          <div className="flex-1 min-w-0 flex flex-col">
            <b className="text-[15px] text-text leading-tight">Euliv</b>
            <span className="text-[12px] text-muted truncate" data-euliv-topic="">{topicLine || "Your data, out loud"}</span>
          </div>
          {talk && (
            <Link to={`/v/${talk.id}`} onClick={onClose} title="This talk is saved in Library - open it"
              className="ui-focus hidden sm:inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-kind-answer-fill text-kind-answer text-[12px] font-medium max-w-[240px]" data-euliv-saved="">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0"><path d="M5 12l5 5L20 7" /></svg>
              <span className="truncate">Saved · {talk.title}</span>
            </Link>
          )}
          <button type="button" onClick={() => { if (!showSettings) { interrupt(); setPhase("idle"); } setShowSettings((v) => !v); }} aria-label="Euliv settings" aria-expanded={showSettings} className="ui-focus w-10 h-10 rounded-full grid place-items-center text-secondary hover:text-text hover:bg-subtle/70" data-euliv-settings-open="">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>
          </button>
          <button type="button" onClick={onClose} aria-label="Close Euliv (Esc)" className="ui-focus w-10 h-10 rounded-full grid place-items-center text-secondary hover:text-text hover:bg-subtle/70" data-euliv-close="">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </header>

        {showSettings ? (
          <EulivSettingsPanel settings={settings} wakeProblem={wakeProblem} onDone={() => setShowSettings(false)} />
        ) : (
          <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-8 py-6 flex flex-col gap-5" aria-live="polite" data-euliv-log="">
            <WakeOffer settings={settings} />
            {msgs.map((m) =>
              m.who === "you" ? (
                <div key={m.id} className="self-end max-w-[85%] rounded-[18px] rounded-br-[6px] bg-subtle px-4 py-2.5 text-[15px] leading-snug text-text" data-euliv-you="">
                  {m.text}
                </div>
              ) : (
                <div key={m.id} className="flex flex-col gap-3 max-w-full" data-euliv-says="">
                  {m.text && <p className="m-0 text-[18px] sm:text-[20px] leading-[1.45] font-medium text-text text-pretty">{m.text}</p>}
                  {m.working && (
                    <span className="inline-flex items-center gap-2.5 text-ui text-secondary" data-euliv-working="">
                      <span className="w-4 h-4 rounded-full gd-orb-ring" aria-hidden="true" /> {m.working}…
                    </span>
                  )}
                  {m.card && <EulivCardView card={m.card} h={{ onPick: pick, onConnect: connectTapped, onClose, onToggle: toggleSource, onGo: goAhead, onPeriod: choosePeriod, onRephrase: rephrase, onExpand: (o) => o && setWide(true) }} />}
                </div>
              ),
            )}
            {caption && (
              <div className="self-end max-w-[85%] rounded-[18px] rounded-br-[6px] border border-dashed border-border-strong px-4 py-2.5 text-[15px] leading-snug text-secondary" data-euliv-caption="">
                {caption}
              </div>
            )}
          </div>
        )}

        <footer className="shrink-0 border-t border-border px-4 sm:px-8 pt-5 pb-[max(16px,env(safe-area-inset-bottom))] flex flex-col items-center gap-3">
          <div className="relative w-[88px] h-[88px] grid place-items-center">
            {phase === "listening" && <span className="absolute inset-[-18px] rounded-full gd-orb-glow transition-transform duration-100" style={{ transform: `scale(${0.9 + level * 1.4})` }} aria-hidden="true" />}
            {(phase === "thinking" || phase === "working") && <span className="absolute inset-[-6px] rounded-full gd-orb-ring" aria-hidden="true" />}
            <button
              type="button"
              onClick={tapOrb}
              disabled={!canListen && phase === "idle"}
              aria-label={phase === "listening" ? "Done talking" : phase === "speaking" ? "Interrupt and talk" : "Talk to Euliv"}
              className={`ui-focus relative w-[76px] h-[76px] rounded-full gd-orb grid place-items-center text-[rgb(var(--color-base))] transition-transform duration-100 disabled:opacity-50 ${
                phase === "speaking" ? "gd-orb-speaking" : phase === "thinking" || phase === "working" ? "gd-orb-thinking" : phase === "idle" ? "gd-orb-idle" : ""
              }`}
              style={phase === "listening" ? { transform: `scale(${orbScale})` } : undefined}
              data-euliv-orb=""
            >
              {phase === "listening" ? <LevelBars level={level} live className="bg-[rgb(var(--color-base))]" /> : phase === "idle" ? <MicGlyph /> : null}
            </button>
          </div>
          <span className="text-[13px] text-secondary min-h-[18px]" data-euliv-status="">{status}</span>
          <form
            className="w-full max-w-[560px] flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              sendTyped(typed);
            }}
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onFocus={() => phase === "listening" && interrupt()}
              placeholder={canListen ? "Or type to Euliv…" : "Type to Euliv…"}
              aria-label="Type to Euliv"
              className="flex-1 min-w-0 h-11 rounded-full border border-border bg-base/60 px-4 text-[15px] text-text placeholder:text-faint outline-none focus:border-kind-answer-border"
              data-euliv-input=""
            />
            <button type="submit" disabled={!typed.trim()} className="ui-focus h-11 px-4 rounded-full bg-primary text-on-primary text-ui font-medium disabled:opacity-35">
              Send
            </button>
          </form>
          <span className="text-[11px] text-faint text-center leading-snug max-w-[520px]">
            Euliv answers from the sources you can open. GD360 never records audio - your browser turns speech into words.
          </span>
        </footer>
      </div>
    </div>
  );
}

/** Once per browser: "Start me by voice - turn on Hi Euliv". The wake word is off until
 *  the person says yes (it keeps the microphone open while GD360 is in front). */
function WakeOffer({ settings }: { settings: EulivSettings }) {
  const [done, setDone] = useState<"" | "on" | "later">("");
  const able = speechInputSupported() && !isTouchDevice();
  if (!able || settings.wakeAsked || (settings.wake && !done)) return null;
  if (done === "on") {
    return (
      <div className="order-last rounded-[16px] border border-kind-answer-border bg-kind-answer-fill/60 px-4 py-3 text-[13px] text-secondary" data-euliv-wake-on="">
        <b className="text-text">“Hi Euliv” is on.</b> Close this and just say it on the Home page.
      </div>
    );
  }
  if (done) return null;
  return (
    <div className="order-last rounded-[16px] border border-border bg-base/40 px-4 py-3 flex flex-wrap items-center gap-3" data-euliv-wake-offer="">
      <span className="flex-1 min-w-[220px] text-[13px] leading-snug text-secondary">
        <b className="text-text">Start me by voice?</b> Turn on “Hi Euliv” and I'll listen for my name on the Home page. Nothing is sent until you say it.
      </span>
      <button type="button" onClick={() => { saveSettings({ wake: true, wakeAsked: true }); setDone("on"); }}
        className="ui-focus h-9 px-4 rounded-full bg-primary text-on-primary text-[13px] font-semibold" data-euliv-wake-yes="">Turn on</button>
      <button type="button" onClick={() => { saveSettings({ wakeAsked: true }); setDone("later"); }}
        className="ui-focus h-9 px-3 rounded-full text-[13px] text-secondary hover:text-text">Not now</button>
    </div>
  );
}

function MicGlyph() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

// ---- settings -------------------------------------------------------------------------------------

function Toggle({ on, onChange, label, help, disabled, id }: { on: boolean; onChange: (v: boolean) => void; label: string; help: string; disabled?: boolean; id: string }) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? "opacity-50" : "cursor-pointer"}`} htmlFor={id}>
      <input id={id} type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-1 w-[18px] h-[18px] accent-[rgb(var(--color-kind-answer))] shrink-0" />
      <span className="flex flex-col gap-0.5">
        <b className="text-[14px] text-text font-semibold">{label}</b>
        <span className="text-[12.5px] text-secondary leading-snug">{help}</span>
      </span>
    </label>
  );
}

function EulivSettingsPanel({ settings, wakeProblem, onDone }: { settings: EulivSettings; wakeProblem: string; onDone: () => void }) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [memory, setMemory] = useState<EulivMemory[] | null>(null);
  const [test, setTest] = useState<{ level: number; peak: number; label: string; problem: string; running: boolean } | null>(null);
  const monRef = useRef<MicMonitor | null>(null);
  const touch = isTouchDevice();

  useEffect(() => {
    void loadVoices().then((v) => setVoices(v));
    assistantApi.memory().then(setMemory).catch(() => setMemory([]));
    return () => monRef.current?.stop();
  }, []);

  const lang = voiceLang().toLowerCase().split("-")[0];
  const shown = voices.filter((v) => v.lang.toLowerCase().startsWith(lang)).slice(0, 40);

  const runTest = async () => {
    monRef.current?.stop();
    const m = new MicMonitor();
    monRef.current = m;
    setTest({ level: 0, peak: 0, label: "", problem: "", running: true });
    const problem = await m.start();
    if (problem && problem !== "muted") {
      setTest({ level: 0, peak: 0, label: m.label, problem: MIC_HELP[problem], running: false });
      m.stop();
      return;
    }
    const t0 = Date.now();
    const tick = window.setInterval(() => {
      if (monRef.current !== m) return window.clearInterval(tick);
      const l = m.level();
      setTest({ level: l, peak: m.loudest, label: m.label, problem: problem === "muted" ? MIC_HELP.muted : "", running: true });
      if (Date.now() - t0 > 6000) {
        window.clearInterval(tick);
        setTest({ level: 0, peak: m.loudest, label: m.label, problem: m.loudest < SOUND_LEVEL ? (problem === "muted" ? MIC_HELP.muted : "Silence - nothing reached the microphone. Check it's connected, not muted, and the right one is chosen.") : "", running: false });
        m.stop();
      }
    }, 80);
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-8 py-6 flex flex-col gap-5" data-euliv-settings="">
      <Toggle
        id="euliv-wake"
        on={settings.wake && !touch}
        disabled={touch || !speechInputSupported()}
        onChange={(v) => saveSettings({ wake: v })}
        label="Listen for “Hi Euliv”"
        help={
          touch
            ? "On phones and tablets Euliv listens only while you tap the orb."
            : "Say “Hi Euliv” or just “Euliv” on the Home page while its tab is in front. A small pill shows while it's listening; nothing is sent until you say the name."
        }
      />
      {wakeProblem && <span className="text-[12.5px] text-warning -mt-3 pl-8">{wakeProblem}</span>}
      <Toggle id="euliv-speak" on={settings.speak} disabled={!speechOutputSupported()} onChange={(v) => saveSettings({ speak: v })} label="Speak answers out loud" help="Off: Euliv writes its answers only." />
      <Toggle id="euliv-hands" on={settings.handsFree} onChange={(v) => saveSettings({ handsFree: v })} label="Keep the conversation going" help="After each answer Euliv listens for your next question - no tap needed." />
      <Toggle id="euliv-talkover" on={!!settings.talkOver} onChange={(v) => saveSettings({ talkOver: v })} label="Talk over Euliv"
        help="Interrupt just by talking while Euliv speaks. Best with headphones - on speakers Euliv could hear its own voice. With headphones this is on by itself." />
      <Toggle id="euliv-keep" on={settings.keep !== false} onChange={(v) => saveSettings({ keep: v })} label="Keep a written record" help="Each talk is saved in Library under “Talks”, so you can read it again or carry on. Words only - never audio." />

      <label className="flex flex-col gap-1.5 text-[12.5px] text-secondary" data-euliv-accent="">
        Your English
        <select value={settings.lang || ""} onChange={(e) => saveSettings({ lang: e.target.value || null })} className="h-10 rounded-[10px] border border-border-strong bg-base px-2.5 text-[14px] text-text">
          <option value="">Automatic - {ENGLISHES.find(([c]) => c.toLowerCase() === autoEnglish().toLowerCase())?.[1] || autoEnglish()}</option>
          {ENGLISHES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
        </select>
        <span className="text-[12px] text-muted">Euliv listens for this accent. Pick yours if it mishears you.</span>
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5 text-[12.5px] text-secondary">
          Voice
          <select value={settings.voice || ""} onChange={(e) => saveSettings({ voice: e.target.value || null })} className="h-10 rounded-[10px] border border-border-strong bg-base px-2.5 text-[14px] text-text">
            <option value="">Automatic (most natural)</option>
            {shown.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-[12.5px] text-secondary">
          Speed
          <select value={String(settings.rate)} onChange={(e) => saveSettings({ rate: Number(e.target.value) })} className="h-10 rounded-[10px] border border-border-strong bg-base px-2.5 text-[14px] text-text">
            {[0.9, 1, 1.1, 1.25].map((r) => <option key={r} value={r}>{r === 1 ? "Normal" : `${r}×`}</option>)}
          </select>
        </label>
      </div>
      <button type="button" onClick={() => speak("Hi, I'm Euliv. This is how I sound.")} className="self-start ui-focus h-9 px-3 rounded-full border border-border text-[13px] text-secondary hover:text-text">
        Hear this voice
      </button>

      <div className="flex flex-col gap-2 rounded-[16px] border border-border p-4" data-euliv-mictest="">
        <div className="flex items-center gap-3">
          <b className="text-[14px] text-text flex-1">Test microphone</b>
          <button type="button" onClick={runTest} disabled={test?.running} className="ui-focus h-9 px-3 rounded-full bg-subtle text-[13px] text-text disabled:opacity-50">
            {test?.running ? "Say something…" : test ? "Test again" : "Start test"}
          </button>
        </div>
        {test && (
          <>
            <div className="h-2 rounded-full bg-subtle overflow-hidden" aria-hidden="true">
              <div className="h-full bg-kind-answer transition-[width] duration-75" style={{ width: `${Math.round(Math.min(1, (test.running ? test.level : test.peak) * 2.2) * 100)}%` }} />
            </div>
            {test.label && <span className="text-[12px] text-muted">Listening to: {test.label}</span>}
            {test.problem ? (
              <span className="text-[12.5px] text-warning">{test.problem}</span>
            ) : !test.running && test.peak >= SOUND_LEVEL ? (
              <span className="text-[12.5px] text-good">Your microphone works - Euliv can hear you.</span>
            ) : null}
          </>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <b className="text-[14px] text-text">What your words mean</b>
        <span className="text-[12.5px] text-secondary">Euliv remembers the sources you pick for a topic, so it doesn't ask again.</span>
        {memory === null ? null : memory.length === 0 ? (
          <span className="text-[12.5px] text-muted">Nothing yet.</span>
        ) : (
          memory.map((m) => (
            <div key={m.topic} className="flex items-center gap-3 rounded-[12px] border border-border px-3 py-2.5 text-[13px]">
              <span className="flex-1 min-w-0 truncate text-text">“{m.label}” → {m.sources.map((s) => s.name).join(", ")}</span>
              <button type="button" onClick={() => assistantApi.forget(m.topic).then(() => setMemory((cur) => (cur || []).filter((x) => x.topic !== m.topic)))} className="ui-focus h-8 px-2.5 rounded-[8px] border border-border text-[12px] text-secondary hover:text-text">
                Forget
              </button>
            </div>
          ))
        )}
      </div>

      <div className="rounded-[14px] border border-kind-answer-border bg-kind-answer-fill/60 p-3.5 text-[12.5px] leading-snug text-secondary">
        <b className="text-text">Privacy.</b> GD360 never records or stores audio. Your browser's speech service turns speech into words; only the words reach GD360, and Euliv only sees the sources you can already open.
      </div>
      <button type="button" onClick={onDone} className="self-start ui-focus h-10 px-4 rounded-full bg-primary text-on-primary text-ui font-medium">Done</button>
    </div>
  );
}

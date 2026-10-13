// Round 42: the staff phone app - /staff/:token?k=
// Door check-in by QR (camera) or search, walk-ins in seconds (with a
// business-card photo), session doors, queue and room counts. A sponsor's
// link opens the same app in lead-scan mode. No signal? Everything is
// queued on the phone with a client id and sent when it's back - a retry
// never counts anyone twice.
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import jsQR from "jsqr";
import { errText, publicEvent } from "../api/eventos";

type Info = {
  title: string; format: string; location: string | null; start_local: string | null; mode: "staff" | "sponsor";
  counts: { checked_in: number; registered: number; walk_ins: number };
  sponsor: { id: string; name: string; booth: string | null; leads: number; goal: number | null } | null;
  gates: string[]; zones: { id: string; name: string }[]; sessions: { id: string; title: string; room: string | null; starts_at: string | null }[];
  interests: string[]; vision: boolean; sample: boolean;
};
type Person = { id: string; code: string; name: string | null; company: string | null; title: string | null; tier: string; icp: boolean | null;
  status: string; walk_in: boolean; checked_in_at: string | null; meeting: string | null; vip: boolean; repeat: boolean };
type Flash = { tone: "good" | "warn" | "bad" | "info"; title: string; sub?: string; person?: Person | null };
type Tab = "door" | "walkin" | "rooms" | "count" | "leads";

const uid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
const store = {
  get: (k: string, d = "") => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const offline = (e: any) => !e?.response;
const buzz = (ms: number | number[]) => { try { navigator.vibrate?.(ms); } catch { /* none */ } };

// ------------------------------------------------------------ the camera --
function Scanner({ onCode, paused }: { onCode: (text: string) => void; paused: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ t: string; at: number }>({ t: "", at: 0 });
  const [state, setState] = useState<"starting" | "on" | "denied" | "none">("starting");
  const cb = useRef(onCode);
  cb.current = onCode;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stop = false;
    const Detector = (window as any).BarcodeDetector;
    let detector: any = null;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setState("none"); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch { setState("denied"); return; }
      if (stop) { stream.getTracks().forEach((t) => t.stop()); return; }
      const v = video.current!;
      v.srcObject = stream;
      v.setAttribute("playsinline", "true");
      await v.play().catch(() => undefined);
      setState("on");
      try { if (Detector) detector = new Detector({ formats: ["qr_code"] }); } catch { detector = null; }
      const tick = async () => {
        if (stop) return;
        if (!pausedRef.current && v.readyState >= 2) {
          let text: string | null = null;
          try {
            if (detector) {
              const r = await detector.detect(v);
              text = r?.[0]?.rawValue || null;
            } else {
              const c = canvas.current!;
              const w = 640;
              const h = Math.round((v.videoHeight / Math.max(v.videoWidth, 1)) * w) || 360;
              c.width = w; c.height = h;
              const g = c.getContext("2d", { willReadFrequently: true })!;
              g.drawImage(v, 0, 0, w, h);
              const img = g.getImageData(0, 0, w, h);
              text = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" })?.data || null;
            }
          } catch { /* a bad frame */ }
          if (text) {
            const now = Date.now();
            if (text !== last.current.t || now - last.current.at > 3500) {
              last.current = { t: text, at: now };
              cb.current(text);
            }
          }
        }
        timer = window.setTimeout(tick, detector ? 120 : 180);
      };
      tick();
    })();
    return () => { stop = true; window.clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);
  return (
    <div className="relative w-full aspect-[4/3] max-h-[46vh] rounded-[18px] overflow-hidden bg-black" data-scanner={state}>
      <video ref={video} className="absolute inset-0 w-full h-full object-cover" muted playsInline />
      <canvas ref={canvas} className="hidden" />
      {state === "on" && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          <div className="w-[58%] aspect-square relative">
            {["top-0 left-0 border-t-4 border-l-4 rounded-tl-[14px]", "top-0 right-0 border-t-4 border-r-4 rounded-tr-[14px]", "bottom-0 left-0 border-b-4 border-l-4 rounded-bl-[14px]", "bottom-0 right-0 border-b-4 border-r-4 rounded-br-[14px]"].map((c) => (
              <span key={c} className={`absolute w-9 h-9 ${c}`} style={{ borderColor: "rgb(var(--color-primary))" }} />
            ))}
            <span className="absolute left-2 right-2 h-[2px] top-1/2 animate-pulse" style={{ background: "rgb(var(--color-primary) / 0.8)", boxShadow: "0 0 12px rgb(var(--color-primary))" }} />
          </div>
        </div>
      )}
      {state !== "on" && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-[13px] text-white/80">
          {state === "starting" ? "Starting the camera…" : state === "denied" ? "Camera blocked - allow it in the browser, or search by name below." : "No camera here - search by name or type the ticket code below."}
        </div>
      )}
      {paused && state === "on" && <div className="absolute inset-0 bg-black/45" />}
    </div>
  );
}

// ------------------------------------------------------------- the app --
export default function StaffApp() {
  const { token = "" } = useParams();
  const [params] = useSearchParams();
  const k = params.get("k") || "";
  const qKey = `gd360_evq_${token}`;
  const [info, setInfo] = useState<Info | null>(null);
  const [miss, setMiss] = useState("");
  const [tab, setTab] = useState<Tab>("door");
  const [by, setBy] = useState(() => store.get("gd360_staff_name"));
  const [askName, setAskName] = useState(false);
  const [gate, setGate] = useState(() => store.get(`gd360_gate_${token}`));
  const [queue, setQueue] = useState<any[]>(() => { try { return JSON.parse(store.get(qKey, "[]")); } catch { return []; } });
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [flash, setFlash] = useState<Flash | null>(null);
  const flashTimer = useRef(0);
  const syncing = useRef(false);

  const load = useCallback(() => {
    publicEvent.staff(token, k).then((x: Info) => {
      setInfo(x);
      if (x.mode === "sponsor") setTab("leads");
      if (!gate && x.gates[0]) setGate(x.gates[0]);
    }).catch((e) => { if (offline(e)) setOnline(false); else setMiss(errText(e, "This staff link isn't valid.")); });
  }, [token, k]);
  useEffect(load, [load]);
  useEffect(() => { if (!by) setAskName(true); }, []);
  useEffect(() => { store.set(qKey, JSON.stringify(queue)); }, [queue, qKey]);
  useEffect(() => { if (gate) store.set(`gd360_gate_${token}`, gate); }, [gate, token]);
  useEffect(() => { if (info) document.title = `Staff · ${info.title}`; }, [info]);

  const show = (f: Flash, ms = 3200) => {
    setFlash(f);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), ms);
  };
  const enqueue = (item: any) => setQueue((q) => [...q, item]);
  const sync = useCallback(async () => {
    if (syncing.current) return;
    let items: any[] = [];
    try { items = JSON.parse(store.get(qKey, "[]")); } catch { items = []; }
    if (!items.length) return;
    syncing.current = true;
    try {
      const r = await publicEvent.sync(token, k, items.slice(0, 200));
      const done = new Set((r.results || []).map((x: any) => x.client_id));
      setQueue((q) => q.filter((x) => !done.has(x.client_id)));
      setOnline(true);
      load();
    } catch (e) { if (offline(e)) setOnline(false); } finally { syncing.current = false; }
  }, [token, k, qKey, load]);
  useEffect(() => {
    const on = () => { setOnline(true); sync(); };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const t = window.setInterval(() => { sync(); if (navigator.onLine) load(); }, 20000);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); window.clearInterval(t); };
  }, [sync, load]);

  // send now, or queue it on the phone when there's no signal
  const send = async (type: string, body: any, call: (item: any) => Promise<any>): Promise<any> => {
    const item = { type, client_id: uid(), at: new Date().toISOString().slice(0, 19), by: by || undefined, ...body };
    if (!navigator.onLine) { enqueue(item); return "queued"; }
    try { const r = await call(item); setOnline(true); return r; } catch (e) {
      if (offline(e)) { setOnline(false); enqueue(item); return "queued"; }
      throw e;
    }
  };

  if (miss) return (
    <div className="min-h-screen bg-base text-text grid place-items-center p-6 text-center"><div className="max-w-[340px] flex flex-col gap-2">
      <div className="text-[19px] font-semibold">This staff link isn't working</div><p className="m-0 text-ui text-secondary">{miss}</p></div></div>
  );
  if (!info) return <div className="min-h-screen bg-base p-4"><div className="h-[80vh] rounded-[18px] bg-surface2 animate-pulse" /></div>;

  const sponsor = info.mode === "sponsor";
  const tabs: { id: Tab; label: string; icon: ReactNode }[] = sponsor
    ? [{ id: "leads", label: "Scan leads", icon: <IconScan /> }]
    : [{ id: "door", label: "Door", icon: <IconScan /> }, { id: "walkin", label: "Walk-in", icon: <IconPlus /> },
      ...(info.sessions.length ? [{ id: "rooms" as Tab, label: "Rooms", icon: <IconRoom /> }] : []), { id: "count", label: "Count", icon: <IconCount /> }];

  return (
    <div className="min-h-[100dvh] bg-base text-text flex flex-col" data-staff-app={info.mode}>
      <header className="sticky top-0 z-20 bg-base/90 backdrop-blur border-b border-border px-4 pt-[max(12px,env(safe-area-inset-top))] pb-3 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-brand-ink">{sponsor ? `${info.sponsor?.name} · lead scan` : "Staff app"}{info.sample ? " · sample" : ""}</div>
            <div className="text-[15px] font-semibold truncate">{info.title}</div>
          </div>
          <button type="button" onClick={() => sync()} className={`h-7 px-2.5 rounded-full text-[11.5px] border inline-flex items-center gap-1.5 shrink-0 ${online ? "border-good-border bg-good-fill text-good" : "border-warning-border bg-warning-fill text-warning"}`} data-net={online ? "online" : "offline"}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "currentColor" }} />{online ? "Online" : "Offline"}{queue.length ? ` · ${queue.length} to send` : ""}
          </button>
        </div>
        {sponsor ? (
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2 rounded-full bg-border/60 overflow-hidden"><div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, (100 * (info.sponsor?.leads || 0)) / Math.max(info.sponsor?.goal || 1, 1))}%`, background: "rgb(var(--color-primary))" }} /></div>
            <span className="text-[12.5px] tabular-nums text-secondary">{info.sponsor?.leads ?? 0}{info.sponsor?.goal ? ` / ${info.sponsor.goal}` : ""} leads</span>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 text-center">
            {[["In", info.counts.checked_in], ["Registered", info.counts.registered], ["Walk-ins", info.counts.walk_ins]].map(([l, v]) => (
              <div key={l as string} className="rounded-[10px] bg-surface border border-border py-1.5"><div className="text-[17px] font-semibold tabular-nums leading-tight" data-count={l}>{(v as number).toLocaleString()}</div><div className="text-[10.5px] text-muted">{l}</div></div>
            ))}
          </div>
        )}
      </header>

      {flash && (
        <div className="fixed inset-x-3 top-[max(12px,env(safe-area-inset-top))] z-40" role="status" data-flash={flash.tone}>
          <div className="rounded-[16px] border px-4 py-3.5 shadow-card flex items-start gap-3"
            style={{ background: flash.tone === "good" ? "rgb(var(--color-good))" : flash.tone === "warn" ? "rgb(var(--color-warning))" : flash.tone === "bad" ? "rgb(var(--color-danger))" : "rgb(var(--color-surface))", color: flash.tone === "info" ? undefined : "#06150F", borderColor: "transparent" }}
            onClick={() => setFlash(null)}>
            <span className="text-[26px] leading-none font-bold">{flash.tone === "good" ? "✓" : flash.tone === "bad" ? "×" : flash.tone === "warn" ? "!" : "↻"}</span>
            <div className="min-w-0 flex-1">
              <div className="text-[16px] font-semibold leading-tight">{flash.title}</div>
              {flash.person && <div className="text-[13.5px] mt-0.5 font-medium">{[flash.person.company, flash.person.title].filter(Boolean).join(" · ")}</div>}
              {flash.person && (flash.person.vip || flash.person.repeat || flash.person.icp) && (
                <div className="flex gap-1.5 mt-1.5 flex-wrap">{flash.person.vip && <Chip>{flash.person.tier.toUpperCase()}</Chip>}{flash.person.icp && <Chip>ICP</Chip>}{flash.person.repeat && <Chip>came last time</Chip>}</div>)}
              {flash.person?.meeting && <div className="text-[13px] mt-1.5">Meeting: {flash.person.meeting}</div>}
              {flash.sub && <div className="text-[13px] mt-0.5 opacity-90">{flash.sub}</div>}
            </div>
          </div>
        </div>
      )}

      <main className="flex-1 px-4 py-4 pb-28 flex flex-col gap-4">
        {tab === "door" && !sponsor && <Door info={info} gate={gate} setGate={setGate} token={token} k={k} send={send} show={show} reload={load} />}
        {tab === "walkin" && !sponsor && <WalkIn info={info} gate={gate} token={token} k={k} send={send} show={show} reload={load} />}
        {tab === "rooms" && !sponsor && <Rooms info={info} token={token} k={k} send={send} show={show} />}
        {tab === "count" && !sponsor && <Count info={info} token={token} k={k} send={send} show={show} />}
        {tab === "leads" && sponsor && <Leads info={info} token={token} k={k} send={send} show={show} reload={load} />}
        <button type="button" className="self-center text-[12px] text-muted underline" onClick={() => setAskName(true)}>{by ? `Scanning as ${by} · change` : "Add your name"}</button>
      </main>

      {tabs.length > 1 && (
        <nav className="fixed bottom-0 inset-x-0 z-30 bg-surface/95 backdrop-blur border-t border-border grid pb-[env(safe-area-inset-bottom)]" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>
          {tabs.map((t) => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} data-staff-tab={t.id}
              className={`h-[62px] flex flex-col items-center justify-center gap-1 text-[11.5px] ${tab === t.id ? "text-brand-ink" : "text-muted"}`}>
              {t.icon}{t.label}
            </button>
          ))}
        </nav>
      )}

      {askName && (
        <div className="fixed inset-0 z-50 bg-black/60 grid items-end sm:place-items-center" onClick={() => by && setAskName(false)}>
          <form className="w-full sm:max-w-[420px] bg-surface border-t sm:border border-border rounded-t-[22px] sm:rounded-[22px] p-5 pb-[max(20px,env(safe-area-inset-bottom))] flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); store.set("gd360_staff_name", by); setAskName(false); }}>
            <div className="text-[17px] font-semibold">Who's scanning?</div>
            <div className="text-[13px] text-muted">Your first name goes on every check-in and lead, so the team knows who to ask.</div>
            <input className="input !h-12 text-[16px]" autoFocus value={by} onChange={(e) => setBy(e.target.value)} placeholder="e.g. Priya" aria-label="Your name" />
            <button type="submit" className="btn-primary !h-12 text-[15px] justify-center" disabled={!by.trim()}>Start</button>
          </form>
        </div>
      )}
    </div>
  );
}

type SendFn = (type: string, body: any, call: (item: any) => Promise<any>) => Promise<any>;
type ShowFn = (f: Flash, ms?: number) => void;

// ------------------------------------------------------------------ door --
function Door({ info, gate, setGate, token, k, send, show, reload }: { info: Info; gate: string; setGate: (g: string) => void; token: string; k: string; send: SendFn; show: ShowFn; reload: () => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<Person[]>([]);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2) { setRes([]); return; }
    const t = window.setTimeout(() => publicEvent.search(token, k, q.trim()).then((r) => setRes(r.people)).catch(() => setRes([])), 220);
    return () => window.clearTimeout(t);
  }, [q, token, k]);
  const checkin = async (body: { code?: string; ticket_id?: string }) => {
    if (busy) return;
    setBusy(true); setPaused(true);
    try {
      const r = await send("checkin", { ...body, gate }, (item) => publicEvent.checkin(token, { k, ...item }));
      if (r === "queued") { buzz(60); show({ tone: "info", title: "Saved on this phone", sub: "No signal - it's sent as soon as you're back online." }); }
      else if (!r.ok) { buzz([80, 60, 80]); show({ tone: "bad", title: r.error || "Not found", person: r.person }); }
      else if (r.already) { buzz([40, 40, 40]); show({ tone: "warn", title: `${r.person.name || "Guest"} is already in`, sub: r.person.checked_in_at ? `Checked in at ${new Date(r.person.checked_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : undefined, person: r.person }); }
      else { buzz(90); show({ tone: "good", title: `Welcome, ${(r.person.name || "guest").split(" ")[0]}`, person: r.person }); reload(); }
      setQ(""); setRes([]);
    } catch (e) { show({ tone: "bad", title: errText(e) }); } finally { setBusy(false); window.setTimeout(() => setPaused(false), 1400); }
  };
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] text-muted shrink-0">Gate</span>
        <div className="flex gap-1.5 overflow-x-auto">{info.gates.map((g) => (
          <button key={g} type="button" onClick={() => setGate(g)} className={`h-8 px-3 rounded-full text-[12.5px] border whitespace-nowrap ${gate === g ? "border-tint-border bg-tint text-text" : "border-border text-muted"}`}>{g}</button>))}</div>
      </div>
      <Scanner onCode={(c) => checkin({ code: c })} paused={paused} />
      <div className="flex flex-col gap-2">
        <input className="input !h-12 text-[16px]" placeholder="Search a name, company or type the code" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" data-door-search="" />
        {res.map((p) => (
          <div key={p.id} className="rounded-[14px] border border-border bg-surface px-3.5 py-3 flex items-center gap-3" data-result={p.code}>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-medium truncate">{p.name || "Guest"} {p.vip && <Chip>{p.tier.toUpperCase()}</Chip>}</div>
              <div className="text-[12.5px] text-muted truncate">{[p.company, p.title].filter(Boolean).join(" · ") || p.code}</div>
            </div>
            {p.status === "checked_in" ? <span className="text-[12px] text-good">in ✓</span> :
              <button type="button" className="btn-primary !h-10 !px-4 text-[14px]" disabled={busy} onClick={() => checkin({ ticket_id: p.id })}>Check in</button>}
          </div>
        ))}
        {q.trim().length >= 4 && /^[A-Z0-9]{6,10}$/i.test(q.trim()) && !res.length && (
          <button type="button" className="btn-secondary !h-11 justify-center" onClick={() => checkin({ code: q.trim() })}>Check in code {q.trim().toUpperCase()}</button>
        )}
      </div>
    </>
  );
}

// --------------------------------------------------------------- walk-in --
function WalkIn({ info, gate, token, k, send, show, reload }: { info: Info; gate: string; token: string; k: string; send: SendFn; show: ShowFn; reload: () => void }) {
  const blank = { name: "", email: "", company: "", title: "", phone: "", interests: [] as string[], note: "", wants_meeting: false, consent: false };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [err, setErr] = useState("");
  const started = useRef<number | null>(null);
  const photo = useRef<HTMLInputElement>(null);
  const touch = () => { if (started.current === null) started.current = Date.now(); };
  const set = (patch: Partial<typeof f>) => { touch(); setF((x) => ({ ...x, ...patch })); };
  const readCard = async (file: File) => {
    touch(); setReading(true); setErr("");
    try {
      const small = await shrink(file, 1400);
      const r = await publicEvent.ocr(token, k, small);
      const x = r.fields || {};
      setF((cur) => ({ ...cur, name: x.name || cur.name, email: x.email || cur.email, company: x.company || cur.company, title: x.title || cur.title, phone: x.phone || cur.phone }));
    } catch (e) { setErr(errText(e, "Couldn't read the card - type it in.")); } finally { setReading(false); }
  };
  const save = async () => {
    setBusy(true); setErr("");
    try {
      const seconds = started.current ? Math.round((Date.now() - started.current) / 100) / 10 : undefined;
      const r = await send("walkin", { ...f, gate, seconds }, (item) => publicEvent.walkin(token, { k, ...item }));
      if (r === "queued") show({ tone: "info", title: "Saved on this phone", sub: "Sent when you're back online." });
      else if (!r.ok) { setErr(r.error || "Check the details."); return; }
      else if (r.registered) show({ tone: r.already ? "warn" : "good", title: r.already ? "Already checked in" : `They had registered - ${(f.name || "guest").split(" ")[0]} is checked in`, person: r.person });
      else { buzz(90); show({ tone: "good", title: `Walk-in saved${seconds ? ` in ${Math.round(seconds)}s` : ""}`, sub: f.wants_meeting ? "A meeting task was added for the team." : undefined, person: r.person }); }
      setF(blank); started.current = null; reload();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save(); }} data-walkin-form="">
      <div className="flex items-center justify-between"><div className="text-[18px] font-semibold">New walk-in</div>
        {info.vision && <>
          <input ref={photo} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { const x = e.target.files?.[0]; if (x) readCard(x); e.target.value = ""; }} />
          <button type="button" className="btn-secondary !h-9 text-[13px]" disabled={reading} onClick={() => photo.current?.click()}>{reading ? "Reading…" : "📷 Card photo"}</button>
        </>}
      </div>
      <BigInput label="Company" value={f.company} onChange={(v) => set({ company: v })} autoComplete="organization" />
      <BigInput label="Name" value={f.name} onChange={(v) => set({ name: v })} autoComplete="name" />
      <BigInput label="Email" type="email" value={f.email} onChange={(v) => set({ email: v })} inputMode="email" autoComplete="email" />
      <div className="grid grid-cols-2 gap-3">
        <BigInput label="Role" value={f.title} onChange={(v) => set({ title: v })} />
        <BigInput label="Phone" type="tel" value={f.phone} onChange={(v) => set({ phone: v })} inputMode="tel" />
      </div>
      <div className="flex flex-col gap-1.5"><span className="text-[12.5px] text-secondary">Interested in</span>
        <div className="flex flex-wrap gap-1.5">{info.interests.map((x) => {
          const on = f.interests.includes(x);
          return <button key={x} type="button" onClick={() => set({ interests: on ? f.interests.filter((y) => y !== x) : [...f.interests, x] })}
            className={`h-9 px-3.5 rounded-full border text-[13.5px] ${on ? "border-tint-border bg-tint text-text" : "border-border text-muted"}`}>{x}</button>;
        })}</div></div>
      <textarea className="input min-h-[64px] text-[15px]" placeholder="Note (optional)" value={f.note} onChange={(e) => set({ note: e.target.value })} aria-label="Note" />
      <Toggle on={f.wants_meeting} onChange={(v) => set({ wants_meeting: v })} label="Wants a meeting - add a task for the team" />
      <Toggle on={f.consent} onChange={(v) => set({ consent: v })} label="They agreed to hear from us by email" />
      {err && <div className="text-[13px] text-danger" role="alert">{err}</div>}
      <button type="submit" className="btn-primary !h-13 py-3.5 text-[16px] justify-center" disabled={busy || !(f.name.trim() || f.email.trim() || f.company.trim())} data-save-walkin="">{busy ? "Saving…" : "Save and check in"}</button>
    </form>
  );
}

// ----------------------------------------------------------------- rooms --
function Rooms({ info, token, k, send, show }: { info: Info; token: string; k: string; send: SendFn; show: ShowFn }) {
  const [sid, setSid] = useState(() => store.get(`gd360_room_${token}`) || info.sessions[0]?.id || "");
  const [n, setN] = useState<{ in: number; cap: number | null } | null>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => { store.set(`gd360_room_${token}`, sid); setN(null); }, [sid, token]);
  const s = info.sessions.find((x) => x.id === sid);
  const scan = async (code?: string) => {
    if (!sid) return;
    setPaused(true);
    try {
      const r = await send("session", { session_id: sid, code }, (item) => publicEvent.session(token, { k, ...item }));
      if (r === "queued") show({ tone: "info", title: "Saved on this phone" }, 1600);
      else if (!r.ok) show({ tone: "bad", title: r.error || "Not found" });
      else { buzz(60); setN({ in: r.in_room ?? (n?.in || 0), cap: r.capacity ?? null }); show({ tone: "good", title: r.person ? `${(r.person.name || "Guest").split(" ")[0]} - in the room` : "+1 counted", person: r.person }, 1600); }
    } catch (e) { show({ tone: "bad", title: errText(e) }); } finally { window.setTimeout(() => setPaused(false), 1000); }
  };
  const full = n && n.cap ? n.in / n.cap : 0;
  return (
    <>
      <select className="input !h-12 text-[15px]" value={sid} onChange={(e) => setSid(e.target.value)} aria-label="Session">
        {info.sessions.map((x) => <option key={x.id} value={x.id}>{x.starts_at ? new Date(x.starts_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " · " : ""}{x.title}{x.room ? ` (${x.room})` : ""}</option>)}
      </select>
      {n && (
        <div className="rounded-[14px] border border-border bg-surface p-3.5 flex items-center gap-3">
          <div className="text-[28px] font-semibold tabular-nums">{n.in}</div>
          <div className="flex-1 flex flex-col gap-1"><span className="text-[12.5px] text-muted">in {s?.room || "the room"}{n.cap ? ` of ${n.cap} seats` : ""}</span>
            {n.cap ? <div className="h-2 rounded-full bg-border/60 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${Math.min(100, full * 100)}%`, background: full > 1 ? "rgb(var(--color-danger))" : full > 0.85 ? "rgb(var(--color-warning))" : "rgb(var(--color-primary))" }} /></div> : null}</div>
          {full > 1 && <span className="text-[12px] text-danger font-medium">Full</span>}
        </div>
      )}
      <Scanner onCode={(c) => scan(c)} paused={paused} />
      <button type="button" className="btn-secondary !h-12 justify-center text-[15px]" onClick={() => scan()}>+1 without a badge</button>
    </>
  );
}

// ----------------------------------------------------------------- count --
function Count({ info, token, k, send, show }: { info: Info; token: string; k: string; send: SendFn; show: ShowFn }) {
  const [gate, setGate] = useState(info.gates[0] || "");
  const [zone, setZone] = useState(info.zones[0]?.name || "");
  const [people, setPeople] = useState("");
  const post = async (kind: "queue" | "occupancy", z: string, value: number) => {
    try {
      const r = await send("count", { kind, zone: z, value }, (item) => publicEvent.count(token, { k, ...item }));
      buzz(40);
      show({ tone: r === "queued" ? "info" : "good", title: kind === "queue" ? `${z}: ${value} min queue` : `${z}: ${value} people`, sub: r === "queued" ? "Saved on this phone" : undefined }, 1800);
      if (kind === "occupancy") setPeople("");
    } catch (e) { show({ tone: "bad", title: errText(e) }); }
  };
  return (
    <>
      <section className="rounded-[18px] border border-border bg-surface p-4 flex flex-col gap-3">
        <div className="text-[16px] font-semibold">Queue at the gate</div>
        <div className="flex gap-1.5 flex-wrap">{info.gates.map((g) => (
          <button key={g} type="button" onClick={() => setGate(g)} className={`h-8 px-3 rounded-full text-[12.5px] border ${gate === g ? "border-tint-border bg-tint text-text" : "border-border text-muted"}`}>{g}</button>))}</div>
        <div className="grid grid-cols-3 gap-2">{[0, 2, 5, 10, 15, 25].map((m) => (
          <button key={m} type="button" onClick={() => post("queue", gate, m)} className="h-14 rounded-[12px] border border-border bg-surface2 text-[16px] font-medium tabular-nums active:scale-[0.98]"
            style={{ color: m >= 15 ? "rgb(var(--color-danger))" : m >= 10 ? "rgb(var(--color-warning))" : undefined }}>{m === 0 ? "No queue" : `${m} min`}</button>))}</div>
      </section>
      {info.zones.length > 0 && (
        <section className="rounded-[18px] border border-border bg-surface p-4 flex flex-col gap-3">
          <div className="text-[16px] font-semibold">People in a room</div>
          <select className="input !h-12 text-[15px]" value={zone} onChange={(e) => setZone(e.target.value)} aria-label="Room">{info.zones.map((z) => <option key={z.id}>{z.name}</option>)}</select>
          <div className="flex gap-2">
            <input className="input !h-12 text-[18px] flex-1 tabular-nums" inputMode="numeric" placeholder="How many?" value={people} onChange={(e) => setPeople(e.target.value.replace(/\D/g, ""))} aria-label="People" />
            <button type="button" className="btn-primary !h-12 px-5" disabled={!people} onClick={() => post("occupancy", zone, Number(people))}>Send</button>
          </div>
        </section>
      )}
    </>
  );
}

// ----------------------------------------------------------------- leads --
function Leads({ info, token, k, send, show, reload }: { info: Info; token: string; k: string; send: SendFn; show: ShowFn; reload: () => void }) {
  const blank = { code: "", name: "", email: "", company: "", title: "", rating: 0, interests: [] as string[], note: "" };
  const [f, setF] = useState(blank);
  const [scanned, setScanned] = useState<Person | null>(null);
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = !!f.code || manual;
  const onCode = async (code: string) => {
    if (open) return;
    const c = code.trim().replace(/\/$/, "").split("/").pop()!.split("?")[0].toUpperCase();
    buzz(50);
    setF({ ...blank, code: c });
    try { const r = await publicEvent.search(token, k, c); setScanned(r.people?.[0] || null); } catch { setScanned(null); }
  };
  const save = async () => {
    setBusy(true);
    try {
      const body = f.code ? { code: f.code, rating: f.rating || undefined, interests: f.interests, note: f.note || undefined }
        : { name: f.name, email: f.email, company: f.company, title: f.title, rating: f.rating || undefined, interests: f.interests, note: f.note || undefined };
      const r = await send("lead", body, (item) => publicEvent.lead(token, { k, ...item }));
      if (r === "queued") show({ tone: "info", title: "Lead saved on this phone", sub: "Sent when you're back online." });
      else if (!r.ok) { show({ tone: "bad", title: r.error || "Couldn't save" }); return; }
      else { buzz(90); show({ tone: "good", title: `Lead saved${r.person?.name ? ` - ${r.person.name}` : ""}`, sub: r.leads ? `${r.leads} leads${info.sponsor?.goal ? ` of ${info.sponsor.goal}` : ""}` : undefined }); reload(); }
      setF(blank); setScanned(null); setManual(false);
    } catch (e) { show({ tone: "bad", title: errText(e) }); } finally { setBusy(false); }
  };
  return (
    <>
      {!open && <>
        <Scanner onCode={onCode} paused={open} />
        <button type="button" className="btn-secondary !h-12 justify-center text-[15px]" onClick={() => setManual(true)}>No badge? Type it in</button>
      </>}
      {open && (
        <form className="rounded-[18px] border border-border bg-surface p-4 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save(); }} data-lead-form="">
          {f.code ? (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><div className="text-[17px] font-semibold truncate">{scanned?.name || `Badge ${f.code}`}</div>
                <div className="text-[13px] text-muted truncate">{[scanned?.company, scanned?.title].filter(Boolean).join(" · ") || "Details come from their ticket"}</div></div>
              <span className="font-mono text-[12px] text-muted">{f.code}</span>
            </div>
          ) : <>
            <div className="text-[17px] font-semibold">New lead</div>
            <BigInput label="Name" value={f.name} onChange={(v) => setF({ ...f, name: v })} />
            <BigInput label="Email" type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} inputMode="email" />
            <div className="grid grid-cols-2 gap-3"><BigInput label="Company" value={f.company} onChange={(v) => setF({ ...f, company: v })} /><BigInput label="Role" value={f.title} onChange={(v) => setF({ ...f, title: v })} /></div>
          </>}
          <div className="flex flex-col gap-1.5"><span className="text-[12.5px] text-secondary">How hot?</span>
            <div className="grid grid-cols-5 gap-1.5">{[1, 2, 3, 4, 5].map((v) => (
              <button key={v} type="button" onClick={() => setF({ ...f, rating: v })} className={`h-11 rounded-[10px] border text-[18px] ${f.rating >= v ? "border-warning-border bg-warning-fill text-warning" : "border-border text-muted"}`} aria-label={`${v} of 5`}>★</button>))}</div></div>
          <div className="flex flex-wrap gap-1.5">{info.interests.map((x) => {
            const on = f.interests.includes(x);
            return <button key={x} type="button" onClick={() => setF({ ...f, interests: on ? f.interests.filter((y) => y !== x) : [...f.interests, x] })}
              className={`h-9 px-3.5 rounded-full border text-[13.5px] ${on ? "border-tint-border bg-tint text-text" : "border-border text-muted"}`}>{x}</button>;
          })}</div>
          <textarea className="input min-h-[60px] text-[15px]" placeholder="What did they ask about?" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} aria-label="Note" />
          <div className="grid grid-cols-[1fr_2fr] gap-2">
            <button type="button" className="btn-secondary !h-12 justify-center" onClick={() => { setF(blank); setScanned(null); setManual(false); }}>Cancel</button>
            <button type="submit" className="btn-primary !h-12 justify-center text-[15px]" disabled={busy || (!f.code && !(f.name.trim() || f.email.trim()))} data-save-lead="">{busy ? "Saving…" : "Save lead"}</button>
          </div>
        </form>
      )}
    </>
  );
}

// ------------------------------------------------------------- helpers --
function BigInput({ label, value, onChange, type = "text", inputMode, autoComplete }: { label: string; value: string; onChange: (v: string) => void; type?: string; inputMode?: any; autoComplete?: string }) {
  return <label className="flex flex-col gap-1"><span className="text-[12.5px] text-secondary">{label}</span>
    <input className="input !h-12 text-[16px]" type={type} inputMode={inputMode} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}
function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className="flex items-center gap-3 text-left py-1">
      <span className="w-11 h-6 rounded-full relative shrink-0 transition-colors" style={{ background: on ? "rgb(var(--color-primary))" : "rgb(var(--color-border-strong))" }}>
        <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all" style={{ left: on ? 22 : 2 }} /></span>
      <span className="text-[14px] text-text">{label}</span>
    </button>
  );
}
const Chip = ({ children }: { children: ReactNode }) => <span className="inline-flex h-5 px-1.5 rounded-[6px] text-[10.5px] font-semibold items-center" style={{ background: "rgba(6,21,15,0.14)" }}>{children}</span>;
async function shrink(file: File, max: number): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b || file), "image/jpeg", 0.85));
  } catch { return file; }
}
const ico = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
const IconScan = () => <svg {...ico}><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16" /></svg>;
const IconPlus = () => <svg {...ico}><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.5 3.6-5.5 7-5.5M18 14v6M15 17h6" /></svg>;
const IconRoom = () => <svg {...ico}><path d="M4 20V6l8-3 8 3v14M9 20v-6h6v6" /></svg>;
const IconCount = () => <svg {...ico}><path d="M5 19V9M12 19V5M19 19v-7" /></svg>;

// 2026-10-10 (round 19): 2-step sign-in in Profile, and the banner a person
// sees when their workspace requires it and they haven't set it up yet.
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { errorText, mfaApi } from "../api/ops";
import { Button, ShieldCheckIcon } from "../ui";
import { CopyButton } from "./OpsParts";

type Status = { enabled: boolean; enabled_at: string | null; recovery_codes_left: number };

export function TwoStepSection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qr_svg: string | null } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [askPassword, setAskPassword] = useState<null | "disable" | "codes">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = () => mfaApi.status().then(setStatus).catch(() => setStatus({ enabled: false, enabled_at: null, recovery_codes_left: 0 }));
  useEffect(() => {
    load();
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(errorText(e, "That didn't work - try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="security" className="card p-6 space-y-4" aria-label="2-step sign-in">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 rounded-ctl bg-tint text-brand-ink inline-flex items-center justify-center shrink-0"><ShieldCheckIcon size={18} /></span>
        <div className="flex-1">
          <h2 className="text-lg font-semibold m-0">2-step sign-in</h2>
          <p className="text-sm text-muted m-0 mt-1">
            After your password, GD360 asks for a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…). Someone with your password alone can't get in.
          </p>
        </div>
        {status && (
          <span className={`text-[11px] font-medium px-2 py-1 rounded-full border shrink-0 ${status.enabled ? "bg-good-fill text-good border-good-border" : "bg-subtle text-secondary border-border"}`}>
            {status.enabled ? "On" : "Off"}
          </span>
        )}
      </div>
      {error && <div role="alert" className="text-sm text-danger bg-danger-fill border border-danger-border rounded-ctl px-3 py-2">{error}</div>}

      {codes && (
        <div className="rounded-card border border-warning-border bg-warning-fill p-4 space-y-3">
          <div className="text-sm font-semibold text-text">Save these recovery codes now</div>
          <p className="text-sm text-secondary m-0">If you lose your phone, each code signs you in once. They won't be shown again.</p>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 font-mono text-[13px]">
            {codes.map((c) => <span key={c} className="px-2 py-1.5 rounded-ctl bg-surface border border-border text-center text-text">{c}</span>)}
          </div>
          <div className="flex gap-2">
            <CopyButton text={codes.join("\n")} label="Copy all" />
            <Button size="sm" variant="secondary" className="!h-7" onClick={() => setCodes(null)}>I've saved them</Button>
          </div>
        </div>
      )}

      {status && !status.enabled && !setup && (
        <Button variant="primary" loading={busy} onClick={() => run(async () => setSetup(await mfaApi.setup()))}>Turn on 2-step sign-in</Button>
      )}

      {status && !status.enabled && setup && (
        <div className="grid gap-5 sm:grid-cols-[180px_1fr] items-start">
          <div className="rounded-card bg-white p-2 w-[180px] h-[180px] flex items-center justify-center" aria-label="QR code to scan">
            {setup.qr_svg ? <div className="w-full h-full [&>svg]:w-full [&>svg]:h-full" dangerouslySetInnerHTML={{ __html: setup.qr_svg }} /> : <span className="text-xs text-black/60 text-center">Type the key instead</span>}
          </div>
          <div className="space-y-3">
            <ol className="m-0 pl-4 text-sm text-secondary space-y-1.5">
              <li>Scan the code with your authenticator app.</li>
              <li>Or type this key: <span className="font-mono text-text break-all">{setup.secret}</span> <CopyButton text={setup.secret.replace(/\s/g, "")} label="Copy key" className="ml-1" /></li>
              <li>Enter the 6-digit code the app shows.</li>
            </ol>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  const out = await mfaApi.enable(code);
                  setCodes(out.recovery_codes);
                  setSetup(null);
                  setCode("");
                  await load();
                });
              }}
            >
              <input className="input font-mono tracking-[0.3em] text-center w-[150px]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456"
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} aria-label="6-digit code" />
              <Button type="submit" variant="primary" disabled={code.length !== 6 || busy} loading={busy}>Turn on</Button>
              <Button type="button" variant="ghost" onClick={() => setSetup(null)}>Cancel</Button>
            </form>
          </div>
        </div>
      )}

      {status?.enabled && (
        <div className="space-y-3">
          <div className="text-sm text-secondary">
            On since {status.enabled_at ? new Date(status.enabled_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—"} · {status.recovery_codes_left} recovery code{status.recovery_codes_left === 1 ? "" : "s"} left
          </div>
          {askPassword ? (
            <form
              className="flex gap-2 flex-wrap"
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  if (askPassword === "disable") await mfaApi.disable(password);
                  else setCodes((await mfaApi.newCodes(password)).recovery_codes);
                  setPassword("");
                  setAskPassword(null);
                  await load();
                });
              }}
            >
              <input className="input flex-1 min-w-[200px]" type="password" placeholder="Your password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Your password" autoFocus />
              <Button type="submit" variant={askPassword === "disable" ? "danger" : "primary"} disabled={!password || busy} loading={busy}>
                {askPassword === "disable" ? "Turn off" : "Make new codes"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => { setAskPassword(null); setPassword(""); }}>Cancel</Button>
            </form>
          ) : (
            <div className="flex gap-2 flex-wrap">
              <Button variant="secondary" onClick={() => setAskPassword("codes")}>New recovery codes</Button>
              <Button variant="ghost" className="!text-danger" onClick={() => setAskPassword("disable")}>Turn off</Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Shown on app pages when a workspace requires 2-step sign-in and the
 * signed-in person hasn't turned it on. */
export function MfaRequiredBanner() {
  const location = useLocation();
  const [needed, setNeeded] = useState(false);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let token = "";
    try {
      token = localStorage.getItem("gd360_token") || "";
    } catch {
      token = "";
    }
    if (!token) return;
    mfaApi.me().then((u) => setNeeded(!!u.mfa_setup_required && !u.mfa_enabled)).catch(() => setNeeded(false));
  }, [location.pathname === "/profile"]);
  if (!needed || hidden || location.pathname === "/profile" || location.pathname.startsWith("/admin") || location.pathname === "/login") return null;
  return (
    <div role="status" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-[min(560px,calc(100vw-32px))] rounded-card border border-warning-border bg-surface shadow-pop px-4 py-3 flex items-center gap-3">
      <ShieldCheckIcon size={18} className="text-warning shrink-0" />
      <div className="flex-1 text-sm text-text">Your workspace asks everyone to use 2-step sign-in. It takes a minute.</div>
      <Link to="/profile#security" className="btn-primary text-xs shrink-0">Set it up</Link>
      <button type="button" className="text-muted hover:text-text text-xs shrink-0" onClick={() => setHidden(true)} aria-label="Later">Later</button>
    </div>
  );
}

// 2026-10-10 (round 19): the second step of a 2-step sign-in - the 6-digit
// code from the person's authenticator app, or one of their recovery codes.
// Used by the app's sign-in, the admin sign-in and the company-domain viewer.
import { FormEvent, useState } from "react";

export default function MfaStep({ onSubmit, onBack, email }: { onSubmit: (code: string) => Promise<void>; onBack: () => void; email?: string }) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(code.trim());
    } catch (err: any) {
      const status = err?.response?.status;
      const d = err?.response?.data?.detail;
      setError(status === 429 ? "Too many tries - wait a minute and try again." : typeof d === "string" ? d : "That code didn't work.");
      if (status === 401) setTimeout(onBack, 1800);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-label="2-step sign-in">
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-xl font-semibold text-text">{recovery ? "Use a recovery code" : "Enter your code"}</h2>
        <p className="m-0 text-sm text-muted leading-relaxed">
          {recovery
            ? "Type one of the ten recovery codes you saved when you turned on 2-step sign-in. Each works once."
            : <>Open your authenticator app and type the 6-digit code for GD360{email ? <> ({email})</> : null}.</>}
        </p>
      </div>
      {error && <div role="alert" className="text-sm text-danger bg-danger-fill border border-danger-border rounded-ctl px-3 py-2">{error}</div>}
      <input
        className="input text-center font-mono text-[22px] tracking-[0.35em]"
        inputMode={recovery ? "text" : "numeric"}
        autoComplete="one-time-code"
        autoFocus
        maxLength={recovery ? 14 : 6}
        placeholder={recovery ? "xxxxx-xxxxx" : "123456"}
        value={code}
        onChange={(e) => setCode(recovery ? e.target.value : e.target.value.replace(/\D/g, ""))}
        aria-label={recovery ? "Recovery code" : "6-digit code"}
      />
      <button className="btn-primary w-full" type="submit" disabled={busy || (!recovery && code.length !== 6) || (recovery && code.length < 10)}>
        {busy ? "Checking…" : "Sign in"}
      </button>
      <div className="flex items-center justify-between text-sm">
        <button type="button" className="text-muted hover:text-text" onClick={onBack}>&larr; Back</button>
        <button type="button" className="text-primary hover:underline" onClick={() => { setRecovery((v) => !v); setCode(""); setError(""); }}>
          {recovery ? "Use the app code" : "Lost your phone?"}
        </button>
      </div>
    </form>
  );
}

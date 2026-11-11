import { FormEvent, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../api/AuthContext";
import ThemeToggle from "../components/ThemeToggle";
import MfaStep from "../components/MfaStep";
import AuthArt from "../components/AuthArt";
import { EulivLogo } from "../components/Brand";

// Small, dependency-free eye / eye-off icons for the "show password" toggle
// below - so someone checking what they actually typed doesn't need to
// switch keyboards or copy-paste out of the field to see it.
function EyeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a20.3 20.3 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a20.29 20.29 0 0 1-3.22 4.36M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <path d="M1 1l22 22" />
    </svg>
  );
}

export default function Login() {
  const { login, completeMfa } = useAuth();
  // 2026-10-10 (round 19): set when the password was right and the account
  // uses 2-step sign-in - the form then asks for the authenticator code.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Set by <Protected> (App.tsx) when this login was reached by being
  // bounced off a page that needed to be signed in first - a workspace
  // invite link, most commonly - so signing in lands back there instead of
  // always going to "/".
  const from = (location.state as { from?: string } | null)?.from || "/";

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await login(email, password);
      if (res.mfaRequired && res.mfaToken) {
        setMfaToken(res.mfaToken);
        return;
      }
      navigate(from, { replace: true });
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Login failed.");
    } finally {
      setBusy(false);
    }
  };

  // 2026-11-11 (Midnight & Cobalt): the sign-in page from the "Euliv dark redesign" canvas - the form on the left,
  // a cobalt sky with an example answer and its proof trail on the right (components/AuthArt.tsx).
  return (
    <div className="eu-auth">
      <main className="eu-auth-main">
        <div className="absolute top-2 right-2">
          <ThemeToggle />
        </div>
        <div className="eu-auth-form">
          <Link to="/" aria-label="Euliv home"><EulivLogo size={26} /></Link>
          <div>
            <h1>{mfaToken ? "One more step" : "Your data analyst is ready"}</h1>
            <p className="eu-sub">{mfaToken ? "Enter the code from your authenticator app." : "Sign in to your workspace."}</p>
          </div>
          {mfaToken ? (
            <MfaStep
              email={email}
              onBack={() => { setMfaToken(null); setPassword(""); }}
              onSubmit={async (code) => {
                await completeMfa(mfaToken, code);
                navigate(from, { replace: true });
              }}
            />
          ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {error && <div role="alert" className="text-sm text-danger bg-danger-fill border border-danger-border rounded-lg px-3 py-2">{error}</div>}
            <div>
              <label htmlFor="login-email">Work email</label>
              <input id="login-email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
            </div>
            <div>
              <label htmlFor="login-password">Password</label>
              {/* paddingRight inline: .input's own padding shorthand wins over a pr-* utility (see index.css). */}
              <div className="relative">
                <input
                  id="login-password"
                  className="input"
                  style={{ paddingRight: "2.75rem" }}
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-1 top-0 h-full px-2.5 flex items-center text-muted hover:text-text transition"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOffIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <button className="btn-primary w-full" type="submit" disabled={busy}>
              {busy ? "Signing in..." : "Sign in"}
            </button>
            <p className="text-sm text-muted text-center m-0">
              New here?{" "}
              <Link to="/register" state={{ from }} className="eu-link">
                Create a workspace
              </Link>
            </p>
          </form>
          )}
          <p className="eu-auth-fine m-0">
            By continuing, you agree to our <Link to="/privacy" className="underline">Privacy Policy</Link>.
          </p>
        </div>
      </main>
      <AuthArt />
    </div>
  );
}

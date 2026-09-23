import { FormEvent, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../api/AuthContext";
import ThemeToggle from "../components/ThemeToggle";

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
  const { login } = useAuth();
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
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Login failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-extrabold gradient-text">GD360 Analytics</h1>
          <p className="text-muted mt-2">AI-driven, no-code 360&deg; data analytics.</p>
        </div>
        <form onSubmit={onSubmit} className="card p-8 space-y-4">
          <h2 className="text-xl font-semibold mb-2">Welcome back</h2>
          {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
          <div>
            <label className="text-sm text-muted mb-1 block">Email</label>
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Password</label>
            {/* paddingRight is set inline, not via a pr-* class - .input's
                own padding shorthand in index.css is plain CSS defined after
                @tailwind utilities in the source, so at equal specificity it
                silently wins over a pr-* utility class in the compiled
                stylesheet (the same cascade issue already fixed this way on
                the "Your data sources" search field). An inline style always
                wins regardless of cascade order, so this can't regress. */}
            <div className="relative">
              <input
                className="input"
                style={{ paddingRight: "2.75rem" }}
                type={showPassword ? "text" : "password"}
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
          <p className="text-sm text-muted text-center">
            New here?{" "}
            <Link to="/register" state={{ from }} className="text-primary hover:underline">
              Create a free account
            </Link>
          </p>
          <p className="text-xs text-muted text-center">
            <Link to="/privacy" className="hover:text-text hover:underline">Privacy Policy</Link>
          </p>
        </form>
      </div>
    </div>
  );
}

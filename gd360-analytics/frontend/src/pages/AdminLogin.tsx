import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import MfaStep from "../components/MfaStep";

// This is a separate sign-in screen from the regular user login. It still
// checks the same email + password against the same accounts table (there
// is only one set of accounts in the app) - but it only lets you in if
// that account is on the admin allow-list, and it will not sign you into
// the app at all if it is not, unlike the regular login form.
// 2026-10-10: who gets in is decided by the backend (Mission Control roles:
// ADMIN_EMAILS owners plus invited staff) - see GET /admin/v2/me.

export default function AdminLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mfaToken, setMfaToken] = useState<string | null>(null);

  // Shared by both steps: the access token must belong to a Mission Control account.
  const finish = async (data: { access_token: string; user: unknown }) => {
    try {
      await api.get("/admin/v2/me", { headers: { Authorization: `Bearer ${data.access_token}` } });
    } catch {
      setError("This account does not have Mission Control access.");
      setBusy(false);
      setMfaToken(null);
      return;
    }
    localStorage.setItem("gd360_token", data.access_token);
    localStorage.setItem("gd360_user", JSON.stringify(data.user));
    window.location.href = "/admin";
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { data } = await api.post("/auth/login", { email, password });
      if (data.mfa_required) {
        setMfaToken(data.mfa_token);
        setBusy(false);
        return;
      }
      await finish(data);
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Incorrect email or password.");
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-extrabold gradient-text">GD360 Analytics</h1>
          <p className="text-muted mt-2">Owner-only admin sign in.</p>
        </div>
        {mfaToken ? (
          <div className="card p-8">
            <MfaStep
              email={email}
              onBack={() => setMfaToken(null)}
              onSubmit={async (code) => {
                const { data } = await api.post("/auth/login/mfa", { mfa_token: mfaToken, code });
                await finish(data);
              }}
            />
          </div>
        ) : (
        <form onSubmit={onSubmit} className="card p-8 space-y-4">
          <h2 className="text-xl font-semibold mb-2">Admin Login</h2>
          {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
          <div>
            <label className="text-sm text-muted mb-1 block">Admin email</label>
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Password</label>
            <input className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          </div>
          <button className="btn-primary w-full" type="submit" disabled={busy}>
            {busy ? "Signing in..." : "Sign in as admin"}
          </button>
          <p className="text-sm text-muted text-center">
            Not an admin? <Link to="/login" className="text-primary hover:underline">Go to regular login</Link>
          </p>
        </form>
        )}
      </div>
    </div>
  );
}

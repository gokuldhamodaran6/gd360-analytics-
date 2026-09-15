import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";

// This is a separate sign-in screen from the regular user login. It still
// checks the same email + password against the same accounts table (there
// is only one set of accounts in the app) - but it only lets you in if
// that account is on the admin allow-list, and it will not sign you into
// the app at all if it is not, unlike the regular login form.
const ADMIN_EMAILS = ["gokuldhamodaranb@gmail.com", "gokuldhamodaran6@gmail.com"];

export default function AdminLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { data } = await api.post("/auth/login", { email, password });
      const loggedInEmail = (data.user?.email || "").toLowerCase();
      if (!ADMIN_EMAILS.includes(loggedInEmail)) {
        setError("This account does not have admin access.");
        setBusy(false);
        return;
      }
      localStorage.setItem("gd360_token", data.access_token);
      localStorage.setItem("gd360_user", JSON.stringify(data.user));
      window.location.href = "/admin";
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
      </div>
    </div>
  );
}

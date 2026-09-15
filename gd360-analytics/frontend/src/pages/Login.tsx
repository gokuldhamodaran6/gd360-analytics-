import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../api/AuthContext";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Login failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
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
            <input className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          </div>
          <button className="btn-primary w-full" type="submit" disabled={busy}>
            {busy ? "Signing in..." : "Sign in"}
          </button>
          <p className="text-sm text-muted text-center">
            New here? <Link to="/register" className="text-primary hover:underline">Create a free account</Link>
          </p>
        </form>
        <div className="text-center mt-4">
          <Link to="/admin-login" className="btn-secondary inline-block text-sm">Admin Login</Link>
        </div>
      </div>
    </div>
  );
}

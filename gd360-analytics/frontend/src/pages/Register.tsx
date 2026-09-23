import { FormEvent, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../api/AuthContext";
import ThemeToggle from "../components/ThemeToggle";

export default function Register() {
  const { register, getCaptcha } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // See Login.tsx - carried the same way, for the same reason (a
  // signed-out visitor following a workspace invite link who doesn't have
  // an account yet).
  const from = (location.state as { from?: string } | null)?.from || "/";
  const [fullName, setFullName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [captchaId, setCaptchaId] = useState("");
  const [captchaQuestion, setCaptchaQuestion] = useState("");
  const [captchaAnswer, setCaptchaAnswer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadCaptcha = async () => {
    try {
      const challenge = await getCaptcha();
      setCaptchaId(challenge.captcha_id);
      setCaptchaQuestion(challenge.question);
      setCaptchaAnswer("");
    } catch {
      setCaptchaQuestion("");
    }
  };

  useEffect(() => {
    loadCaptcha();
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await register(email, password, captchaId, captchaAnswer, fullName, company);
      navigate(from, { replace: true });
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Registration failed.");
      // The question is single-use either way, so line up a fresh one.
      loadCaptcha();
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
          <p className="text-muted mt-2">Free, unlimited AI analytics. No credit card.</p>
        </div>
        <form onSubmit={onSubmit} className="card p-8 space-y-4">
          <h2 className="text-xl font-semibold mb-2">Create your account</h2>
          {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
          <div>
            <label className="text-sm text-muted mb-1 block">Full name</label>
            <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Ada Lovelace" />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Company</label>
            <input className="input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme Inc." />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Email</label>
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Password</label>
            <input className="input" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">
              {captchaQuestion ? `Quick check: ${captchaQuestion}` : "Quick check"}
            </label>
            <input
              className="input"
              required
              inputMode="numeric"
              value={captchaAnswer}
              onChange={(e) => setCaptchaAnswer(e.target.value.replace(/[^0-9-]/g, ""))}
              placeholder="Your answer"
            />
          </div>
          <button className="btn-primary w-full" type="submit" disabled={busy || !captchaId}>
            {busy ? "Creating account..." : "Create free account"}
          </button>
          <p className="text-sm text-muted text-center">
            Already have an account?{" "}
            <Link to="/login" state={{ from }} className="text-primary hover:underline">
              Sign in
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

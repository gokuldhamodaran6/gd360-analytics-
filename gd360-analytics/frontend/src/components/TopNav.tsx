import { Link } from "react-router-dom";
import { useAuth } from "../api/AuthContext";

export default function TopNav() {
  const { user, logout } = useAuth();
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-border">
      <Link to="/" className="text-lg font-extrabold gradient-text">GD360 Analytics</Link>
      <div className="flex items-center gap-4">
        <span className="text-sm text-muted hidden sm:inline">
          {user?.full_name || user?.email} · <span className="text-accent">Unlimited free plan</span>
        </span>
        <button className="btn-secondary text-sm" onClick={logout}>Sign out</button>
      </div>
    </div>
  );
}

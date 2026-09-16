import { Link } from "react-router-dom";
import { useAuth } from "../api/AuthContext";
import ThemeToggle from "./ThemeToggle";

// Display-only check for showing the Admin link in the nav. The real
// access control happens on the backend (see ADMIN_EMAILS in config.py) -
// this just avoids showing the link to people it would 403 for anyway.
const ADMIN_EMAILS = ["gokuldhamodaran6@gmail.com", "gokuldhamodaranb@gmail.com"];

export default function TopNav({ onConnectData }: { onConnectData?: () => void }) {
  const { user, logout } = useAuth();
  const isAdmin = !!user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase());

  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-border">
      <Link to="/" className="flex items-center gap-2.5">
        <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white font-bold text-sm shrink-0">
          G
        </span>
        <span className="text-lg font-extrabold gradient-text">GD360 Analytics</span>
      </Link>
      <div className="flex items-center gap-3">
        <Link to="/profile" className="text-sm text-muted hidden md:inline hover:text-primary transition-colors">
          {user?.full_name || user?.email} <span className="text-border mx-1">&middot;</span>{" "}
          <span className="text-accent">Unlimited free plan</span>
        </Link>
        <ThemeToggle />
        {onConnectData && (
          <button className="btn-primary text-sm" onClick={onConnectData}>
            + Connect data
          </button>
        )}
        {isAdmin && (
          <Link to="/admin" className="btn-secondary text-sm">Admin</Link>
        )}
        <button className="btn-secondary text-sm" onClick={logout}>Sign out</button>
      </div>
    </div>
  );
}

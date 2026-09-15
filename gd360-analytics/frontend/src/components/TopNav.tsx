import { Link } from "react-router-dom";
import { useAuth } from "../api/AuthContext";

// Display-only check for showing the Admin link in the nav. The real
// access control happens on the backend (see ADMIN_EMAILS in config.py) -
// this just avoids showing the link to people it would 403 for anyway.
const ADMIN_EMAILS = ["gokuldhamodaranb@gmail.com", "gokuldhamodaran6@gmail.com"];

export default function TopNav() {
  const { user, logout } = useAuth();
  const isAdmin = !!user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase());

  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-border">
      <Link to="/" className="text-lg font-extrabold gradient-text">GD360 Analytics</Link>
      <div className="flex items-center gap-4">
        <span className="text-sm text-muted hidden sm:inline">
          {user?.full_name || user?.email} · <span className="text-accent">Unlimited free plan</span>
        </span>
        {isAdmin && (
          <Link to="/admin" className="btn-secondary text-sm">Admin</Link>
        )}
        <button className="btn-secondary text-sm" onClick={logout}>Sign out</button>
      </div>
    </div>
  );
}

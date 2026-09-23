import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./api/AuthContext";
import Login from "./pages/Login";
import Register from "./pages/Register";
import AdminLogin from "./pages/AdminLogin";
import Landing from "./pages/Landing";
import Dashboard from "./pages/Dashboard";
import Workspace from "./pages/Workspace";
import Dashboards from "./pages/Dashboards";
import DashboardView from "./pages/DashboardView";
import DataSources from "./pages/DataSources";
import NewProject from "./pages/NewProject";
import AdminDashboard from "./pages/AdminDashboard";
import Profile from "./pages/Profile";
import HelpBigQuery from "./pages/HelpBigQuery";
import HelpSnowflake from "./pages/HelpSnowflake";
import ConnectResourcePicker from "./pages/ConnectResourcePicker";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import InviteJoin from "./pages/InviteJoin";

function Protected({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  // Carries the originally-requested path through login/register (read
  // back by both - see their own onSubmit) so a signed-out person clicking
  // a workspace invite link (or any other deep link) lands back on that
  // exact page right after signing in, instead of always bouncing to "/".
  if (!user) return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
  return children;
}

// The home route is public: a signed-out visitor sees the marketing
// landing page (so they can learn about the product before creating an
// account), while a signed-in user sees their real dashboard. This is
// intentionally NOT wrapped in Protected, unlike every other route below.
function Home() {
  const { user, loading } = useAuth();
  if (loading) return null;
  return user ? <Dashboard /> : <Landing />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/admin-login" element={<AdminLogin />} />
      <Route path="/" element={<Home />} />
      {/* Must be registered before "/workspace/:datasourceId" below would
          otherwise be ambiguous with it if this ever moved under
          /workspace - kept as its own top-level path instead so there's no
          risk of "new" ever being parsed as a real :datasourceId. */}
      <Route path="/project/new" element={<Protected><NewProject /></Protected>} />
      <Route path="/workspace/:datasourceId" element={<Protected><Workspace /></Protected>} />
      <Route path="/dashboards" element={<Protected><Dashboards /></Protected>} />
      <Route path="/dashboards/:dashboardId" element={<Protected><DashboardView /></Protected>} />
      <Route path="/data" element={<Protected><DataSources /></Protected>} />
      <Route path="/admin" element={<Protected><AdminDashboard /></Protected>} />
      <Route path="/profile" element={<Protected><Profile /></Protected>} />
      {/* Public and standalone (no <Protected> wrapper): opened in a new
          browser tab from the BigQuery connect popout, so it needs to work
          even in a fresh tab that may not carry an existing session yet. */}
      <Route path="/help/connect-bigquery" element={<HelpBigQuery />} />
      {/* Same idea, for the Snowflake connect popout. */}
      <Route path="/help/connect-snowflake" element={<HelpSnowflake />} />
      {/* Public and standalone: read before someone ever creates an
          account, and it's also what Google/Microsoft's OAuth verification
          reviewers check when this app requests Sheets/Excel/Drive/
          OneDrive access. Linked from the Landing footer and the
          Login/Register cards below. */}
      <Route path="/privacy" element={<PrivacyPolicy />} />
      {/* Where the browser lands after the Google/Microsoft OAuth redirect
          (see DataSourceForm.tsx's "Connect" tab) - genuinely protected
          (not a fresh, session-less tab like the BigQuery guide above),
          since it calls authenticated endpoints to list/finish a
          connection. A real browser redirect from Google/Microsoft always
          carries this app's normal cookie-less localStorage session along
          with it (same origin, same tab), so <Protected> here behaves
          exactly as it does on every other in-app route. */}
      <Route path="/connect/:provider" element={<Protected><ConnectResourcePicker /></Protected>} />
      {/* A workspace's shareable invite link - see routers/workspaces.py.
          Protected like any other in-app page: a signed-out visitor is
          bounced to /login first (state.from carries this exact URL back,
          see Protected above) and lands here again right after signing in
          or creating an account. */}
      <Route path="/invite/:token" element={<Protected><InviteJoin /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

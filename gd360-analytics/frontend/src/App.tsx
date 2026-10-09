import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./api/AuthContext";
import Login from "./pages/Login";
import Register from "./pages/Register";
import AdminLogin from "./pages/AdminLogin";
import Landing from "./pages/Landing";
import Dashboard from "./pages/Dashboard";
import Workspace from "./pages/Workspace";
import Dashboards from "./pages/Dashboards";
import NewDashboard from "./pages/NewDashboard";
import DashboardView from "./pages/DashboardView";
import DashboardBuilderView from "./pages/DashboardBuilderView";
import PublicDashboardView from "./pages/PublicDashboardView";
import DataSources from "./pages/DataSources";
import MLModels from "./pages/MLModels";
import MLStudio from "./pages/MLStudio";
import MLStudioNew from "./pages/MLStudioNew";
import MLStudioProject from "./pages/MLStudioProject";
import MLModelDetail from "./pages/MLModelDetail";
import Jobs from "./pages/Jobs";
import Automations from "./pages/Automations";
import AutomationEdit from "./pages/AutomationEdit";
import Experiments from "./pages/Experiments";
import Governance from "./pages/Governance";
import NewProject from "./pages/NewProject";
import AdminDashboard from "./pages/AdminDashboard";
import Profile from "./pages/Profile";
import HelpBigQuery from "./pages/HelpBigQuery";
import HelpSnowflake from "./pages/HelpSnowflake";
import ConnectResourcePicker from "./pages/ConnectResourcePicker";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import InviteJoin from "./pages/InviteJoin";
import HomePage from "./pages/Home";
import ProjectWorkspace from "./pages/ProjectWorkspace";
import ProjectDashboard from "./pages/ProjectDashboard";
import SpacePage from "./pages/SpacePage";
import CommandPalette from "./components/CommandPalette";
import ErrorBoundary from "./components/ErrorBoundary";

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
  // 2026-10-08 (round 11): signed in, "/" is the one-question Home; the
  // full Projects library (folders, bulk actions) moved to /projects.
  return user ? <HomePage /> : <Landing />;
}

// 2026-09-24 (Dashboard Builder Phase 4, white-label custom domains): this
// exact same built JS bundle is served by Render regardless of which
// hostname it's reached through - GD360's own onrender.com URL, OR any
// number of customers' own custom domains pointed at the same frontend
// static site (see backend/app/services/render_domains.py's own docstring
// for why they all resolve to ONE Render service). A hostname this app
// doesn't recognize as its own is therefore, by construction, someone's
// white-label custom domain - and that whole domain is dedicated to their
// one published dashboard (see the Dashboard Builder Spec's white-label
// section: "a customer points their own subdomain at their published
// dashboard"), so every path on it renders PublicDashboardView in its
// hostname-resolution mode (see that file's own module docstring),
// skipping the rest of this app's routes entirely - a stranger on a
// customer's own domain should never be able to reach GD360's own /login,
// /register, or anyone else's data by guessing a path.
function isRecognizedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1") return true;
  // Every real deployment of this app today is served from a Render
  // onrender.com static-site hostname - see get_service's own confirmed
  // service details in this round's build notes.
  if (h.endsWith(".onrender.com")) return true;
  return false;
}

export default function App() {
  // 2026-10-07: one boundary around every page, reset on navigation, so a
  // render error shows a notice instead of a blank screen (see
  // components/ErrorBoundary.tsx).
  const boundaryKey = useLocation().pathname;
  const hostname = typeof window !== "undefined" ? window.location.hostname : "";
  if (!isRecognizedHost(hostname)) {
    return <ErrorBoundary resetKey={boundaryKey}><PublicDashboardView /></ErrorBoundary>;
  }
  return (
    <>
      {/* 2026-09-25f (command palette round): mounted once here rather than
          by each page - it reads its own auth/workspace state and renders
          nothing (see its own `if (!user) return null`) on the signed-out
          routes above (Login/Register/Landing/etc.), so nothing below
          needs to know it exists. Opened by Cmd+K/Ctrl+K anywhere, or by
          the search button every authenticated page's TopNav now shows. */}
      <CommandPalette />
      <ErrorBoundary resetKey={boundaryKey}>
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
      {/* 2026-10-08 (round 11): multi-source Projects and their dashboards. */}
      <Route path="/projects" element={<Protected><Dashboard /></Protected>} />
      <Route path="/p/:projectId" element={<Protected><ProjectWorkspace /></Protected>} />
      <Route path="/project-dashboards/:dashboardId" element={<Protected><ProjectDashboard /></Protected>} />
      {/* 2026-10-09 (round 15): one Space - channel hub / overview. */}
      <Route path="/spaces/:id" element={<Protected><SpacePage /></Protected>} />
      <Route path="/workspace/:datasourceId" element={<Protected><Workspace /></Protected>} />
      <Route path="/dashboards" element={<Protected><Dashboards /></Protected>} />
      {/* 2026-10-07 (dashboard from a prompt): describe -> propose -> refine
          -> publish (Builder.dc.html). Listed before /dashboards/:dashboardId
          so "new" is never read as an id. */}
      <Route path="/dashboards/new" element={<Protected><NewDashboard /></Protected>} />
      <Route path="/dashboards/:dashboardId" element={<Protected><DashboardView /></Protected>} />
      {/* 2026-09-24 (Dashboard Builder Phase 1): the new pages+blocks kind
          of dashboard gets its own viewer at a deliberately different path
          from /dashboards/:dashboardId above, rather than branching inside
          DashboardView itself - the two kinds render completely differently
          (grid of typed blocks vs. a flat chart list) and keeping them as
          separate pages means neither one's code has to know the other
          exists. Dashboards.tsx picks which of the two links to render for
          a given row based on its layout_version. */}
      <Route path="/dashboard-builder/:dashboardId" element={<Protected><DashboardBuilderView /></Protected>} />
      {/* The public, no-login viewer a dashboard's "Publish" link points
          at - deliberately NOT wrapped in <Protected>, same reasoning as
          /help/connect-bigquery and /privacy below: this has to work for
          someone who has never signed in and never will. */}
      <Route path="/d/:slug" element={<PublicDashboardView />} />
      <Route path="/data" element={<Protected><DataSources /></Protected>} />
      {/* 2026-09-28 (ML Models round): the real ML feature - see
          AppSidebar.tsx's own nav entry for this, placed right after
          Data Sources. (The "Saved Tables" feature that used to sit here
          was removed the same day, once it turned out to duplicate a
          capability chat's own cross-datasource picker already provided
          for free, while confusingly sitting right next to this one.) */}
      {/* 2026-10-08 (round 13): ML Studio - goal -> plan -> training ->
          results. The older gallery + wizard stays at /ml-models/classic. */}
      <Route path="/ml-models" element={<Protected><MLStudio /></Protected>} />
      <Route path="/ml-models/classic" element={<Protected><MLModels /></Protected>} />
      <Route path="/ml-studio/new" element={<Protected><MLStudioNew /></Protected>} />
      <Route path="/ml-studio/:id" element={<Protected><MLStudioProject /></Protected>} />
      <Route path="/ml-models/:id" element={<Protected><MLModelDetail /></Protected>} />
      {/* 2026-09-28 (scheduled auto-refresh + background jobs round): the
          Jobs page - see AppSidebar.tsx's own nav entry for this, placed
          between Dashboards and Data Sources exactly like the sidebar.
          2026-09-30 (Governance/Jobs redesign + Pipelines/Catalog removal
          round, Gokul's own report): Jobs now has a second "Chains" tab
          that absorbs the standalone Pipelines page's own real capability
          (named, multi-step chains) - pages/Pipelines.tsx and its /pipelines
          route are gone (the backend router/services.pipelines are
          untouched; Jobs' Chains tab calls the exact same endpoints), and
          the /catalog route and its entire page are gone outright too,
          since that one genuinely duplicated the Projects filter and Data
          Sources page. */}
      <Route path="/jobs" element={<Protected><Jobs /></Protected>} />
      {/* 2026-10-08 (round 12): Automations - WHEN -> DO -> TELL. /jobs keeps
          the older dashboard schedules and pipelines reachable. */}
      <Route path="/automations" element={<Protected><Automations /></Protected>} />
      <Route path="/automations/new" element={<Protected><AutomationEdit /></Protected>} />
      <Route path="/automations/:automationId" element={<Protected><AutomationEdit /></Protected>} />
      {/* Phase 4 (2026-09-28, Experimentation / A/B testing): see
          AppSidebar.tsx's own nav entry for this, placed exactly like the
          sidebar. */}
      <Route path="/experiments" element={<Protected><Experiments /></Protected>} />
      {/* Phase 5, Batch A (2026-09-28, data governance & quality): see
          AppSidebar.tsx's own nav entry for this, placed right after
          Experiments exactly like the sidebar. Owner-only - the backend
          403s a non-owner, and Governance.tsx shows a plain message for
          that instead of a raw error. */}
      <Route path="/governance" element={<Protected><Governance /></Protected>} />
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
      </ErrorBoundary>
    </>
  );
}

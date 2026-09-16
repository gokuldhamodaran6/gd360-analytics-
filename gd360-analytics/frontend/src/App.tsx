import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./api/AuthContext";
import Login from "./pages/Login";
import Register from "./pages/Register";
import AdminLogin from "./pages/AdminLogin";
import Landing from "./pages/Landing";
import Dashboard from "./pages/Dashboard";
import Workspace from "./pages/Workspace";
import DashboardView from "./pages/DashboardView";
import AdminDashboard from "./pages/AdminDashboard";
import Profile from "./pages/Profile";

function Protected({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
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
      <Route path="/workspace/:datasourceId" element={<Protected><Workspace /></Protected>} />
      <Route path="/dashboards/:dashboardId" element={<Protected><DashboardView /></Protected>} />
      <Route path="/admin" element={<Protected><AdminDashboard /></Protected>} />
      <Route path="/profile" element={<Protected><Profile /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

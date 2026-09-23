import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { InvitePreview, workspaceApi } from "../api/client";
import ThemeToggle from "../components/ThemeToggle";
import { ACTIVE_WORKSPACE_KEY } from "../lib/useWorkspaceNav";

function UsersIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

// The landing page for a workspace's shareable invite link (see
// routers/workspaces.py preview_invite/join_via_invite) - reached at
// /invite/:token, always signed in by the time it renders (App.tsx's
// <Protected> bounces a signed-out visitor through /login or /register
// first and carries this exact URL back via location.state.from).
export default function InviteJoin() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError("");
    workspaceApi
      .previewInvite(token)
      .then(setPreview)
      .catch((err) => {
        setError(
          err?.response?.status === 404
            ? "This invite link is invalid or has been reset by the workspace owner."
            : "Couldn't load this invite. Please try again."
        );
      })
      .finally(() => setLoading(false));
  }, [token]);

  const enterWorkspace = (workspaceId: string) => {
    try {
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceId);
    } catch {
      // Falls back to whatever workspace was already active - not
      // catastrophic, just means the switch doesn't stick this one time.
    }
    navigate("/", { replace: true });
  };

  const join = async () => {
    if (!token || !preview) return;
    setJoining(true);
    setError("");
    try {
      const ws = await workspaceApi.joinInvite(token);
      enterWorkspace(ws.id);
    } catch {
      setError("Couldn't join this workspace. Please try again.");
      setJoining(false);
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
        </div>
        <div className="card p-8 text-center">
          {loading && <div className="text-sm text-muted py-6">Loading invite&hellip;</div>}

          {!loading && error && (
            <>
              <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5 mb-5 text-left">
                {error}
              </div>
              <button className="btn-secondary w-full" onClick={() => navigate("/")}>
                Go to your Projects
              </button>
            </>
          )}

          {!loading && !error && preview && (
            <>
              <div className="w-12 h-12 rounded-xl bg-primary/15 text-primary flex items-center justify-center mx-auto mb-4">
                <UsersIcon className="w-6 h-6" />
              </div>
              <h2 className="text-xl font-bold mb-1.5">
                {preview.already_member ? "You're already in" : "You've been invited to join"}
              </h2>
              <p className="text-lg font-semibold gradient-text mb-1">{preview.workspace_name}</p>
              <p className="text-sm text-muted mb-6">
                {preview.member_count} {preview.member_count === 1 ? "member" : "members"}
              </p>
              {preview.already_member ? (
                <button className="btn-primary w-full" onClick={() => enterWorkspace(preview.workspace_id)}>
                  Go to workspace
                </button>
              ) : (
                <button className="btn-primary w-full" disabled={joining} onClick={join}>
                  {joining ? "Joining…" : `Join ${preview.workspace_name}`}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

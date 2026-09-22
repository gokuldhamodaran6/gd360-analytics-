import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import ThemeToggle from "../components/ThemeToggle";
import { connectionsApi, datasourceApi, OAuthResource } from "../api/client";

// Where the browser lands after the Google/Microsoft OAuth redirect flow
// (see DataSourceForm.tsx's "Connect" tab and backend routers/
// connections.py) finishes step 2 - the person already approved access on
// Google's/Microsoft's own site; this page is where they pick WHICH
// spreadsheet/workbook GD360 should actually read, then hands off into the
// normal Workspace the same way every other connect flow does.
//
// Reached two different ways, both via a real browser redirect (never SPA
// navigation) so both need to work from a cold page load:
//   /connect/google_sheets?connection_id=... or /connect/microsoft_excel?connection_id=...
//   /connect/error?provider=...&reason=...  (consent was denied, or the
//     token exchange itself failed - see connections.py's callback)

const PROVIDER_LABEL: Record<string, string> = {
  google_sheets: "Google Sheets",
  microsoft_excel: "Excel (OneDrive)",
};

const REASON_MESSAGE: Record<string, string> = {
  access_denied: "Access wasn't approved, so nothing was connected.",
  missing_code: "The sign-in didn't finish - please try again.",
  bad_state: "This sign-in link expired or was already used - please try again.",
  token_exchange: "GD360 couldn't complete the sign-in with the details it got back - please try again.",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-base text-text">
      <div className="max-w-xl mx-auto px-4 sm:px-6 py-10">
        <div className="flex items-center justify-between mb-8">
          <Link to="/" className="font-bold text-lg tracking-tight">
            GD360 <span className="text-primary">Analytics</span>
          </Link>
          <ThemeToggle />
        </div>
        {children}
      </div>
    </div>
  );
}

// Top level: only ever reads the route/query params and picks which of the
// two panels below to render - it holds no state and calls no other hooks
// itself, so branching between an "error" URL and a real connection_id
// here (rather than inside ResourcePicker, which DOES hold state) never
// runs into React's "hooks must run in the same order every render" rule.
export default function ConnectResourcePicker() {
  const { provider } = useParams<{ provider: string }>();
  const [params] = useSearchParams();

  if (provider === "error") {
    return <ErrorPanel failedProvider={params.get("provider") || ""} reason={params.get("reason") || ""} />;
  }
  return <ResourcePicker provider={provider || ""} connectionId={params.get("connection_id") || ""} />;
}

function ErrorPanel({ failedProvider, reason }: { failedProvider: string; reason: string }) {
  const navigate = useNavigate();
  return (
    <Shell>
      <div className="card p-6 text-center">
        <div className="w-12 h-12 rounded-full bg-red-500/10 text-red-400 flex items-center justify-center mx-auto mb-4">
          <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v5M12 16h.01" />
          </svg>
        </div>
        <div className="font-bold text-lg mb-1">Couldn't connect{PROVIDER_LABEL[failedProvider] ? ` ${PROVIDER_LABEL[failedProvider]}` : ""}</div>
        <p className="text-sm text-muted mb-6">{REASON_MESSAGE[reason] || "Something went wrong during sign-in."}</p>
        <button type="button" className="btn-primary" onClick={() => navigate("/")}>
          Back to GD360
        </button>
      </div>
    </Shell>
  );
}

function ResourcePicker({ provider, connectionId }: { provider: string; connectionId: string }) {
  const navigate = useNavigate();
  const providerLabel = PROVIDER_LABEL[provider] || "your data";
  const [resources, setResources] = useState<OAuthResource[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<OAuthResource | null>(null);
  const [name, setName] = useState("");
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState("");
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async (searchTerm?: string) => {
    if (!connectionId) return;
    setLoading(true);
    setLoadError("");
    try {
      const result = await connectionsApi.listResources(connectionId, searchTerm);
      setResources(result.resources);
    } catch (err: any) {
      setLoadError(err?.response?.data?.detail || "Could not load your files - please try again.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!connectionId) {
      setLoadError("Missing connection - please start the connect flow again.");
      setLoading(false);
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  const onSearchChange = (value: string) => {
    setSearch(value);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => load(value || undefined), 400);
  };

  const pick = (r: OAuthResource) => {
    setSelected(r);
    setName(r.name);
    setFinishError("");
  };

  const cancel = async () => {
    if (connectionId) {
      try {
        await datasourceApi.delete(connectionId);
      } catch {
        // Best-effort cleanup only - an abandoned pending connection is
        // invisible everywhere else in the app either way (see backend
        // list_datasources), so a failed delete here is harmless.
      }
    }
    navigate("/");
  };

  const finish = async () => {
    if (!selected || !connectionId) return;
    setFinishing(true);
    setFinishError("");
    try {
      const ds = await connectionsApi.finish(connectionId, {
        name: name.trim() || selected.name,
        resource_id: selected.id,
        resource_name: selected.name,
        drive_id: selected.drive_id || undefined,
      });
      navigate(`/workspace/${ds.id}`);
    } catch (err: any) {
      setFinishError(err?.response?.data?.detail || "Could not finish connecting - please try again.");
    } finally {
      setFinishing(false);
    }
  };

  return (
    <Shell>
      <div className="mb-6">
        <div className="text-xs font-semibold uppercase tracking-wide text-primary mb-2">Live connection</div>
        <h1 className="text-2xl font-bold leading-tight mb-2">Pick a {providerLabel.toLowerCase()} to connect</h1>
        <p className="text-sm text-muted leading-relaxed">
          GD360 will read this live - any edits you make show up here automatically, with nothing to re-upload.
        </p>
      </div>

      <div className="card p-4">
        <input
          className="input mb-3"
          placeholder={`Search your ${providerLabel}...`}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />

        {loadError && (
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">{loadError}</div>
        )}

        {loading ? (
          <div className="text-sm text-muted py-8 text-center">Loading...</div>
        ) : resources && resources.length === 0 ? (
          <div className="text-sm text-muted py-8 text-center">
            No {providerLabel} files found{search ? " for that search" : ""}.
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto space-y-1.5 -mx-1 px-1">
            {(resources || []).map((r) => (
              <button
                type="button"
                key={r.id}
                onClick={() => pick(r)}
                className={`w-full flex items-center justify-between gap-3 text-left px-3 py-2.5 rounded-lg border transition ${
                  selected?.id === r.id ? "border-primary bg-primary/5" : "border-border hover:bg-surface2"
                }`}
              >
                <span className="min-w-0 flex-1 text-sm font-medium truncate">{r.name}</span>
                <span className="text-[11px] text-muted shrink-0">{timeAgo(r.modified_at)}</span>
              </button>
            ))}
          </div>
        )}

        {selected && (
          <div className="mt-5 pt-5 border-t border-border">
            <label className="text-sm text-muted mb-1 block">Name in GD360</label>
            <input className="input mb-3" value={name} onChange={(e) => setName(e.target.value)} placeholder={selected.name} />
            {finishError && (
              <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">{finishError}</div>
            )}
            <button type="button" className="btn-primary w-full" onClick={finish} disabled={finishing}>
              {finishing ? "Connecting..." : `Connect ${selected.name}`}
            </button>
          </div>
        )}
      </div>

      <div className="mt-6 text-center">
        <button type="button" onClick={cancel} className="text-sm font-medium text-muted hover:text-text">
          Cancel
        </button>
      </div>
    </Shell>
  );
}

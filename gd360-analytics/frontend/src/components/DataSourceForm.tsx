import { FormEvent, useState } from "react";
import { api } from "../api/client";

const DB_KINDS = [
  { value: "postgres", label: "PostgreSQL", defaultPort: 5432 },
  { value: "mysql", label: "MySQL / MariaDB", defaultPort: 3306 },
  { value: "mongodb", label: "MongoDB", defaultPort: 27017 },
];

export default function DataSourceForm({ onCreated }: { onCreated: () => void }) {
  const [mode, setMode] = useState<"db" | "file">("db");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // DB form state
  const [kind, setKind] = useState("postgres");
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(5432);
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [ssl, setSsl] = useState(true);

  // File form state
  const [fileName, setFileName] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const submitDb = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post("/datasources/database", { name, kind, host, port, database, username, password, ssl });
      onCreated();
      setName(""); setHost(""); setDatabase(""); setUsername(""); setPassword("");
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Could not connect. Check your credentials and network access.");
    } finally {
      setBusy(false);
    }
  };

  const submitFile = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("name", fileName || file.name);
      form.append("file", file);
      await api.post("/datasources/file", form, { headers: { "Content-Type": "multipart/form-data" } });
      onCreated();
      setFileName(""); setFile(null);
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Could not read file.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-6">
      <div className="flex gap-2 mb-5">
        <button className={`px-4 py-2 rounded-lg text-sm font-medium ${mode === "db" ? "bg-primary text-white" : "btn-secondary"}`} onClick={() => setMode("db")}>
          Connect a database
        </button>
        <button className={`px-4 py-2 rounded-lg text-sm font-medium ${mode === "file" ? "bg-primary text-white" : "btn-secondary"}`} onClick={() => setMode("file")}>
          Upload CSV / Excel
        </button>
      </div>

      {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-4">{error}</div>}

      {mode === "db" ? (
        <form onSubmit={submitDb} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className="text-sm text-muted mb-1 block">Connection name</label>
            <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Production Postgres" />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Database type</label>
            <select className="input" value={kind} onChange={(e) => {
              const k = e.target.value;
              setKind(k);
              const found = DB_KINDS.find((d) => d.value === k);
              if (found) setPort(found.defaultPort);
            }}>
              {DB_KINDS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Host</label>
            <input className="input" required value={host} onChange={(e) => setHost(e.target.value)} placeholder="db.example.com" />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Port</label>
            <input className="input" required type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Database name</label>
            <input className="input" required value={database} onChange={(e) => setDatabase(e.target.value)} />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Username</label>
            <input className="input" required value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Read-only user recommended" />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Password</label>
            <input className="input" required type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="flex items-center gap-2 mt-6">
            <input id="ssl" type="checkbox" checked={ssl} onChange={(e) => setSsl(e.target.checked)} />
            <label htmlFor="ssl" className="text-sm text-muted">Require SSL/TLS</label>
          </div>
          <div className="sm:col-span-2 text-xs text-muted bg-surface2 border border-border rounded-lg p-3">
            GD360 only ever runs read-only SELECT / find queries against your database, and your password is
            encrypted at rest. For extra safety, connect with a database user that only has SELECT privileges.
          </div>
          <div className="sm:col-span-2">
            <button className="btn-primary" type="submit" disabled={busy}>{busy ? "Connecting..." : "Test & connect"}</button>
          </div>
        </form>
      ) : (
        <form onSubmit={submitFile} className="space-y-4">
          <div>
            <label className="text-sm text-muted mb-1 block">Name</label>
            <input className="input" value={fileName} onChange={(e) => setFileName(e.target.value)} placeholder="Q3 sales export" />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">File (.csv, .xlsx, .xls)</label>
            <input className="input" type="file" accept=".csv,.xlsx,.xls" required onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </div>
          <button className="btn-primary" type="submit" disabled={busy}>{busy ? "Uploading..." : "Upload"}</button>
        </form>
      )}
    </div>
  );
}

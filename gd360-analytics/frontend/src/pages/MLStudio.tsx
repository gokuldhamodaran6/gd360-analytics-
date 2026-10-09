// 2026-10-08 (round 13): ML Studio home - start from a goal in words, see
// every model (training, ready or stopped).
// 2026-10-09 (round 14): choose what to learn from (any connected table or
// uploaded file), start from a table's suggested ideas, and no more side
// doors to the classic wizard or the Experiments page.
// 2026-10-09 (round 15): learn from a Space, one source, several sources
// joined or a file; all 21 kinds in a gallery with family filters; the
// model list as a table (kind, what it learns from, score, runs, use).
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import BrandTile from "../components/BrandTile";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { FAMILIES, FAMILY_COLOR, FAMILY_OF, Limits, metricLine, mlStudioApi, ProblemType, StudioProject, StudioTable, TYPE_LABEL } from "../api/mlStudio";
import { Space, spacesApi } from "../api/spaces";
import { timeAgo } from "../project/format";
import { FILE_KINDS, ideasFor } from "../ml/ideas";

type Mode = "all" | "space" | "source" | "join" | "file";

const MODES: { id: Mode; label: string }[] = [
  { id: "all", label: "All my data" },
  { id: "space", label: "A Space" },
  { id: "source", label: "One source" },
  { id: "join", label: "Several sources" },
  { id: "file", label: "A file" },
];

const SELECT = "h-10 min-w-0 max-w-full w-full sm:w-auto sm:min-w-[300px] rounded-ctl border border-border bg-base px-2.5 text-ui text-text";

export default function MLStudio() {
  const navigate = useNavigate();
  const { workspaces, activeWorkspaceId, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [items, setItems] = useState<StudioProject[] | null>(null);
  const [goal, setGoal] = useState("");
  const [error, setError] = useState("");
  const [tables, setTables] = useState<StudioTable[]>([]);
  const [types, setTypes] = useState<ProblemType[]>([]);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  // round 15: by default GD360 looks across everything this person can use;
  // a Space, one source, a join or a file narrow it on purpose
  const [mode, setMode] = useState<Mode>("all");
  const [spaceId, setSpaceId] = useState("");
  const [from, setFrom] = useState("");
  const [base, setBase] = useState("");
  const [file, setFile] = useState("");
  const [fam, setFam] = useState<string>("All");
  const [hint, setHint] = useState("");

  useEffect(() => {
    mlStudioApi
      .types()
      .then((t) => {
        setTables(t.tables);
        setTypes(t.types);
        setLimits(t.limits);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    spacesApi
      .list(activeWorkspaceId)
      .then((s) => {
        setSpaces(s);
        setSpaceId((cur) => cur || s[0]?.id || "");
      })
      .catch(() => setSpaces([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId]);

  useEffect(() => {
    mlStudioApi.list().then(setItems).catch(() => {
      setItems([]);
      setError("Couldn't load your models.");
    });
  }, []);

  useEffect(() => {
    if (!items?.some((p) => p.status === "training")) return;
    const t = setInterval(() => mlStudioApi.list().then(setItems).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [items]);

  const files = useMemo(() => tables.filter((t) => FILE_KINDS.has(t.kind)), [tables]);
  const space = spaces?.find((s) => s.id === spaceId) || null;

  /** The "learn from" part of a link to the new-project page. */
  const scope = (): URLSearchParams | null => {
    const q = new URLSearchParams();
    if (mode === "space" && spaceId) q.set("space", spaceId);
    if (mode === "source" && from) {
      const [sid, tbl] = from.split("::");
      q.set("source", sid);
      q.set("table", tbl);
    }
    if (mode === "file" && file) {
      const [sid, tbl] = file.split("::");
      q.set("source", sid);
      q.set("table", tbl);
    }
    if (mode === "join") {
      if (!base) return null;
      const [sid, tbl] = base.split("::");
      q.set("source", sid);
      q.set("table", tbl);
      q.set("join", "1");
      if (spaceId && space?.source_ids.includes(sid)) q.set("space", spaceId);
    }
    return q;
  };

  const go = () => {
    const q = scope();
    if (!q) {
      setHint("Pick the main table first - GD360 then finds the tables that share a key with it.");
      return;
    }
    if (goal.trim()) q.set("goal", goal.trim());
    navigate(`/ml-studio/new${q.toString() ? `?${q}` : ""}`);
  };
  const typeLink = (id: string) => {
    const q = scope() || new URLSearchParams();
    q.set("type", id);
    if (goal.trim()) q.set("goal", goal.trim());
    return `/ml-studio/new?${q}`;
  };
  const startFrom = (t: StudioTable, type: string) => navigate(`/ml-studio/new?${new URLSearchParams({ type, source: t.source_id, table: t.table })}`);
  const open = (p: StudioProject) => navigate(p.problem_type ? `/ml-studio/${p.id}` : `/ml-models/${p.id}`);

  const scopeNote = (() => {
    if (mode === "all")
      return `GD360 looks across all ${new Set(tables.map((t) => t.source_id)).size || "your"} sources you can use, picks the table that fits your goal and can join others on a shared key - you see the plan before anything trains.`;
    if (mode === "space") {
      if (!spaces?.length) return "Spaces group the sources one team works from. Make one on the Data page, then train on everything in it.";
      if (!space) return "Pick a Space.";
      if (!space.sources.length) return `The ${space.name} Space has no sources yet - add one on the Data page.`;
      const names = space.sources.map((s) => s.name);
      const list = names.length > 4 ? `${names.slice(0, 4).join(", ")} and ${names.length - 4} more` : names.join(", ").replace(/, ([^,]*)$/, " and $1");
      return `GD360 looks across ${list}, picks the table that fits your goal, and can join others on a shared key - you see the join before anything trains.`;
    }
    if (mode === "source")
      return `GD360 reads the whole table${limits ? ` - up to ${limits.max_rows.toLocaleString()} rows on this server` : ""} - and says so if it has to stop early. Never a silent sample.`;
    if (mode === "join") return "Pick the main table; GD360 finds the tables that share a key with it, shows how many rows match and what is lost before anything trains.";
    return "A file is profiled the moment it lands - types, empties, dates - so the plan is ready in seconds.";
  })();

  // one idea card per source first, so six cards show six different sources
  const ideaTables = useMemo(() => {
    // round 15: lookup tables (a synced app's accounts / owners / change log)
    // have a handful of rows - nothing to learn from; the tables that carry
    // events (posts, daily rows, orders, campaigns) come first.
    const LOOKUP = /^(accounts|owners|changes|campaigns_meta|pipelines|lists|payouts)$/i;
    const RICH = /(posts|daily|orders|order_lines|charges|deals|campaigns|tickets|events|sessions|traffic)/i;
    const withIdeas = tables
      .filter((t) => !LOOKUP.test(t.table) && ideasFor(t).length > 0)
      .sort((a, b) => Number(RICH.test(b.table)) - Number(RICH.test(a.table)));
    const seen = new Set<string>();
    const first = withIdeas.filter((t) => (seen.has(t.source_id) ? false : (seen.add(t.source_id), true)));
    const rest = withIdeas.filter((t) => !first.includes(t));
    return [...first, ...rest].slice(0, 6);
  }, [tables]);

  const shownTypes = types.filter((t) => fam === "All" || t.family === fam);

  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0">
        <TopNav hideLogo />
        <main className="px-4 sm:px-8 lg:px-10 py-8 max-w-[1200px] mx-auto flex flex-col gap-7">
          <header className="flex flex-col gap-2 max-w-[820px]">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">ML Studio</span>
            <h1 className="m-0 text-[28px] sm:text-[36px] font-semibold tracking-tight text-text text-balance leading-tight">
              Predict, forecast and discover — from any data you have
            </h1>
            <p className="m-0 text-body text-secondary">
              Say what you want to know and what to learn from: a file, one source, several sources joined, or a whole Space. GD360 picks the method, tests
              every model on rows it never saw and tells you what it left out and why.
            </p>
          </header>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              go();
            }}
            className="rounded-[20px] border border-border-strong bg-surface p-4 sm:p-5 flex flex-col gap-4"
            style={{ boxShadow: "0 0 0 5px rgb(var(--auto-do-fill) / 0.45)" }}
          >
            <label htmlFor="ml-goal" className="text-ui text-secondary">What do you want to know?</label>
            <textarea
              id="ml-goal"
              rows={2}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  go();
                }
              }}
              placeholder="Which customers will stop buying in the next 60 days — and what would keep them?"
              className="w-full resize-none bg-transparent border-0 outline-none text-[18px] sm:text-[20px] leading-snug text-text placeholder:text-faint"
            />
            <div className="flex flex-col gap-2.5 pt-3.5 border-t border-border">
              <span className="text-ui text-secondary" id="ml-learn-from">Learn from</span>
              <div className="flex gap-3 flex-wrap items-center">
                <div role="radiogroup" aria-labelledby="ml-learn-from" className="grid grid-cols-2 sm:flex [&>*:first-child]:col-span-2 sm:[&>*:first-child]:col-span-1 gap-0.5 p-[3px] rounded-[11px] border border-border bg-base w-full sm:w-auto">
                  {MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={mode === m.id}
                      onClick={() => {
                        setMode(m.id);
                        setHint("");
                      }}
                      className={`h-9 px-3 sm:px-3.5 rounded-[9px] text-ui whitespace-nowrap transition-colors ${mode === m.id ? "bg-subtle text-text" : "text-muted hover:text-text"}`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>

                {mode === "space" && (
                  <div className="flex gap-2 flex-wrap" role="radiogroup" aria-label="Space">
                    {spaces === null && <span className="text-ui text-muted">Loading Spaces…</span>}
                    {spaces?.length === 0 && (
                      <Link to="/data" className="text-ui text-muted underline hover:text-text">No Spaces yet - make one on the Data page</Link>
                    )}
                    {spaces?.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        role="radio"
                        aria-checked={spaceId === s.id}
                        onClick={() => setSpaceId(s.id)}
                        className={`inline-flex items-center gap-2 h-8 px-3 rounded-full border text-ui ${spaceId === s.id ? "text-text" : "border-border bg-base text-secondary hover:text-text"}`}
                        style={spaceId === s.id ? { borderColor: "rgb(var(--auto-do-border))", background: "rgb(var(--auto-do-fill))" } : undefined}
                      >
                        <span className="w-2 h-2 rounded-[3px]" style={{ background: s.color }} aria-hidden="true" />
                        {s.name}
                      </button>
                    ))}
                  </div>
                )}

                {mode === "source" && (
                  <>
                    <label htmlFor="ml-from-home" className="sr-only">Table to learn from</label>
                    <select id="ml-from-home" value={from} onChange={(e) => setFrom(e.target.value)} className={SELECT}>
                      <option value="">Let GD360 choose from all your data</option>
                      {tables.map((t) => (
                        <option key={`${t.source_id}::${t.table}`} value={`${t.source_id}::${t.table}`}>{t.source} · {t.table}</option>
                      ))}
                    </select>
                  </>
                )}

                {mode === "join" && (
                  <>
                    <label htmlFor="ml-base-home" className="sr-only">Main table - one row per case</label>
                    <select
                      id="ml-base-home"
                      value={base}
                      onChange={(e) => {
                        setBase(e.target.value);
                        setHint("");
                      }}
                      className={SELECT}
                    >
                      <option value="">Main table (one row per customer, order…)</option>
                      {tables.map((t) => (
                        <option key={`${t.source_id}::${t.table}`} value={`${t.source_id}::${t.table}`}>{t.source} · {t.table}</option>
                      ))}
                    </select>
                    <span className="text-caption text-muted">then pick the tables to join</span>
                  </>
                )}

                {mode === "file" && (
                  <>
                    {files.length > 0 && (
                      <>
                        <label htmlFor="ml-file-home" className="sr-only">Uploaded file</label>
                        <select id="ml-file-home" value={file} onChange={(e) => setFile(e.target.value)} className={SELECT}>
                          <option value="">Choose a file you uploaded</option>
                          {files.map((t) => (
                            <option key={`${t.source_id}::${t.table}`} value={`${t.source_id}::${t.table}`}>{t.source} · {t.table}</option>
                          ))}
                        </select>
                      </>
                    )}
                    <Link
                      to="/data?tab=catalog"
                      className="inline-flex items-center h-10 px-3.5 rounded-[11px] border border-dashed text-ui"
                      style={{ borderColor: "rgb(var(--auto-do-border))", color: "rgb(var(--auto-do))" }}
                    >
                      Upload a CSV or Excel file
                    </Link>
                  </>
                )}
              </div>
              <span className="text-caption text-muted">{scopeNote}</span>
              {hint && <span role="alert" className="text-caption text-warning">{hint}</span>}
            </div>
            <div className="flex justify-end">
              <button type="submit" className="btn-primary text-[15px] h-11 px-5 inline-flex items-center gap-2 w-full sm:w-auto justify-center">
                Make a plan
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M3 7h8M7.5 3.5L11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </form>

          {ideaTables.length > 0 && (
            <section className="flex flex-col gap-3" aria-labelledby="ml-ideas">
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <h2 id="ml-ideas" className="m-0 text-[18px] font-semibold text-text">Start from your data</h2>
                <span className="text-caption text-muted">GD360 reads each table's columns and suggests what it can learn</span>
              </div>
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 360px), 1fr))" }}>
                {ideaTables.map((t) => (
                  <article key={`${t.source_id}::${t.table}`} className="rounded-card border border-border bg-surface p-4 flex flex-col gap-3 min-w-0">
                    <div className="flex gap-3 items-center min-w-0">
                      <BrandTile kind={t.kind} name={t.source} size={36} />
                      <span className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-body font-semibold text-text truncate">{t.table}</span>
                        <span className="text-caption text-muted truncate">{t.source} · {t.columns.length} columns</span>
                      </span>
                    </div>
                    <div className="flex gap-1.5 flex-wrap">
                      {ideasFor(t).map((i) => (
                        <button
                          key={i.type}
                          type="button"
                          onClick={() => startFrom(t, i.type)}
                          className="h-[30px] px-2.5 rounded-[9px] border text-caption hover:brightness-110"
                          style={{ borderColor: "rgb(var(--auto-do-border))", background: "rgb(var(--auto-do-fill) / 0.5)", color: "rgb(var(--auto-do))" }}
                        >
                          {i.label}
                        </button>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {types.length > 0 && (
            <section className="flex flex-col gap-3.5" aria-labelledby="ml-kinds">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <h2 id="ml-kinds" className="m-0 text-[18px] font-semibold text-text">Or choose what to build · {types.length} kinds</h2>
                <div className="flex gap-1.5 flex-wrap" role="radiogroup" aria-label="Filter by family">
                  {["All", ...FAMILIES].map((f) => (
                    <button
                      key={f}
                      type="button"
                      role="radio"
                      aria-checked={fam === f}
                      onClick={() => setFam(f)}
                      className={`inline-flex items-center gap-2 h-8 px-3 rounded-full border text-ui ${fam === f ? "text-text" : "border-border bg-base text-secondary hover:text-text"}`}
                      style={fam === f ? { borderColor: "rgb(var(--auto-do-border))", background: "rgb(var(--auto-do-fill))" } : undefined}
                    >
                      <span className="w-2 h-2 rounded-[3px]" style={{ background: FAMILY_COLOR[f] || "rgb(var(--auto-do))" }} aria-hidden="true" />
                      {f}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 240px), 1fr))" }}>
                {shownTypes.map((t) => (
                  <Link
                    key={t.id}
                    to={typeLink(t.id)}
                    className="flex flex-col gap-1.5 p-3.5 rounded-[14px] border border-border bg-surface hover:border-border-strong hover:bg-subtle/40 min-h-[96px] min-w-0"
                  >
                    <span className="flex justify-between items-center gap-2">
                      <span className="text-[14.5px] font-semibold text-text">{t.title}</span>
                      <span className="w-2 h-2 rounded-[3px] shrink-0" style={{ background: FAMILY_COLOR[t.family] }} aria-hidden="true" />
                    </span>
                    <span className="text-caption text-secondary leading-snug">{t.sub}</span>
                    <span className="mt-auto font-mono text-[10.5px] tracking-[0.04em] text-muted">
                      {t.family}
                      {t.needs ? ` · ${t.needs}` : ""}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {error && <div role="alert" className="rounded-card border border-danger-border bg-danger-fill px-4 py-3 text-ui text-text">{error}</div>}

          <section className="flex flex-col gap-3" aria-labelledby="ml-models">
            <div className="flex justify-between items-baseline gap-3 flex-wrap">
              <h2 id="ml-models" className="m-0 text-[18px] font-semibold text-text">Your models{items ? ` · ${items.length}` : ""}</h2>
              <span className="text-caption text-muted">Every training run and comparison lives inside its project</span>
            </div>
            {!items && <div className="text-ui text-muted">Loading…</div>}
            {items && items.length === 0 && (
              <div className="rounded-card border border-dashed border-border-strong p-6 text-ui text-muted">
                No models yet. Describe what you want above, or pick one of the {types.length || 21} kinds.
              </div>
            )}
            {items && items.length > 0 && (
              <div className="overflow-x-auto rounded-card border border-border bg-surface">
                <table className="w-full border-collapse text-ui min-w-[820px] table-fixed">
                  <thead>
                    <tr className="text-left">
                      {(
                        [
                          ["Model", "w-[22%]"],
                          ["Kind", "w-[13%]"],
                          ["Learns from", "w-[17%]"],
                          ["Held-out score", "w-[16%]"],
                          ["Runs", "w-[8%]"],
                          ["In use", "w-[13%]"],
                          ["Status", "w-[11%]"],
                        ] as const
                      ).map(([h, w]) => (
                        <th key={h} scope="col" className={`${w} font-medium text-caption text-muted px-3 py-2.5 border-b border-border whitespace-nowrap ${h === "Held-out score" ? "text-right" : ""}`}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((p) => {
                      const fam = p.problem_type ? FAMILY_OF[p.problem_type] || "Predict" : "Predict";
                      const kindLabel = p.problem_type ? TYPE_LABEL[p.problem_type] || p.problem_type : p.task_type === "regression" ? "Number" : "Yes / no";
                      return (
                        <tr key={p.id} onClick={() => open(p)} className="cursor-pointer border-b border-border last:border-b-0 hover:bg-subtle/60">
                          <td className="px-3 py-3">
                            <Link
                              to={p.problem_type ? `/ml-studio/${p.id}` : `/ml-models/${p.id}`}
                              onClick={(e) => e.stopPropagation()}
                              className="block font-medium text-text truncate hover:underline"
                              title={p.name}
                            >
                              {p.name}
                            </Link>
                            <span className="block text-caption text-muted">{timeAgo(p.trained_at || p.created_at)}</span>
                          </td>
                          <td className="px-3 py-3 truncate">
                            <span className="inline-flex items-center gap-1.5 text-secondary">
                              <span className="w-2 h-2 rounded-[3px]" style={{ background: FAMILY_COLOR[fam] }} aria-hidden="true" />
                              {kindLabel}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-secondary" title={`${p.source || ""}${p.table ? ` · ${p.table}` : ""}${p.rows ? ` · ${p.rows.toLocaleString()} rows` : ""}`}>
                            <span className="block truncate">{p.source}</span>
                            <span className="block truncate text-caption text-muted">
                              {p.table || ""}
                              {p.rows ? ` · ${p.rows.toLocaleString()} rows` : ""}
                            </span>
                          </td>
                          <td className={`px-3 py-3 font-mono text-right truncate ${p.status === "failed" ? "text-danger" : "text-text"}`} title={metricLine(p)}>
                            {metricLine(p)}
                          </td>
                          <td className="px-3 py-3 font-mono text-secondary whitespace-nowrap">
                            {p.version || 1} run{(p.version || 1) === 1 ? "" : "s"}
                          </td>
                          <td className="px-3 py-3 text-secondary truncate">
                            {p.predictions > 0 ? `Scored ${p.predictions.toLocaleString()} time${p.predictions === 1 ? "" : "s"}` : <span className="text-muted">Not yet</span>}
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap">
                            <Status p={p} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

function Status({ p }: { p: StudioProject }) {
  const tone = p.status === "training" ? "rgb(var(--auto-tell))" : p.status === "failed" ? "rgb(var(--color-danger))" : "rgb(var(--auto-do))";
  const label = p.status === "training" ? "Training" : p.status === "failed" ? "Didn't finish" : "Ready";
  return (
    <span className="inline-flex items-center gap-2 text-ui" style={{ color: tone }}>
      <span className={`w-[7px] h-[7px] rounded-full ${p.status === "training" ? "animate-pulse" : ""}`} style={{ background: tone }} aria-hidden="true" />
      {label}
    </span>
  );
}

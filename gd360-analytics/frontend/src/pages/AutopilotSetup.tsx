// 2026-10-17 (R53): Autopilot setup - the business brain every plan starts from (website, products, audiences,
// each source's numbers with where they came from), the industry pack, the integrations (digest channels,
// conversions APIs, Teams, LinkedIn, Luma - secrets write-only), the morning digest, the nine-agent crew, the
// MCP server other agents can read initiatives through, and whether the pace ranges held.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import ThemeToggle from "../components/ThemeToggle";
import AppSidebar from "../components/AppSidebar";
import TopNav from "../components/TopNav";
import { useWorkspaceNav } from "../lib/useWorkspaceNav";
import { errorText } from "../api/initiatives";
import { API_URL } from "../api/client";
import { Agent, autopilotApi, Brain, Integrations, Pack } from "../api/autopilot";
import { Banner, CopyField, Field, fmt, Section, Stat } from "../initiatives/ui";
import { AgentTag } from "../autopilot/kit";
import { Seg } from "../eventos/kit";

type View = "brain" | "integrations" | "crew";

export default function AutopilotSetup() {
  const { workspaces, activeWorkspaceId: ws, switchWorkspace, handleWorkspaceCreated } = useWorkspaceNav();
  const [view, setView] = useState<View>(() => (["brain", "integrations", "crew"].includes(window.location.hash.slice(1)) ? window.location.hash.slice(1) as View : "brain"));
  const [err, setErr] = useState("");
  return (
    <div className="dash-shell flex min-h-screen">
      <AppSidebar workspaces={workspaces} activeWorkspaceId={ws} onWorkspaceSwitch={switchWorkspace} onWorkspaceCreated={handleWorkspaceCreated} />
      <div className="flex-1 min-w-0 flex flex-col">
        <TopNav breadcrumb={[{ label: "Initiatives", to: "/initiatives" }, { label: "Autopilot" }]} />
        <header className="flex flex-wrap justify-between items-end gap-4 px-4 sm:px-8 pt-7 pb-5 border-b border-border">
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Initiatives · Autopilot</span>
            <h1 className="m-0 text-[24px] font-semibold tracking-tight text-text">Autopilot setup</h1>
            <p className="m-0 text-ui text-secondary max-w-[680px]">What GD360 knows about your business, where it sends the morning digest, which platforms it talks to, and the agents that do the work inside your policy.</p>
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <ThemeToggle />
            <Seg items={[{ id: "brain", label: "Business brain" }, { id: "integrations", label: "Integrations & digest" }, { id: "crew", label: "Crew & MCP" }]}
              value={view} onChange={(v) => { setView(v); try { window.history.replaceState(null, "", `#${v}`); } catch { /* ignore */ } }} label="Autopilot setup" />
          </div>
        </header>
        <main className="px-4 sm:px-8 py-6 pb-20 flex flex-col gap-5 min-w-0">
          {err && <Banner kind="error" onClose={() => setErr("")}>{err}</Banner>}
          {ws && view === "brain" && <BrainView ws={ws} onError={setErr} />}
          {ws && view === "integrations" && <IntegrationsView ws={ws} onError={setErr} />}
          {ws && view === "crew" && <CrewView ws={ws} onError={setErr} />}
        </main>
      </div>
    </div>
  );
}

function BrainView({ ws, onError }: { ws: string; onError: (s: string) => void }) {
  const [b, setB] = useState<Brain | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [form, setForm] = useState({ website: "", about: "", products: "", voice: "", industry: "" });
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const fill = (x: Brain) => { setB(x); setForm({ website: x.website || "", about: x.about || "", products: (x.products || []).join(", "), voice: x.voice || "", industry: x.industry || "" }); };
  useEffect(() => {
    setB(null);
    autopilotApi.brain(ws).then(fill).catch((e) => onError(errorText(e, "Couldn't load the business brain.")));
    autopilotApi.packs().then(setPacks).catch(() => undefined);
  }, [ws, onError]);
  const refresh = async () => {
    setBusy("refresh"); setMsg("");
    try { fill(await autopilotApi.refreshBrain(ws, form.website.trim() || undefined)); setMsg("Read again: the website, every connected source and your finished initiatives. What you wrote by hand was kept."); }
    catch (e) { onError(errorText(e)); } finally { setBusy(""); }
  };
  const save = async () => {
    setBusy("save"); setMsg("");
    try {
      const body: Record<string, any> = {};
      if (form.website.trim() !== (b?.website || "")) body.website = form.website.trim();
      if (form.about.trim() !== (b?.about || "")) body.about = form.about.trim();
      if (form.voice.trim() !== (b?.voice || "")) body.voice = form.voice.trim();
      if (form.industry && form.industry !== (b?.industry || "")) body.industry = form.industry;
      const prods = form.products.split(",").map((x) => x.trim()).filter(Boolean);
      if (prods.join("|") !== (b?.products || []).join("|")) body.products = prods;
      fill(await autopilotApi.editBrain(ws, body as any));
      setMsg("Saved. A refresh never overwrites what you write here.");
    } catch (e) { onError(errorText(e)); } finally { setBusy(""); }
  };
  if (!b) return <div className="grid gap-4">{[200, 260].map((h, k) => <div key={k} className="rounded-card bg-surface2 animate-pulse" style={{ height: h }} />)}</div>;
  const pack = packs.find((p) => p.key === (form.industry || b.industry));
  return (
    <div className="flex flex-col gap-5" data-brain="">
      {msg && <Banner kind="good" onClose={() => setMsg("")}>{msg}</Banner>}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] items-start">
        <Section title="Your business" sub={`Every plan starts here. Last read ${b.refreshed_at ? new Date(b.refreshed_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "never"}.`}
          actions={<button type="button" className="btn-secondary text-sm" onClick={refresh} disabled={!!busy} data-brain-refresh="">{busy === "refresh" ? "Reading…" : "Read everything again"}</button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Website"><input className="input" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://yourcompany.com" data-brain-website="" /></Field>
            <Field label="Industry">
              <select className="input" value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} data-brain-industry="">
                <option value="">Pick one</option>{packs.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </Field>
          </div>
          <Field label="What you do" hint={b.edited.about ? "Written by you" : "Read from your website"}><textarea className="input min-h-[80px]" value={form.about} onChange={(e) => setForm({ ...form, about: e.target.value })} data-brain-about="" /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Products (comma separated)"><input className="input" value={form.products} onChange={(e) => setForm({ ...form, products: e.target.value })} /></Field>
            <Field label="Voice"><input className="input" value={form.voice} onChange={(e) => setForm({ ...form, voice: e.target.value })} placeholder="Plain, confident, no hype" /></Field>
          </div>
          <div><button type="button" className="btn-primary text-sm" onClick={save} disabled={!!busy} data-brain-save="">{busy === "save" ? "Saving…" : "Save"}</button></div>
        </Section>
        <Section title="Audiences" sub="Who you already reach. A plan for investors or candidates won't use your customer tiers.">
          {Object.keys(b.audiences || {}).length === 0 ? <p className="m-0 text-ui text-muted">None found yet. Add accounts in Accounts.</p> : (
            <div className="flex flex-col gap-3">
              {Object.entries(b.audiences).map(([k, a]: [string, any]) => (
                <div key={k} className="rounded-ctl border border-border p-3" data-audience={k}>
                  <div className="text-ui text-text font-medium capitalize">{k}</div>
                  <div className="text-caption text-secondary tabular-nums">{a.accounts ?? 0} accounts · {a.contacts ?? 0} contacts{a.tiers ? ` · ${Object.entries(a.tiers).map(([t, n]) => `${t === "unscored" ? "unscored" : `tier ${t}`} ${n}`).join(", ")}` : ""}</div>
                </div>
              ))}
            </div>
          )}
          {b.brand && <div className="text-caption text-muted">Brand read from the site: {typeof b.brand === "string" ? b.brand : JSON.stringify(b.brand).slice(0, 160)}</div>}
        </Section>
      </div>

      <Section title={`Facts · ${b.facts.length}`} sub="Numbers the planner may use, each with its source. Targets cite these, your history or a benchmark - or say they're an assumption.">
        {b.facts.length === 0 ? <p className="m-0 text-ui text-muted">Connect Instagram, LinkedIn, Meta or Google Ads, GA4 or HubSpot in <Link to="/data" className="text-brand-ink hover:underline">Data</Link> and the numbers appear here.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-caption tabular-nums min-w-[560px]" data-facts="">
              <thead><tr className="text-muted text-left"><th className="font-normal py-1.5">Fact</th><th className="font-normal text-right">Value</th><th className="font-normal pl-4">Source</th><th className="font-normal text-right">As of</th></tr></thead>
              <tbody>{b.facts.map((f) => (
                <tr key={f.key} className="border-t border-border"><td className="py-2 text-text">{f.label}</td><td className="text-right text-text">{fmt(f.value, f.unit)}</td>
                  <td className="pl-4 text-secondary">{f.source}</td><td className="text-right text-muted">{f.as_of || "—"}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Section>

      {pack && (
        <Section title={`${pack.label} pack`} sub="The initiatives that usually work in this industry, the channels, and the benchmarks a plan falls back to when you have no history.">
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="flex flex-col gap-2" data-pack={pack.key}>
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Start one</span>
              {pack.initiatives.map((x) => (
                <Link key={x.brief} to={`/initiatives/new?kind=${x.kind}&brief=${encodeURIComponent(x.brief)}`} className="ui-focus rounded-ctl border border-border px-3 py-2.5 hover:border-border-strong flex justify-between gap-3 text-ui text-text">
                  <span>{x.brief}</span><span className="text-caption text-muted shrink-0 capitalize">{x.kind}</span>
                </Link>
              ))}
              <span className="text-caption text-muted mt-1">Channels: {pack.channels.join(", ")} · Focus: {pack.focus.join(", ")}</span>
            </div>
            <div className="flex flex-col gap-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Benchmarks</span>
              {pack.benchmarks.map((m) => (
                <div key={m.key} className="flex justify-between gap-3 text-caption border-t border-border pt-2 first-of-type:border-t-0" data-benchmark={m.key}>
                  <span className="text-secondary">{m.key.replace(/_/g, " ")}<span className="block text-[11px] text-muted">{m.source}</span></span>
                  <span className="tabular-nums text-text shrink-0">{m.low}–{m.high} <span className="text-muted">(typ. {m.typical})</span></span>
                </div>
              ))}
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}

function SecretInput({ label, set, name, vals, setVals, hint }: { label: string; set: boolean; name: string; vals: Record<string, any>; setVals: (v: Record<string, any>) => void; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <input className="input" type="password" autoComplete="off" value={vals[name] ?? ""} onChange={(e) => setVals({ ...vals, [name]: e.target.value })}
        placeholder={set ? "Saved - type to replace" : "Not set"} data-secret={name} />
    </Field>
  );
}

function IntegrationsView({ ws, onError }: { ws: string; onError: (s: string) => void }) {
  const [st, setSt] = useState<Integrations | null>(null);
  const [vals, setVals] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [preview, setPreview] = useState<{ lines: string[]; sent?: any[] } | null>(null);
  const load = useCallback(() => { autopilotApi.integrations(ws).then((x) => { setSt(x); setVals({ ...x.plain }); }).catch((e) => onError(errorText(e))); }, [ws, onError]);
  useEffect(load, [load]);
  const save = async () => {
    setBusy("save"); setMsg("");
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(vals)) if (v !== "" && v !== undefined) out[k] = k === "digest_hour" ? Number(v) : v;
    try { const x = await autopilotApi.saveIntegrations(ws, out); setSt(x); setVals({ ...x.plain }); setMsg("Saved. Secrets are encrypted and never shown again."); }
    catch (e) { onError(errorText(e)); } finally { setBusy(""); }
  };
  const digest = async (send: boolean) => {
    setBusy(send ? "send" : "preview");
    try { setPreview(await autopilotApi.digest(ws, send)); } catch (e) { onError(errorText(e)); } finally { setBusy(""); }
  };
  if (!st) return <div className="h-60 rounded-card bg-surface2 animate-pulse" />;
  const P = (name: string, label: string, ph = "", hint?: string) => (
    <Field label={label} hint={hint}><input className="input" value={vals[name] ?? ""} onChange={(e) => setVals({ ...vals, [name]: e.target.value })} placeholder={ph} data-plain={name} /></Field>
  );
  const On = ({ on }: { on: boolean }) => <span className={`text-caption ${on ? "text-good" : "text-muted"}`} data-connected={on ? "yes" : "no"}>{on ? "● Connected" : "○ Not set up"}</span>;
  const luma = st.luma_hook ? `${API_URL}/public/autopilot/luma/${st.luma_hook}?code=YOURCODE` : null;
  return (
    <div className="flex flex-col gap-5" data-integrations="">
      {msg && <Banner kind="good" onClose={() => setMsg("")}>{msg}</Banner>}
      <Section title="Morning digest" sub="One message a day: what waits for you, what the agents did overnight, and what's behind." actions={<On on={st.digest.on} />}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Send it"><select className="input" value={String(vals.digest_on ?? st.digest.on)} onChange={(e) => setVals({ ...vals, digest_on: e.target.value === "true" })}><option value="true">Every morning</option><option value="false">Off</option></select></Field>
          <Field label="Hour"><select className="input" value={String(vals.digest_hour ?? st.digest.hour)} onChange={(e) => setVals({ ...vals, digest_hour: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}</select></Field>
          {P("digest_timezone", "Time zone", "Asia/Kolkata")}
          {P("digest_email", "Email to (blank = your login email)", "you@company.com")}
          <SecretInput label="Slack incoming webhook" set={st.digest.slack} name="slack_webhook" vals={vals} setVals={setVals} />
          <SecretInput label="Teams incoming webhook" set={st.digest.teams} name="teams_webhook" vals={vals} setVals={setVals} />
        </div>
        <details className="text-ui">
          <summary className="cursor-pointer text-caption text-secondary">WhatsApp (needs an approved message template) {st.digest.whatsapp ? "· connected" : ""}</summary>
          <div className="grid gap-3 sm:grid-cols-2 mt-3">
            <SecretInput label="WhatsApp Cloud API token" set={st.digest.whatsapp} name="whatsapp_token" vals={vals} setVals={setVals} />
            {P("whatsapp_phone_id", "Phone number ID")}
            {P("whatsapp_to", "Send to (with country code)", "+91…")}
            {P("whatsapp_template", "Approved template name", "daily_digest", "Meta requires a pre-approved template for business-started messages.")}
          </div>
        </details>
        <div className="flex gap-2 flex-wrap">
          <button type="button" className="btn-secondary text-sm" onClick={() => digest(false)} disabled={!!busy} data-digest-preview="">{busy === "preview" ? "Building…" : "Preview today's digest"}</button>
          <button type="button" className="btn-secondary text-sm" onClick={() => digest(true)} disabled={!!busy} data-digest-send="">{busy === "send" ? "Sending…" : "Send it now"}</button>
        </div>
        {preview && (
          <div className="rounded-ctl border border-border bg-surface2/50 p-3.5 flex flex-col gap-1.5" data-digest-lines="">
            {preview.lines.map((l, k) => <span key={k} className="text-ui text-text">{l}</span>)}
            {preview.sent && <span className="text-caption text-muted">Sent: {preview.sent.map((x: any) => `${x.channel || x.platform}: ${x.ok ? "ok" : x.why || "failed"}`).join(" · ") || "no channel set up"}</span>}
          </div>
        )}
      </Section>

      <Section title="Conversions back to the ad platforms" sub="Each registration is sent back to the platform that brought it, so Meta, LinkedIn and Google optimise for real sign-ups. Emails are hashed (SHA-256) before they leave.">
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="flex flex-col gap-3"><div className="flex justify-between"><span className="text-ui font-medium text-text">Meta Conversions API</span><On on={st.meta_capi} /></div>
            {P("meta_pixel_id", "Pixel (dataset) ID")}<SecretInput label="Access token" set={st.meta_capi} name="meta_capi_token" vals={vals} setVals={setVals} /></div>
          <div className="flex flex-col gap-3"><div className="flex justify-between"><span className="text-ui font-medium text-text">LinkedIn Conversions API</span><On on={st.linkedin_capi} /></div>
            {P("linkedin_conversion_rule", "Conversion rule ID")}<SecretInput label="Access token" set={st.linkedin_capi} name="linkedin_capi_token" vals={vals} setVals={setVals} /></div>
          <div className="flex flex-col gap-3"><div className="flex justify-between"><span className="text-ui font-medium text-text">Google Ads</span><On on={st.google_ads} /></div>
            {P("google_ads_customer_id", "Customer ID", "123-456-7890")}{P("google_ads_conversion_action", "Conversion action ID")}{P("google_ads_client_id", "OAuth client ID")}
            <SecretInput label="OAuth client secret" set={st.google_ads} name="google_ads_client_secret" vals={vals} setVals={setVals} />
            <SecretInput label="Refresh token" set={st.google_ads} name="google_ads_refresh_token" vals={vals} setVals={setVals} />
            <SecretInput label="Developer token" set={st.google_ads} name="google_ads_developer_token" vals={vals} setVals={setVals} hint="Needs Basic access from Google. Only registrations that arrived with a gclid can be sent." /></div>
        </div>
        {st.last._last_capi && <span className="text-caption text-muted">Last sent {new Date(st.last._last_capi.at).toLocaleString()}: {(st.last._last_capi.results || []).map((r: any) => `${r.platform} ${r.ok ? "ok" : r.status || "failed"}`).join(" · ")}</span>}
      </Section>

      <div className="grid gap-5 lg:grid-cols-3 items-start">
        <Section title="Microsoft Teams" sub="Attendance pulled from Graph after a Teams webinar." actions={<On on={st.teams_graph} />}>
          {P("graph_tenant_id", "Tenant ID")}{P("graph_client_id", "App (client) ID")}
          <SecretInput label="Client secret" set={st.teams_graph} name="graph_client_secret" vals={vals} setVals={setVals} hint="Application permission OnlineMeetingArtifact.Read.All and an application access policy." />
        </Section>
        <Section title="LinkedIn @mentions" sub="Other people's posts that mention your page." actions={<On on={st.linkedin_mentions} />}>
          {P("linkedin_org_id", "Company page (organization) ID")}
          <SecretInput label="Token with Community Management access" set={st.linkedin_mentions} name="linkedin_token" vals={vals} setVals={setVals} hint="LinkedIn grants this only after its app review." />
        </Section>
        <Section title="Luma" sub="Registrations and check-ins from Luma count for the initiative whose code you put in the URL.">
          {luma ? <CopyField value={luma} label="Luma webhook URL" testId="luma" /> : <span className="text-caption text-muted">Save once to get your webhook URL.</span>}
          <span className="text-caption text-muted">In Luma (Plus plan): Settings → Webhooks → add this URL, replacing YOURCODE with the initiative's code from its Evidence tab.</span>
        </Section>
      </div>
      <div className="sticky bottom-4 flex justify-end"><button type="button" className="btn-primary text-sm shadow-pop" onClick={save} disabled={busy === "save"} data-integrations-save="">{busy === "save" ? "Saving…" : "Save integrations"}</button></div>
    </div>
  );
}

function CrewView({ ws, onError }: { ws: string; onError: (s: string) => void }) {
  const [crew, setCrew] = useState<{ crew: Agent[]; mcp: { url: string; tools: string[] } } | null>(null);
  const [bt, setBt] = useState<Awaited<ReturnType<typeof autopilotApi.backtest>> | null>(null);
  useEffect(() => {
    autopilotApi.crew(ws).then(setCrew).catch((e) => onError(errorText(e)));
    autopilotApi.backtest(ws).then(setBt).catch(() => undefined);
  }, [ws, onError]);
  const mcpUrl = `${API_URL}${crew?.mcp.url || "/mcp"}`;
  return (
    <div className="flex flex-col gap-5" data-crew="">
      <Section title="The crew" sub="Nine agents, each with one job. What they may do alone is set per initiative in its Pace tab; budgets and outside emails always ask.">
        {!crew ? <div className="h-60 rounded-ctl bg-surface2 animate-pulse" /> : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {crew.crew.map((a) => (
              <div key={a.key} className="rounded-ctl border border-border p-4 flex flex-col gap-2" data-crew-agent={a.key}>
                <AgentTag agent={a.key} />
                <p className="m-0 text-ui text-text leading-snug">{a.does}</p>
                <div className="text-caption text-secondary"><b className="font-medium text-good">Alone:</b> {a.alone.join("; ")}</div>
                <div className="text-caption text-secondary"><b className="font-medium text-warning">Asks:</b> {a.asks.join("; ")}</div>
                <div className="mt-auto pt-2 border-t border-border text-caption text-muted tabular-nums">30 days: {a.last_30_days.done_alone} alone · {a.last_30_days.asked} asked · {a.last_30_days.undone} undone</div>
              </div>
            ))}
          </div>
        )}
      </Section>
      <div className="grid gap-5 lg:grid-cols-2 items-start">
        <Section title="MCP server" sub="Other agents (Claude, ChatGPT, your own) can read your initiatives with your GD360 token. Read-only.">
          <CopyField value={mcpUrl} label="MCP URL" testId="mcp" />
          <span className="text-caption text-muted">Streamable HTTP, JSON responses. Send <code className="font-mono">Authorization: Bearer &lt;your GD360 token&gt;</code>. Tools: {crew?.mcp.tools.join(", ") || "…"}.</span>
        </Section>
        <Section title="Did the pace ranges hold?" sub="On finished initiatives: the 80% range at the halfway point against where each target really landed.">
          {!bt ? <div className="h-24 rounded-ctl bg-surface2 animate-pulse" /> : bt.tested === 0 ? <p className="m-0 text-ui text-muted">Nothing finished with enough daily history yet. This fills in as initiatives finish.</p> : (
            <div className="flex flex-col gap-3" data-backtest="">
              <div className="grid grid-cols-3 gap-4"><Stat label="Targets tested" value={bt.tested} /><Stat label="Landed in range" value={bt.held} /><Stat label="Coverage" value={bt.coverage !== null ? `${Math.round(100 * bt.coverage)}%` : "—"} hint="An honest 80% range holds about 80% of the time" /></div>
              {bt.verdict && <p className="m-0 text-caption text-secondary">{bt.verdict}</p>}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

// Mission Control · Flags & announcements — who sees new work, and what we
// tell them inside the app.
import { useEffect, useRef, useState } from "react";
import { errText, mcDelete, mcPatch, mcPost, useMC } from "../api";
import { ActionButton, ago, Card, Empty, ErrorBox, fmtN, Loading, Modal, PageHead, Pill, Seg, useCan, useToast } from "../ui";

const NO = "Your role can't do this";

/** On/off switch that runs an async action and toasts on failure. */
function Toggle({ on, label, disabled, title, onToggle }: { on: boolean; label: string; disabled?: boolean; title?: string; onToggle: (next: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={title} disabled={disabled || busy}
      onClick={async () => {
        setBusy(true);
        try { await onToggle(!on); } catch (e) { toast(errText(e, "That didn't work."), true); } finally { setBusy(false); }
      }}
      style={{ width: 44, height: 26, borderRadius: 26, border: 0, cursor: disabled ? "not-allowed" : "pointer", position: "relative", flex: "none",
        background: on ? "#43E5A0" : "#2A3436", opacity: disabled ? 0.45 : busy ? 0.7 : 1 }}>
      <span style={{ position: "absolute", top: 4, left: on ? 22 : 4, width: 18, height: 18, borderRadius: 18, background: "#07090A", transition: "left .15s" }} />
    </button>
  );
}

function FlagRow({ f, segments, canEdit, reload }: { f: any; segments: any[]; canEdit: boolean; reload: () => void }) {
  const [pct, setPct] = useState<number>(f.rollout_pct ?? 0);
  const committed = useRef<number>(f.rollout_pct ?? 0);
  const toast = useToast();
  useEffect(() => { setPct(f.rollout_pct ?? 0); committed.current = f.rollout_pct ?? 0; }, [f.rollout_pct]);
  const patch = async (body: any) => { await mcPatch(`/flags/${encodeURIComponent(f.key)}`, body); reload(); };
  // commit on release (pointer up / key up / blur) — the ref stops a double save
  const commitPct = async () => {
    if (pct === committed.current) return;
    const before = committed.current;
    committed.current = pct;
    try {
      await patch({ rollout_pct: pct });
      toast(`${f.name}: rollout ${pct}%`);
    } catch (e) {
      committed.current = before;
      setPct(before);
      toast(errText(e, "Couldn't change rollout."), true);
    }
  };
  const t = canEdit ? undefined : NO;
  return (
    <tr>
      <td>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, maxWidth: 280 }}>
          <span style={{ fontWeight: 700 }}>{f.name}</span>
          <span className="mc-mono" style={{ fontSize: 11, color: "var(--ink3)" }}>{f.key}</span>
          {f.description && <span className="mc-tip">{f.description}</span>}
        </div>
      </td>
      <td><Toggle on={f.enabled} label={`${f.enabled ? "Turn off" : "Turn on"} ${f.name}`} disabled={!canEdit} title={t} onToggle={(v) => patch({ enabled: v })} /></td>
      <td style={{ minWidth: 190 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input type="range" min={0} max={100} step={5} value={pct} disabled={!canEdit} title={t} aria-label={`Rollout for ${f.name}`}
            style={{ accentColor: "#43E5A0", width: "100%" }}
            onChange={(e) => setPct(Number(e.target.value))} onPointerUp={commitPct} onKeyUp={commitPct} onBlur={commitPct} />
          <span className="mc-mono mc-num" style={{ width: 40, textAlign: "right" }}>{pct}%</span>
        </div>
      </td>
      <td><Toggle on={f.staff_only} label={`Staff only for ${f.name}`} disabled={!canEdit} title={t} onToggle={(v) => patch({ staff_only: v })} /></td>
      <td>
        <select className="mc-select" style={{ height: 32, maxWidth: 190 }} value={f.segment_id || ""} disabled={!canEdit} title={t} aria-label={`Audience for ${f.name}`}
          onChange={async (e) => {
            try { await patch({ segment_id: e.target.value || null }); toast(`${f.name}: audience updated`); } catch (err) { toast(errText(err, "Couldn't change audience."), true); }
          }}>
          <option value="">Everyone</option>
          {segments.map((s) => <option key={s.id} value={s.id}>{s.name} · {fmtN(s.count)}</option>)}
        </select>
      </td>
      <td className="mc-mono mc-num">{f.staff_only ? <Pill tone="b">staff only</Pill> : fmtN(f.exposed_estimate)}</td>
      <td><span className="mc-tip">{f.owner_email || "—"}<br />{ago(f.updated_at)}</span></td>
      <td>
        <ActionButton className="mc-btn sm d" disabled={!canEdit} title={t} confirm="Delete flag?" done={`Deleted ${f.key}`}
          run={async () => { await mcDelete(`/flags/${encodeURIComponent(f.key)}`); reload(); }}>Delete</ActionButton>
      </td>
    </tr>
  );
}

function NewFlag({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  useEffect(() => { if (open) { setKey(""); setName(""); setDesc(""); } }, [open]);
  const keyOk = /^[a-z0-9_.-]{2,60}$/.test(key);
  return (
    <Modal open={open} onClose={onClose} title="New flag">
      <span className="mc-tip">New flags start off at 0%. Turn them on and roll out from the table.</span>
      <label className="mc-field">Key
        <input className="mc-input mc-mono" value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} placeholder="e.g. charts.v3" autoFocus />
        <span className="mc-tip" style={{ color: key && !keyOk ? "var(--red)" : undefined }}>Lowercase letters, numbers, dots, dashes and underscores. The code checks this key.</span>
      </label>
      <label className="mc-field">Name
        <input className="mc-input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. New chart engine" />
      </label>
      <label className="mc-field">What it does (optional)
        <textarea className="mc-textarea" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} />
      </label>
      <ActionButton className="mc-btn p" disabled={!keyOk || name.trim().length < 2} done="Flag created" run={async () => {
        await mcPost("/flags", { key, name: name.trim(), description: desc.trim() || null });
        onClose();
        onSaved();
      }}>Create flag</ActionButton>
    </Modal>
  );
}

/** How the announcement looks inside GD360 (Obsidian app chrome). */
function Preview({ kind, title, body, cta }: { kind: "banner" | "modal"; title: string; body: string; cta: string }) {
  const T = title.trim() || "Your headline";
  const B = body.trim();
  const ctaPill = cta.trim() && (
    <span style={{ alignSelf: kind === "modal" ? "flex-start" : undefined, height: 30, padding: "0 12px", borderRadius: 999, background: "#43E5A0", color: "#04140D", fontSize: 12.5, fontWeight: 700, display: "inline-flex", alignItems: "center", flex: "none" }}>{cta.trim()}</span>
  );
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 16, overflow: "hidden", background: "#07090A" }} aria-label="Preview">
      <div style={{ height: 30, display: "flex", alignItems: "center", gap: 6, padding: "0 12px", borderBottom: "1px solid var(--line0)" }}>
        {[0, 1, 2].map((i) => <span key={i} style={{ width: 9, height: 9, borderRadius: 9, background: "#2A3436" }} />)}
        <span className="mc-mono" style={{ marginLeft: 8, fontSize: 11, color: "var(--ink3)" }}>GD360 · Home</span>
      </div>
      {kind === "banner" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", padding: "12px 14px", background: "#132320", borderBottom: "1px solid #24413A" }}>
          <span style={{ flex: "1 1 220px", fontSize: 13, lineHeight: 1.45 }}><b>{T}</b>{B ? ` ${B}` : ""}</span>
          {ctaPill}
          <span aria-hidden="true" style={{ color: "var(--ink3)", fontSize: 15 }}>×</span>
        </div>
      )}
      <div style={{ position: "relative", padding: 22, display: "flex", flexDirection: "column", gap: 10, minHeight: 200 }}>
        <span style={{ fontSize: 18, fontWeight: 800 }}>What do you want to know?</span>
        <div style={{ height: 40, borderRadius: 12, border: "1px solid var(--line)", background: "var(--s1)" }} />
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ height: 60, flex: 1, borderRadius: 12, background: "var(--s1)" }} />
          <div style={{ height: 60, flex: 1, borderRadius: 12, background: "var(--s1)" }} />
        </div>
        {kind === "modal" && (
          <div style={{ position: "absolute", inset: 0, background: "rgba(3,5,6,.7)", display: "grid", placeItems: "center", padding: 16 }}>
            <div style={{ maxWidth: 320, width: "100%", padding: 18, borderRadius: 16, border: "1px solid #24413A", background: "#0B0F10", display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontWeight: 800, fontSize: 16 }}>{T}</span>
              {B && <span style={{ fontSize: 13, color: "var(--ink2)", lineHeight: 1.5 }}>{B}</span>}
              {ctaPill}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({ segments, users, onSaved }: { segments: any[]; users: number; onSaved: () => void }) {
  const can = useCan();
  const ok = can("announce.write");
  const [kind, setKind] = useState<"banner" | "modal">("banner");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [ctaLabel, setCtaLabel] = useState("");
  const [ctaUrl, setCtaUrl] = useState("");
  const [seg, setSeg] = useState("");
  const urlOk = !ctaUrl.trim() || ctaUrl.trim().startsWith("/") || ctaUrl.trim().startsWith("https://");
  const valid = title.trim().length >= 2 && urlOk && (!ctaLabel.trim() || !!ctaUrl.trim());
  const reach = seg ? segments.find((s) => s.id === seg)?.count ?? 0 : users;
  const send = async (status: "draft" | "live") => {
    await mcPost("/announcements", {
      kind, title: title.trim(), body: body.trim() || null, cta_label: ctaLabel.trim() || null, cta_url: ctaUrl.trim() || null,
      segment_id: seg || null, status,
    });
    setTitle(""); setBody(""); setCtaLabel(""); setCtaUrl("");
    onSaved();
  };
  return (
    <div className="mc-row">
      <Card title="COMPOSE AN ANNOUNCEMENT" style={{ flex: "1 1 420px" }}>
        <Seg<"banner" | "modal"> label="Type" value={kind} onChange={setKind} options={[["banner", "Banner"], ["modal", "Modal"]]} />
        <label className="mc-field">Headline
          <input className="mc-input" value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Pricing is coming soon" />
        </label>
        <label className="mc-field">Message
          <textarea className="mc-textarea" rows={3} maxLength={600} value={body} onChange={(e) => setBody(e.target.value)} placeholder="One or two short sentences." />
        </label>
        <div className="mc-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
          <label className="mc-field">Button label (optional)
            <input className="mc-input" value={ctaLabel} maxLength={40} onChange={(e) => setCtaLabel(e.target.value)} placeholder="e.g. Learn more" />
          </label>
          <label className="mc-field">Button link
            <input className="mc-input mc-mono" value={ctaUrl} maxLength={300} onChange={(e) => setCtaUrl(e.target.value)} placeholder="/pricing or https://…"
              style={{ borderColor: urlOk ? undefined : "var(--red)" }} />
          </label>
        </div>
        {!urlOk && <span className="mc-tip" style={{ color: "var(--red)" }}>Links must start with / or https://</span>}
        {urlOk && ctaLabel.trim() && !ctaUrl.trim() && <span className="mc-tip" style={{ color: "var(--amber)" }}>Add a link for the button.</span>}
        <label className="mc-field">Audience
          <select className="mc-select" value={seg} onChange={(e) => setSeg(e.target.value)}>
            <option value="">Everyone · {fmtN(users)} people</option>
            {segments.map((s) => <option key={s.id} value={s.id}>{s.name} · {fmtN(s.count)} people</option>)}
          </select>
        </label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <ActionButton className="mc-btn p" disabled={!ok || !valid} title={ok ? undefined : NO} confirm={`Show this to ${fmtN(reach)} people now?`} done="Announcement is live"
            run={() => send("live")}>Publish now</ActionButton>
          <ActionButton className="mc-btn" disabled={!ok || !valid} title={ok ? undefined : NO} done="Draft saved" run={() => send("draft")}>Save draft</ActionButton>
          <span className="mc-mono" style={{ fontSize: 12, color: "var(--ink3)" }}>reaches {fmtN(reach)} people</span>
        </div>
      </Card>
      <Card title="LIVE PREVIEW · AS PEOPLE SEE IT IN GD360" style={{ flex: "1 1 420px" }}>
        <Preview kind={kind} title={title} body={body} cta={ctaLabel} />
        <span className="mc-tip">{kind === "banner" ? "A strip across the top of the app." : "A card over the page."} It keeps showing until each person dismisses it.</span>
      </Card>
    </div>
  );
}

const ANN_TONE: Record<string, "g" | "b" | undefined> = { live: "g", draft: "b" };

export default function Flags() {
  const fl = useMC<any>("/flags");
  const an = useMC<any>("/announcements");
  const [newFlag, setNewFlag] = useState(false);
  const can = useCan();
  const canFlags = can("flags.write");
  const canAnn = can("announce.write");
  const reloadAll = () => { fl.reload(); an.reload(); };
  const segments = fl.data?.segments || [];

  return (
    <div className="mc-page">
      <PageHead eyebrow="Product · release and messaging" title="Flags & announcements"
        sub="Flags decide who sees new work. Announcements tell the right people at the right moment.">
        <button type="button" className="mc-btn p" disabled={!canFlags} title={canFlags ? undefined : NO} onClick={() => setNewFlag(true)}>New flag</button>
        <button type="button" className="mc-btn" onClick={reloadAll}>Refresh</button>
      </PageHead>

      {fl.error && <ErrorBox text={fl.error} retry={fl.reload} />}
      {fl.loading && !fl.data && <Loading rows={3} />}
      {fl.data && (
        <Card title={`FEATURE FLAGS · ${fl.data.flags.filter((f: any) => f.enabled).length} ON OF ${fl.data.flags.length}`}
          right={<span className="mc-tip">Exposed = estimated people who see it: audience × rollout.</span>}>
          {fl.data.flags.length === 0 ? <Empty>No flags yet. Create one to ship new work to a slice of people first.</Empty> : (
            <div className="mc-tablewrap">
              <table className="mc-table" style={{ minWidth: 1080 }}>
                <thead><tr><th>FLAG</th><th>ON</th><th>ROLLOUT</th><th>STAFF ONLY</th><th>AUDIENCE</th><th>EXPOSED</th><th>OWNER</th><th></th></tr></thead>
                <tbody>
                  {fl.data.flags.map((f: any) => <FlagRow key={f.key} f={f} segments={segments} canEdit={canFlags} reload={fl.reload} />)}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      <NewFlag open={newFlag} onClose={() => setNewFlag(false)} onSaved={fl.reload} />

      {fl.data && <Composer segments={segments} users={fl.data.users} onSaved={an.reload} />}

      {an.error && <ErrorBox text={an.error} retry={an.reload} />}
      {an.loading && !an.data && <Loading rows={2} />}
      {an.data && (
        <Card title="ANNOUNCEMENTS">
          {an.data.announcements.length === 0 ? <Empty>No announcements yet. Write one above and save it as a draft or publish it.</Empty> : (
            <div className="mc-tablewrap">
              <table className="mc-table" style={{ minWidth: 900 }}>
                <thead><tr><th>ANNOUNCEMENT</th><th>TYPE</th><th>AUDIENCE</th><th>STATUS</th><th>SEEN</th><th>CLICKED</th><th>DISMISSED</th><th></th></tr></thead>
                <tbody>
                  {an.data.announcements.map((a: any) => (
                    <tr key={a.id}>
                      <td>
                        <div style={{ display: "flex", flexDirection: "column", gap: 2, maxWidth: 320 }}>
                          <span style={{ fontWeight: 600 }}>{a.title}</span>
                          <span className="mc-tip">{a.created_by} · {ago(a.created_at)}{a.cta_url ? ` · → ${a.cta_url}` : ""}</span>
                        </div>
                      </td>
                      <td style={{ color: "var(--ink2)", textTransform: "capitalize" }}>{a.kind}</td>
                      <td style={{ color: "var(--ink2)" }}>{a.segment} · <span className="mc-mono mc-num">{fmtN(a.audience)}</span></td>
                      <td><Pill tone={ANN_TONE[a.status]}>{a.status}</Pill></td>
                      <td className="mc-mono mc-num">{fmtN(a.seen)}</td>
                      <td className="mc-mono mc-num">{fmtN(a.clicked)}</td>
                      <td className="mc-mono mc-num">{fmtN(a.dismissed)}</td>
                      <td>
                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                          {a.status === "live" ? (
                            <ActionButton className="mc-btn sm d" disabled={!canAnn} title={canAnn ? undefined : NO} confirm="End it now?" done="Announcement ended"
                              run={async () => { await mcPatch(`/announcements/${a.id}`, { status: "ended" }); an.reload(); }}>End</ActionButton>
                          ) : (
                            <ActionButton className="mc-btn sm p" disabled={!canAnn} title={canAnn ? undefined : NO} confirm={`Show to ${fmtN(a.audience)} people?`} done="Announcement is live"
                              run={async () => { await mcPatch(`/announcements/${a.id}`, { status: "live" }); an.reload(); }}>{a.status === "ended" ? "Publish again" : "Publish"}</ActionButton>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <span className="mc-tip">Live announcements show at the top of the app for the chosen audience.</span>
        </Card>
      )}
    </div>
  );
}

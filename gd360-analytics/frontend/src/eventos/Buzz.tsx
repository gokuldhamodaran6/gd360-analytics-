// Buzz: every post about the event - before, during and after - found
// without anyone tagging it; the review queue; what people say.
import { useCallback, useEffect, useState } from "react";
import { Initiative } from "../api/initiatives";
import { Buzz, eventApi, errText, Mention } from "../api/eventos";
import { Banner } from "../initiatives/ui";
import { C, compact, HBar, StackedDays } from "./charts";
import { Card, Eyebrow, Legend, PostCard, Seg, Skel } from "./kit";

type Ph = "all" | "before" | "during" | "after" | "review";
const KIND_COLORS = { attendee: C.primary, speaker: C.blue, own: C.violet, press: C.warning };

export default function BuzzTab({ i, onChanged }: { i: Initiative; onChanged: () => void }) {
  const [ph, setPh] = useState<Ph>("all");
  const [b, setB] = useState<Buzz | null>(null);
  const [items, setItems] = useState<Mention[]>([]);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState("");
  const q = useCallback((offset = 0) => ({
    phase: ph === "all" || ph === "review" ? undefined : ph, state: ph === "review" ? "review" : undefined, limit: 24, offset,
  }), [ph]);
  const load = useCallback(() => {
    eventApi.buzz(i.id, q(0)).then((x) => { setB(x); setItems(x.items); }).catch((e) => setErr(errText(e)));
  }, [i.id, q]);
  useEffect(load, [load]);
  const more = async () => {
    try { const x = await eventApi.buzz(i.id, q(items.length)); setItems((old) => [...old, ...x.items]); } catch (e) { setErr(errText(e)); }
  };
  const scan = async () => {
    setBusy(true); setErr(""); setMsg("");
    try {
      const r: any = await eventApi.scan(i.id);
      setMsg(r.vision === "sample" ? "Sample event - nothing to scan." : `Scan done: ${r.new} new, ${r.updated} refreshed, ${r.review} waiting for a look. Picture check: ${r.vision}.`
        + (r.errors?.length ? ` Skipped: ${r.errors.join("; ")}` : ""));
      load(); onChanged();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const add = async () => {
    if (!url.trim()) return;
    setBusy(true); setErr("");
    try { await eventApi.addPost(i.id, url.trim(), kind || undefined); setUrl(""); setMsg("Added - it counts straight away."); load(); onChanged(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const decide = async (m: Mention, state: "confirmed" | "rejected") => {
    try {
      await eventApi.patchMention(i.id, m.id, { state });
      setItems((xs) => (state === "rejected" || ph === "review" ? xs.filter((x) => x.id !== m.id) : xs.map((x) => (x.id === m.id ? { ...x, state } : x))));
      onChanged();
    }
    catch (e) { setErr(errText(e)); }
  };
  if (!b) return <div className="grid gap-4"><Skel h={110} /><Skel h={300} /><Skel h={400} /></div>;
  const kinds = Object.entries(b.kinds).sort((a, c) => c[1] - a[1]);
  const maxV = Math.max(1, ...b.voices.map((v) => v.reach));
  const scanAt = b.last_scan_at ? new Date(b.last_scan_at + (b.last_scan_at.endsWith("Z") ? "" : "Z")).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div className="flex flex-col gap-5" data-screen="buzz">
      {err && <Banner kind="error" onClose={() => setErr("")}>{err}</Banner>}
      {msg && <Banner kind="good" onClose={() => setMsg("")}>{msg}</Banner>}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1"><Eyebrow>Buzz · social, press, creators</Eyebrow>
          <h2 className="m-0 text-[20px] font-semibold text-text">Every post about the event, found without anyone tagging it</h2>
          <span className="text-caption text-muted">By hashtag, tracked link, code, the event's name - or the banner, backdrop or badge in the picture. {scanAt ? `Last scan ${scanAt}.` : ""}</span></div>
        <Seg label="Phase" value={ph} onChange={(v) => setPh(v as Ph)} items={[
          { id: "all", label: "All", badge: b.total }, { id: "before", label: "Before", badge: b.counts.before }, { id: "during", label: "During", badge: b.counts.during },
          { id: "after", label: "After", badge: b.counts.after }, { id: "review", label: "To check", badge: b.review },
        ]} />
      </div>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
        {[["Posts found", b.total.toLocaleString(), `${b.counts.before} before · ${b.counts.during} during · ${b.counts.after} after`],
          ["Reach", compact(b.reach || 0), "as the platforms report it"],
          ["Positive", b.positive_share !== null ? `${Math.round(b.positive_share)}%` : "–", `${b.sentiment.negative || 0} unhappy`],
          ["Attendees who posted", b.attendee_posters.toLocaleString(), b.attendees ? `of ${b.attendees.toLocaleString()} who came` : ""],
          ["Waiting for a look", String(b.review), "matched on words only (< 0.90)"]].map(([l, v, s]) => (
          <div key={l} className="rounded-card border border-border bg-surface px-4 py-3.5 flex flex-col gap-1"><span className="text-caption text-muted">{l}</span>
            <span className="text-[24px] font-semibold tabular-nums leading-tight">{v}</span><span className="text-caption text-secondary truncate">{s}</span></div>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Card title="Posts per day, and who is posting" sub="Event days shaded">
          <StackedDays ariaLabel="Posts per day split by who posted" rows={b.days} height={220}
            keys={[{ key: "attendee", label: "Attendees", color: KIND_COLORS.attendee }, { key: "speaker", label: "Speakers and sponsors", color: KIND_COLORS.speaker },
              { key: "own", label: "Your accounts", color: KIND_COLORS.own }, { key: "press", label: "Press, creators, public", color: KIND_COLORS.press }]} />
          <Legend items={[{ label: "Attendees", color: KIND_COLORS.attendee }, { label: "Speakers and sponsors", color: KIND_COLORS.speaker }, { label: "Your accounts", color: KIND_COLORS.own }, { label: "Press, creators, public", color: KIND_COLORS.press }]} />
        </Card>
        <Card title="Who is talking" sub="Posts and reach by voice">
          <div className="flex flex-col gap-2.5">
            {b.voices.map((v) => <HBar key={v.kind} label={v.kind} value={v.reach} max={maxV} right={`${v.posts} · ${compact(v.reach)}`} color={C.primary} />)}
          </div>
          <div className="text-caption text-muted">How posts were found: {Object.entries(b.matched_by).map(([k, v]) => `${k} ${v}`).join(" · ")}</div>
          <div className="text-caption text-muted">Platforms: {Object.entries(b.platforms).map(([k, v]) => `${k} ${v}`).join(" · ")}</div>
          {kinds.length === 0 && <div className="text-caption text-muted">No posts yet.</div>}
        </Card>
      </div>
      <Card title={ph === "review" ? "Check these - are they about the event?" : "The wall"} sub={`${b.items_total.toLocaleString()} posts${ph !== "all" ? ` · ${ph}` : ""} · biggest first`}
        right={b.can_edit ? (
          <div className="flex gap-2 flex-wrap items-center">
            <input className="input !py-1.5 text-caption w-[260px]" placeholder="Paste a post or article link" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} aria-label="Post link" />
            <select className="input !py-1.5 !w-auto text-caption" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Who posted it">
              <option value="">Who posted? (auto)</option><option value="attendee">Attendee</option><option value="speaker">Speaker</option><option value="sponsor">Sponsor</option>
              <option value="press">Press</option><option value="creator">Creator</option><option value="own">Our account</option><option value="public">Someone else</option>
            </select>
            <button type="button" className="btn-secondary text-sm" disabled={busy || !url.trim()} onClick={add}>Add</button>
            <button type="button" className="btn-primary text-sm" disabled={busy} onClick={scan}>{busy ? "Scanning…" : "Scan now"}</button>
          </div>) : null}>
        {items.length ? (
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {items.map((m) => <PostCard key={m.id} m={m} canEdit={b.can_edit} onDecide={(s) => decide(m, s)} />)}
          </div>
        ) : <div className="text-caption text-muted">{ph === "review" ? "Nothing to check." : "No posts yet. Connect your social accounts, add a hashtag and the banner in Setup, or paste a link."}</div>}
        {items.length < b.items_total && <button type="button" className="btn-secondary text-sm self-center" onClick={more}>Load more</button>}
      </Card>
      {b.complaints.length > 0 && (
        <Card title="Unhappy posts" sub="Reply, and the cause becomes a learning for next time" tone="warning">
          <div className="flex flex-col">
            {b.complaints.map((m) => (
              <div key={m.id} className="py-2.5 border-t border-border first:border-t-0 flex gap-3 items-start">
                <span className="text-caption text-muted w-[90px] shrink-0">{m.author}</span>
                <span className="text-ui text-text flex-1">{m.text}</span>
                {m.url && <a href={m.url} target="_blank" rel="noreferrer" className="text-caption text-brand-ink shrink-0">Reply ↗</a>}
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card title="Where posts come from" sub="What this scan can and can't see">
        <div className="grid gap-3 md:grid-cols-3 text-caption text-secondary">
          <div><b className="text-text">Your accounts</b> - Instagram, Facebook Pages, LinkedIn Pages, YouTube you've connected. Every post, its picture and numbers.</div>
          <div><b className="text-text">Anyone's public posts</b> - X and YouTube search when their keys are set on this GD360. Instagram and LinkedIn don't let any tool search other people's posts - paste those links.</div>
          <div><b className="text-text">Pictures</b> - posts without a hashtag are checked for your banner, backdrop or badge (brand marks only, never faces). Upload them in Setup.</div>
        </div>
        {b.scan?.sources?.length > 0 && <div className="text-caption text-muted">Last scan read: {b.scan.sources.map((s: any) => `${s.name}${s.posts ? ` (${s.posts})` : ""}`).join(", ")}</div>}
      </Card>
    </div>
  );
}

// 2026-10-10 (round 19): "Publish to company domain" (approved board H1).
// Opened from a dashboard's Publish menu. Picks the address
// (data.acmeretail.com/sales), the title, who can open it (everyone the
// domain allows / invited people / the team only) and - for a dashboard on a
// live database or warehouse - an optional row rule so each person sees only
// their rows. Owners and admins publish at once; a member sends a request
// when the workspace asks for one (Trust Center › Rules).
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { domainsApi, errorText, type PublishState, type RowRule } from "../api/ops";
import { Button, ConfirmDialog, Select, Sheet, Skeleton, Switch, CheckIcon, ExternalIcon, PlusIcon, TrashIcon, WarningIcon } from "../ui";
import { Banner, ChoiceCards, CopyButton, Eyebrow } from "./OpsParts";

type RuleRow = { who: string; values: string };

function ruleToRows(rule: RowRule | null): RuleRow[] {
  if (!rule) return [{ who: "", values: "" }];
  const rows: RuleRow[] = [
    ...Object.entries(rule.by_email || {}).map(([k, v]) => ({ who: k, values: v.join(", ") })),
    ...Object.entries(rule.by_domain || {}).map(([k, v]) => ({ who: `@${k}`, values: v.join(", ") })),
  ];
  return rows.length ? rows : [{ who: "", values: "" }];
}

export function PublishToDomainSheet({ dashboardId, open, onClose, onChanged }: { dashboardId: string; open: boolean; onClose: () => void; onChanged?: () => void }) {
  const [st, setSt] = useState<PublishState | null>(null);
  const [error, setError] = useState("");
  const [path, setPath] = useState("");
  const [title, setTitle] = useState("");
  const [audience, setAudience] = useState<"domain" | "invited" | "members">("domain");
  const [invited, setInvited] = useState("");
  const [ruleOn, setRuleOn] = useState(false);
  const [column, setColumn] = useState("");
  const [rows, setRows] = useState<RuleRow[]>([{ who: "", values: "" }]);
  const [fallback, setFallback] = useState<"none" | "all">("none");
  const [note, setNote] = useState("");
  const [avail, setAvail] = useState<{ path: string; available: boolean; reason: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);

  const load = async () => {
    try {
      const s = await domainsApi.forDashboard(dashboardId);
      setSt(s);
      const p = s.publication;
      setPath(p?.path || s.suggested_path || "");
      setTitle(p?.title || s.dashboard.name);
      setAudience(p?.audience || "domain");
      setInvited((p?.invited_emails || []).join("\n"));
      setRuleOn(!!p?.row_rule);
      setColumn(p?.row_rule?.column || "");
      setRows(ruleToRows(p?.row_rule || null));
      setFallback(p?.row_rule && p.row_rule.default === "all" ? "all" : "none");
      setNote(p?.request_note || "");
      setError("");
    } catch (e: any) {
      setError(errorText(e, "Couldn't open publishing."));
    }
  };
  useEffect(() => {
    if (open) {
      setSt(null);
      setDone("");
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dashboardId]);

  // live address check
  useEffect(() => {
    if (!st?.domain || !path.trim()) {
      setAvail(null);
      return;
    }
    const t = setTimeout(() => {
      domainsApi.pathAvailable(st.domain!.id, path, st.publication?.id).then(setAvail).catch(() => setAvail(null));
    }, 300);
    return () => clearTimeout(t);
  }, [path, st]);

  const columns = useMemo(() => {
    const out: { value: string; label: string }[] = [];
    const seen = new Set<string>();
    Object.entries(st?.columns || {}).forEach(([table, cols]) =>
      cols.forEach((c) => {
        if (!seen.has(c)) {
          seen.add(c);
          out.push({ value: c, label: Object.keys(st!.columns).length > 1 ? `${c}  ·  ${table}` : c });
        }
      })
    );
    return out.sort((a, b) => a.value.localeCompare(b.value));
  }, [st]);

  const buildRule = (): RowRule | null => {
    if (!ruleOn || !column) return null;
    const by_email: RowRule["by_email"] = {};
    const by_domain: RowRule["by_domain"] = {};
    rows.forEach((r) => {
      const who = r.who.trim().toLowerCase();
      const vals = r.values.split(",").map((v) => v.trim()).filter(Boolean);
      if (!who || !vals.length) return;
      if (who.startsWith("@")) by_domain[who.slice(1)] = vals;
      else if (who.includes("@")) by_email[who] = vals;
      else by_domain[who] = vals;
    });
    return { column, by_email, by_domain, default: fallback };
  };

  const submit = async () => {
    if (!st?.domain) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        dashboard_id: dashboardId,
        path,
        title: title.trim() || null,
        audience,
        invited_emails: audience === "invited" ? invited.split(/[\s,;]+/).filter(Boolean) : [],
        row_rule: buildRule(),
        note: note.trim() || null,
      };
      const pub = st.publication && (st.publication.status === "live" ? st.can_manage : st.publication.status === "pending")
        ? await domainsApi.updatePublication(st.publication.id, body)
        : await domainsApi.publish(st.domain.id, body);
      setDone(pub.status === "live" ? `Live at ${pub.url.replace("https://", "")}` : "Request sent. Owners and admins have been told.");
      onChanged?.();
      await load();
    } catch (e: any) {
      setError(errorText(e, "Couldn't publish it."));
    } finally {
      setBusy(false);
    }
  };

  const takeOff = async () => {
    if (!st?.publication) return;
    setBusy(true);
    try {
      await domainsApi.unpublish(st.publication.id);
      setConfirmOff(false);
      setDone(st.publication.status === "live" ? "Taken off the domain." : "Request withdrawn.");
      onChanged?.();
      await load();
    } catch (e: any) {
      setError(errorText(e, "Couldn't do that."));
    } finally {
      setBusy(false);
    }
  };

  const dom = st?.domain;
  const pub = st?.publication && st.publication.status !== "removed" ? st.publication : null;
  const live = pub?.status === "live";
  const pending = pub?.status === "pending";
  const readOnlyLive = live && !st?.can_manage;
  const blocked = !st || !dom || !st.in_workspace || st.mode === "none";
  const audText = dom ? (dom.audience === "company" ? `People at ${dom.allowed_email_domains.join(", ") || "the company"}` : dom.audience === "invited" ? "People invited to the domain" : "Anyone") : "";
  const canSubmit = !blocked && !readOnlyLive && path.trim() && (!avail || avail.available) && (audience !== "invited" || invited.trim()) && (!ruleOn || column);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="md"
      title="Publish to company domain"
      subtitle={dom ? <span className="font-mono">{dom.hostname}</span> : undefined}
      footer={
        st && dom && !blocked ? (
          <div className="flex items-center gap-2 w-full flex-wrap">
            {pub && (live ? st.can_manage : pending) && (
              <Button variant="ghost" className="!text-danger" leadingIcon={<TrashIcon size={14} />} onClick={() => setConfirmOff(true)} disabled={busy}>
                {live ? "Take it off" : "Withdraw"}
              </Button>
            )}
            <div className="flex-1" />
            {live && <a href={pub!.url} target="_blank" rel="noreferrer" className="btn-secondary text-sm inline-flex items-center gap-1.5">Open <ExternalIcon size={13} /></a>}
            {!readOnlyLive && (
              <Button variant="primary" disabled={!canSubmit || busy} loading={busy} onClick={submit}>
                {live || pending ? "Save changes" : st.mode === "request" ? "Send request" : "Publish"}
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      {!st && !error && <div className="flex flex-col gap-3"><Skeleton className="h-16" /><Skeleton className="h-10" /><Skeleton className="h-24" /></div>}
      {error && <div className="mb-3"><Banner tone="danger">{error}</Banner></div>}
      {done && <div className="mb-3"><Banner tone="good">{done}</Banner></div>}
      {st && !dom && (
        <div className="flex flex-col gap-3">
          <div className="text-section font-semibold text-text">No company domain yet</div>
          <p className="m-0 text-ui text-secondary leading-relaxed">
            Put dashboards on your own address - like <span className="font-mono text-text">data.yourcompany.com/sales</span> - where people sign in with their work email and see exactly this view.
          </p>
          {st.can_manage ? (
            <Link to="/settings/domains" className="btn-primary text-sm self-start">Connect a domain</Link>
          ) : (
            <Banner>Only {st.workspace?.name || "the workspace"}'s owner or an admin can connect one. Ask them - you can publish here once it's live.</Banner>
          )}
        </div>
      )}
      {st && dom && !st.in_workspace && (
        <Banner tone="warning">
          Only {st.workspace?.name}'s dashboards go on {dom.hostname}. Share this dashboard with {st.workspace?.name} first (Dashboards → … → Share with team).
        </Banner>
      )}
      {st && dom && st.in_workspace && st.mode === "none" && <Banner>Viewers can't publish. Ask an owner, an admin or the dashboard's owner.</Banner>}

      {st && dom && !blocked && (
        <div className="flex flex-col gap-5">
          {dom.status !== "live" && <Banner tone="warning">{dom.hostname} isn't live yet. You can publish now - the address opens as soon as the domain is ready.</Banner>}
          {pending && <Banner tone="warning">Waiting for an owner's or admin's OK{pub?.requested_at ? "" : ""}. You can still change it.</Banner>}
          {pub?.status === "rejected" && <Banner tone="danger">Not approved{pub.decided_by ? ` by ${pub.decided_by}` : ""}{pub.decision_note ? `: “${pub.decision_note}”` : "."} Change it and send it again.</Banner>}
          {live && (
            <div className="rounded-card border border-good-border bg-good-fill p-3.5 flex items-center gap-3 flex-wrap">
              <span className="w-6 h-6 rounded-full bg-good text-on-primary inline-flex items-center justify-center"><CheckIcon size={13} /></span>
              <div className="flex-1 min-w-[200px]">
                <div className="text-ui font-medium text-text">Live</div>
                <div className="font-mono text-caption text-secondary break-all">{pub!.url.replace("https://", "")}</div>
              </div>
              <CopyButton text={pub!.url} label="Copy link" />
            </div>
          )}
          {readOnlyLive && <Banner>Only owners and admins change a published dashboard.</Banner>}

          <fieldset disabled={readOnlyLive || busy} className="flex flex-col gap-5 m-0 p-0 border-0 min-w-0">
            <label className="flex flex-col gap-1.5">
              <span className="text-ui text-text">Address</span>
              <div className={`flex items-center rounded-ctl border bg-base overflow-hidden ${avail && !avail.available ? "border-danger" : "border-border focus-within:border-primary"}`}>
                <span className="pl-3 pr-0.5 text-ui text-muted font-mono whitespace-nowrap truncate max-w-[60%]">{dom.hostname}/</span>
                <input className="flex-1 min-w-0 bg-transparent h-10 pr-3 text-ui font-mono text-text outline-none" value={path} onChange={(e) => setPath(e.target.value)} aria-label="Path" />
              </div>
              <span className={`text-caption ${avail && !avail.available ? "text-danger" : "text-muted"}`}>
                {avail ? (avail.available ? (avail.path !== path ? `Will be saved as /${avail.path}` : "Available") : avail.reason) : "Letters, numbers and dashes."}
              </span>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-ui text-text">Title on the domain</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
            </label>

            <div className="flex flex-col gap-2">
              <span className="text-ui text-text">Who can open it</span>
              <ChoiceCards
                label="Who can open it"
                value={audience}
                onChange={(v) => setAudience(v)}
                options={[
                  { value: "domain", title: "Everyone the domain allows", text: dom.audience === "public" ? "Anyone - no sign-in." : audText },
                  { value: "invited", title: "Invited people", text: "Only the emails you list." },
                  { value: "members", title: "Team only", text: `The ${st.member_count} member${st.member_count === 1 ? "" : "s"} of ${st.workspace?.name}.` },
                ]}
              />
              <span className="text-caption text-muted">
                {audience === "domain" && `${audText}${dom.audience !== "public" ? ", signed in with their GD360 account" : ", without signing in"}. Members of ${st.workspace?.name} always can.`}
                {audience === "invited" && "Only these people (signed in with that email), plus members of the team."}
                {audience === "members" && `Only the ${st.member_count} member${st.member_count === 1 ? "" : "s"} of ${st.workspace?.name}.`}
              </span>
              {audience === "invited" && (
                <textarea className="input font-mono min-h-[90px]" placeholder={"dana@acmeretail.com\nops-lead@partner.com"} value={invited} onChange={(e) => setInvited(e.target.value)} aria-label="Invited emails" />
              )}
            </div>

            <div className="rounded-card border border-border p-4 flex flex-col gap-3">
              <Switch
                checked={ruleOn}
                disabled={!st.dashboard.warehouse_native}
                onChange={setRuleOn}
                label="Show each person only their rows"
                description={st.dashboard.warehouse_native
                  ? "Every number, chart and filter is limited to the rows you give each person. They can't remove it."
                  : "Works for dashboards on a live database or warehouse. This one keeps stored numbers - publish a separate dashboard per group instead."}
              />
              {ruleOn && st.dashboard.warehouse_native && (
                <div className="flex flex-col gap-3">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-caption text-muted">Rows are chosen by</span>
                    <Select value={column} onChange={(e) => setColumn(e.target.value)} options={[{ value: "", label: "Pick a column…" }, ...columns]} aria-label="Column" />
                  </label>
                  {column && (
                    <>
                      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] gap-2 items-center">
                        <Eyebrow>Person or @domain</Eyebrow>
                        <Eyebrow>Sees {column}</Eyebrow>
                        <span />
                        {rows.map((r, i) => (
                          <RuleLine key={i} row={r} onChange={(nr) => setRows((x) => x.map((y, j) => (j === i ? nr : y)))} onRemove={() => setRows((x) => (x.length > 1 ? x.filter((_, j) => j !== i) : [{ who: "", values: "" }]))} />
                        ))}
                      </div>
                      <Button size="sm" variant="secondary" className="self-start !h-8" leadingIcon={<PlusIcon size={13} />} onClick={() => setRows((x) => [...x, { who: "", values: "" }])}>Add a rule</Button>
                      <label className="flex items-center gap-3 flex-wrap">
                        <span className="text-caption text-muted">Everyone else sees</span>
                        <Select size="sm" value={fallback} onChange={(e) => setFallback(e.target.value as "none" | "all")} options={[{ value: "none", label: "Nothing" }, { value: "all", label: "Every row" }]} aria-label="Everyone else" className="w-[150px]" />
                      </label>
                      <div className="text-caption text-muted leading-relaxed">
                        Owners, admins and the dashboard's owner always see every row. Blocks whose data can't be limited by {column} (and SQL cells) are left out of a limited view.
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {st.sensitive_columns.length > 0 && (
              <div className="rounded-card border border-warning-border bg-warning-fill p-3.5 flex gap-3">
                <WarningIcon size={16} className="text-warning shrink-0 mt-0.5" />
                <div className="text-caption text-secondary leading-relaxed">
                  Its source has {st.sensitive_columns.length} column{st.sensitive_columns.length === 1 ? "" : "s"} with personal data ({st.sensitive_columns.slice(0, 4).map((c) => c.column).join(", ")}). Check no block shows them, or hide them in the Trust Center.
                </div>
              </div>
            )}

            {st.mode === "request" && !live && (
              <label className="flex flex-col gap-1.5">
                <span className="text-ui text-text">Note for the approver (optional)</span>
                <textarea className="input min-h-[64px]" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="For the Monday leadership review" />
                <span className="text-caption text-muted">{st.workspace?.name} asks members to get an OK before publishing here.</span>
              </label>
            )}
          </fieldset>
        </div>
      )}
      <ConfirmDialog
        open={confirmOff}
        title={live ? `Take it off ${dom?.hostname}?` : "Withdraw the request?"}
        confirmLabel={live ? "Take it off" : "Withdraw"}
        tone="danger"
        busy={busy}
        onCancel={() => setConfirmOff(false)}
        onConfirm={takeOff}
      >
        {live ? "The address stops opening at once. The dashboard stays in GD360." : "Nothing is published."}
      </ConfirmDialog>
    </Sheet>
  );
}

function RuleLine({ row, onChange, onRemove }: { row: RuleRow; onChange: (r: RuleRow) => void; onRemove: () => void }) {
  return (
    <>
      <input className="input text-ui font-mono" placeholder="dana@acme.com or @acme.com" value={row.who} onChange={(e) => onChange({ ...row, who: e.target.value })} aria-label="Person or email domain" />
      <input className="input text-ui" placeholder="North, East" value={row.values} onChange={(e) => onChange({ ...row, values: e.target.value })} aria-label="Values" />
      <button type="button" onClick={onRemove} className="ui-focus w-8 h-8 rounded-ctl text-muted hover:text-danger inline-flex items-center justify-center" aria-label="Remove rule">
        <TrashIcon size={14} />
      </button>
    </>
  );
}

/** The row at the top of a dashboard's Publish menu. */
export function DomainPublishRow({ dashboardId, onOpen }: { dashboardId: string; onOpen: () => void }) {
  const [st, setSt] = useState<PublishState | null>(null);
  useEffect(() => {
    domainsApi.forDashboard(dashboardId).then(setSt).catch(() => setSt(null));
  }, [dashboardId]);
  const pub = st?.publication && st.publication.status !== "removed" ? st.publication : null;
  return (
    <button type="button" onClick={onOpen} className="ui-focus w-full text-left rounded-ctl border border-border bg-base hover:border-border-strong p-3 flex items-center gap-3 mb-3" data-domain-publish="">
      <span className="w-8 h-8 rounded-ctl bg-tint text-brand-ink inline-flex items-center justify-center shrink-0 font-mono text-[13px]" aria-hidden="true">/</span>
      <span className="min-w-0 flex-1">
        <span className="block text-ui font-medium text-text">{st?.domain ? `Publish to ${st.domain.hostname}` : "Publish to company domain"}</span>
        <span className="block text-caption text-muted truncate">
          {pub ? (pub.status === "live" ? `Live at /${pub.path}` : pub.status === "pending" ? "Waiting for an OK" : "Not approved - change it and ask again") : st?.domain ? "Your address, your sign-in, this exact view" : "Your own address - data.yourcompany.com"}
        </span>
      </span>
      {pub?.status === "live" && <span className="w-2 h-2 rounded-full bg-good shrink-0" aria-hidden="true" />}
    </button>
  );
}

// 2026-10-09 (round 15): connect a synced app in four steps - Sign in (the
// app's own sign-in page, or a key/token), Choose (which accounts or pages),
// Spaces & schedule, and Sync (tables appear with row counts as the first
// copy lands). Works for every app GET /apps lists, the four older ones too.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import BrandTile from "../components/BrandTile";
import {
  AppField, AppMeta, catalogApi, CatalogConnector, ConnectAppPayload, ConnectedApp, DiscoveredAccount, Space, SPACE_COLORS, spacesApi,
} from "../api/spaces";
import { chipClass, CloseButton, errorText, ErrorNote, Overlay, Skeleton } from "./shared";

const INTERVALS: Record<string, string> = {
  "15m": "Every 15 minutes",
  "1h": "Every hour",
  "6h": "Every 6 hours",
  daily: "Once a day",
};

// Fields a "Sign in with ..." hand-off fills in by itself.
const SIGN_IN_COVERS = new Set(["access_token", "refresh_token", "client_id", "client_secret", "service_account_json"]);

const DRAFT_KEY = "gd360_connect_app_draft";
type Draft = { kind: string; name: string; interval: string; history: "90" | "all" };

function saveDraft(d: Draft) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* storage blocked */
  }
}
function readDraft(kind: string): Draft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    return d && d.kind === kind ? d : null;
  } catch {
    return null;
  }
}
function clearDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage blocked */
  }
}

const STEP_NAMES = ["Sign in", "Choose", "Spaces", "Sync"];

function Stepper({ step }: { step: number }) {
  return (
    <ol className="list-none m-0 p-0 grid grid-cols-4 gap-1.5" aria-label="Steps">
      {STEP_NAMES.map((n, i) => (
        <li key={n} className="flex flex-col gap-[7px]" aria-current={i + 1 === step ? "step" : undefined}>
          <span className={`h-[3px] rounded-[3px] ${i + 1 <= step ? "bg-primary" : "bg-surface2"}`} />
          <span className={`text-[11.5px] ${i + 1 === step ? "text-text" : "text-muted"}`}>{n}</span>
        </li>
      ))}
    </ol>
  );
}

function CheckGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="shrink-0">
      <path d="M3 7.2l2.6 2.6L11 4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FieldInput({
  field, value, onChange, shown, onToggleShown, idPrefix,
}: {
  field: AppField; value: string; onChange: (v: string) => void; shown: boolean; onToggleShown: () => void; idPrefix: string;
}) {
  const id = `${idPrefix}-${field.key}`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] text-secondary">
        {field.label}
        {field.optional ? <span className="text-muted"> (optional)</span> : null}
      </label>
      {field.multiline ? (
        <textarea
          id={id}
          rows={5}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          spellCheck={false}
          className="input font-mono text-[12px]"
          style={field.secret && !shown ? ({ WebkitTextSecurity: "disc" } as React.CSSProperties) : undefined}
        />
      ) : (
        <div className="relative">
          <input
            id={id}
            type={field.secret && !shown ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
            className={`input h-11 ${field.secret ? "pr-16" : ""}`}
          />
          {field.secret && (
            <button
              type="button"
              onClick={onToggleShown}
              aria-label={shown ? `Hide ${field.label}` : `Show ${field.label}`}
              aria-pressed={shown}
              className="ui-focus absolute right-1.5 top-1/2 -translate-y-1/2 h-8 px-2.5 rounded-[8px] text-[12px] text-secondary hover:text-text hover:bg-surface2"
            >
              {shown ? "Hide" : "Show"}
            </button>
          )}
        </div>
      )}
      {field.multiline && field.secret && (
        <button type="button" onClick={onToggleShown} className="ui-focus self-start text-[12px] text-muted hover:text-text" aria-pressed={shown}>
          {shown ? "Hide the key" : "Show the key"}
        </button>
      )}
    </div>
  );
}

export default function ConnectAppSheet({
  meta,
  tile,
  workspaceId,
  spaces,
  pendingId: initialPending,
  initialError,
  onClose,
  onConnected,
}: {
  meta: AppMeta;
  tile?: CatalogConnector | null;
  workspaceId?: string | null;
  spaces: Space[] | null;
  pendingId?: string | null;
  initialError?: string | null;
  onClose: () => void;
  onConnected: (app: ConnectedApp) => void;
}) {
  const navigate = useNavigate();
  const label = tile?.label || meta.label;
  const draft = useMemo(() => (initialPending || initialError ? readDraft(meta.kind) : null), [meta.kind, initialPending, initialError]);

  const [pendingId] = useState<string | null>(initialPending || null);
  const signedIn = !!pendingId;
  const [useKeys, setUseKeys] = useState(!meta.oauth_ready);
  const [name, setName] = useState(draft?.name || label);
  const [values, setValues] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [interval, setIntervalChoice] = useState(draft?.interval || meta.default_interval || meta.intervals[0] || "1h");
  const [history, setHistory] = useState<"90" | "all">(draft?.history || "all");

  // Fields shown on the key path (step 1): a list of accounts found by
  // discovery replaces the optional "which accounts" boxes.
  const keyFields = meta.fields.filter((f) => !(meta.discover && f.optional && !f.secret));
  // Fields a sign-in does not fill in (e.g. the Google Ads customer ID).
  const extraFields = meta.fields.filter((f) => !SIGN_IN_COVERS.has(f.key) && !(meta.discover && f.optional && !f.secret));
  const hasChoose = meta.discover || (signedIn && extraFields.length > 0);

  const [step, setStep] = useState<number>(() => (initialPending ? (meta.discover || extraFields.length ? 2 : 3) : 1));
  const [stepError, setStepError] = useState<{ step: number; text: string } | null>(initialError ? { step: 1, text: initialError } : null);
  const [busy, setBusy] = useState(false);

  // step 2 - accounts
  const [accounts, setAccounts] = useState<DiscoveredAccount[] | null>(null);
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [discovering, setDiscovering] = useState(false);

  // step 3 - spaces
  const editable = useMemo(() => (spaces || []).filter((s) => s.can_edit), [spaces]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [suggestion, setSuggestion] = useState<{ name: string; color: string | null; space_id: string | null } | null>(null);
  const [newSpace, setNewSpace] = useState<{ name: string; color: string; on: boolean } | null>(null);
  const suggestedOnce = useRef(false);

  // step 4 - sync
  const [app, setApp] = useState<ConnectedApp | null>(null);
  const [pollError, setPollError] = useState("");

  const required = (f: AppField) => f.optional !== true;
  const val = (k: string) => (values[k] || "").trim();
  const keysMissing = keyFields.filter((f) => required(f) && !val(f.key));
  const extraMissing = extraFields.filter((f) => required(f) && !val(f.key));

  useEffect(() => {
    if (suggestedOnce.current) return;
    suggestedOnce.current = true;
    spacesApi
      .suggest(meta.kind, workspaceId)
      .then((s) => {
        if (!s.name) return;
        setSuggestion({ name: s.name, color: s.color, space_id: s.space_id });
      })
      .catch(() => {});
  }, [meta.kind, workspaceId]);

  // Pre-select the suggested Space (or offer to create it) once both the
  // suggestion and the person's Spaces are known.
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || !suggestion || spaces === null) return;
    preselected.current = true;
    const existing = editable.find((s) => s.id === suggestion.space_id) || editable.find((s) => s.name.toLowerCase() === suggestion.name.toLowerCase());
    if (existing) setPicked((p) => ({ ...p, [existing.id]: true }));
    else if (!(spaces || []).some((s) => s.name.toLowerCase() === suggestion.name.toLowerCase())) {
      setNewSpace({ name: suggestion.name, color: suggestion.color || SPACE_COLORS[0], on: true });
    }
  }, [suggestion, spaces, editable]);

  const credentials = (): Record<string, string> | undefined => {
    const list = signedIn ? extraFields : keyFields;
    const out: Record<string, string> = {};
    for (const f of list) if (val(f.key)) out[f.key] = val(f.key);
    return Object.keys(out).length ? out : undefined;
  };

  const runDiscover = async () => {
    setDiscovering(true);
    setStepError(null);
    setAccounts(null);
    try {
      const found = await catalogApi.discover(meta.kind, signedIn ? { pending_id: pendingId! } : { credentials: credentials() });
      setAccounts(found);
      setOff({});
    } catch (e: any) {
      setStepError({ step: 2, text: errorText(e, `Couldn't list your ${label} accounts. Please try again.`) });
      setAccounts([]);
    } finally {
      setDiscovering(false);
    }
  };

  // Entering step 2 with discovery: fetch the accounts.
  useEffect(() => {
    if (step === 2 && meta.discover && accounts === null && !discovering) runDiscover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const startSignIn = async () => {
    setBusy(true);
    setStepError(null);
    saveDraft({ kind: meta.kind, name: name.trim() || label, interval, history });
    try {
      const out = await catalogApi.oauthStart(meta.kind);
      window.location.href = out.authorize_url;
    } catch (e: any) {
      clearDraft();
      setBusy(false);
      const text = errorText(e, `Couldn't open the ${label} sign-in. Please try again.`);
      if (e?.response?.status === 503) {
        setUseKeys(true);
        setStepError({ step: 1, text: `${text} You can connect with a key or token below instead.` });
      } else {
        setStepError({ step: 1, text });
      }
    }
  };

  const fromStep1 = () => {
    setStepError(null);
    if (meta.discover) {
      setAccounts(null);
      setStep(2);
    } else setStep(3);
  };

  const chosenIds = (accounts || []).filter((a) => !off[a.id]).map((a) => a.id);

  const fromStep2 = () => {
    setStepError(null);
    setStep(3);
  };

  const back = () => {
    setStepError(null);
    if (step === 3) setStep(hasChoose ? 2 : 1);
    else if (step === 2) setStep(1);
  };

  const pickedSpaceIds = editable.filter((s) => picked[s.id]).map((s) => s.id);

  const connect = async () => {
    setBusy(true);
    setStepError(null);
    const payload: ConnectAppPayload = {
      kind: meta.kind,
      name: name.trim() || label,
      sync_interval: interval,
      space_ids: pickedSpaceIds,
    };
    const creds = credentials();
    if (creds) payload.credentials = creds;
    if (pendingId) payload.pending_id = pendingId;
    if (meta.discover && accounts && accounts.length > 0) payload.account_ids = chosenIds;
    if (newSpace?.on) payload.new_space = { name: newSpace.name, color: newSpace.color };
    if (history === "90") payload.history_days = 90;
    if (workspaceId) payload.workspace_id = workspaceId;
    try {
      const out = await catalogApi.connect(payload);
      clearDraft();
      setApp(out);
      setStep(4);
      onConnected(out);
    } catch (e: any) {
      const text = errorText(e, `Couldn't connect ${label}. Check the details and try again.`);
      const low = text.toLowerCase();
      let at = 3;
      if (low.includes("space") || low.includes("colour")) at = 3;
      else if (low.includes("account") && meta.discover) at = 2;
      else if (!signedIn) at = 1;
      else if (extraFields.length) at = 2;
      setStepError({ step: at, text });
      setStep(at);
    } finally {
      setBusy(false);
    }
  };

  // Follow the first sync.
  const syncing = !!app && app.syncing && !pollError;
  useEffect(() => {
    if (!app || !syncing) return;
    const t = window.setInterval(async () => {
      try {
        const s = await catalogApi.status(app.id);
        setApp((prev) => ({ ...(prev || s), ...s, space_ids: prev?.space_ids ?? s.space_ids }));
      } catch (e: any) {
        setPollError(errorText(e, "Couldn't check on the sync just now. It keeps running in the background."));
      }
    }, 2500);
    return () => window.clearInterval(t);
  }, [app?.id, syncing]); // eslint-disable-line react-hooks/exhaustive-deps

  const appSpaces = useMemo(() => {
    const ids = app?.space_ids || [];
    return ids.map((id) => {
      const s = (spaces || []).find((x) => x.id === id);
      return s ? { id, name: s.name } : { id, name: newSpace?.name || "your Space" };
    });
  }, [app?.space_ids, spaces, newSpace?.name]);

  const errFor = (n: number) => (stepError && stepError.step === n ? <ErrorNote>{stepError.text}</ErrorNote> : null);

  const nameField = (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="connect-app-name" className="text-[13px] text-secondary">Name in GD360</label>
      <input id="connect-app-name" className="input h-11" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
    </div>
  );

  const fieldList = (list: AppField[]) =>
    list.map((f) => (
      <FieldInput
        key={f.key}
        idPrefix="connect-app"
        field={f}
        value={values[f.key] || ""}
        onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
        shown={!!shown[f.key]}
        onToggleShown={() => setShown((s) => ({ ...s, [f.key]: !s[f.key] }))}
      />
    ));

  const tables = app?.tables || [];
  const done = !!app && !app.syncing;
  const intervalText = (INTERVALS[interval] || interval).toLowerCase();

  return (
    <Overlay label={`Connect ${label}`} onClose={onClose} side="right" maxWidth="max-w-[500px]">
      <div className="p-5 sm:p-7 flex flex-col gap-6 min-h-full">
        <div className="flex justify-between items-center gap-3">
          <div className="flex items-center gap-3.5 min-w-0">
            {tile ? (
              <BrandTile slug={tile.slug} monogram={tile.monogram} color={tile.color} ink={tile.ink} size={48} />
            ) : (
              <BrandTile kind={meta.kind} name={meta.label} size={48} />
            )}
            <span className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[19px] font-semibold text-text truncate">Connect {label}</span>
              <span className="text-[12.5px] text-muted">
                {meta.oauth_provider && !useKeys ? "Secure sign-in · read-only" : "Key or token · read-only"}
              </span>
            </span>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        <Stepper step={step} />

        {step === 1 && (
          <div className="flex flex-col gap-[18px]">
            {meta.oauth_ready && !useKeys ? (
              <>
                <p className="m-0 text-[15px] leading-relaxed text-secondary">
                  GD360 opens {label}’s own sign-in. You approve <b className="text-text font-semibold">read-only</b> access — GD360 can never post, reply, spend or change anything.
                </p>
                {meta.summary && (
                  <div className="flex flex-col gap-2">
                    <span className="font-mono text-[10.5px] text-muted tracking-[0.08em] uppercase">What GD360 will read</span>
                    <div className="flex items-start gap-3 px-3 py-2.5 rounded-[12px] border border-border bg-surface text-[13.5px] text-text">
                      <span className="text-primary mt-0.5"><CheckGlyph /></span>
                      <span>{meta.summary}</span>
                    </div>
                  </div>
                )}
                {nameField}
                <div className="px-3.5 py-3 rounded-[12px] bg-primary/5 border border-primary/20 text-[12.5px] text-secondary leading-relaxed">
                  Tokens are encrypted at rest and refreshed automatically. GD360 only reads.
                </div>
                {errFor(1)}
                <button type="button" className="btn-primary h-11 text-[14px]" onClick={startSignIn} disabled={busy}>
                  {busy ? `Opening ${label}…` : `Continue with ${label}`}
                </button>
                <button
                  type="button"
                  className="ui-focus self-center text-[13px] text-muted hover:text-text underline underline-offset-2"
                  onClick={() => {
                    setStepError(null);
                    setUseKeys(true);
                  }}
                >
                  Use a key or token instead
                </button>
              </>
            ) : (
              <>
                {meta.summary && <p className="m-0 text-[14px] leading-relaxed text-secondary">{meta.summary}</p>}
                {meta.steps.length > 0 && (
                  <div className="flex flex-col gap-2 p-4 rounded-[12px] border border-border bg-surface">
                    <span className="font-mono text-[10.5px] text-muted tracking-[0.08em] uppercase">How to get the details</span>
                    <ol className="m-0 pl-5 flex flex-col gap-2 text-[13px] text-secondary leading-relaxed list-decimal">
                      {meta.steps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                  </div>
                )}
                {nameField}
                {fieldList(keyFields)}
                <p className="m-0 text-[12.5px] text-muted leading-relaxed">
                  GD360 only reads. Credentials are encrypted at rest and never shown again after you save them.
                </p>
                {errFor(1)}
                <button type="button" className="btn-primary h-11 text-[14px]" onClick={fromStep1} disabled={keysMissing.length > 0}>
                  Continue
                </button>
                {meta.oauth_ready && (
                  <button
                    type="button"
                    className="ui-focus self-center text-[13px] text-muted hover:text-text underline underline-offset-2"
                    onClick={() => {
                      setStepError(null);
                      setUseKeys(false);
                    }}
                  >
                    Sign in with {label} instead
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-3.5">
            {meta.discover ? (
              <>
                <p className="m-0 text-[15px] text-secondary">{signedIn ? "Signed in. Choose what to bring in:" : "Choose what to bring in:"}</p>
                {discovering && (
                  <div className="flex flex-col gap-2" aria-busy="true" aria-label="Finding your accounts">
                    <Skeleton className="h-[62px]" />
                    <Skeleton className="h-[62px]" />
                    <span className="text-[12.5px] text-muted">Finding your accounts…</span>
                  </div>
                )}
                {!discovering && accounts && accounts.length > 0 && (
                  <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
                    <legend className="sr-only">Accounts to sync</legend>
                    {accounts.map((a) => (
                      <label key={a.id} className="flex items-center gap-3 px-3.5 py-3 rounded-[12px] border border-border bg-surface cursor-pointer hover:border-border-strong">
                        <input
                          type="checkbox"
                          className="w-[18px] h-[18px] shrink-0"
                          checked={!off[a.id]}
                          onChange={() => setOff((s) => ({ ...s, [a.id]: !s[a.id] }))}
                        />
                        <span className="flex flex-col gap-0.5 min-w-0">
                          <span className="text-[14px] font-medium text-text truncate">{a.name}</span>
                          {a.detail && <span className="text-[12px] text-muted">{a.detail}</span>}
                        </span>
                      </label>
                    ))}
                    <span className="text-[12px] text-muted">
                      {chosenIds.length} of {accounts.length} chosen{chosenIds.length === 0 ? " — choose at least one" : ""}
                    </span>
                  </fieldset>
                )}
                {!discovering && accounts && accounts.length === 0 && !(stepError && stepError.step === 2) && (
                  <div className="px-3.5 py-3 rounded-[12px] border border-dashed border-border-strong text-[13px] text-secondary leading-relaxed">
                    No accounts showed up for this {signedIn ? "sign-in" : "key"}. You can carry on and GD360 syncs what the {signedIn ? "sign-in" : "key"} can see, or go back and use a different one.
                  </div>
                )}
              </>
            ) : (
              <p className="m-0 text-[15px] text-secondary">Signed in. A few details to finish:</p>
            )}
            {signedIn && extraFields.length > 0 && <div className="flex flex-col gap-3.5">{fieldList(extraFields)}</div>}
            {errFor(2)}
            {stepError?.step === 2 && meta.discover && !discovering && (
              <button type="button" className="btn-secondary h-10 text-[13.5px] self-start" onClick={runDiscover}>
                Try again
              </button>
            )}
            <div className="flex gap-2">
              {!signedIn && (
                <button type="button" className="btn-secondary h-11 text-[14px]" onClick={back}>
                  Back
                </button>
              )}
              <button
                type="button"
                className="btn-primary h-11 text-[14px] flex-1"
                onClick={fromStep2}
                disabled={discovering || (meta.discover && !!accounts && accounts.length > 0 && chosenIds.length === 0) || (signedIn && extraMissing.length > 0) || (meta.discover && accounts === null)}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2.5">
              <span className="text-[14px] font-semibold text-text" id="pick-spaces">Add to Spaces</span>
              <div className="flex flex-wrap gap-2" role="group" aria-labelledby="pick-spaces">
                {spaces === null && <Skeleton className="h-8 w-40 rounded-full" />}
                {editable.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={!!picked[s.id]}
                    onClick={() => setPicked((p) => ({ ...p, [s.id]: !p[s.id] }))}
                    className={chipClass(!!picked[s.id])}
                  >
                    <span className="w-2 h-2 rounded-[3px]" style={{ background: s.color }} aria-hidden="true" />
                    {s.name}
                  </button>
                ))}
                {newSpace && (
                  <button
                    type="button"
                    aria-pressed={newSpace.on}
                    onClick={() => setNewSpace((n) => (n ? { ...n, on: !n.on } : n))}
                    className={chipClass(newSpace.on)}
                  >
                    <span className="w-2 h-2 rounded-[3px]" style={{ background: newSpace.color }} aria-hidden="true" />+ Create ‘{newSpace.name}’
                  </button>
                )}
              </div>
              <span className="text-[12.5px] text-secondary">
                {suggestion ? `GD360 suggests ${suggestion.name} for ${label}. ` : ""}A source can sit in several Spaces — or none for now.
              </span>
            </div>
            <div className="flex flex-col gap-2.5">
              <span className="text-[14px] font-semibold text-text" id="pick-freq">Keep it fresh</span>
              <div className="flex gap-2 flex-wrap" role="group" aria-labelledby="pick-freq">
                {meta.intervals.map((i) => (
                  <button key={i} type="button" aria-pressed={interval === i} onClick={() => setIntervalChoice(i)} className={chipClass(interval === i)}>
                    {INTERVALS[i] || i}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2.5">
              <span className="text-[14px] font-semibold text-text" id="pick-history">History to import</span>
              <div className="flex gap-2 flex-wrap" role="group" aria-labelledby="pick-history">
                <button type="button" aria-pressed={history === "90"} onClick={() => setHistory("90")} className={chipClass(history === "90")}>
                  Last 90 days
                </button>
                <button type="button" aria-pressed={history === "all"} onClick={() => setHistory("all")} className={chipClass(history === "all")}>
                  Everything available
                </button>
              </div>
            </div>
            {errFor(3)}
            <div className="flex gap-2">
              {!(signedIn && !hasChoose) && (
                <button type="button" className="btn-secondary h-11 text-[14px]" onClick={back} disabled={busy}>
                  Back
                </button>
              )}
              <button type="button" className="btn-primary h-11 text-[14px] flex-1" onClick={connect} disabled={busy}>
                {busy ? "Checking the connection…" : "Connect and sync"}
              </button>
            </div>
          </div>
        )}

        {step === 4 && app && (
          <div className="flex flex-col gap-3.5" aria-live="polite">
            <p className="m-0 text-[15px] text-secondary">
              {app.sync_error && done
                ? `The first sync stopped: ${app.sync_error}`
                : done
                ? `First sync finished — ${tables.length} table${tables.length === 1 ? "" : "s"}, ready to ask.`
                : `Syncing the first copy · then ${intervalText}. You can close this; it keeps going in the background.`}
            </p>
            {tables.map((t) => (
              <div key={t.name} className="flex flex-col gap-2 px-3.5 py-3 rounded-[12px] border border-border bg-surface">
                <span className="flex justify-between gap-2.5">
                  <span className="font-mono text-[13px] text-text truncate">{t.name}</span>
                  <span className="text-[12px] text-muted shrink-0">{(t.rows ?? 0).toLocaleString()} rows</span>
                </span>
                <span className="h-1 rounded bg-surface2 overflow-hidden">
                  <span className="block h-full w-full bg-primary rounded" />
                </span>
              </div>
            ))}
            {!done && !pollError && (
              <div className="flex flex-col gap-2 px-3.5 py-3 rounded-[12px] border border-border bg-surface" aria-hidden="true">
                <span className="flex justify-between gap-2.5">
                  <span className="text-[13px] text-muted">{tables.length ? "Fetching the next table…" : "Fetching the first table…"}</span>
                </span>
                <span className="h-1 rounded bg-surface2 overflow-hidden">
                  <span className="block h-full w-2/5 bg-primary/60 rounded animate-pulse" />
                </span>
              </div>
            )}
            {pollError && <p className="m-0 text-[12.5px] text-muted">{pollError}</p>}
            {done ? (
              <div className="flex flex-col gap-2.5">
                {!app.sync_error && (
                  <div className="p-3.5 rounded-[12px] bg-primary/10 border border-primary/30 text-[13.5px] text-text">
                    Ready.{" "}
                    {appSpaces.length
                      ? `${label} is in ${appSpaces.map((s) => s.name).join(", ")}. Ask about it, or open the Space’s overview.`
                      : `Ask about ${label} any time.`}
                  </div>
                )}
                <button
                  type="button"
                  className="btn-primary h-11 text-[14px]"
                  onClick={() => {
                    onClose();
                    navigate(appSpaces[0] ? `/?space=${encodeURIComponent(appSpaces[0].id)}` : "/");
                  }}
                >
                  Ask about {label}
                </button>
                {appSpaces[0] && (
                  <button
                    type="button"
                    className="btn-secondary h-11 text-[14px]"
                    onClick={() => {
                      onClose();
                      navigate(`/spaces/${encodeURIComponent(appSpaces[0].id)}`);
                    }}
                  >
                    Open {appSpaces[0].name}
                  </button>
                )}
              </div>
            ) : (
              <button type="button" className="btn-primary h-11 text-[14px]" onClick={onClose}>
                Run it in the background
              </button>
            )}
          </div>
        )}
      </div>
    </Overlay>
  );
}

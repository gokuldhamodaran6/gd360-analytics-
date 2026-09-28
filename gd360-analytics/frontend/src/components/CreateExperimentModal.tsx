import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { experimentsApi, type Experiment } from "../api/client";

// Phase 4 (2026-09-28, Experimentation / A/B testing): the roadmap's own
// spec for this feature - "A 3-step wizard modal (metric -> variants ->
// launch)... Copies the existing step-based dashboard-creation wizard
// exactly" - so this is modeled closely on
// components/BuildDashboardModal.tsx's own structure: a step string-union
// state, a useEffect that resets everything when `open` flips true, inline
// per-step Next-button validation (no separate validation functions),
// explicit Back buttons, and the same reusable error-banner className that
// file already uses.
//
// Unlike BuildDashboardModal, "launch" here isn't a separate follow-up
// call - creating the experiment (POST /experiments) already sets it
// status="running" server-side the moment it's created (see backend
// models.Experiment's own docstring for why there's no separate draft/
// launch split). So the "Launch experiment" button on step 3 both creates
// AND launches it in one call, then this modal shows the two public URLs
// the backend just generated right there, before closing - the one and
// only moment those URLs are worth interrupting the founder to copy, the
// same way DataSourceForm.tsx's WebhookCredentialsPanel shows a streaming
// datasource's webhook URL/secret once, right after creation.

type Step = "metric" | "variants" | "launch";

function CloseIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function ArrowLeftIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}

// The exact copy-to-clipboard pattern DataSourceForm.tsx's own
// WebhookCredentialsPanel already uses for a streaming datasource's
// webhook URL - a readOnly input + a button that flips to "Copied!" for
// 1.5s, failing silently if the Clipboard API is blocked (the value is
// still visible/selectable by hand either way). Exported so
// pages/Experiments.tsx can reuse the exact same field for a running
// experiment's public URLs instead of redeclaring it.
export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be blocked in some browser contexts - ignore.
    }
  };

  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <input readOnly className="input text-xs flex-1 font-mono" value={value} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn-secondary text-xs px-3 py-2.5 shrink-0" onClick={copy}>
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export default function CreateExperimentModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [step, setStep] = useState<Step>("metric");
  const [name, setName] = useState("");
  const [metricName, setMetricName] = useState("");
  const [variantA, setVariantA] = useState("Control");
  const [variantB, setVariantB] = useState("Treatment");
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState("");
  // Set once the backend call actually succeeds - the modal then shows this
  // experiment's public URLs instead of closing immediately, so the
  // founder has one guaranteed chance to copy them.
  const [launched, setLaunched] = useState<Experiment | null>(null);

  // Fresh every time this reopens - a stale draft or error from a previous
  // open of this same modal should never carry over.
  useEffect(() => {
    if (open) {
      setStep("metric");
      setName("");
      setMetricName("");
      setVariantA("Control");
      setVariantB("Treatment");
      setError("");
      setLaunched(null);
      setLaunching(false);
    }
  }, [open]);

  if (!open) return null;

  const launch = async () => {
    if (launching) return;
    setLaunching(true);
    setError("");
    try {
      const exp = await experimentsApi.create({
        name: name.trim(),
        metric_name: metricName.trim(),
        variant_a_name: variantA.trim() || "Control",
        variant_b_name: variantB.trim() || "Treatment",
      });
      setLaunched(exp);
      onCreated();
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Couldn't launch this experiment. Please try again.");
    } finally {
      setLaunching(false);
    }
  };

  const handleClose = () => {
    if (launching) return;
    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="dash-card w-full max-w-lg p-6 relative">
        <button
          className="absolute top-4 right-4 text-muted hover:text-text transition disabled:opacity-40"
          onClick={handleClose}
          disabled={launching}
          aria-label="Close"
        >
          <CloseIcon />
        </button>

        {launched ? (
          <>
            <h2 className="text-lg font-bold mb-1">Experiment launched</h2>
            <p className="text-xs text-muted mb-4 leading-relaxed">
              &ldquo;{launched.name}&rdquo; is now running. Paste these two URLs into your website&rsquo;s own
              code - call the assignment URL before you decide which version to show a visitor, then call the
              conversion URL once they complete &ldquo;{launched.metric_name}&rdquo;.
            </p>
            <div className="space-y-3">
              <CopyField label="Assignment URL" value={launched.assign_url} />
              <CopyField label="Conversion URL" value={launched.convert_url} />
            </div>
            <p className="text-[11px] text-muted mt-3 leading-relaxed">
              You can always find these again on this experiment&rsquo;s card on the Experiments page.
            </p>
            <button type="button" className="btn-primary text-sm w-full mt-4" onClick={onClose}>
              Done
            </button>
          </>
        ) : step === "metric" ? (
          <>
            <h2 className="text-lg font-bold mb-1">New experiment</h2>
            <p className="text-xs text-muted mb-5 leading-relaxed max-w-sm">
              Step 1 of 3 - name this test and say what it&rsquo;s measuring.
            </p>

            {error && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">
                {error}
              </div>
            )}

            <label className="block text-xs font-semibold text-muted mb-1.5">Experiment name</label>
            <input
              autoFocus
              className="input text-sm w-full mb-4"
              placeholder='e.g. "Homepage CTA color"'
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
            />

            <label className="block text-xs font-semibold text-muted mb-1.5">What are you measuring?</label>
            <input
              className="input text-sm w-full"
              placeholder='e.g. "Signup conversion"'
              value={metricName}
              onChange={(e) => setMetricName(e.target.value)}
              maxLength={200}
            />

            <div className="flex items-center justify-end mt-5">
              <button
                type="button"
                disabled={!name.trim() || !metricName.trim()}
                onClick={() => setStep("variants")}
                className="btn-primary text-sm disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </>
        ) : step === "variants" ? (
          <>
            <button
              type="button"
              className="text-xs text-muted hover:text-text transition flex items-center gap-1 mb-3"
              onClick={() => setStep("metric")}
            >
              <ArrowLeftIcon /> Back
            </button>
            <h2 className="text-lg font-bold mb-1">Variants</h2>
            <p className="text-xs text-muted mb-5 leading-relaxed max-w-sm">
              Step 2 of 3 - name the two versions visitors will be split between, 50/50.
            </p>

            {error && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">
                {error}
              </div>
            )}

            <label className="block text-xs font-semibold text-muted mb-1.5">Variant A</label>
            <input
              autoFocus
              className="input text-sm w-full mb-4"
              placeholder="Control"
              value={variantA}
              onChange={(e) => setVariantA(e.target.value)}
              maxLength={80}
            />

            <label className="block text-xs font-semibold text-muted mb-1.5">Variant B</label>
            <input
              className="input text-sm w-full"
              placeholder="Treatment"
              value={variantB}
              onChange={(e) => setVariantB(e.target.value)}
              maxLength={80}
            />

            <div className="flex items-center justify-end mt-5">
              <button
                type="button"
                disabled={!variantA.trim() || !variantB.trim()}
                onClick={() => setStep("launch")}
                className="btn-primary text-sm disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </>
        ) : (
          <>
            <button
              type="button"
              className="text-xs text-muted hover:text-text transition flex items-center gap-1 mb-3 disabled:opacity-40"
              onClick={() => setStep("variants")}
              disabled={launching}
            >
              <ArrowLeftIcon /> Back
            </button>
            <h2 className="text-lg font-bold mb-1">Review and launch</h2>
            <p className="text-xs text-muted mb-4 leading-relaxed max-w-sm">
              Step 3 of 3 - this starts collecting data immediately. You can stop it any time from the
              Experiments page.
            </p>

            {error && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">
                {error}
              </div>
            )}

            <div className="rounded-xl border border-border p-3 space-y-2 text-sm mb-5">
              <div className="flex justify-between gap-3">
                <span className="text-muted">Name</span>
                <span className="font-medium truncate">{name}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted">Measuring</span>
                <span className="font-medium truncate">{metricName}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted">Variant A</span>
                <span className="font-medium truncate">{variantA.trim() || "Control"}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted">Variant B</span>
                <span className="font-medium truncate">{variantB.trim() || "Treatment"}</span>
              </div>
            </div>

            <button type="button" disabled={launching} onClick={launch} className="btn-primary text-sm w-full disabled:opacity-50">
              {launching ? "Launching…" : "Launch experiment"}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

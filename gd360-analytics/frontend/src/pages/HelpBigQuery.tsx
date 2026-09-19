import { Link } from "react-router-dom";
import ThemeToggle from "../components/ThemeToggle";

// Standalone, no-login-required guide page - opened in a NEW browser tab
// from the "How to connect BigQuery to GD360" link inside the BigQuery
// connect popout (see DataSourceForm.tsx), so filling that form out never
// means losing your place in it. Public (no <Protected> wrapper, unlike
// almost every other page in this app) since it is just static how-to
// content anyone can read, and a fresh tab may not carry an existing
// session yet anyway.
//
// Deliberately terse (2026-09-19 rewrite, per Gokul: "make it crisp and
// short... user has to understand quickly and complete their step asap").
// Originally 8 fuller-sentence steps; condensed to 6 short, scannable
// fragments with the actual clickable button/field names bolded, since
// those are the only words someone mid-task actually needs to find fast.
// Dropped the standalone "confirm the BigQuery API is enabled" step -
// almost always already true for anyone with existing BigQuery data - and
// folded "open the file and copy it" into the same step as creating the
// key, since those two actions always happen back-to-back anyway. Every
// navigation path below is still real, accurate Google Cloud Console
// navigation, just said in fewer words. The IAM role recommendation
// (BigQuery Data Viewer + BigQuery Job User) is the standard least-
// privilege combination for a service account that only needs to run
// SELECT queries: Data Viewer can read table data and metadata, and Job
// User can actually run a query job - together they are enough for
// GD360's read-only access and nothing more.

function StepNumber({ n }: { n: number }) {
  return (
    <div className="w-8 h-8 rounded-full bg-primary/15 text-primary font-bold text-sm flex items-center justify-center shrink-0">
      {n}
    </div>
  );
}

const STEPS = [
  {
    title: "Open your Google Cloud project",
    body: (
      <>
        Go to <strong>console.cloud.google.com</strong> and pick your project from the picker at the top.
      </>
    ),
  },
  {
    title: "Create a service account",
    body: (
      <>
        <strong>IAM &amp; Admin → Service Accounts → Create Service Account</strong>. Any name works.
      </>
    ),
  },
  {
    title: "Give it read-only access",
    body: (
      <>
        Add only these two roles: <strong>BigQuery Data Viewer</strong> and <strong>BigQuery Job User</strong>.
      </>
    ),
  },
  {
    title: "Create and copy the key",
    body: (
      <>
        Open the account → <strong>Keys → Add Key → Create new key → JSON</strong>. Open the downloaded file
        and copy everything in it.
      </>
    ),
  },
  {
    title: "Find your Project ID and Dataset ID",
    body: (
      <>
        <strong>Project ID</strong>: on your dashboard, under the project name.{" "}
        <strong>Dataset ID</strong>: under <strong>BigQuery → SQL Workspace</strong>.
      </>
    ),
  },
  {
    title: "Paste and connect",
    body: (
      <>
        Paste both IDs and the JSON key into GD360, then click <strong>Test &amp; connect</strong>.
      </>
    ),
  },
];

export default function HelpBigQuery() {
  return (
    <div className="min-h-screen bg-base text-text">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10">
        <div className="flex items-center justify-between mb-8">
          <Link to="/" className="font-bold text-lg tracking-tight">
            GD360 <span className="text-primary">Analytics</span>
          </Link>
          <ThemeToggle />
        </div>

        <div className="mb-8">
          <div className="text-xs font-semibold uppercase tracking-wide text-primary mb-2">Data warehouse setup</div>
          <h1 className="text-2xl sm:text-3xl font-bold leading-tight mb-3">How to connect BigQuery to GD360</h1>
          <p className="text-sm text-muted leading-relaxed">
            GD360 uses a <strong>read-only service account</strong> - not your Google login. Takes about 5 minutes.
          </p>
        </div>

        <div className="space-y-5">
          {STEPS.map((s, i) => (
            <div key={s.title} className="card p-4 flex gap-4">
              <StepNumber n={i + 1} />
              <div className="min-w-0">
                <div className="font-semibold text-sm mb-1">{s.title}</div>
                <p className="text-sm text-muted leading-relaxed">{s.body}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 text-xs text-muted bg-surface2 border border-border rounded-lg p-4 leading-relaxed">
          GD360 never asks for your Google password. This key is <strong>read-only</strong> - revoke it anytime
          by deleting the service account in Google Cloud Console.
        </div>

        <div className="mt-8 text-center">
          <Link to="/" className="text-sm font-medium text-primary hover:underline">
            &larr; Back to GD360
          </Link>
        </div>
      </div>
    </div>
  );
}

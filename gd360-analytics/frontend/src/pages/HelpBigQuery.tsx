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
// Every step below is real, accurate Google Cloud Console navigation as of
// this app's build date - nothing here is invented or approximate. The
// IAM role recommendation (BigQuery Data Viewer + BigQuery Job User) is
// the standard least-privilege combination for a service account
// that only needs to run SELECT queries: Data Viewer can read table data and
// metadata, and Job User can actually run a query job - together they are
// enough for GD360's read-only access and nothing more.

function StepNumber({ n }: { n: number }) {
  return (
    <div className="w-8 h-8 rounded-full bg-primary/15 text-primary font-bold text-sm flex items-center justify-center shrink-0">
      {n}
    </div>
  );
}

const STEPS = [
  {
    title: "Open (or create) a Google Cloud project",
    body:
      "Go to console.cloud.google.com and sign in with the Google account that owns your data. Use the project " +
      "picker at the top of the page to select the project your BigQuery data lives in, or create a new one if " +
      "you're starting fresh.",
  },
  {
    title: "Make sure the BigQuery API is enabled",
    body:
      "In the left-hand menu (or the search bar at the top), go to “APIs & Services” and confirm " +
      "“BigQuery API” is enabled for this project. If your project already has BigQuery datasets in it, " +
      "it almost certainly already is.",
  },
  {
    title: "Create a service account",
    body:
      "Go to “IAM & Admin” → “Service Accounts” → “Create Service Account”. " +
      "Give it any name you like, for example “gd360-read-only” - GD360 will only ever use this account " +
      "to read data, never to change anything.",
  },
  {
    title: "Grant it read-only access",
    body:
      "On the “Grant this service account access to project” step, add two roles: BigQuery Data Viewer " +
      "and BigQuery Job User. That's enough for GD360 to list your tables and run SELECT queries against them - " +
      "nothing more. Skip granting it anything else.",
  },
  {
    title: "Create a JSON key for it",
    body:
      "Open the service account you just created, go to its “Keys” tab, click “Add Key” → " +
      "“Create new key”, and choose JSON. A .json file downloads automatically to your computer - this " +
      "is the credential GD360 needs. Keep it somewhere safe; anyone who has it can read the data it's scoped to.",
  },
  {
    title: "Open that file and copy everything in it",
    body:
      "Open the downloaded .json file in any text editor (Notepad, TextEdit, VS Code - anything works). Select " +
      "all of its contents (the whole thing, starting from the first { to the last }) and copy it.",
  },
  {
    title: "Find your Project ID and Dataset ID",
    body:
      "Your Project ID is shown on the Cloud Console's dashboard, right under the project name (it looks like " +
      "“my-project-123456”, not the friendly display name). Your Dataset ID is the name of the BigQuery " +
      "dataset you want GD360 to read from - find it under “BigQuery” → “SQL Workspace” " +
      "in the left-hand tree, listed under your project.",
  },
  {
    title: "Fill in GD360's form and connect",
    body:
      "Back in the GD360 tab, paste your Project ID, your Dataset ID, and the full JSON key you copied in step 6 " +
      "into the matching fields, give the connection a name, and click “Test & connect.” GD360 tests the " +
      "connection and reads your dataset's table list before saving anything.",
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
            GD360 connects to BigQuery with a read-only service account, not your personal Google login. These
            steps walk through getting the three things GD360's connect form asks for: your Project ID, your
            Dataset ID, and a service account key. It takes about five minutes the first time.
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
          GD360 never asks for your Google account password, and this service account can only read the data you
          scope it to - it cannot change or delete anything in BigQuery. You can revoke access at any time by
          deleting the service account (or just its key) from the Google Cloud Console.
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

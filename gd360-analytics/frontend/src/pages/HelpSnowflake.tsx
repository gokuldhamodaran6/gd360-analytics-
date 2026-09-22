import { Link } from "react-router-dom";
import ThemeToggle from "../components/ThemeToggle";

// Standalone, no-login-required guide page - opened in a NEW browser tab
// from the "How to connect Snowflake to GD360" link inside the Snowflake
// connect popout (see DataSourceForm.tsx), so filling that form out never
// means losing your place in it. Public (no <Protected> wrapper, matching
// HelpBigQuery.tsx) since it is just static how-to content anyone can
// read, and a fresh tab may not carry an existing session yet anyway.
//
// Mirrors HelpBigQuery.tsx's terse, scannable step format (per Gokul's
// 2026-09-19 direction for that page: short fragments, real clickable
// names bolded). Step 2 here is a copyable SQL block instead of a click
// path, because that is genuinely how a least-privilege Snowflake role
// gets created - there is no equivalent point-and-click flow for it the
// way BigQuery's IAM roles have one. The granted privileges (USAGE on the
// warehouse/database/schema, SELECT on every table, and SELECT on FUTURE
// tables so new tables stay visible without re-granting) are the standard
// minimal set for a read-only reporting/BI role in Snowflake.

function StepNumber({ n }: { n: number }) {
  return (
    <div className="w-8 h-8 rounded-full bg-primary/15 text-primary font-bold text-sm flex items-center justify-center shrink-0">
      {n}
    </div>
  );
}

const SETUP_SQL = `CREATE ROLE gd360_readonly;
GRANT USAGE ON WAREHOUSE <your_warehouse> TO ROLE gd360_readonly;
GRANT USAGE ON DATABASE <your_database> TO ROLE gd360_readonly;
GRANT USAGE ON SCHEMA <your_database>.<your_schema> TO ROLE gd360_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA <your_database>.<your_schema> TO ROLE gd360_readonly;
GRANT SELECT ON FUTURE TABLES IN SCHEMA <your_database>.<your_schema> TO ROLE gd360_readonly;

CREATE USER gd360_service_user
  PASSWORD = '<a strong password>'
  DEFAULT_ROLE = gd360_readonly
  DEFAULT_WAREHOUSE = <your_warehouse>;

GRANT ROLE gd360_readonly TO USER gd360_service_user;`;

const STEPS = [
  {
    title: "Find your Account Identifier",
    body: (
      <>
        In Snowsight, click your account name (bottom-left) → <strong>Account</strong> → copy the{" "}
        <strong>Account Identifier</strong>. It's also the part of your Snowflake URL before{" "}
        <strong>.snowflakecomputing.com</strong> (e.g. <strong>xy12345.us-east-1</strong>).
      </>
    ),
  },
  {
    title: "Create a read-only role and user",
    body: (
      <>
        Open a <strong>SQL worksheet</strong> as an admin (or ask whoever manages your Snowflake account to run
        this) - it creates a role that can only ever read, and a dedicated login for GD360:
      </>
    ),
    sql: SETUP_SQL,
  },
  {
    title: "Note your warehouse, database, and schema",
    body: (
      <>
        Use the exact names you granted access to above - the <strong>warehouse</strong> is Snowflake's own name
        for a compute cluster, and <strong>schema</strong> is optional (leave it blank to use the user's default).
      </>
    ),
  },
  {
    title: "Paste and connect",
    body: (
      <>
        Enter the account identifier, warehouse, database, schema (optional), and the{" "}
        <strong>gd360_service_user</strong> username/password into GD360, then click{" "}
        <strong>Test &amp; connect</strong>.
      </>
    ),
  },
];

export default function HelpSnowflake() {
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
          <h1 className="text-2xl sm:text-3xl font-bold leading-tight mb-3">How to connect Snowflake to GD360</h1>
          <p className="text-sm text-muted leading-relaxed">
            GD360 uses a <strong>read-only Snowflake user</strong> - not your own login. Takes about 5 minutes.
          </p>
        </div>

        <div className="space-y-5">
          {STEPS.map((s, i) => (
            <div key={s.title} className="card p-4 flex gap-4">
              <StepNumber n={i + 1} />
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-sm mb-1">{s.title}</div>
                <p className="text-sm text-muted leading-relaxed">{s.body}</p>
                {s.sql && (
                  <pre className="mt-3 text-xs font-mono bg-surface2 border border-border rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words">
                    {s.sql}
                  </pre>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 text-xs text-muted bg-surface2 border border-border rounded-lg p-4 leading-relaxed">
          GD360 never asks for your own Snowflake login. This user is <strong>read-only</strong> - revoke it anytime
          by running <strong>DROP USER gd360_service_user;</strong> in Snowflake.
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

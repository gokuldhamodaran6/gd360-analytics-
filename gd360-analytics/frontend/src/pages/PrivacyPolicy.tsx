import { Link } from "react-router-dom";
import ThemeToggle from "../components/ThemeToggle";

// Public, standalone (no <Protected> wrapper, like HelpBigQuery.tsx) - a
// privacy policy has to be reachable by anyone, signed in or not, since
// it's read before someone ever creates an account, and it's also what
// Google/Microsoft's own OAuth verification reviewers check for when an
// app requests access to Sheets/Excel/Drive/OneDrive (see App.tsx's
// /connect/:provider route and the "Connect" tab in DataSourceForm.tsx).
//
// Written to describe what this app ACTUALLY does, not generic boilerplate -
// every claim below (encryption at rest, bcrypt password hashing, read-only
// connections, which third parties see what, localStorage-only session
// storage, no ad-tracking scripts) is grounded in the real backend/frontend
// code as of this page's writing. If the app's data handling changes later
// (a new AI provider, a new integration, actual analytics/tracking added),
// this page needs a matching update - it is not self-maintaining.
//
// This is a starting template, not a substitute for legal review - see the
// note Claude gave alongside this file.

const CONTACT_EMAIL = "gokuldhamodaran6@gmail.com";
const EFFECTIVE_DATE = "September 22, 2026";

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mb-8 scroll-mt-24">
      <h2 className="text-lg font-bold mb-3">{title}</h2>
      <div className="text-sm text-muted leading-relaxed space-y-3">{children}</div>
    </section>
  );
}

const TOC = [
  ["overview", "Overview"],
  ["information-we-collect", "Information we collect"],
  ["ai-processing", "How your data reaches AI providers"],
  ["how-we-use-it", "How we use information"],
  ["how-we-share-it", "How we share information"],
  ["security", "How we protect your data"],
  ["retention", "Data retention"],
  ["your-choices", "Your choices & rights"],
  ["cookies", "Cookies & local storage"],
  ["children", "Children's privacy"],
  ["changes", "Changes to this policy"],
  ["contact", "Contact us"],
] as const;

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-base text-text">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
        <div className="flex items-center justify-between mb-8">
          <Link to="/" className="font-bold text-lg tracking-tight">
            GD360 <span className="text-primary">Analytics</span>
          </Link>
          <ThemeToggle />
        </div>

        <div className="mb-8">
          <div className="text-xs font-semibold uppercase tracking-wide text-primary mb-2">Legal</div>
          <h1 className="text-2xl sm:text-3xl font-bold leading-tight mb-3">Privacy Policy</h1>
          <p className="text-sm text-muted leading-relaxed">
            Effective {EFFECTIVE_DATE}. This explains what GD360 Analytics ("GD360", "we", "us") collects when you
            use the app, why, who else ever sees it, and the choices you have.
          </p>
        </div>

        {/* Jump links - a policy this long is normally skimmed for one
            section, not read start to finish. */}
        <nav className="card p-4 mb-8">
          <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">On this page</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
            {TOC.map(([id, label]) => (
              <a key={id} href={`#${id}`} className="text-primary hover:underline">
                {label}
              </a>
            ))}
          </div>
        </nav>

        <Section id="overview" title="Overview">
          <p>
            GD360 is a data analytics tool: you connect your data (a database, a warehouse, an uploaded file, or a
            live source like Google Sheets), ask questions about it in plain English, and GD360 generates charts and
            answers. This policy covers the account information you give us directly, the credentials and data you
            connect, and what we do with each.
          </p>
          <p>
            We built GD360 to read your data, never to resell it. We don't run ads, we don't have a marketing
            analytics/tracking script on this site, and we don't sell personal information to anyone.
          </p>
        </Section>

        <Section id="information-we-collect" title="Information we collect">
          <p>
            <strong className="text-text">Account information.</strong> When you sign up: your email address, a
            securely hashed password (we use bcrypt - we never store or can see your actual password), and
            optionally your name and company.
          </p>
          <p>
            <strong className="text-text">Data source connections.</strong> When you connect a database or
            warehouse, we store the connection details (host, port, database name) and the password or service
            account key you provide - encrypted at rest, and never shown back to you or anyone else once saved. We
            only ever run read-only queries against your database; GD360 cannot write to, modify, or delete
            anything in a source you connect.
          </p>
          <p>
            <strong className="text-text">Google Sheets / Microsoft Excel connections.</strong> If you connect a
            live spreadsheet or workbook, you sign in directly with Google or Microsoft. We receive and store an
            access token (encrypted at rest, same as a database password) scoped to read-only access to the one
            file you pick - we never see your Google or Microsoft password, and we request only enough permission
            to read spreadsheets/workbooks and list your files, nothing more. You can revoke this access at any time
            from your Google Account or Microsoft Account security settings, which immediately stops GD360 from
            reading that data.
          </p>
          <p>
            <strong className="text-text">Uploaded files.</strong> A CSV or Excel file you upload is stored so it
            survives a restart of our servers, and is only ever used to answer your own questions about it.
          </p>
          <p>
            <strong className="text-text">The data itself.</strong> Whatever is inside a source you connect (a
            database table, a spreadsheet, an uploaded file) is, functionally, your data passing through our
            service so we can analyze it for you - see "How your data reaches AI providers" below for the one place
            a portion of it leaves our servers.
          </p>
          <p>
            <strong className="text-text">Usage information.</strong> The questions you ask, the charts and
            answers generated, and any tables you save, so your chat history and saved work are there when you come
            back.
          </p>
          <p>
            <strong className="text-text">Technical information.</strong> Basic request metadata (like IP address)
            used only for security purposes - rate-limiting abusive requests and slowing down repeated failed login
            attempts on an account.
          </p>
        </Section>

        <Section id="ai-processing" title="How your data reaches AI providers">
          <p>
            To turn a plain-English question into a chart or answer, GD360 sends your question - together with only
            the schema/column information and the specific rows needed to answer it, never your whole raw database
            dump - to a third-party AI provider (currently Google's Gemini API; GD360 can be configured to use a
            different provider instead). That provider processes the request to generate a response and, under our
            agreement with them, does not use it to train their own general-purpose models.
          </p>
          <p>
            This is the one point in the pipeline where a slice of your data necessarily leaves our own servers -
            it's how the "ask in plain English" feature works at all. If you'd rather a particular data source never
            has this happen, don't connect it or don't ask questions about it.
          </p>
        </Section>

        <Section id="how-we-use-it" title="How we use information">
          <p>We use what we collect to:</p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>Operate the service - authenticate you, run your queries, generate your charts and answers.</li>
            <li>Keep your account secure - detect suspicious login activity, enforce lockouts after repeated failed attempts.</li>
            <li>Maintain and improve GD360 - understand which features are used, and fix what's broken.</li>
            <li>Communicate with you about your account or significant changes to the service.</li>
          </ul>
        </Section>

        <Section id="how-we-share-it" title="How we share information">
          <p>We do not sell your personal information or your data. We share information only with:</p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              <strong className="text-text">Infrastructure providers</strong> who host the app and its database, and
              who process data only on our instructions to keep the service running.
            </li>
            <li>
              <strong className="text-text">The AI provider</strong> described above, only the minimum needed to
              answer the specific question you asked.
            </li>
            <li>
              <strong className="text-text">Google or Microsoft</strong>, only when you choose to connect a Google
              Sheets or Excel data source - we exchange your approval for an access token with them directly; we
              never see or store your Google/Microsoft password.
            </li>
            <li>
              <strong className="text-text">Law enforcement or regulators</strong>, only if legally required to, and
              only to the extent the law requires.
            </li>
          </ul>
        </Section>

        <Section id="security" title="How we protect your data">
          <ul className="list-disc pl-5 space-y-1.5">
            <li>Passwords are hashed with bcrypt - we cannot look up or recover your actual password.</li>
            <li>Database passwords, service account keys, and OAuth tokens are encrypted at rest and are never returned to any client once saved.</li>
            <li>Every connection GD360 makes to your data is read-only - no source you connect can be modified or deleted through GD360.</li>
            <li>All traffic between your browser and GD360 is encrypted in transit (HTTPS).</li>
            <li>Access to the underlying infrastructure is limited to those who need it to operate the service.</li>
          </ul>
          <p>No method of storing or transmitting data is 100% secure, but this is how we work to protect yours.</p>
        </Section>

        <Section id="retention" title="Data retention">
          <p>
            We keep your account information and connected-data metadata for as long as your account is active.
            Disconnecting a data source removes its stored credentials immediately. Deleting your account removes
            your account information, saved data, and connection credentials from our active systems, other than
            what we're required to retain for legal, security, or accounting reasons.
          </p>
        </Section>

        <Section id="your-choices" title="Your choices & rights">
          <ul className="list-disc pl-5 space-y-1.5">
            <li>You can review, rename, or disconnect any data source at any time from within GD360.</li>
            <li>You can revoke GD360's access to Google Sheets or Excel/OneDrive at any time from your Google or Microsoft account's own security/connected-apps settings.</li>
            <li>You can update your profile information from your account settings.</li>
            <li>You can request a copy of your data, or request that we delete your account and associated data, by contacting us below.</li>
          </ul>
          <p>
            Depending on where you live, you may have additional rights under laws like the GDPR or CCPA (for
            example, the right to access, correct, or delete your personal information, or to object to certain
            processing) - contact us and we'll respond to any request consistent with applicable law.
          </p>
        </Section>

        <Section id="cookies" title="Cookies & local storage">
          <p>
            GD360 does not use advertising or cross-site tracking cookies, and this site does not run any
            third-party analytics or tracking script. We use your browser's local storage only to keep you signed
            in (a session token) and to remember your light/dark theme preference - both stay on your device and
            are used only by GD360 itself.
          </p>
        </Section>

        <Section id="children" title="Children's privacy">
          <p>
            GD360 is a business analytics tool and is not directed at, or knowingly used to collect information
            from, children. If you believe a child has provided us with personal information, contact us and we'll
            remove it.
          </p>
        </Section>

        <Section id="changes" title="Changes to this policy">
          <p>
            If we make a material change to how we collect or use information, we'll update the effective date
            above and, where appropriate, let you know directly. Continuing to use GD360 after a change means you
            accept the updated policy.
          </p>
        </Section>

        <Section id="contact" title="Contact us">
          <p>
            Questions about this policy, or a request about your data? Reach us at{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </Section>

        <div className="mt-10 text-center">
          <Link to="/" className="text-sm font-medium text-primary hover:underline">
            &larr; Back to GD360
          </Link>
        </div>
      </div>
    </div>
  );
}

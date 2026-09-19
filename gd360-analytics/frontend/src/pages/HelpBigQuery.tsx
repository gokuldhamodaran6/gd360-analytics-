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

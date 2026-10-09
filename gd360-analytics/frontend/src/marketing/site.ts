// 2026-10-09: the public website's few company details in one place.
// Fill these in and redeploy; anything left empty is simply not shown
// (contact cards then point to the Enterprise demo form on /pricing).
export const SITE = {
  founderName: "Gokul Dhamodaran",
  founderRole: "Founder & CEO",
  /** Two or three lines in your own words. Empty shows a short default. */
  founderBio:
    "Gokul founded GD360 on one conviction: every team deserves answers it can prove, not charts it has to take on trust. He leads product, design and engineering, and holds every release to a single test — would a finance lead sign off on this answer without re-checking it?",
  founderLinkedIn: "https://www.linkedin.com/in/gokuldhamodaran/",
  founderEmail: "gokuldhamodaranb@gmail.com",
  investorsEmail: "gokuldhamodaranb@gmail.com",
  helloEmail: "gokuldhamodaranb@gmail.com", // press, partners and general enquiries
  careersEmail: "gokuldhamodaranb@gmail.com",
  /** Registered company name and address for the footer. */
  legalLine: "",
  /** Set VITE_BILLING_ENABLED=true once card payments are connected. */
  billingEnabled: import.meta.env.VITE_BILLING_ENABLED === "true",
};

export const DEFAULT_FOUNDER_BIO =
  "Building GD360 so that every team — not just the ones with a data department — can ask a question and trust the answer.";

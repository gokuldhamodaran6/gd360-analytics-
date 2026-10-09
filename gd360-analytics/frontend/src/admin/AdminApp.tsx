// 2026-10-10: Mission Control — GD360's internal admin portal. Its own shell
// (side navigation + top bar) and nested routes under /admin. Access is
// decided by the backend (/admin/v2/me): ADMIN_EMAILS owners and invited
// staff, each seeing what their role allows.
import { FormEvent, lazy, Suspense, useEffect, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import "./admin.css";
import { errText, mcGet } from "./api";
import { ErrorBox, Icon, Loading, Me, MeCtx, ToastHost } from "./ui";

const Overview = lazy(() => import("./screens/Overview"));
const Accounts = lazy(() => import("./screens/Accounts"));
const AccountDetail = lazy(() => import("./screens/AccountDetail"));
const People = lazy(() => import("./screens/People"));
const Segments = lazy(() => import("./screens/Segments"));
const Crm = lazy(() => import("./screens/Crm"));
const Support = lazy(() => import("./screens/Support"));
const Plans = lazy(() => import("./screens/Plans"));
const PricingLab = lazy(() => import("./screens/PricingLab"));
const Product = lazy(() => import("./screens/Product"));
const AiCost = lazy(() => import("./screens/AiCost"));
const Flags = lazy(() => import("./screens/Flags"));
const Health = lazy(() => import("./screens/Health"));
const Access = lazy(() => import("./screens/Access"));
const Trust = lazy(() => import("./screens/Trust"));

const I = {
  main: "M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z",
  accounts: "M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1",
  people: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  segments: "M22 3H2l8 9.46V19l4 2v-8.54z",
  crm: "M3 3h5v18H3zM10 3h5v12h-5zM17 3h4v8h-4z",
  support: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  plans: "M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  revenue: "M3 17l6-6 4 4 8-8M14 7h7v7",
  product: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  ai: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z",
  flags: "M4 22V4M4 4h13l-2 4 2 4H4",
  health: "M22 12h-4l-3 9L9 3l-3 9H2",
  access: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4",
  trust: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
};

type NavItem = [string, string, keyof typeof I, string?];
const NAV: [string, NavItem[]][] = [
  ["Overview", [["/admin", "Command center", "main"]]],
  ["Customers", [["/admin/accounts", "Accounts", "accounts"], ["/admin/people", "People", "people"], ["/admin/segments", "Segments", "segments"]]],
  ["Growth", [["/admin/crm", "Pipeline & leads", "crm", "crm"]]],
  ["Support", [["/admin/support", "Inbox & SLAs", "support", "support"]]],
  ["Revenue", [["/admin/plans", "Plans & entitlements", "plans", "overrides"], ["/admin/pricing-lab", "Pricing lab & forecast", "revenue"]]],
  ["Product", [["/admin/product", "Funnels & retention", "product"], ["/admin/ai", "AI usage & cost", "ai"], ["/admin/flags", "Flags & announcements", "flags"]]],
  ["Platform", [["/admin/health", "System health", "health", "health"]]],
  ["Trust", [["/admin/access", "Staff access & audit", "access", "access"], ["/admin/trust", "Security & privacy", "trust", "trust"]]],
];

function Shell({ me }: { me: Me }) {
  const [badges, setBadges] = useState<Record<string, number>>({});
  const [q, setQ] = useState("");
  const nav = useNavigate();
  const loc = useLocation();
  useEffect(() => {
    let alive = true;
    const load = () => mcGet("/badges").then((b) => alive && setBadges(b)).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, [loc.pathname]);
  const search = (e: FormEvent) => {
    e.preventDefault();
    const v = q.trim();
    if (!v) return;
    if (/^#?\d{3,6}$/.test(v)) nav(`/admin/support?q=${encodeURIComponent(v.replace("#", ""))}`);
    else nav(`/admin/people?q=${encodeURIComponent(v)}`);
  };
  const initials = (me.name || me.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join("");
  return (
    <div className="mc-root">
      <nav className="mc-nav" aria-label="Mission Control">
        <Link to="/admin" className="mc-brand">
          <span className="mc-brand-g">G</span>
          <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontWeight: 800, fontSize: 15 }}>GD360</span>
            <span className="mc-mono" style={{ fontSize: 10.5, letterSpacing: "0.12em", color: "var(--g)" }}>MISSION CONTROL</span>
          </span>
        </Link>
        <div className="mc-groups" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {NAV.map(([group, items]) => (
            <div key={group} className="mc-group">
              <span className="mc-glabel">{group.toUpperCase()}</span>
              {items.map(([to, label, icon, badgeKey]) => {
                const n = badgeKey ? badges[badgeKey] || 0 : 0;
                return (
                  <NavLink key={to} to={to} end={to === "/admin"} className={({ isActive }) => `mc-item${isActive ? " on" : ""}`}>
                    <Icon d={I[icon]} />
                    <span>{label}</span>
                    {n > 0 && <span className={`mc-badge${["support", "health", "access", "trust", "overrides"].includes(badgeKey!) ? " warn" : ""}`}>{n}</span>}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </div>
        <div className="mc-navfoot" style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
          <Link to="/" className="mc-item"><Icon d="M15 18l-6-6 6-6" /><span>Back to the app</span></Link>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 6px" }}>
            <span style={{ width: 34, height: 34, borderRadius: 34, background: "var(--g-tint)", border: "1px solid var(--g-bd)", color: "var(--g)", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 13 }}>{initials}</span>
            <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{me.name}</span>
              <span style={{ fontSize: 11.5, color: "var(--ink3)" }}>{me.role_label}</span>
            </span>
          </div>
        </div>
      </nav>
      <div className="mc-main">
        <header className="mc-top">
          <form onSubmit={search} className="mc-search" role="search">
            <Icon d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5" size={16} />
            <label style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }} htmlFor="mc-q">Search</label>
            <input id="mc-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people by name, email or company — or a ticket number" />
            <span className="mc-kbd">Enter</span>
          </form>
          <Link to="/admin?ask=1" className="mc-btn" style={{ borderColor: "var(--g-bd)", background: "var(--g-tint)", color: "var(--g-soft)" }}>
            <Icon d={I.ai} size={15} /> Ask Admin
          </Link>
          <span style={{ flex: 1 }} />
          <span className="mc-mono" style={{ fontSize: 11.5, color: "var(--ink3)" }}>{me.role_label} · {me.email}</span>
        </header>
        <Suspense fallback={<div className="mc-page"><Loading rows={4} /></div>}>
          <Routes>
            <Route index element={<Overview />} />
            <Route path="accounts" element={<Accounts />} />
            <Route path="accounts/:key" element={<AccountDetail />} />
            <Route path="people" element={<People />} />
            <Route path="segments" element={<Segments />} />
            <Route path="crm" element={<Crm />} />
            <Route path="support" element={<Support />} />
            <Route path="plans" element={<Plans />} />
            <Route path="pricing-lab" element={<PricingLab />} />
            <Route path="product" element={<Product />} />
            <Route path="ai" element={<AiCost />} />
            <Route path="flags" element={<Flags />} />
            <Route path="health" element={<Health />} />
            <Route path="access" element={<Access />} />
            <Route path="trust" element={<Trust />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}

export default function AdminApp() {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState("");
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    mcGet<Me>("/me").then(setMe).catch((e) => {
      if (e?.response?.status === 403) setDenied(true);
      else setErr(errText(e, "Couldn't open Mission Control."));
    });
  }, []);
  if (denied) {
    return (
      <div className="mc-root" style={{ alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div className="mc-card mc-pad" style={{ maxWidth: 440, display: "flex", flexDirection: "column", gap: 12 }}>
          <span className="mc-lbl">MISSION CONTROL</span>
          <h1 style={{ margin: 0, fontSize: 24 }}>This area is for the GD360 team.</h1>
          <p style={{ margin: 0, color: "var(--ink2)", lineHeight: 1.55 }}>Your account doesn't have a Mission Control role. If you should have one, ask an Owner to invite your email.</p>
          <Link to="/" className="mc-btn p" style={{ alignSelf: "flex-start" }}>Back to GD360</Link>
        </div>
      </div>
    );
  }
  if (err) return <div className="mc-root" style={{ padding: 24 }}><ErrorBox text={err} retry={() => window.location.reload()} /></div>;
  if (!me) return <div className="mc-root" style={{ padding: 24 }}><div style={{ width: "100%" }}><Loading rows={4} /></div></div>;
  return (
    <MeCtx.Provider value={me}>
      <ToastHost>
        <Shell me={me} />
      </ToastHost>
    </MeCtx.Provider>
  );
}

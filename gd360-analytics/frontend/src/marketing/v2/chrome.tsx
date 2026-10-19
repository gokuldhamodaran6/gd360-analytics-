// 2026-10-19 (R56, website boards): the public site's top bar and footer in brand v2.
import type { ReactNode } from "react";
import { useAuth } from "../../api/AuthContext";
import { A } from "../shared";
import { SITE } from "../site";
import "./site2.css";

export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#121514" />
      <path d="M8 21.5 13 15l4 3.5 7-9" stroke="#43E5A0" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SiteNav() {
  const { user } = useAuth();
  return (
    <header className="mk2-nav" data-mk2-nav="">
      <div className="mk2-wrap">
        <A href="/" className="mk2-logo" aria-label="GD360 home"><Mark />GD<span>360</span></A>
        <nav className="mk2-links" aria-label="Site">
          <A href="/#how">Product</A>
          <A href="/#proof">Why trust it</A>
          <A href="/#sources">Sources</A>
          <A href="/#security">Security</A>
          <A href="/pricing">Pricing</A>
          <A href="/about">About</A>
        </nav>
        <span className="mk2-sp" />
        {user ? (
          <A href="/" className="mk2-btn pri">Open GD360</A>
        ) : (
          <>
            <A href="/login" className="mk2-btn sec hide-sm">Sign in</A>
            <A href="/start" className="mk2-btn pri" data-mk2-start="">Start free</A>
          </>
        )}
      </div>
    </header>
  );
}

export function SiteFoot() {
  const mail = SITE.helloEmail;
  return (
    <footer className="mk2-foot">
      <div className="mk2-wrap">
        <div className="cols">
          <div>
            <A href="/" className="mk2-logo"><Mark size={22} />GD<span>360</span></A>
            <p style={{ color: "var(--ink3)", fontSize: 13.5, lineHeight: 1.6, marginTop: 12, maxWidth: 280 }}>Ask your data in plain words and see every step behind the answer.</p>
          </div>
          <div><b>Product</b><A href="/#how">How it works</A><A href="/#proof">Proof on every number</A><A href="/#sources">Sources</A><A href="/pricing">Pricing</A></div>
          <div><b>Company</b><A href="/about">About</A>{mail && <a href={`mailto:${mail}`}>Contact</a>}</div>
          <div><b>Trust</b><A href="/#security">Security</A><A href="/privacy">Privacy</A></div>
          <div><b>Get going</b><A href="/start">Start free</A><A href="/login">Sign in</A></div>
        </div>
        <div style={{ marginTop: 32, fontSize: 12.5, color: "var(--ink3)" }}>© {new Date().getFullYear()} GD360{SITE.legalLine ? ` · ${SITE.legalLine}` : ""}</div>
      </div>
    </footer>
  );
}

export function Site({ children, data }: { children: ReactNode; data?: string }) {
  return (
    <div className="mk2" data-mk2={data || ""}>
      <SiteNav />
      {children}
      <SiteFoot />
    </div>
  );
}

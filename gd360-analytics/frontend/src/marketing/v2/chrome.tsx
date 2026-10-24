// 2026-10-19 (R56, website boards): the public site's top bar and footer in brand v2.
import type { ReactNode } from "react";
import { useAuth } from "../../api/AuthContext";
import { A } from "../shared";
import { SITE } from "../site";
import { EulivMark, Wordmark } from "../../components/Brand";
import "./site2.css";

export function Mark({ size = 26 }: { size?: number }) {
  return <EulivMark size={size} tone="deep" />;   // R61: the Euliv orb
}

export function SiteNav() {
  const { user } = useAuth();
  return (
    <header className="mk2-nav" data-mk2-nav="">
      <div className="mk2-wrap">
        <A href="/" className="mk2-logo" aria-label="Euliv home"><Mark /><Wordmark size={18} tone="deep" /></A>
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
          <A href="/" className="mk2-btn pri">Open Euliv</A>
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
            <A href="/" className="mk2-logo"><Mark size={22} /><Wordmark size={16} tone="deep" /></A>
            <p style={{ color: "var(--ink3)", fontSize: 13.5, lineHeight: 1.6, marginTop: 12, maxWidth: 280 }}>Ask your data in plain words and see every step behind the answer.</p>
          </div>
          <div><b>Product</b><A href="/#how">How it works</A><A href="/#proof">Proof on every number</A><A href="/#sources">Sources</A><A href="/pricing">Pricing</A></div>
          <div><b>Company</b><A href="/about">About</A>{mail && <a href={`mailto:${mail}`}>Contact</a>}</div>
          <div><b>Trust</b><A href="/#security">Security</A><A href="/privacy">Privacy</A></div>
          <div><b>Get going</b><A href="/start">Start free</A><A href="/login">Sign in</A></div>
        </div>
        <div style={{ marginTop: 32, fontSize: 12.5, color: "var(--ink3)" }}>© {new Date().getFullYear()} Euliv{SITE.legalLine ? ` · ${SITE.legalLine}` : ""}</div>
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

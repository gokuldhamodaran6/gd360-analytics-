// 2026-10-09: shared pieces of the public website (Home, Pricing, About,
// Get started) built from the approved "GD360 Website — Final" mockup.
import { AnchorHTMLAttributes, ReactNode, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { errorDetailText } from "../api/client";

/** One link element for the whole site: in-app routes ("/pricing",
 * "/#platform") go through the router, everything else ("#enterprise",
 * "mailto:", "https://") is a plain anchor. */
export function A({ href = "#", children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href?: string }) {
  if (href.startsWith("/")) {
    return (
      <Link to={href} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

/** Page title, scroll to the top on arrival, and scroll to "#section" when
 * the address carries one (a link like "/#platform" from another page). */
export function useMarketingPage(title: string) {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);
  useEffect(() => {
    if (!hash) {
      window.scrollTo(0, 0);
      return;
    }
    const id = decodeURIComponent(hash.slice(1));
    // after the page has painted
    const t = window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    return () => window.clearTimeout(t);
  }, [pathname, hash]);
}

/** A readable message from an API error. */
export function errorText(e: any, fallback: string): string {
  return errorDetailText(e?.response?.data?.detail) || fallback;
}

/** "Coming soon" dialog for things that aren't switched on yet (paid plans,
 * card payments). Closes on Escape, on the backdrop and on Close; slides up
 * as a sheet on phones. Styles: .gd-soon-* in marketing.css. */
export function SoonDialog({ open, onClose, eyebrow, title, primary, children }: {
  open: boolean;
  onClose: () => void;
  eyebrow: string;
  title: string;
  primary?: ReactNode;
  children?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="gd-soon-veil" onClick={onClose}>
      <div className="gd-soon-card" role="dialog" aria-modal="true" aria-labelledby="gd-soon-title" onClick={(e) => e.stopPropagation()}>
        <div className="gd-soon-glyph" aria-hidden="true">
          <span className="gd-soon-ring"></span>
          <span className="gd-soon-ring gd-soon-ring2"></span>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="#04140D" strokeWidth="1.8" />
            <path d="M12 7v5l3.2 2" stroke="#04140D" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <span className="gd-soon-eyebrow">{eyebrow}</span>
        <h3 id="gd-soon-title" className="gd-soon-title">{title}</h3>
        <p className="gd-soon-body">{children}</p>
        <div className="gd-soon-actions">
          {primary}
          <button type="button" className="gd-soon-later" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

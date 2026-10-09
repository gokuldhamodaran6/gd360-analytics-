// 2026-10-09: shared pieces of the public website (Home, Pricing, About,
// Get started) built from the approved "GD360 Website — Final" mockup.
import { AnchorHTMLAttributes, useEffect } from "react";
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

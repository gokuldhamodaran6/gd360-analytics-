// 2026-10-30 (SEO round): server-side render of the public pages, used only at build time by prerender.mjs (frontend folder).
// The browser still renders the app as before; this just puts the page's real words into the HTML file so search
// engines, link previews and AI crawlers that don't run JavaScript see the same content people see.
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import MarketingHome from "./marketing/pages/Home";
import MarketingAbout from "./marketing/pages/About";

export const PAGES: Record<string, () => JSX.Element> = {
  "/": () => <MarketingHome />,
  "/about": () => <MarketingAbout />,
};

export function render(path: string): string {
  const Page = PAGES[path];
  return renderToString(
    <StaticRouter location={path}>
      <Page />
    </StaticRouter>
  );
}

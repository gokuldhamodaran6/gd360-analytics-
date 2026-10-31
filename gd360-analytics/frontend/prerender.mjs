// 2026-10-30 (SEO round): runs after `vite build` (see package.json "build"), from the frontend folder.
//  1. Fills __SITE_URL__ in dist/index.html from VITE_SITE_URL (default: the onrender address).
//  2. Writes the real HTML of the public pages into the files the server sends, so crawlers and link previews that
//     don't run JavaScript read the page's words: "/" -> dist/index.html, "/about" -> dist/about/index.html.
//     A tiny inline script empties that HTML before the app starts on any other address, for a signed-in person,
//     or on a customer's own domain, so nobody ever sees the wrong page flash.
//  3. Writes dist/robots.txt and dist/sitemap.xml for the same address.
// The titles and descriptions here mirror each page's useMarketingPage call; keep the two in step.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const SITE = String(process.env.VITE_SITE_URL || "https://gd360-analytics-web.onrender.com").replace(/\/+$/, "");

const PAGES = {
  "/": {
    file: "index.html",
    title: "Euliv: AI Data Analyst That Proves Every Number",
    description: "Ask your warehouse, databases and apps in plain English. Euliv answers with charts and shows the query behind every number. Free in early access.",
  },
  "/about": {
    file: "about/index.html",
    title: "About Euliv: Built So Every Team Can Trust Its Numbers",
    description: "Euliv is an AI data analyst for companies without a data team, founded by Gokul Dhamodaran. Our mission, principles and how to reach us.",
  },
};
const SITEMAP = ["/", "/about", "/start"];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// Mirrors App.tsx isRecognizedHost(): only there does "/" show the public site.
const guard = (path) =>
  `<script>(function(){var k=false;try{var h=location.hostname.toLowerCase();var ok=h==="localhost"||h==="127.0.0.1"||/\\.onrender\\.com$/.test(h);` +
  `var p=location.pathname.replace(/\\/+$/,"")||"/";k=ok&&p===${JSON.stringify(path)}&&!localStorage.getItem("gd360_token");}catch(e){}` +
  `if(!k){var r=document.getElementById("root");if(r)r.innerHTML="";}})();</script>`;

const ssrPath = join(root, "dist-ssr", "prerender.js");
const { render } = await import(pathToFileURL(ssrPath).href);

const template = readFileSync(join(dist, "index.html"), "utf8").replaceAll("__SITE_URL__", SITE);
if (!template.includes('<div id="root"></div>')) throw new Error("prerender: #root placeholder not found in dist/index.html");

for (const [path, page] of Object.entries(PAGES)) {
  const body = render(path);
  if (body.length < 2000) throw new Error(`prerender: ${path} rendered only ${body.length} characters`);
  const url = SITE + (path === "/" ? "/" : path);
  let html = template
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(page.title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(page.description)}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(page.title)}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${esc(page.title)}$2`);
  if (path !== "/") {
    html = html
      .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(page.description)}$2`)
      .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${esc(page.description)}$2`);
  }
  html = html.replace('<div id="root"></div>', `<div id="root">${body}</div>${guard(path)}`);
  const out = join(dist, page.file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`prerender: ${path} -> ${page.file} (${body.length} chars of HTML)`);
}

const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  join(dist, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    SITEMAP.map((p) => `  <url><loc>${SITE}${p}</loc><lastmod>${today}</lastmod></url>`).join("\n") +
    `\n</urlset>\n`
);
writeFileSync(
  join(dist, "robots.txt"),
  `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /admin-login\nDisallow: /new-landing\n\nSitemap: ${SITE}/sitemap.xml\n`
);
rmSync(join(root, "dist-ssr"), { recursive: true, force: true });
console.log(`prerender: sitemap.xml and robots.txt for ${SITE}`);

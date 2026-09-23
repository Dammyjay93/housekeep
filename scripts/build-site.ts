/**
 * Builds the website in site/: the live demo page, the fonts, and the landing page's terminal
 * report, all from the same demo data the CLI uses, so the site can't drift from the tool.
 *
 * Run with: npm run site:build (Cloudflare Pages runs it too, then serves site/).
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDemo } from "../src/demo.js";
import { renderDashboard } from "../src/render.js";
import { type Paint, summaryReport } from "../src/report.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const site = join(root, "site");

mkdirSync(join(site, "fonts"), { recursive: true });
for (const font of ["Geist-Regular.woff2", "Geist-Medium.woff2", "OFL-Geist.txt"]) {
  copyFileSync(join(root, "assets", "fonts", font), join(site, "fonts", font));
}

const demo = loadDemo();
writeFileSync(join(site, "demo.html"), renderDashboard(demo, { token: "demo", openers: [], demo: true }));

// The report as the terminal prints it, with its colours as classes. Markers survive the escaping.
const mark = (cls: string) => (s: string): string => `\u0001${cls}\u0002${s}\u0003`;
const html: Paint = { red: mark("r"), amber: mark("a"), green: mark("g"), dim: mark("d"), bold: mark("b") };
const report = summaryReport(demo, html).replace(/^\n+/, "").replace(/\n+$/, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/\u0001(\w)\u0002/g, '<span class="$1">').replace(/\u0003/g, "</span>")
  + '\n\n  <span class="b">o</span> <span class="d">open the map</span>   <span class="b">q</span> <span class="d">quit</span> <span class="cursor"></span>';
// The command that printed it, as it would sit in the terminal.
const typed = '<span class="d">~/code</span> <span class="g">$</span> npx git-housekeep\n\n';
const indexFile = join(site, "index.html");
const index = readFileSync(indexFile, "utf8");
const start = "<!--demo-report-->";
const end = "<!--/demo-report-->";
const a = index.indexOf(start);
const b = index.indexOf(end);
if (a < 0 || b < a) throw new Error("site/index.html is missing its <!--demo-report--> markers");
writeFileSync(indexFile, index.slice(0, a + start.length) + typed + report + index.slice(b));

process.stdout.write("Built site/: demo.html, fonts/, and the report in index.html\n");

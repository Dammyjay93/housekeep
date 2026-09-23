/** The dashboard page: the template, with its fonts and data embedded so it works offline and from a file. */

import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR, readJson } from "./config.js";
import type { Snapshot } from "./model.js";
import { asString, isRecord } from "./proc.js";

const ASSETS = fileURLToPath(new URL("../../assets/", import.meta.url));
const TEMPLATE = join(ASSETS, "dashboard.html");

// Geist (SIL Open Font License) ships with Housekeep.
const DEFAULT_FACES: Face[] = [{ file: "Geist-Regular.woff2", weight: "400" }, { file: "Geist-Medium.woff2", weight: "500" }];
const KINDS: Record<string, [string, string]> = {
  ".woff2": ["font/woff2", "woff2"], ".woff": ["font/woff", "woff"], ".otf": ["font/otf", "opentype"], ".ttf": ["font/ttf", "truetype"],
};

interface Face {
  file: string;
  weight: string;
  range?: string;
  fill?: boolean;
}

const fontCss = new Map<boolean, string>();

/**
 * The interface font as embedded @font-face rules. To use your own, put its files in
 * ~/.config/housekeep/fonts with a faces.json: {"faces": [{"file": "Mine-Regular.otf", "weight": "400"}],
 * "labelLift": "0px"}. A face can carry a unicode "range"; one marked "fill" catches characters the
 * others lack; labelLift nudges button labels for fonts whose letters sit low.
 */
function fonts(bundledOnly: boolean): string {
  const known = fontCss.get(bundledOnly);
  if (known !== undefined) return known;
  const customDir = join(CONFIG_DIR, "fonts");
  const custom = bundledOnly ? undefined : readJson(join(customDir, "faces.json"));
  let dir = join(ASSETS, "fonts");
  let faces = DEFAULT_FACES;
  let lift = "0px";
  if (isRecord(custom) && Array.isArray(custom.faces) && custom.faces.length) {
    dir = customDir;
    faces = custom.faces.flatMap((f): Face[] => {
      if (!isRecord(f)) return [];
      const file = asString(f.file);
      return file ? [{ file, weight: asString(f.weight) ?? "400", range: asString(f.range) ?? undefined, fill: f.fill === true }] : [];
    });
    lift = asString(custom.labelLift) ?? "0px";
  }
  const rules = [`:root{--label-lift:${lift};}`];
  for (const face of faces) {
    const path = join(dir, face.file);
    const kind = KINDS[extname(path).toLowerCase()];
    if (!kind || !existsSync(path)) continue;
    const family = face.fill ? "Housekeep Fill" : "Housekeep Sans";
    const src = `url(data:${kind[0]};base64,${readFileSync(path).toString("base64")}) format('${kind[1]}')`;
    rules.push(`@font-face{font-family:"${family}";src:${src};font-weight:${face.weight};font-display:block;${face.range ? `unicode-range:${face.range};` : ""}}`);
  }
  const css = rules.join("\n");
  fontCss.set(bundledOnly, css);
  return css;
}

export interface LivePage {
  token: string;
  openers: string[];
  /** Made-up projects: buttons show what they'd do, and the page answers them itself. */
  demo?: boolean;
}

/**
 * `live` carries the server's token; without it the page is a read-only snapshot. A demo page always
 * uses the bundled font, since it's shared (the website) rather than yours.
 */
export function renderDashboard(data: Snapshot, live: LivePage | null): string {
  const embed = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");
  return readFileSync(TEMPLATE, "utf8")
    .replace("/*__FONTS__*/", () => fonts(Boolean(live?.demo)))
    .replace("/*__HOUSEKEEP_LIVE__*/null", () => embed(live))
    .replace("/*__HOUSEKEEP_DATA__*/null", () => embed(data));
}

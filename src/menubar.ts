/**
 * The menu bar light, as SwiftBar plugin output: a coloured dot and how many projects need you,
 * and under it each project's next step and four checks.
 */

import type { Snapshot, Tier } from "./model.js";
import { plural } from "./proc.js";

export const PLUGIN_NAME = "housekeep";

// Apple's system red, orange and green: legible on light and dark menu bars.
const SIGNAL: Record<Tier, string> = { "at-risk": "#FF453A", attention: "#FF9F0A", safe: "#30D158" };
const BADGE: Record<Tier, string> = { "at-risk": "At risk", attention: "Check", safe: "" };

const sf = (symbol: string, color?: string): string => {
  if (!color) return `sfimage=${symbol}`;
  const config = { renderingMode: "Palette", colors: [color], scale: "small", weight: "regular" };
  return `sfimage=${symbol} sfconfig=${Buffer.from(JSON.stringify(config)).toString("base64")}`;
};

/** A SwiftBar parameter value: quoted, with no double quotes inside to break the line. */
const q = (value: string): string => `"${value.replace(/"/g, "'")}"`;

/** SwiftBar treats | as the start of parameters, so it can't appear in a title. */
const plain = (text: string): string => text.replace(/\|/g, "/").replace(/\n/g, " ");

const since = (iso: string | null): string => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return plural(Math.floor(s / 86_400), "day") + " ago";
};

export interface MenuCommand {
  node: string;
  script: string;
}

export function menubar(data: Snapshot, mapUrl: string, cmd: MenuCommand): string {
  const lines: string[] = [];
  if (data.error) {
    lines.push(`| ${sf("exclamationmark.triangle")} tooltip=${q(`Housekeep: ${data.error.title}`)}`, "---",
      `${plain(data.error.title)} | size=13`, `${plain(data.error.detail)} | size=11`, "---", "Try again | refresh=true");
    return lines.join("\n");
  }
  const projects = data.projects;
  const needy = projects.filter((p) => p.tier !== "safe");
  const worst: Tier = projects.some((p) => p.tier === "at-risk") ? "at-risk" : needy.length ? "attention" : "safe";
  lines.push(needy.length
    ? `${needy.length} need you | ${sf("circle.fill", SIGNAL[worst])} tooltip=${q(`Housekeep: ${needy.length} of ${projects.length} need attention`)}`
    : `| ${sf("checkmark.circle")} tooltip=${q("Housekeep: everything is clean")}`);
  lines.push("---");
  const headline = !projects.length ? "No active projects to watch"
    : needy.length ? `${needy.length} of ${plural(projects.length, "project")} need${needy.length === 1 ? "s" : ""} attention`
    : `All ${plural(projects.length, "project")} clean`;
  lines.push(`${headline} | size=14 href=${mapUrl}`);
  const fetched = projects.map((p) => p.fetch.at).filter((a): a is string => Boolean(a)).sort()[0] ?? null;
  lines.push(`Checked ${since(data.generatedAt)}${fetched ? ` · fetched ${since(fetched)}` : ""} | size=11`, "---");

  projects.forEach((p, i) => {
    if (i && p.tier === "safe" && projects[i - 1]?.tier !== "safe") lines.push("---");
    const badge = BADGE[p.tier] ? ` badge=${q(BADGE[p.tier])}` : "";
    lines.push(`${plain(p.name)} | ${sf("circle.fill", SIGNAL[p.tier])}${badge}`);
    const here = `${mapUrl}#${p.slug}`;
    if (p.next) {
      lines.push(`--${p.next.tier === "safe" ? "" : "**Start here:** "}${plain(p.next.title)} | md=true size=13 href=${here}`);
      lines.push(`--${plain(p.next.why)} | size=11`, "-----");
    }
    for (const s of p.signals) lines.push(`--${s.label}  ·  ${plain(s.headline)} | ${sf("circle.fill", SIGNAL[s.tier])} size=13 href=${here}`);
    if (p.fetch.error) lines.push(`--${plain(p.fetch.error)} | size=11`);
    lines.push("-----", `--Open on the map | href=${here}`,
      `--Show in Finder | bash=/usr/bin/open param1=-R param2=${q(p.path)} terminal=false`);
    if (p.next?.ask) lines.push(`--Copy request for your AI assistant | bash=${q(cmd.node)} param1=${q(cmd.script)} param2=copy param3=${q(p.path)} terminal=false`);
  });
  lines.push("---", `Open the map | href=${mapUrl}`, "Check now | refresh=true");
  return lines.join("\n");
}

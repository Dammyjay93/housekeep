/** The terminal report: every project's verdict and next step, or one project in detail. */

import type { Project, Signal, Snapshot, Tier } from "./model.js";
import { plural } from "./proc.js";

const useColor = (stream: NodeJS.WriteStream): boolean =>
  !("NO_COLOR" in process.env) && (process.env.FORCE_COLOR !== undefined || Boolean(stream.isTTY));

export interface Paint {
  red: (s: string) => string;
  amber: (s: string) => string;
  green: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
}

export function paint(stream: NodeJS.WriteStream): Paint {
  const on = useColor(stream);
  const wrap = (open: string, close: string) => (s: string): string => (on ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return { red: wrap("31", "39"), amber: wrap("33", "39"), green: wrap("32", "39"), dim: wrap("2", "22"), bold: wrap("1", "22") };
}

const since = (iso: string | null): string => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return plural(Math.floor(s / 86_400), "day") + " ago";
};

function mark(c: Paint, tier: Tier): string {
  return tier === "at-risk" ? c.red("●") : tier === "attention" ? c.amber("●") : c.green("✓");
}

function verdict(c: Paint, tier: Tier): string {
  return tier === "at-risk" ? c.red("Could lose work") : tier === "attention" ? c.amber("Needs attention") : c.dim("All clear");
}

/** A short phrase per unhealthy signal, e.g. "5 behind origin/main". */
function brief(p: Project, s: Signal): string {
  if (s.key === "sync" && p.main.remoteRef && /^\d+ (behind|ahead)$/.test(s.cell)) return `${s.cell.replace("ahead", "ahead of")} ${p.main.remoteRef}`;
  if (s.key === "sync" && s.cell === "Diverged" && p.main.remoteRef) return `diverged from ${p.main.remoteRef}`;
  if (s.key === "cleanup") return s.headline;
  return s.cell.charAt(0).toLowerCase() + s.cell.slice(1);
}

const pad = (s: string, width: number): string => (s.length >= width ? s.slice(0, width - 1) + "…" : s + " ".repeat(width - s.length));

export function summaryReport(data: Snapshot, c: Paint): string {
  const lines: string[] = [""];
  if (data.error) {
    lines.push(`  ${c.red("●")} ${c.bold(data.error.title)}`, `    ${data.error.detail}`, "");
    return lines.join("\n");
  }
  const fetched = data.projects.map((p) => p.fetch.at).filter((a): a is string => Boolean(a)).sort()[0] ?? null;
  lines.push(`  ${c.bold("housekeep")}  ${c.dim(`·  ${plural(data.projects.length, "repo")}${fetched ? `  ·  fetched ${since(fetched)}` : ""}`)}`, "");
  if (!data.projects.length) {
    lines.push(`  No repos you've worked on in the last ${data.activeDays} days.`, c.dim(`  Add folders to watch in ${data.configPath}.`), "");
  }
  const width = Math.min(34, Math.max(12, ...data.projects.map((p) => p.name.length + 2)));
  for (const p of data.projects) {
    lines.push(`  ${mark(c, p.tier)} ${c.bold(pad(p.name, width))} ${verdict(c, p.tier)}`);
    if (p.error) {
      lines.push(`    ${c.dim(p.error)}`, "");
      continue;
    }
    // What to do leads; what was found follows, quieter, under it.
    const issues = p.signals.filter((s) => s.tier !== "safe").map((s) => brief(p, s));
    if (p.next && p.next.tier !== "safe") lines.push(`    ${c.dim("→")} ${p.next.title}`);
    if (issues.length) lines.push(`      ${c.dim(issues.join("  ·  "))}`);
    if (p.fetch.error) lines.push(`      ${c.dim(p.fetch.error)}`);
    if (p.tier !== "safe") lines.push("");
  }
  if (data.projects.some((p) => p.tier === "safe")) lines.push("");
  const n = (t: Tier): number => data.projects.filter((p) => p.tier === t).length;
  const counts = [
    n("at-risk") ? c.red(`${n("at-risk")} could lose work`) : "",
    n("attention") ? c.amber(`${n("attention")} need${n("attention") === 1 ? "s" : ""} attention`) : "",
    n("safe") ? c.green(`${n("safe")} all clear`) : "",
  ].filter(Boolean);
  if (counts.length) lines.push(`  ${counts.join(c.dim("  ·  "))}`);
  if (data.projects.some((p) => p.tier !== "safe")) {
    lines.push("", c.dim("  Each fix is a request for your AI assistant: housekeep <repo> shows it, housekeep copy <repo> copies it."));
  }
  for (const notice of data.notices ?? []) lines.push("", c.dim(`  ${notice}`));
  if (data.blocked.length) {
    lines.push("", c.dim(`  Couldn't look inside ${data.blocked.slice(0, 3).join(", ")}${data.blocked.length > 3 ? " and more" : ""}.`),
      c.dim(process.platform === "darwin"
        ? "  macOS asks before apps read these folders: allow your terminal in System Settings › Privacy & Security › Files and Folders."
        : "  Check the folder permissions, or add the repos to `watch` in your settings."));
  }
  lines.push("");
  return lines.join("\n");
}

export function detailReport(p: Project, c: Paint): string {
  const lines: string[] = ["", `  ${mark(c, p.tier)} ${c.bold(p.name)}  ${c.dim(p.displayPath + (p.head.branch ? `  on ${p.head.branch}` : ""))}   ${verdict(c, p.tier)}`, ""];
  if (p.error) return [...lines, `    ${p.error}`, ""].join("\n");
  for (const s of p.signals) {
    lines.push(`  ${mark(c, s.tier)} ${pad(s.label, 14)}${s.tier === "safe" ? s.headline : c.bold(s.headline)}`);
    if (s.tier !== "safe") {
      lines.push(`    ${" ".repeat(14)}${c.dim(s.hint)}`);
      for (const d of s.details) lines.push(`    ${" ".repeat(14)}${c.dim("· " + d)}`);
    }
  }
  if (p.fetch.error) lines.push("", `  ${c.dim(p.fetch.error)}`);
  if (p.next) {
    lines.push("", `  ${c.dim("→")} ${c.bold(p.next.title)}`, `    ${c.dim(p.next.why)}`);
    if (p.next.tier !== "safe" && p.next.ask) {
      lines.push("", c.dim("    Ask your AI assistant, opened in this repo (housekeep copy copies it):"), `    ${p.next.ask}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** 0 all clear, 1 something needs attention, 2 work could be lost, 3 Housekeep couldn't check. */
export function exitCode(data: Snapshot): number {
  if (data.error) return 3;
  if (data.projects.some((p) => p.tier === "at-risk")) return 2;
  return data.projects.some((p) => p.tier === "attention") ? 1 : 0;
}

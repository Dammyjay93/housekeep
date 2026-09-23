/**
 * The one thing the map does on your computer: open a project's folder in another app. It never runs
 * git. Every fix is a request you copy to your AI assistant, which does the work where you can see it.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Project } from "./model.js";
import { ENV, run } from "./proc.js";

export class OpenError extends Error {}

const MAC = process.platform === "darwin";
const MAC_APPS: Record<string, string> = { vscode: "/Applications/Visual Studio Code.app", cursor: "/Applications/Cursor.app" };

export const OPENERS: Record<string, { label: string; command: (path: string) => [string, string[]] | null }> = {
  files: { label: MAC ? "Finder" : "Files", command: (path) =>
    MAC ? ["open", [path]] : process.platform === "win32" ? ["explorer", [path]] : ["xdg-open", [path]] },
  terminal: { label: "Terminal", command: (path) => (MAC ? ["open", ["-a", "Terminal", path]] : null) },
  vscode: { label: "VS Code", command: (path) => (MAC ? ["open", ["-a", "Visual Studio Code", path]] : ["code", [path]]) },
  cursor: { label: "Cursor", command: (path) => (MAC ? ["open", ["-a", "Cursor", path]] : ["cursor", [path]]) },
};

/** Opens one of the project's own working trees, and nothing else, in the app asked for. */
export function openIn(p: Project, path: string, app: string): string {
  if (path !== p.path && !p.checkouts.some((c) => c.path === path && !c.missing)) throw new OpenError("That folder isn't part of this repo.");
  const opener = OPENERS[app];
  const command = opener?.command(path);
  if (!opener || !command) throw new OpenError("That app isn't available here.");
  spawn(command[0], command[1], { env: ENV, detached: true, stdio: "ignore" }).unref();
  return `Opened in ${opener.label}`;
}

/** Which "Open in" apps this machine has. */
export async function availableOpeners(): Promise<string[]> {
  const out: string[] = ["files"];
  if (MAC) out.push("terminal");
  for (const [key, bin] of [["vscode", "code"], ["cursor", "cursor"]] as const) {
    const installed = MAC ? existsSync(MAC_APPS[key] ?? "") : (await run(process.platform === "win32" ? "where" : "which", [bin])).ok;
    if (installed) out.push(key);
  }
  return out;
}

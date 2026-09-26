/**
 * Running in the background on a Mac, for people who live in the terminal: a LaunchAgent keeps the
 * live map going from login, and a SwiftBar plugin shows the light. The Mac app does both on its own.
 */

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR, STATE_DIR, loadConfig } from "./config.js";
import { PLUGIN_NAME } from "./menubar.js";
import { ENV, HOME, run, tilde } from "./proc.js";

export const LABEL = "dev.housekeep.server";
const PLIST = join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
const PLUGIN_FILE = `${PLUGIN_NAME}.2m.sh`;
const OWN_PLUGIN_DIR = join(CONFIG_DIR, "swiftbar");
const SWIFTBAR_APPS = ["/Applications/SwiftBar.app", join(HOME, "Applications", "SwiftBar.app")];

export const cliPath = (): string => fileURLToPath(new URL("./cli.js", import.meta.url));
export const swiftBarApp = (): string | undefined => SWIFTBAR_APPS.find((a) => existsSync(a));

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sh = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
const uid = (): number => process.getuid?.() ?? 0;

async function pluginDir(): Promise<string | null> {
  const r = await run("defaults", ["read", "com.ameba.SwiftBar", "PluginDirectory"]);
  const dir = r.ok ? r.stdout.trim().replace(/^~(?=\/|$)/, HOME) : "";
  return dir || null;
}

export async function install(): Promise<string[]> {
  if (process.platform !== "darwin") {
    return ["Running in the background and the menu bar light are macOS-only for now. Use housekeep serve to run the live map."];
  }
  const cli = cliPath();
  // npx runs from a cache folder npm may clear; a login item pointing there would break later.
  if (cli.split(sep).includes("_npx")) {
    return ["Install Housekeep first so it has a permanent home: npm install -g git-housekeep, then run housekeep install."];
  }
  const node = process.execPath;
  const out: string[] = [];

  // The live map, from login onwards, restarted if it ever stops.
  mkdirSync(dirname(PLIST), { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const log = join(STATE_DIR, "server.log");
  writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(cli)}</string><string>serve</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(ENV.PATH ?? "/usr/bin:/bin")}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`);
  await run("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
  // Unloading finishes in the background; loading again too soon fails.
  for (let i = 0; i < 50 && (await run("launchctl", ["print", `gui/${uid()}/${LABEL}`])).ok; i++) await new Promise((r) => setTimeout(r, 200));
  const loaded = await run("launchctl", ["bootstrap", `gui/${uid()}`, PLIST]);
  if (!loaded.ok) return [`Couldn't start the background service: ${loaded.stderr.trim() || "launchctl refused"}.`];
  out.push(`The live map now runs in the background, from login: http://127.0.0.1:${loadConfig().port}/`);

  // The menu bar light.
  const app = swiftBarApp();
  if (!app) {
    out.push("For the menu bar light, the Mac app is the easy way: https://housekeep.pages.dev",
      "Or install SwiftBar (brew install --cask swiftbar), then run housekeep install again.");
    return out;
  }
  let dir = await pluginDir();
  if (!dir) {
    mkdirSync(OWN_PLUGIN_DIR, { recursive: true });
    await run("defaults", ["write", "com.ameba.SwiftBar", "PluginDirectory", OWN_PLUGIN_DIR]);
    dir = OWN_PLUGIN_DIR;
  }
  mkdirSync(dir, { recursive: true });
  const plugin = join(dir, PLUGIN_FILE);
  writeFileSync(plugin, `#!/bin/bash
# <xbar.title>Housekeep</xbar.title>
# <xbar.desc>Is your git work committed, pushed, in sync with main, and cleaned up?</xbar.desc>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
exec ${sh(node)} ${sh(cli)} menubar
`);
  chmodSync(plugin, 0o755);
  await run("open", ["-g", app]);
  await run("open", ["-g", `swiftbar://refreshplugin?name=${PLUGIN_NAME}`]);
  out.push(`The menu bar light is in SwiftBar (${tilde(plugin)}).`);
  return out;
}

export async function uninstall(): Promise<string[]> {
  if (process.platform !== "darwin") return ["Nothing to uninstall: background running is macOS-only."];
  await run("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
  rmSync(PLIST, { force: true });
  const dir = await pluginDir();
  if (dir) rmSync(join(dir, PLUGIN_FILE), { force: true });
  if (dir === OWN_PLUGIN_DIR) await run("defaults", ["delete", "com.ameba.SwiftBar", "PluginDirectory"]);
  if (swiftBarApp()) await run("open", ["-g", "swiftbar://refreshallplugins"]);
  return ["Housekeep no longer runs in the background or in the menu bar.", `Your settings are still in ${tilde(CONFIG_DIR)}.`];
}

#!/usr/bin/env node
/** housekeep: is your git work committed, pushed, in sync with main, and cleaned up? */

import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { CONFIG_FILE, MAP_FILE, STATE_DIR, writeAtomic } from "./config.js";
import { loadDemo } from "./demo.js";
import { cliPath, install, swiftBarApp, uninstall } from "./install.js";
import { menubar } from "./menubar.js";
import { ENV, run, tilde } from "./proc.js";
import { renderDashboard } from "./render.js";
import { detailReport, exitCode, paint, summaryReport } from "./report.js";
import { VERSION, scan } from "./scan.js";
import { type LiveServer, runningServer, serverState, startServer } from "./server.js";

const HELP = `housekeep ${VERSION}

Is your git work committed, pushed, in sync with main, and cleaned up?

Usage
  housekeep               Check every repo you've worked on recently
  housekeep <path>        Check one repo in detail (e.g. housekeep .)
  housekeep serve         Run the live map in this terminal
  housekeep open          Open the live map in your browser
  housekeep install       macOS: keep the live map running from login, with a menu bar light (SwiftBar)
  housekeep uninstall     macOS: undo housekeep install

Options
  --json                  Print the full result as JSON (for scripts and AI assistants)
  --fetch                 Fetch from every remote now, whatever the schedule
  --offline               Don't touch the network
  --port <n>              Port for the live map (default 47219)
  --demo                  Try it on made-up projects: nothing on your computer is read or changed
  -v, --version           Print the version
  -h, --help              Show this help

Exit codes
  0 all clear · 1 needs attention · 2 could lose work · 3 couldn't check

Settings live in ${tilde(CONFIG_FILE)}.
`;

const out = (text: string): void => {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
};

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(cmd, args, { env: ENV, detached: true, stdio: "ignore" }).on("error", () => out(`Open ${url} in your browser.`)).unref();
}

/** A quiet spinner on stderr while the first check runs, so the terminal never looks stuck. */
function spinner(text: string): () => void {
  if (!process.stderr.isTTY) return () => undefined;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const timer = setInterval(() => process.stderr.write(`\r  ${frames[i++ % frames.length]} ${text}`), 80);
  return () => {
    clearInterval(timer);
    process.stderr.write("\r\x1b[2K");
  };
}

async function serveUntilStopped(server: LiveServer): Promise<never> {
  return new Promise(() => {
    const stop = (): void => void server.close().then(() => process.exit(0));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function openMap(port: number | undefined): Promise<LiveServer | null> {
  const running = await runningServer();
  if (running) {
    openBrowser(running.url);
    return null;
  }
  const server = await startServer({ port });
  openBrowser(server.url);
  return server;
}

/** After the report: o opens the live map, q (or Ctrl-C) quits. */
function waitForKeys(port: number | undefined, code: number, demo: boolean): Promise<never> {
  const c = paint(process.stdout);
  out(`  ${c.bold("o")} ${c.dim("open the map")}   ${c.bold("q")} ${c.dim("quit")}`);
  let server: LiveServer | null = null;
  const quit = async (): Promise<void> => {
    process.stdin.setRawMode(false);
    if (server) await server.close();
    process.exit(code);
  };
  return new Promise(() => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (key: Buffer) => {
      const k = key.toString();
      if (k === "q" || k === "\u0003" || k === "\u001b") void quit();
      else if (k === "o" && demo) openDemo();
      else if (k === "o") {
        void openMap(port).then((s) => {
          if (s) {
            server = s;
            out(c.dim(`  Live map at ${s.url}. It updates as you work until you quit.`));
          }
        });
      }
    });
  });
}

/** The map with made-up projects, as a page of its own: no server, and nothing read or changed. */
function openDemo(): void {
  const file = join(STATE_DIR, "demo.html");
  writeAtomic(file, renderDashboard(loadDemo(), { token: "demo", openers: [], demo: true }));
  openBrowser(pathToFileURL(file).href);
}

/** SwiftBar runs this: the live server's state when it's up, otherwise a check of its own. */
async function menubarCommand(): Promise<number> {
  const manual = ["MenuAction", "URLScheme", "RefreshAllMenu", "RefreshAllURLScheme", "Shortcut"].includes(process.env.SWIFTBAR_PLUGIN_REFRESH_REASON ?? "");
  const server = await runningServer();
  let data = server ? await serverState(server, manual) : null;
  let url = server?.url ?? pathToFileURL(MAP_FILE).href;
  if (!data) {
    data = await scan({ force: manual });
    writeAtomic(MAP_FILE, renderDashboard(data, null));
    url = pathToFileURL(MAP_FILE).href;
  }
  out(menubar(data, url, { node: process.execPath, script: cliPath() }));
  return 0;
}

/** The menu's "Copy request" item: put the project's request for an AI assistant on the clipboard. */
async function copyCommand(path: string | undefined): Promise<number> {
  if (!path) return (out("housekeep copy needs a repo path."), 3);
  const data = await scan({ offline: true, only: path });
  const p = data.projects[0];
  const text = p?.next?.ask || `Look at the git state of ${path} and walk me back to a clean state: every change committed and pushed, ` +
    "main up to date with the remote, and no merged branches or stale worktrees left. Ask me before anything that pushes, merges or deletes.";
  const copied = process.platform === "darwin" ? await run("pbcopy", [], { input: text }) : null;
  if (!copied?.ok) return (out(text), 0);
  if (swiftBarApp()) {
    await run("open", ["-g", `swiftbar://notify?plugin=housekeep&title=${encodeURIComponent("Copied")}&body=${encodeURIComponent("Paste it into your AI coding assistant.")}&silent=true`]);
  }
  out("Copied. Paste it into your AI coding assistant, opened in that repo.");
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      fetch: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      port: { type: "string" },
      demo: { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return (out(HELP), 0);
  if (values.version) return (out(VERSION), 0);
  const port = values.port !== undefined ? Number(values.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) return (out("housekeep: --port needs a number between 0 and 65535"), 3);

  const [command, ...rest] = positionals;
  if (command === "install" || command === "uninstall") {
    for (const line of await (command === "install" ? install() : uninstall())) out(line);
    return 0;
  }
  if (command === "menubar") return menubarCommand();
  if (command === "copy") return copyCommand(rest[0]);
  if (values.demo && command === "open") return (openDemo(), 0);
  if (command === "serve" || command === "open") {
    if (command === "open") {
      const server = await openMap(port);
      if (!server) return 0;
      out(`Live map at ${server.url}. Press Ctrl-C to stop.`);
      return serveUntilStopped(server);
    }
    const server = await startServer({ port });
    out(`Live map at ${server.url}. Press Ctrl-C to stop.`);
    return serveUntilStopped(server);
  }
  if (rest.length) return (out(`housekeep: unexpected ${rest.join(" ")}. See housekeep --help.`), 3);

  const done = values.json || values.demo ? () => undefined : spinner(command ? "Checking this repo" : "Looking for repos you've worked on");
  const data = values.demo ? loadDemo() : await scan({ force: values.fetch, offline: values.offline, only: command });
  done();
  const code = exitCode(data);
  if (values.json) {
    out(JSON.stringify(data, null, 2));
    return code;
  }
  const c = paint(process.stdout);
  const only = command && !values.demo && data.projects[0];
  out(only ? detailReport(only, c) : summaryReport(data, c));
  if (process.stdin.isTTY && process.stdout.isTTY && !data.error) return waitForKeys(port, code, values.demo);
  return code;
}

// Set the exit code rather than calling process.exit, which cuts off output still being written to a pipe
// (a large --json result read by a script or an AI assistant).
main().then((code) => {
  process.exitCode = code;
}, (err: unknown) => {
  process.stderr.write(`housekeep: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 3;
});

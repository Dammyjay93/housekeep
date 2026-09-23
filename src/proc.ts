/** Running git (and gh) without surprises: no prompts, no locks, plain English errors. */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, sep } from "node:path";

export const HOME = homedir();
/** How the machine is named in copy. */
export const HERE = process.platform === "darwin" ? "this Mac" : "this computer";
const WINDOWS = process.platform === "win32";

// Homebrew's git is usually newer than the one macOS ships; look there first.
const extraPath = process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : [];

export const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: [...extraPath, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
  // Read-only checks must not rewrite the index, which would also make every repo look recently used.
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

export interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  /** Talk to the network: run without a terminal, so ssh can't stop to ask for a passphrase or host key. */
  network?: boolean;
  input?: string;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? ENV,
      windowsHide: true,
      detached: Boolean(opts.network) && !WINDOWS,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeout ?? 20_000);
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error: Error) => finish({ ok: false, code: -1, stdout: "", stderr: error.message, timedOut: false }));
    child.on("close", (code: number | null) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      finish({ ok: code === 0 && !timedOut, code: code ?? -1, stdout, stderr, timedOut });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** git's output with trailing newlines removed, or null if git failed. */
export async function git(cwd: string, ...args: string[]): Promise<string | null> {
  const r = await run("git", ["-C", cwd, ...args]);
  return r.ok ? r.stdout.replace(/\n+$/, "") : null;
}

export async function count(cwd: string, ...args: string[]): Promise<number> {
  return (await countOrNull(cwd, ...args)) ?? 0;
}

/** Like count, but null when git fails, so a failure can never read as "nothing to worry about". */
export async function countOrNull(cwd: string, ...args: string[]): Promise<number | null> {
  const out = await git(cwd, "rev-list", "--count", ...args);
  return out !== null && /^\d+$/.test(out) ? Number(out) : null;
}

export function which(name: string): string | null {
  const exts = WINDOWS ? [".exe", ".cmd", ""] : [""];
  for (const dir of (ENV.PATH ?? "").split(delimiter)) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (dir && existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function tilde(path: string): string {
  return path === HOME || path.startsWith(HOME + sep) ? "~" + path.slice(HOME.length) : path;
}

export function untilde(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(HOME, path.slice(1)) : path;
}

export const plural = (n: number, one: string, many?: string): string => `${n} ${n === 1 ? one : many ?? one + "s"}`;
export const capFirst = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
export const iso = (ms: number | null): string | null => (ms ? new Date(ms).toISOString() : null);

/** Narrowing helpers for JSON from outside (gh, files on disk). */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Run `fn` over `items` with at most `limit` in flight, keeping order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

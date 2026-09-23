/** Where Housekeep keeps your settings and its own state, and what it remembers between runs. */

import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, isRecord, parseJson, tilde } from "./proc.js";

export const CONFIG_DIR = process.env.HOUSEKEEP_CONFIG_DIR
  ?? join(process.env.XDG_CONFIG_HOME ?? join(HOME, ".config"), "housekeep");
export const STATE_DIR = process.env.HOUSEKEEP_STATE_DIR
  ?? join(process.env.XDG_STATE_HOME ?? join(HOME, ".local", "state"), "housekeep");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const MEMO_FILE = join(STATE_DIR, "memo.json");
export const SNAPSHOT_FILE = join(STATE_DIR, "snapshot.json");
export const MAP_FILE = join(STATE_DIR, "map.html");
export const SERVER_FILE = join(STATE_DIR, "server.json");

export interface Config {
  /** Folders to search for projects. */
  roots: string[];
  /** Watch projects you've committed to or switched branches in during this many days. */
  activeDays: number;
  maxDepth: number;
  /** How often to run `git fetch`; 0 means only when you ask. */
  fetchEveryMinutes: number;
  port: number;
  /** Folders to always watch, however old. */
  watch: string[];
  ignore: string[];
}

export const DEFAULT_CONFIG: Config = {
  roots: ["~"],
  activeDays: 45,
  maxDepth: 4,
  fetchEveryMinutes: 10,
  port: 47219,
  watch: [],
  ignore: [],
};

export class CheckFailed extends Error {
  constructor(public readonly title: string, public readonly detail: string) {
    super(title);
  }
}

export function readJson(path: string): unknown {
  try {
    return parseJson(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Write through a temporary file, so a reader never sees half a file. Only you can read it:
 * state includes the live map's token, and every file lists your repos.
 */
export function writeAtomic(path: string, text: string): void {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Tighten a state folder made by an earlier version, when files in it were readable by everyone. */
export function secureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o600);
}

const stringList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
const positive = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

export function loadConfig(): Config {
  let text: string;
  try {
    text = readFileSync(CONFIG_FILE, "utf8");
  } catch {
    writeAtomic(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    return { ...DEFAULT_CONFIG };
  }
  const raw = parseJson(text);
  if (!isRecord(raw)) {
    throw new CheckFailed("Your settings file has a typo", `${tilde(CONFIG_FILE)} isn't valid JSON. Fix it, or delete it to start again from the defaults.`);
  }
  return {
    roots: stringList(raw.roots) ?? DEFAULT_CONFIG.roots,
    activeDays: positive(raw.activeDays) ?? DEFAULT_CONFIG.activeDays,
    maxDepth: positive(raw.maxDepth) ?? DEFAULT_CONFIG.maxDepth,
    fetchEveryMinutes: positive(raw.fetchEveryMinutes) ?? DEFAULT_CONFIG.fetchEveryMinutes,
    port: positive(raw.port) ?? DEFAULT_CONFIG.port,
    watch: stringList(raw.watch) ?? DEFAULT_CONFIG.watch,
    ignore: stringList(raw.ignore) ?? DEFAULT_CONFIG.ignore,
  };
}

/** What only a server can say, cached per repo: GitHub's answers, the remote's default branch, fetch attempts. */
export interface Memo {
  tried: Record<string, number>;
  heads: Record<string, string>;
  github: Record<string, unknown>;
}

export function loadMemo(): Memo {
  const raw = readJson(MEMO_FILE);
  const part = (key: string): Record<string, unknown> => {
    const v = isRecord(raw) ? raw[key] : undefined;
    return isRecord(v) ? v : {};
  };
  const only = <T>(record: Record<string, unknown>, keep: (v: unknown) => v is T): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter((entry): entry is [string, T] => keep(entry[1])));
  return {
    tried: only(part("tried"), (v): v is number => typeof v === "number"),
    heads: only(part("heads"), (v): v is string => typeof v === "string"),
    github: part("github"),
  };
}

export function saveMemo(memo: Memo): void {
  writeAtomic(MEMO_FILE, JSON.stringify(memo));
}

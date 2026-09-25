/** Finding projects and working out, for each one, what git knows and what that means. */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_FILE, CheckFailed, type Config, type DeletedBranch, type Memo, STATE_DIR, loadConfig, loadMemo, readJson, saveMemo, writeAtomic } from "./config.js";
import type { Branch, Checkout, CommittedSecret, MergeKind, NextStep, Project, PrunedBranch, RemoteBranch, Request, Signal, Snapshot, Tier } from "./model.js";
import { VERDICT, worst } from "./model.js";
import { combinedRequest, itemsFor, notesFor } from "./items.js";
import { HERE, type RunResult, capFirst, count, countOrNull, git, isRecord, iso, plural, pool, run, tilde, untilde } from "./proc.js";
import { type GitHubMeta, type RemoteSet, closedPullRequest, fetchDue, githubMeta, metaFromMemo, refreshRemote, remotesOf } from "./remote.js";

export const VERSION = "0.1.2";
export const MIN_GIT: [number, number] = [2, 25];
export const SQUASH_GIT: [number, number] = [2, 38]; // `git merge-tree --write-tree`, used to recognise squash merges
let squashDetection = true;
const notices: string[] = [];

const atLeast = (have: [number, number], want: [number, number]): boolean => have[0] > want[0] || (have[0] === want[0] && have[1] >= want[1]);

/** What this git can do, from `git --version` output. */
export function gitSupport(version: string): { ok: boolean; squash: boolean; version: string } {
  const m = /(\d+)\.(\d+)/.exec(version);
  const have: [number, number] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  return { ok: atLeast(have, MIN_GIT), squash: atLeast(have, SQUASH_GIT), version: version.trim().replace(/^git version /, "") };
}

const SKIP_DIRS = new Set(["Library", "node_modules", "Applications", "Movies", "Music", "Pictures", "build", "dist", "vendor", "target"]);

// Long-lived branches that stay on the remote whatever they contain. A deploy branch that trails
// main looks merged, but deleting it can take a site down. Protected branches and the default branch are kept too.
const KEEP_BRANCHES = new Set(["main", "master", "trunk", "develop", "development", "dev", "staging", "stage", "production", "prod", "live", "release", "gh-pages"]);
const KEEP_PREFIXES = ["release/", "releases/", "hotfix/", "support/"];
const BACKUP_PREFIX = "housekeep/backup-";
const BACKUP_PREFIXES = [BACKUP_PREFIX, "git-light/backup-"];

// Files that usually hold passwords or keys. Template copies (.env.example) are committed on purpose.
const SECRET_PATTERNS = [/^\.env$/, /^\.env\..+/, /\.env$/, /\.(pem|key|p8|p12|pfx|jks|keystore)$/, /^id_(rsa|ed25519|ecdsa)$/,
  /service-account.*\.json$/, /credentials.*\.json$/, /secret.*\.json$/, /^GoogleService-Info\.plist$/];
const TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist", ".defaults"];

// git's own words for an operation left half done.
const OPERATIONS: [string, string][] = [
  ["MERGE_HEAD", "Merge in progress"], ["rebase-merge", "Rebase in progress"], ["rebase-apply", "Rebase in progress"],
  ["CHERRY_PICK_HEAD", "Cherry-pick in progress"], ["REVERT_HEAD", "Revert in progress"], ["BISECT_LOG", "Bisect in progress"],
];

// --- git version --------------------------------------------------------------

export async function checkGit(): Promise<void> {
  const r = await run("git", ["--version"]);
  if (!r.ok) throw new CheckFailed("git isn't working", "Run `git --version` in a terminal to see why.");
  const support = gitSupport(r.stdout);
  if (!support.ok) {
    throw new CheckFailed("git is too old for Housekeep",
      `It needs git ${MIN_GIT.join(".")} or newer; you have ${support.version}. Install a newer git (for example \`brew install git\` or your system's package manager).`);
  }
  squashDetection = support.squash;
  notices.length = 0;
  if (!support.squash) {
    notices.push(`git ${support.version} can't recognise squash-merged branches, so they show as unmerged. Install git ${SQUASH_GIT.join(".")} or newer to see them.`);
  }
}

// --- discovery ----------------------------------------------------------------

async function findRepos(roots: string[], maxDepth: number, blocked: string[]): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      // macOS guards Desktop, Documents, Downloads and iCloud Drive; say so instead of silently seeing nothing.
      const code = err instanceof Error && "code" in err ? String(err.code) : "";
      if (code === "EPERM" || code === "EACCES") blocked.push(dir);
      return;
    }
    // Keep looking inside a repo: a home folder kept as a dotfiles repo, or a folder of repos that's
    // itself a repo, would otherwise hide every project underneath it.
    if (entries.some((e) => e.name === ".git")) found.push(dir);
    if (depth >= maxDepth) return;
    await Promise.all(entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
      .map((e) => walk(join(dir, e.name), depth + 1)));
  };
  for (const root of roots) await walk(root, 0);
  return found;
}

function gitDirOf(repo: string): string {
  const dot = join(repo, ".git");
  try {
    if (statSync(dot).isFile()) {
      const line = readFileSync(dot, "utf8").trim().replace(/^gitdir: /, "");
      return isAbsolute(line) ? line : resolve(repo, line);
    }
  } catch {
    return dot;
  }
  return dot;
}

/**
 * When you last committed, switched branch, staged or reset: never touched by Housekeep's own checks.
 * The reflog says best; a repo without one (brand new, or with reflogs turned off) still has an index and HEAD.
 */
export function lastActivity(repo: string): number {
  const gitdir = gitDirOf(repo);
  const signs = [join(gitdir, "logs", "HEAD"), join(gitdir, "index"), join(gitdir, "HEAD"), join(gitdir, "refs", "heads")];
  const linked = join(gitdir, "worktrees");
  if (existsSync(linked)) for (const w of readdirSync(linked)) signs.push(join(linked, w, "logs", "HEAD"), join(linked, w, "index"));
  return Math.max(0, ...signs.map((f) => (existsSync(f) ? statSync(f).mtimeMs : 0)));
}

export async function commonDir(repo: string): Promise<string | null> {
  const out = await git(repo, "rev-parse", "--git-common-dir");
  return out ? resolve(repo, out) : null;
}

function projectName(repo: string, roots: string[]): string {
  for (const root of roots) {
    const rel = relative(root, repo);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    const parts = rel.split(sep).filter(Boolean);
    // ~/work/townsquare/admin reads better as townsquare/admin than admin.
    return parts.length >= 3 ? parts.slice(-2).join("/") : basename(repo);
  }
  return basename(repo);
}

/** A path as the file system compares it: case-insensitively on macOS and Windows unless told otherwise. */
export function samePathKey(path: string): string {
  return process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;
}

async function discover(cfg: Config): Promise<{ roots: string[]; watch: string[]; found: number; blocked: string[] }> {
  const roots = cfg.roots.map((r) => resolve(untilde(r)));
  // macOS and Windows ignore case in file names by default: ~/Archive and ~/archive are one folder.
  const ignore = new Set(cfg.ignore.map((p) => samePathKey(resolve(untilde(p)))));
  const pinned = cfg.watch.map((p) => resolve(untilde(p)));
  const cutoff = Date.now() - cfg.activeDays * 86_400_000;
  const blocked: string[] = [];
  const all = await findRepos(roots, cfg.maxDepth, blocked);
  const active = all.filter((r) => !ignore.has(samePathKey(r)) && lastActivity(r) >= cutoff);
  const watch: string[] = [];
  const seen = new Set<string>();
  for (const repo of [...pinned, ...active]) {
    const cdir = existsSync(repo) ? await commonDir(repo) : null;
    if (!cdir || seen.has(cdir)) continue;
    // A submodule is part of its parent project, not a project of its own.
    if (await git(repo, "rev-parse", "--show-superproject-working-tree")) continue;
    seen.add(cdir);
    // A linked worktree found on disk is shown under the repo that owns it.
    const owner = basename(cdir) === ".git" ? dirname(cdir) : repo;
    watch.push(existsSync(owner) ? owner : repo);
  }
  return { roots, watch, found: all.length, blocked: blocked.map(tilde) };
}

// --- facts --------------------------------------------------------------------

/** The branch that counts as main: what the server says first, then the usual names. */
async function defaultBranch(repo: string, truth: string | null, candidates: (string | null | undefined)[]): Promise<string> {
  const names = [...candidates];
  if (truth) {
    const sym = await git(repo, "symbolic-ref", "--quiet", "--short", `refs/remotes/${truth}/HEAD`);
    names.push(sym ? sym.replace(`${truth}/`, "") : null);
  }
  for (const name of [...names, "main", "master", "trunk"]) {
    if (!name) continue;
    if ((await git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`)) !== null) return name;
    if (truth && (await git(repo, "rev-parse", "--verify", "--quiet", `refs/remotes/${truth}/${name}`)) !== null) return name;
  }
  return "";
}

interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  prunable: boolean;
  locked: boolean;
}

async function worktrees(repo: string): Promise<Worktree[]> {
  const out: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of [...((await git(repo, "worktree", "list", "--porcelain")) ?? "").split("\n"), ""]) {
    if (!line) {
      if (cur) out.push(cur);
      cur = null;
    } else if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), head: null, branch: null, prunable: false, locked: false };
    } else if (cur && line.startsWith("HEAD ")) {
      cur.head = line.slice(5);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.replace(/^branch refs\/heads\//, "");
    } else if (cur && line.startsWith("prunable")) {
      cur.prunable = true;
    } else if (cur && line.startsWith("locked")) {
      cur.locked = true;
    }
  }
  return out;
}

async function operation(path: string): Promise<string | null> {
  const gitdir = await git(path, "rev-parse", "--absolute-git-dir");
  if (!gitdir) return null;
  return OPERATIONS.find(([name]) => existsSync(join(gitdir, name)))?.[1] ?? null;
}

/** Uncommitted and untracked files in one working tree, and any that look like they hold a secret. */
export async function folderStatus(path: string): Promise<{ changed: number; untracked: number; secrets: string[]; unreadable: boolean }> {
  const r = await run("git", ["-C", path, "status", "--porcelain=v1", "-z", "--untracked-files=normal"], { timeout: 30_000 });
  const changed: string[] = [];
  const untracked: string[] = [];
  const tokens = r.ok ? r.stdout.split("\0") : [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i] ?? "";
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    (code === "??" ? untracked : changed).push(entry.slice(3));
    if (code.includes("R") || code.includes("C")) i++; // a rename or copy is followed by the old path
  }
  const secrets = [...changed, ...untracked]
    .filter((name) => {
      const base = basename(name.replace(/\/$/, ""));
      return SECRET_PATTERNS.some((p) => p.test(base)) && !TEMPLATE_SUFFIXES.some((s) => name.toLowerCase().endsWith(s)) && existsSync(join(path, name));
    })
    .sort();
  // A status that failed or timed out says nothing: it must never read as a clean working tree.
  return { changed: changed.length, untracked: untracked.length, secrets, unreadable: !r.ok };
}

// Ignored files a build or install recreates. Anything else ignored (.env.local, a local database)
// may exist nowhere else, and removing the worktree would delete it.
const REGENERABLE = new Set(["node_modules", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".parcel-cache", ".expo",
  ".vercel", "dist", "build", "out", "coverage", "target", "__pycache__", ".venv", "venv", ".pytest_cache", ".gradle",
  "Pods", "DerivedData", ".DS_Store", ".astro", ".wrangler", ".output", ".angular", ".docusaurus", ".nx", ".svelte-kit",
  "storybook-static", "test-results", "playwright-report"]);

/** Ignored files and folders in a working tree that can't simply be rebuilt, or null if git couldn't list them. */
export async function ignoredKeep(path: string): Promise<string[] | null> {
  const r = await run("git", ["-C", path, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], { timeout: 30_000 });
  if (!r.ok) return null;
  return r.stdout.split("\0").filter(Boolean)
    .filter((f) => !f.replace(/\/$/, "").split("/").some((part) => REGENERABLE.has(part))
      && !/\.(log|tsbuildinfo)$/.test(f) && !f.startsWith(".husky/_")) // husky rebuilds .husky/_ on install
    .sort();
}

const TEMP_ROOTS = [...new Set([tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/private/var/folders"])];

/** A folder the system empties on its own (macOS clears /tmp on restart and after a few days unused). */
export function inTempFolder(path: string): boolean {
  return TEMP_ROOTS.some((t) => path === t || path.startsWith(t.endsWith(sep) ? t : t + sep));
}

/** A path on a drive that isn't connected right now (an unplugged disk, an unmounted share). */
export function onMissingDrive(path: string): boolean {
  if (process.platform === "win32") {
    const drive = /^[A-Za-z]:/.exec(path)?.[0];
    return Boolean(drive) && !existsSync(`${drive}\\`);
  }
  const parts = path.split("/").filter(Boolean);
  for (const [prefix, depth] of [["/Volumes/", 2], ["/media/", 3], ["/run/media/", 4], ["/mnt/", 2]] as const) {
    if (!path.startsWith(prefix)) continue;
    const mount = "/" + parts.slice(0, depth).join("/");
    if (!existsSync(mount)) return true;
    try {
      return readdirSync(mount).length === 0;
    } catch {
      return true;
    }
  }
  return false;
}

// Files that hold secrets far more often than not. Firebase's app config files are meant to be committed.
const SECRET_PATHSPECS = ["**/.env", "**/.env.*", "**/*.env", "**/*.pem", "**/*.key", "**/*.p8", "**/*.p12", "**/*.pfx",
  "**/*.jks", "**/*.keystore", "**/id_rsa", "**/id_ed25519", "**/id_ecdsa", "**/*service-account*.json",
  "**/*credentials*.json", "**/*secret*.json"].map((p) => `:(glob)${p}`);

/** Secret-looking files already committed, and whether they've reached the remote. */
async function committedSecrets(repo: string): Promise<CommittedSecret[]> {
  const listed = (await git(repo, "ls-files", "-z", "--", ...SECRET_PATHSPECS)) ?? "";
  const out: CommittedSecret[] = [];
  for (const path of listed.split("\0").filter(Boolean)) {
    if (TEMPLATE_SUFFIXES.some((s) => path.toLowerCase().endsWith(s))) continue;
    out.push({ path, pushed: Boolean(await git(repo, "rev-list", "-1", "--remotes", "--", path)) });
  }
  return out;
}

/** Noted deleted branches whose work git still has, but no branch, remote branch or tag holds. */
async function prunedBranches(repo: string, deleted: DeletedBranch[], meta: GitHubMeta | null): Promise<PrunedBranch[]> {
  const out: PrunedBranch[] = [];
  for (const d of deleted) {
    if ((await git(repo, "cat-file", "-e", `${d.sha}^{commit}`)) === null) continue; // git has thrown it away
    // Its pull request merged or was closed on purpose: the branch was finished with, not lost.
    if (closedPullRequest(meta, d.name.split("/").slice(1).join("/"), d.sha)) continue;
    const commits = await count(repo, d.sha, "--not", "--branches", "--remotes", "--tags");
    if (commits) out.push({ ...d, commits });
  }
  return out;
}

/**
 * git fetch --prune, noting what it forgets. When a branch is deleted on the remote, pruning drops your
 * last pointer to its commits, and git later throws them away. Housekeep doesn't write to the repo to keep
 * them: if their changes aren't in main (a squash-merged branch deleted after merging is fine), it notes the
 * branch and its last commit in its own state, so a request can bring the work back while git still has it.
 */
export async function fetchNoting(repo: string, names: string[], mainNames: (string | undefined)[], deleted: DeletedBranch[], timeout = 60_000): Promise<RunResult> {
  const refs = async (): Promise<Map<string, string>> => new Map(
    ((await git(repo, "for-each-ref", "--format=%(refname)%09%(objectname)", ...names.map((n) => `refs/remotes/${n}/`))) ?? "")
      .split("\n").filter(Boolean).map((line) => line.split("\t") as [string, string]));
  const before = await refs();
  const r = await run("git", ["-C", repo, "fetch", "--prune", "--quiet", "--multiple", ...names], { timeout, network: true });
  const after = await refs();
  const bases: string[] = [];
  for (const n of names) {
    for (const m of [...new Set([...mainNames, "main", "master", "trunk"])]) {
      if (m && (await git(repo, "rev-parse", "--verify", "--quiet", `refs/remotes/${n}/${m}`)) !== null) bases.push(`refs/remotes/${n}/${m}`);
    }
  }
  for (const [ref, sha] of before) {
    if (after.has(ref) || ref.endsWith("/HEAD")) continue;
    if (!(await count(repo, sha, "--not", "--branches", "--remotes", "--tags"))) continue;
    let landed = false;
    for (const base of bases) if (await inMain(repo, sha, base)) landed = true;
    const name = ref.slice("refs/remotes/".length);
    if (!landed && !deleted.some((d) => d.name === name && d.sha === sha)) deleted.push({ name, sha, at: new Date().toISOString() });
  }
  return r;
}

// Answers keyed by commit IDs never go stale, so they're kept between runs.
const MERGE_CACHE_FILE = join(STATE_DIR, "merges.json");
const MERGE_CACHE_LIMIT = 5000;
let inMainCache: Map<string, MergeKind | null> | null = null;

function mergeCache(): Map<string, MergeKind | null> {
  if (inMainCache) return inMainCache;
  const raw = readJson(MERGE_CACHE_FILE);
  inMainCache = new Map(isRecord(raw)
    ? Object.entries(raw).flatMap(([k, v]): [string, MergeKind | null][] => (v === "merged" || v === "squashed" || v === null ? [[k, v]] : []))
    : []);
  return inMainCache;
}

export function saveMergeCache(): void {
  if (!inMainCache) return;
  const entries = [...inMainCache].slice(-MERGE_CACHE_LIMIT);
  writeAtomic(MERGE_CACHE_FILE, JSON.stringify(Object.fromEntries(entries)));
}

const changedFiles = async (repo: string, from: string, to: string): Promise<Set<string> | null> => {
  const out = await git(repo, "diff", "--name-only", "--no-renames", "-z", from, to);
  return out === null ? null : new Set(out.split("\0").filter(Boolean));
};

/**
 * How `tip`'s work reached `base`: "merged", "squashed" (same changes, different commits) or null.
 *
 * Squash and rebase merges leave the branch's own commits outside main, so ancestry alone misses
 * them. If merging the branch into main would change nothing, every change on it is already there;
 * a conflict or unrelated history counts as not merged.
 */
export async function inMain(repo: string, tip: string, base: string): Promise<MergeKind | null> {
  // Keyed by commit, not by ref name: in the live map, main moves on while the process keeps running.
  const baseSha = await git(repo, "rev-parse", "--verify", "--quiet", `${base}^{commit}`);
  if (!baseSha) return null;
  const key = `${repo}\0${tip}\0${baseSha}`;
  const cache = mergeCache();
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let result: MergeKind | null = null;
  if ((await git(repo, "merge-base", "--is-ancestor", tip, baseSha)) !== null) {
    result = "merged";
  } else if (squashDetection) {
    const fork = await git(repo, "merge-base", baseSha, tip);
    const mine = fork ? await changedFiles(repo, fork, tip) : null;
    const theirs = fork ? await changedFiles(repo, fork, baseSha) : null;
    // Files the branch changed that main has the same way already need no merging.
    const differ = mine && theirs && [...mine].every((f) => theirs.has(f)) ? await changedFiles(repo, baseSha, tip) : null;
    const pending = mine && differ ? [...mine].filter((f) => differ.has(f)) : null;
    if (mine && pending && pending.length === 0) {
      result = "squashed"; // every file it changed is already exactly so in main
    } else if (pending && pending.length <= 100) {
      // Only then is the full merge worth simulating. A branch that touched a file main hasn't since
      // they split can't be in main; hundreds of files that still differ isn't a squash merge either.
      // A pathological merge can take git minutes; past a few seconds it counts as not merged, the safe answer, and is cached.
      const r = await run("git", ["-C", repo, "merge-tree", "--write-tree", baseSha, tip], { timeout: 4_000 });
      const baseTree = await git(repo, "rev-parse", `${baseSha}^{tree}`);
      result = r.ok && r.stdout.split("\n")[0] === baseTree ? "squashed" : null;
    }
  }
  cache.set(key, result);
  return result;
}

/** Why a branch stays whatever it contains, or null. */
export function keptReason(name: string, main: string, meta: GitHubMeta | null): string | null {
  if (name === main || name === meta?.defaultBranch) return "The default branch";
  if (meta?.protected?.includes(name)) return "Protected on GitHub";
  if (KEEP_BRANCHES.has(name) || KEEP_PREFIXES.some((p) => name.startsWith(p))) return "Long-lived branch";
  return null;
}

async function branchFacts(repo: string, host: string, main: string, mainRef: string, base: string | null, meta: GitHubMeta | null,
  held: Map<string, string>, current: Set<string>): Promise<Branch[]> {
  const fmt = "%(refname:short)%09%(objectname)%09%(upstream)%09%(upstream:track)%09%(committerdate:unix)%09%(contents:subject)";
  const pushDefault = (await git(repo, "config", "--get", "push.default")) ?? "simple";
  const prs = meta?.prs ?? [];
  const lines = ((await git(repo, "for-each-ref", "refs/heads", `--format=${fmt}`)) ?? "").split("\n");
  const out = (await pool(lines, 8, async (line): Promise<Branch | null> => {
    const [name = "", tip = "", upstream = "", track = "", when = "", subject = ""] = line.split("\t");
    if (!name || name === main) return null;
    const localOnly = await count(repo, tip, "--not", "--remotes");
    const gone = track === "[gone]";
    const byPr = closedPullRequest(meta, name, tip);
    const how = base ? (await inMain(repo, tip, base)) ?? (byPr?.merged ? "pull-request" : null) : null;
    const upBranch = upstream.startsWith("refs/remotes/") ? upstream.split("/").slice(3).join("/") : "";
    const upstreamIsMain = Boolean(main) && upBranch === main;
    const upTip = upstream && !gone && !upstreamIsMain ? await git(repo, "rev-parse", "--verify", "--quiet", upstream) : null;
    // The remote copy can carry work this computer doesn't have, e.g. pushed from another machine.
    const behind = upTip && base && !(await inMain(repo, upTip, base)) ? await count(repo, `${tip}..${upTip}`) : 0;
    const kept = keptReason(name, main, meta);
    const ahead = behind ? await count(repo, `${base}..${upTip}`) : how || !base ? 0 : await count(repo, `${base}..${tip}`);
    let state: Branch["state"];
    let note: string;
    if (localOnly) {
      state = "unpushed";
      note = `${plural(localOnly, "unpushed commit")}` + (gone ? " (upstream gone)" : "");
    } else if (kept) {
      state = "kept";
      note = kept;
    } else if (how && !behind) {
      state = "merged";
      note = how === "pull-request" && byPr ? `Pull request #${byPr.number} merged into ${mainRef}`
        : `${how === "squashed" ? "Squash-merged" : "Merged"} into ${mainRef}`;
    } else if (how) {
      state = "unmerged";
      note = `Behind its upstream by ${plural(behind, "commit")} that aren't in ${mainRef}`;
    } else if (gone) {
      state = "unmerged";
      note = `Upstream gone on ${host}, and its work isn't in ${mainRef}`;
    } else {
      state = "unmerged";
      note = `Not merged into ${mainRef} yet`;
    }
    const pr = prs.find((p) => p.own && p.head === name);
    return {
      name, state, note, merged: how, aheadOfMain: ahead, localOnly, behindUpstream: behind,
      upstreamGone: gone, onRemote: Boolean(upTip) || gone, upstreamIsMain,
      pushesToMain: upstreamIsMain && (pushDefault === "upstream" || pushDefault === "tracking"),
      pr: pr ? { number: pr.number, url: pr.url } : null,
      lastCommit: /^\d+$/.test(when) ? Number(when) : null, subject: subject || null,
      worktree: held.get(name) ?? null, current: current.has(name),
    };
  })).filter((b): b is Branch => b !== null);
  const order: Record<Branch["state"], number> = { unpushed: 0, unmerged: 1, merged: 2, kept: 3 };
  return out.sort((a, b) => Number(b.current) - Number(a.current) || order[a.state] - order[b.state] || (b.lastCommit ?? 0) - (a.lastCommit ?? 0));
}

export async function remoteBranches(repo: string, rem: RemoteSet, main: string, base: string | null, meta: GitHubMeta | null): Promise<RemoteBranch[]> {
  const push = rem.push;
  if (!push || !base) return [];
  const local = new Set(((await git(repo, "for-each-ref", "refs/heads", "--format=%(refname:short)")) ?? "").split("\n"));
  const prs = meta?.prs ?? [];
  const fmt = "%(refname)%09%(objectname)%09%(committerdate:unix)%09%(symref)";
  const lines = ((await git(repo, "for-each-ref", `refs/remotes/${push}`, `--format=${fmt}`)) ?? "").split("\n");
  const out = (await pool(lines, 8, async (line): Promise<RemoteBranch | null> => {
    const [ref = "", sha = "", when = "", symref = ""] = line.split("\t");
    const name = ref.replace(`refs/remotes/${push}/`, "");
    if (!ref || symref || name === "HEAD" || name === main) return null;
    const how = (await inMain(repo, sha, base)) ?? (closedPullRequest(meta, name, sha)?.merged ? "pull-request" : null);
    const kept = keptReason(name, main, meta);
    const pr = prs.find((p) => p.own && p.head === name);
    // Deleting a branch other pull requests are based on closes or retargets them.
    const stacked = rem.fork ? 0 : prs.filter((p) => p.base === name).length;
    const blockedBy = kept ?? (pr ? `Open pull request #${pr.number}` : stacked ? `Base of ${plural(stacked, "open pull request")}` : null);
    return {
      name, sha, merged: how, kept, blockedBy, deletable: Boolean(how) && !blockedBy,
      backup: BACKUP_PREFIXES.some((p) => name.startsWith(p)), local: local.has(name),
      pr: pr ? { number: pr.number, url: pr.url } : null,
      aheadOfMain: how ? 0 : await count(repo, `${base}..${sha}`),
      lastCommit: /^\d+$/.test(when) ? Number(when) : null,
    };
  })).filter((b): b is RemoteBranch => b !== null);
  return out.sort((a, b) => Number(b.deletable) - Number(a.deletable) || (b.lastCommit ?? 0) - (a.lastCommit ?? 0));
}

// --- what it means --------------------------------------------------------------

export type Draft = Omit<Project, "signals" | "next" | "requests" | "items" | "notes" | "request" | "tier" | "verdict">;

/** The four questions every project answers. Labels are git's terms; hints say what they mean. */
export function signals(p: Draft): Signal[] {
  const m = p.main;
  const host = p.host ?? "the remote";
  const ref = m.remoteRef ?? `${p.remotes.truth ?? "origin"}/${m.name || "main"}`;
  const out: Signal[] = [];

  // Working tree: is every change committed?
  {
    const details: string[] = [];
    let loose = 0;
    const secrets = [...new Set(p.checkouts.flatMap((c) => c.secrets))].sort();
    if (secrets[0]) details.push(`${secrets[0]} looks like a password or key file, and git isn't ignoring it`);
    for (const c of p.checkouts) {
      const n = c.changed + c.untracked;
      if (n) {
        loose += n;
        details.push(`${plural(n, "change")} in ${c.primary ? "the main working tree" : `worktree ${c.label}`}`);
      }
      if (c.operation) details.push(c.operation);
    }
    const stashes = p.stashes.length;
    const op = p.checkouts.find((c) => c.operation)?.operation;
    const committed = p.committedSecrets.find((s) => s.pushed) ?? p.committedSecrets[0];
    const unreadable = p.checkouts.filter((c) => c.unreadable);
    const temporary = p.checkouts.filter(tempWork);
    for (const c of temporary) details.push(`${c.path} is in a temporary folder the system empties`);
    for (const c of unreadable) details.push(`git couldn't read ${c.primary ? "the main working tree" : `worktree ${c.label}`}`);
    let headline: string, hint: string, cell: string, tier: Tier;
    if (committed) {
      [headline, hint, cell, tier] = committed.pushed
        ? [`Secret pushed: ${committed.path}`, `It's committed and on ${host}, so anyone with access to the repo can read it. Rotate those keys, then remove the file from git.`, "Secret pushed", "at-risk"]
        : [`Secret committed: ${committed.path}`, "It's in git's history but not pushed yet. Remove it from git before you push.", "Secret committed", "at-risk"];
    } else if (temporary[0]) {
      [headline, hint, cell, tier] = [`Work in a temporary folder: ${tilde(temporary[0].path)}`,
        `The system empties this folder on its own, so uncommitted changes or ignored files like ${temporary[0].ignoredKeep[0] ?? ".env"} there can vanish. Move the worktree somewhere permanent.`,
        "Temporary folder", "at-risk"];
    } else if (secrets[0]) {
      [headline, hint, cell, tier] = [`Possible secret: ${secrets[0]}`, `It looks like a password or key, and git isn't ignoring it. Check it before it's ever pushed to ${host}.`, "Check a file", "at-risk"];
    } else if (unreadable.length) {
      [headline, hint, cell, tier] = ["Couldn't read the working tree", "git status failed or took too long, so nothing here is known. It isn't necessarily clean.", "Couldn't check", "attention"];
    } else if (loose) {
      [headline, hint, cell, tier] = [`${plural(loose, "uncommitted change")}`, "Normal while you work. Commit once something works, so you can always get back to it.", `${loose} uncommitted`, "attention"];
    } else if (stashes) {
      [headline, hint, cell, tier] = [`${plural(stashes, "stash", "stashes")}`, "Changes set aside with git stash are easy to forget. Apply what matters and drop the rest.", `${stashes} stashed`, "attention"];
    } else if (op) {
      [headline, hint, cell, tier] = [op, "git is partway through something. Finish or abort it before anything else.", "In progress", "attention"];
    } else {
      [headline, hint, cell, tier] = ["Working tree clean", "Nothing waiting to be committed.", "Clean", "safe"];
    }
    out.push({ key: "commit", label: "Working tree", tier, headline, hint, details, cell,
      value: loose || !stashes ? loose : stashes, unit: loose || !stashes ? (loose === 1 ? "uncommitted change" : "uncommitted changes") : "stashed" });
  }

  // Push: is every commit on the remote, so losing this computer loses nothing?
  {
    const remote = p.remotes.push ?? "the remote";
    const details = p.branches.filter((b) => b.state === "unpushed").map((b) => `${b.name}: ${plural(b.localOnly, "unpushed commit")}`);
    if (m.localOnly) details.unshift(`${m.name}: ${plural(m.localOnly, "unpushed commit")}`);
    const detached = p.checkouts.filter((c) => c.detachedCommits);
    for (const c of detached) details.push(`${plural(c.detachedCommits, "commit")} on a detached HEAD in ${c.primary ? "the main working tree" : `worktree ${c.label}`}, on no branch at all`);
    for (const b of p.pruned) details.push(`${b.name} was deleted on ${remote} with ${plural(b.commits, "commit")} not in main; its last commit was ${b.sha.slice(0, 7)}`);
    const onNoBranch = detached.reduce((t, c) => t + c.detachedCommits, 0);
    const kept = p.pruned.reduce((t, b) => t + b.commits, 0);
    const unpushed = p.unpushed === null ? null : p.unpushed + onNoBranch + kept;
    const has = p.fetch.hasRemote;
    const countText = plural(unpushed ?? 0, "unpushed commit");
    let headline: string, hint: string, cell: string, tier: Tier;
    if (!has) [headline, hint, cell, tier] = ["No remote", `This repo isn't pushed anywhere, so it exists only on ${HERE}.`, "No remote", "at-risk"];
    else if (unpushed === null) [headline, hint, cell, tier] = ["Couldn't count unpushed commits", "git failed while comparing your branches with the remote, so this isn't necessarily safe.", "Couldn't check", "attention"];
    else if (unpushed) {
      const why = onNoBranch ? `Some are on a detached HEAD, on no branch at all, so switching branch loses them.`
        : kept ? `Some were on a branch deleted on ${remote} before its work reached main.` : `They exist only on ${HERE}.`;
      [headline, hint, cell, tier] = [countText, `${why} Push them so they're safe if ${HERE} is lost.`, `${unpushed} unpushed`, "at-risk"];
    } else if (p.remotes.sameDisk) {
      [headline, hint, cell, tier] = [`Pushed, but only to this disk`, `${remote} is a folder on the same disk (${tilde(p.remotes.localPath ?? "")}), so losing ${HERE} loses both copies. Push to a server too.`, "Same disk", "attention"];
    } else [headline, hint, cell, tier] = ["Everything pushed", `Every commit is on ${host}${p.remotes.localPath ? ` (${tilde(p.remotes.localPath)})` : ""}.`, "Pushed", "safe"];
    out.push({ key: "push", label: "Push", tier, headline, hint, details, cell, count: countText,
      value: has ? unpushed : null, unit: has ? (unpushed === 1 ? "unpushed commit" : "unpushed commits") : "no remote" });
  }

  // Sync: does local main match main on the source of truth?
  {
    const name = m.name || "main";
    let details: string[] = [];
    let headline: string, hint: string, cell: string, tier: Tier;
    let value: number | null = null;
    let unit = "commits apart";
    if (!m.name) [headline, hint, cell, tier] = ["No main branch", `Nothing to compare with ${host}.`, "No main", "attention"];
    else if (!m.remoteMain) [headline, hint, cell, tier] = [`No ${ref}`, `${host} has no ${name} to compare with.`, `No ${ref}`, "attention"];
    else if (!m.local) {
      [headline, hint, cell, tier] = [`No local ${name}`, `Nothing here can fall behind ${ref}.`, "No local copy", "safe"];
      value = 0;
    } else if (m.ahead === null || m.behind === null) {
      [headline, hint, cell, tier] = [`Couldn't compare ${name} with ${ref}`, "git failed while comparing them, so they aren't necessarily in step.", "Couldn't check", "attention"];
    } else if (m.ahead && m.behind) {
      [headline, hint, cell, tier] = [`${name} and ${ref} have diverged`, "Each side has commits the other doesn't. This needs a careful fix.", "Diverged", "attention"];
      details = [`${plural(m.behind, "commit")} only on ${ref}`, `${plural(m.ahead, "commit")} only in local ${name}`];
      value = m.ahead + m.behind;
    } else if (m.behind) {
      [headline, hint, cell, tier] = [`${name} is behind ${ref} by ${plural(m.behind, "commit")}`, "Nothing is lost. Pull before you start new work.", `${m.behind} behind`, "attention"];
      [value, unit] = [m.behind, `behind ${ref}`];
    } else if (m.ahead) {
      [headline, hint, cell, tier] = [`${name} is ahead of ${ref} by ${plural(m.ahead, "commit")}`, `${ref} doesn't have these yet, so it isn't the source of truth right now.`, `${m.ahead} ahead`, "attention"];
      [value, unit] = [m.ahead, `ahead of ${ref}`];
    } else {
      [headline, hint, cell, tier] = [`${name} is up to date with ${ref}`, `${capFirst(HERE)} and ${host} agree.`, "Up to date", "safe"];
      value = 0;
    }
    if (p.remotes.fork && m.remoteMain) details.push(`${ref} is the upstream project this repo is a fork of`);
    if (p.limits.shallow) {
      details.push("This is a shallow clone, so these counts may be off");
      if (tier === "safe") [headline, hint, cell, tier] = ["Shallow clone", "Only part of the history is here, so the counts can't be trusted. Fetch the full history.", "Shallow", "attention"];
    }
    if (m.checks?.state === "failing") {
      details.push(`Failing on ${ref}: ${m.checks.failed.slice(0, 3).join(", ")}${m.checks.failed.length > 3 ? ` and ${m.checks.failed.length - 3} more` : ""}`);
      if (tier === "safe") [headline, hint, cell, tier] = [`Checks are failing on ${ref}`, `${host} ran checks on the latest commit and they failed, so ${ref} can't be trusted until they pass.`, "Checks failing", "attention"];
    }
    out.push({ key: "sync", label: "Sync", tier, headline, hint, details, cell, value, unit });
  }

  // Cleanup: merged branches and stale worktrees, here or on the remote. Unmerged work isn't mess.
  {
    const remote = p.remotes.push ?? "the remote";
    const byName = new Map(p.branches.map((b) => [b.name, b]));
    const mergedHere = p.branches.filter((b) => b.state === "merged");
    const mergedThere = p.remoteBranches.filter((b) => b.deletable);
    // A branch merged both here and on the remote is one thing to clean up, not two.
    const names = new Set([...mergedHere.map((b) => b.name), ...mergedThere.map((b) => b.name)]);
    const unmerged = new Set([...p.branches.filter((b) => b.state === "unmerged").map((b) => b.name),
      ...p.remoteBranches.filter((b) => !b.merged && !b.kept).map((b) => b.name)]);
    // A worktree on an unplugged drive only looks gone, and a locked one git won't prune.
    const prunable = p.checkouts.filter((c) => c.missing && !c.offline && !c.locked);
    const offline = p.checkouts.filter((c) => c.offline);
    const idle = p.checkouts.filter((c) => !c.primary && !c.missing && !c.unreadable && c.changed + c.untracked === 0
      && !c.ignoredKeep.length && !c.detachedCommits && (c.branch === null || byName.get(c.branch)?.state === "merged"));
    const total = names.size + prunable.length + idle.length;
    const details: string[] = [];
    if (names.size) {
      const where = mergedHere.length && mergedThere.length ? ` (${mergedHere.length} local, ${mergedThere.length} on ${remote})`
        : mergedThere.length ? ` on ${remote}` : "";
      details.push(`${plural(names.size, "merged branch", "merged branches")}${where}`);
    }
    if (idle.length) details.push(`${plural(idle.length, "worktree")} holding merged work`);
    if (prunable.length) details.push(`${plural(prunable.length, "prunable worktree")} (folder deleted)`);
    if (offline.length) details.push(`${plural(offline.length, "worktree")} on a drive that isn't connected`);
    const progress = unmerged.size ? `${plural(unmerged.size, "unmerged branch", "unmerged branches")}` : "";
    const blind = p.limits.singleBranch;
    let headline: string, hint: string, tier: Tier;
    if (total) [headline, hint, tier] = [details[0] ?? "", `Their work is already in ${ref}. Safe to delete.`, "attention"];
    else if (blind) [headline, hint, tier] = ["Single-branch clone", `This clone only fetches ${m.name || "main"}, so merged branches on ${host} can't be seen.`, "attention"];
    else [headline, hint, tier] = ["Nothing to clean up", progress ? `${progress} still in progress. That's work, not mess.` : "No merged branches or stale worktrees.", "safe"];
    const extra = [...details.filter((d) => d !== headline), ...(blind && total ? [`This clone can't see branches on ${host}`] : []), ...(progress && total ? [`${progress} still in progress`] : [])];
    out.push({ key: "cleanup", label: "Cleanup", tier, headline, hint, details: extra,
      cell: total ? `${total} to clean up` : blind ? "Can't see" : "Clean", value: total, unit: "to clean up",
      mergedHere: mergedHere.length, mergedOnRemote: mergedThere.length, prunable: prunable.length, unmerged: unmerged.size });
  }
  return out;
}

/** The single most important thing to do next, plus a request an AI coding assistant can act on when it needs judgement. */
export function nextStep(p: Draft, sig: Record<Signal["key"], Signal>): NextStep {
  const m = p.main;
  const name = m.name || "main";
  const ref = m.remoteRef ?? `${p.remotes.truth ?? "origin"}/${name}`;
  const host = p.host ?? "the remote";
  const remote = p.remotes.push ?? "origin";
  const path = p.path;
  const { commit, push, sync, cleanup } = sig;
  const committed = p.committedSecrets.find((s) => s.pushed) ?? p.committedSecrets[0];
  if (committed) {
    return { tier: "at-risk", kind: "assistant", title: `${committed.pushed ? "Deal with a pushed secret" : "Remove a committed secret"}: ${committed.path}`,
      why: committed.pushed ? `It's on ${host}, so anyone with access to the repo can read it. If it holds real keys, rotate them first.`
        : "It's in git's history but not pushed yet. Take it out of git before you push.",
      ask: `In ${path}, the file ${committed.path} was committed${committed.pushed ? ` and pushed to ${remote}` : ""}, and it looks like it holds secrets. ` +
        "Check whether the keys in it are real. If they are, tell me which services I need to change them on. Then take the file out of git " +
        "without deleting it from my computer, and make git ignore it from now on. Don't rewrite history or force-push without asking me first." };
  }
  const secret = p.checkouts.flatMap((c) => c.secrets)[0];
  if (secret) {
    return { tier: "at-risk", kind: "assistant", title: `Check ${secret} for secrets`,
      why: `It looks like a password or key file, and git isn't ignoring it. If it holds real keys, they must never be pushed to ${host}.`,
      ask: `In ${path}, check whether ${secret} contains real secrets (API keys, passwords, tokens). If it only has placeholders, tell me and leave it. ` +
        "If it has real secrets, make git ignore it and check it was never committed. Tell me what you found before changing anything, and don't push." };
  }
  if (!p.fetch.hasRemote) {
    return { tier: "at-risk", kind: "assistant", title: "Add a remote and push",
      why: `This repo isn't pushed anywhere, so it exists only on ${HERE}.`,
      ask: `The git repo in ${path} has no remote. Walk me through creating a private GitHub repository for it and pushing it there, step by step. Ask before creating anything.` };
  }
  if (push.tier === "at-risk" && p.pruned.length && !p.unpushed && !p.checkouts.some((c) => c.detachedCommits)) {
    return { tier: "at-risk", kind: "restore-pruned", title: `Recreate ${plural(p.pruned.length, "deleted branch", "deleted branches")}`,
      why: `${p.pruned.map((b) => b.name).slice(0, 2).join(", ")} ${p.pruned.length === 1 ? "was" : "were"} deleted on ${remote} while holding work that isn't in ${ref}. ` +
        `Git still has the commits, but nothing points at them, so it will throw them away eventually.`,
      ask: `In ${path}, ${p.pruned.length === 1 ? "a branch was" : "some branches were"} deleted on ${remote} while still holding work that isn't in ${ref}: ` +
        `${p.pruned.map((b) => `${b.name.split("/").slice(1).join("/") || b.name}, whose last commit was ${b.sha}`).join("; ")}. ` +
        "Git still has that work, but nothing points to it, so it will be cleaned up eventually. " +
        `Bring ${p.pruned.length === 1 ? "it" : "each one"} back as a local branch with the same name (add "-restored" if the name is taken), ` +
        "then tell me what's on it and whether that work already landed somewhere else. Don't push or delete anything without asking." };
  }
  if (push.tier === "at-risk") {
    const onMain = m.localOnly ? ` Don't push ${name} itself: put its new commits on a branch of their own and push that instead, because pushing ${name} can put the site live.` : "";
    const detached = p.checkouts.some((c) => c.detachedCommits) ? " Some commits aren't on any branch yet (a detached HEAD), so give them a branch first." : "";
    return { tier: "at-risk", kind: "push-all", title: `Push ${push.count ?? "unpushed commits"}`,
      why: `They exist only on ${HERE}. Pushing copies them to ${host}; ${ref} itself isn't changed.`,
      ask: `In ${path}, some commits exist only on this computer. Push them to ${remote} so they're backed up, each branch under its own name.` +
        `${onMain}${detached} Don't change ${ref}, and don't force-push. Show me the plan before you start.` };
  }
  const temp = p.checkouts.find(tempWork);
  if (temp) {
    return { tier: "at-risk", kind: "assistant", title: "Move a worktree out of a temporary folder",
      why: `${tilde(temp.path)} is in a folder the system empties on its own, taking ${[
        temp.changed + temp.untracked ? plural(temp.changed + temp.untracked, "uncommitted change") : "",
        temp.ignoredKeep.slice(0, 2).join(", "),
      ].filter(Boolean).join(" and ")} with it.`,
      ask: `In ${path}, the worktree at ${temp.path} is inside a temporary folder that the system empties on its own. Move it somewhere permanent ` +
        `(for example into ~/worktrees), and make sure files git ignores, like ${temp.ignoredKeep[0] ?? ".env files"}, come with it. Don't delete anything.` };
  }
  if (p.checkouts.some((c) => c.unreadable) || p.unpushed === null || (m.local && m.remoteMain && (m.ahead === null || m.behind === null))) {
    return { tier: "attention", kind: "assistant", title: "Find out why git can't read this repo",
      why: "A git command failed or took too long, so Housekeep can't tell whether your work is safe here.",
      ask: `In ${path}, git is failing or very slow (checking the status, or comparing branches with the remote). Find out why ` +
        "(a huge folder that should be ignored, a broken index, permissions, a corrupt object) and tell me how to fix it. Don't change or delete files without asking." };
  }
  const loose = p.checkouts.reduce((t, c) => t + c.changed + c.untracked, 0);
  if (loose) {
    return { tier: "attention", kind: "assistant", title: `Commit ${plural(loose, "uncommitted change")}`,
      why: "Uncommitted work is the easiest kind to lose or overwrite by accident.",
      ask: `In ${path} there ${loose === 1 ? "is" : "are"} ${plural(loose, "uncommitted change")}. Look at what changed, group it into sensible commits with clear messages, ` +
        "and show me the plan before committing. Leave out anything that looks like a secret or a build artefact. Don't push." };
  }
  if (p.stashes.length) {
    return { tier: "attention", kind: "assistant", title: `Review ${plural(p.stashes.length, "stash", "stashes")}`,
      why: "Stashed changes are easy to forget. Apply what matters and drop the rest.",
      ask: `In ${path} there ${p.stashes.length === 1 ? "is" : "are"} ${plural(p.stashes.length, "stash", "stashes")}. For each, tell me in plain English what it contains and whether it's already committed. Recommend apply or drop, and don't drop anything without asking.` };
  }
  if (commit.tier !== "safe") {
    return { tier: "attention", kind: "assistant", title: `Finish or abort: ${commit.headline.toLowerCase()}`,
      why: "Until it's finished or aborted, git won't behave normally here.",
      ask: `In ${path}, git has a ${commit.headline.toLowerCase()}. Explain what's going on and how to finish or abort it safely. Don't discard any work without asking.` };
  }
  if (p.limits.shallow || p.limits.singleBranch) {
    return { tier: "attention", kind: "fetch-all", title: p.limits.shallow ? "Fetch the full history" : "Fetch all branches",
      why: `This is a ${p.limits.shallow ? "shallow" : "single-branch"} clone, so Housekeep can't fully compare it with ${host}.`,
      ask: `In ${path}, the clone is ${p.limits.shallow ? "shallow" : "single-branch"}, so it's missing part of the project. Fetch every branch and the whole history, without changing any of my branches or files.` };
  }
  if (m.ahead && m.behind) {
    return { tier: "attention", kind: "assistant", title: `Reconcile ${name} with ${ref}`,
      why: `They've diverged: ${plural(m.ahead, "commit")} only here and ${plural(m.behind, "commit")} only on ${ref}.`,
      ask: `In ${path}, ${name} and ${ref} have gone different ways: ${plural(m.ahead, "commit")} only here and ${plural(m.behind, "commit")} only there. Explain what's on each side in plain English and suggest the safest way to bring them back together. Don't push, force-push or delete anything without asking.` };
  }
  if (m.behind) {
    return { tier: "attention", kind: "pull", title: `Pull ${name} (fast-forward)`,
      why: `${ref} has ${plural(m.behind, "commit")} ${HERE} doesn't. A fast-forward only adds them; nothing here is lost.`,
      ask: `In ${path}, bring ${name} up to date with ${ref}, only by adding the new commits on top (a fast-forward). If that isn't possible, explain why and stop.` };
  }
  if (sync.tier !== "safe") {
    return { tier: "attention", kind: "assistant", title: m.ahead ? `Get ${name}'s commits into ${ref}` : `Set up ${ref}`,
      why: `Until they match, ${ref} isn't the source of truth.`,
      ask: `In ${path}, local ${name} and ${ref} don't match. Explain why, and the right way to get these commits into ${ref} (normally a pull request). Tell me whether it would deploy anything, and don't push without asking.` };
  }
  const risky = p.branches.filter((b) => b.pushesToMain).map((b) => b.name);
  if (risky.length) {
    return { tier: "attention", kind: "unset-upstream", title: `Unset upstream on ${plural(risky.length, "branch", "branches")}`,
      why: `${risky.slice(0, 3).join(", ")} ${risky.length === 1 ? "tracks" : "track"} ${ref}, and push.default=upstream means a plain git push from ${risky.length === 1 ? "it" : "them"} updates ${ref} directly.`,
      ask: `In ${path}, ${risky.join(", ")} ${risky.length === 1 ? "is" : "are"} set up so that a plain push would change ${ref} directly. Stop ${risky.length === 1 ? "it" : "them"} tracking ${ref}, so ${risky.length === 1 ? "it pushes" : "each pushes"} to a branch of ${risky.length === 1 ? "its" : "their"} own. Don't push anything.` };
  }
  if (cleanup.tier !== "safe") {
    const [kind, title]: [NextStep["kind"], string] = cleanup.mergedHere
      ? ["delete-merged", `Delete ${plural(cleanup.mergedHere, "merged branch", "merged branches")}`]
      : cleanup.mergedOnRemote ? ["delete-remote", `Delete ${plural(cleanup.mergedOnRemote, "merged branch", "merged branches")} on ${remote}`]
      : cleanup.prunable ? ["prune-worktrees", `Prune ${plural(cleanup.prunable, "worktree")}`]
      : ["assistant", capFirst(cleanup.headline)];
    const local = p.branches.filter((b) => b.state === "merged" && !b.worktree && !b.current).map((b) => b.name);
    const onRemote = p.remoteBranches.filter((b) => b.deletable);
    const gone = p.checkouts.filter((c) => c.missing && !c.locked && !c.offline);
    const parts = [
      local.length ? `Delete the local ${local.length === 1 ? "branch" : "branches"} ${local.join(", ")}. Before deleting, check each one again: every change on it should already be in ${ref}. ` +
        "Some may have been squash-merged, so compare the changes, not the commits." : "",
      onRemote.length ? `Delete ${onRemote.length === 1 ? "the branch" : "the branches"} ${onRemote.map((b) => b.name).join(", ")} on ${remote}. Fetch first and check again, and skip any that has new commits ` +
        `(${onRemote.map((b) => `${b.name} should still be at ${b.sha.slice(0, 7)}`).join(", ")}), is protected, or has an open pull request.` : "",
      gone.length ? `Git still lists ${plural(gone.length, "worktree")} whose ${gone.length === 1 ? "folder was" : "folders were"} deleted. Clear ${gone.length === 1 ? "it" : "them"} out, after making sure ` +
        "each folder is really gone (not just on a drive that isn't plugged in) and didn't hold commits that aren't on any branch." : "",
    ].filter(Boolean);
    return { tier: "attention", kind, title, why: cleanup.hint,
      ask: parts.length
        ? `In ${path}, some things are already in ${ref} and can be cleaned up. ${parts.join(" ")} Show me the list and wait for my yes. Don't touch ${name}, and don't force-push.`
        : `In ${path}, find branches (local and on ${remote}) and worktrees whose work is already in ${ref}, including squash-merged ones. ` +
          `List them, then delete only those after I say yes. Never touch ${name}, protected branches, or anything with an open pull request.` };
  }
  if (push.tier !== "safe" && p.remotes.sameDisk) {
    return { tier: "attention", kind: "assistant", title: "Push to a server, not just this disk",
      why: push.hint,
      ask: `In ${path}, the remote ${remote} is a folder on the same disk (${p.remotes.localPath ?? ""}), so it isn't a real backup. ` +
        "Walk me through adding a private GitHub repository as a second remote and pushing everything there. Ask before creating anything." };
  }
  return { tier: "safe", kind: null, title: "All clear",
    why: `Working tree clean, everything pushed, and ${name} is up to date with ${ref}.` + (cleanup.unmerged ? ` ${cleanup.hint}` : ""), ask: "" };
}

/**
 * Every request beyond the next step, in plain words for your AI assistant. Each carries the checks the
 * change needs, so the assistant makes them before it touches anything: Housekeep itself never does.
 */
export function requestsFor(p: Draft): Request[] {
  const out: Request[] = [];
  const add = (about: Request["about"], name: string | null, does: string, ask: string): void => { out.push({ about, name, does, ask }); };
  const at = `In ${p.path},`;
  const remote = p.remotes.push ?? "origin";
  const main = p.main.name || "main";
  const ref = p.main.remoteRef ?? `${remote}/${main}`;
  const g = p.github;
  const unchecked = g.checked ? ""
    : ` ${p.host === "GitHub" ? `GitHub couldn't be asked about protected branches or open pull requests${g.reason ? ` (${g.reason})` : ""}` : `${p.host ?? "The remote"} can't be asked about protected branches or open pull requests`}, so check with me before deleting any of them.`;
  const one = (n: number, a: string, b: string): string => (n === 1 ? a : b);

  const m = p.main;
  if (m.name && m.remoteMain && m.local) {
    if (m.ahead && m.behind) {
      add("main", main, `reconcile ${main} with ${ref}`, `${at} ${main} and ${ref} have gone different ways: ${plural(m.ahead, "commit")} only here and ${plural(m.behind, "commit")} only there. ` +
        "Explain what's on each side in plain English and suggest the safest way to bring them back together. Don't push, force-push or delete anything without asking.");
    } else if (m.behind) {
      add("main", main, `fast-forward ${main} by ${plural(m.behind, "commit")}`, `${at} bring ${main} up to date with ${ref}, only by adding the new commits on top (a fast-forward). If that isn't possible, explain why and stop.`);
    } else if (m.ahead) {
      add("main", main, `get ${main}'s commits into ${ref} safely`, `${at} ${main} has ${plural(m.ahead, "commit")} that ${ref} doesn't. ` +
        `${m.localOnly ? `Put them on a branch of their own and push that, not ${main}, because pushing ${main} can put the site live. ` : ""}` +
        `Then tell me the right way to get them into ${ref}, usually a pull request. Don't push ${main}, and don't force-push.`);
    }
  }

  const canPR = g.checked && m.remoteMain;
  for (const b of p.branches) {
    if (b.state === "unpushed") {
      add("branch", b.name, `push ${b.name}`, `${at} push the branch ${b.name} to ${remote}: it has ${plural(b.localOnly, "commit")} that ${one(b.localOnly, "exists", "exist")} only on this computer. Don't push ${main} or anything else, and don't force-push.`);
    } else if (b.pushesToMain) {
      add("branch", b.name, `stop ${b.name} pushing to ${ref}`, `${at} ${b.name} is set up so that a plain push would change ${ref} directly. Stop it tracking ${ref}, so it pushes to a branch of its own. Don't push anything.`);
    } else if (b.upstreamGone && !b.merged) {
      add("branch", b.name, `find out what's on ${b.name}`, `${at} the branch ${b.name} was deleted on ${remote}, but it has ${plural(b.aheadOfMain, "commit")} whose changes aren't in ${ref}. Tell me what that work is and whether it's still needed. Don't delete anything without asking.`);
    } else if (b.state === "merged" && !b.current && !b.worktree) {
      add("branch", b.name, `delete ${b.name}`, deleteLocal(at, [b.name], ref, remote));
    } else if (b.state === "unmerged" && b.aheadOfMain && !b.pr && canPR) {
      add("branch", b.name, `open a pull request for ${b.name}`, `${at} open a pull request on GitHub to merge ${b.name} into ${main}${b.localOnly || !b.onRemote ? `, pushing the branch to ${remote} first` : ""}. Write the title and description from its commits. Don't merge it.`);
    }
  }
  const merged = p.branches.filter((b) => b.state === "merged" && !b.current && !b.worktree).map((b) => b.name);
  if (merged.length > 1) add("merged", null, `delete ${merged.length} merged`, deleteLocal(at, merged, ref, remote));

  const gone = p.remoteBranches.filter((b) => b.deletable);
  const deleteRemote = (list: typeof gone): string => `${at} delete ${one(list.length, "the branch", "the branches")} ${list.map((b) => b.name).join(", ")} on ${remote}: ${one(list.length, "its", "their")} work is already in ${ref}. ` +
    `Fetch first and check again, and skip any that has new commits (${list.map((b) => `${b.name} should still be at ${b.sha.slice(0, 7)}`).join(", ")}), is protected, or has an open pull request. Don't force-push.${unchecked}`;
  for (const b of gone) add("remote", b.name, `delete ${b.name} on ${remote}`, deleteRemote([b]));
  if (gone.length > 1) add("merged-remote", null, `delete ${gone.length} merged`, deleteRemote(gone));

  if (g.autoDelete === false && g.canAdmin && g.slug) {
    add("github", null, "let GitHub delete merged branches", `On GitHub, turn on the setting for ${g.slug} that deletes a pull request's branch automatically once it's merged. Change nothing else.`);
  }
  if (p.limits.shallow || p.limits.singleBranch) {
    add("clone", null, p.limits.shallow ? "fetch the full history" : "fetch all branches", `${at} the clone is ${p.limits.shallow ? "shallow" : "single-branch"}, so it's missing part of the project. ` +
      `Fetch every branch${p.limits.shallow ? " and the whole history" : ""}, without changing any of my branches or files.`);
  }

  for (const c of p.checkouts) {
    if (c.missing && !c.offline && !c.locked) {
      add("worktree", c.path, "clear git's record of this deleted folder", `${at} the folder for the worktree at ${c.path} was deleted, but git still lists it. Clear it from git's list, ` +
        "after making sure the folder is really gone (not just on a drive that isn't plugged in) and didn't hold commits that aren't on any branch.");
    } else if (!c.missing && !c.primary && !(c.changed + c.untracked) && !c.operation && !c.unreadable && !c.detachedCommits && !c.ignoredKeep.length) {
      add("worktree", c.path, "remove this worktree", `${at} remove the worktree at ${c.path}${c.branch ? `, keeping the branch ${c.branch}` : ""}. ` +
        "First check it has no uncommitted or new files, no files git ignores that are worth keeping (like .env.local), and no commits that aren't on a branch. Don't touch the main working tree.");
    }
  }
  return out;
}

const deleteLocal = (at: string, names: string[], ref: string, remote: string): string =>
  `${at} delete the local ${names.length === 1 ? "branch" : "branches"} ${names.join(", ")}: ${names.length === 1 ? "its" : "their"} work is already in ${ref}. ` +
  `Before deleting, check each one again: every change on it should be in ${ref}. Some may have been squash-merged, so compare the changes, not the commits. ` +
  `Skip any that's checked out, and leave branches on ${remote} alone.`;

// --- building a project -----------------------------------------------------------

/** Files in a temporary folder that would vanish with it. (Commits there are safe once pushed, so Push covers those.) */
const tempWork = (c: Checkout): boolean =>
  c.temporary && !c.missing && (c.changed + c.untracked > 0 || c.ignoredKeep.length > 0);

/** The push remote is a folder on the same disk as the repo, so it's no backup at all. */
function sameDisk(repo: string, localPath: string | null): boolean {
  if (!localPath || !existsSync(localPath)) return false;
  return statSync(localPath).dev === statSync(repo).dev;
}

/** GitHub's checks on main, but only while they're about the commit origin/main points at here. */
async function checksOnMain(repo: string, truthRef: string | null, meta: GitHubMeta | null): Promise<Project["main"]["checks"]> {
  const c = meta?.checks;
  if (!c || !truthRef || !c.sha || (await git(repo, "rev-parse", "--verify", "--quiet", truthRef)) !== c.sha) return null;
  return { state: c.state, failed: c.failed };
}

const slugOf = (name: string): string => "p-" + name.toLowerCase().replace(/[^a-z0-9]/g, "-");

export async function buildProject(repo: string, name: string, everyMs: number, force: boolean, memo: Memo, offline = false): Promise<Project> {
  const cdir = await commonDir(repo);
  if (!cdir) {
    return {
      name, slug: slugOf(name), path: repo, displayPath: tilde(repo), error: "git couldn't open this folder", host: null,
      remotes: { truth: null, push: null, fork: false, localPath: null, sameDisk: false },
      github: { checked: false, reason: null, host: null, slug: null, prRepo: null, autoDelete: null, canAdmin: false },
      limits: { shallow: false, singleBranch: false },
      main: { name: "", local: false, remoteMain: false, remoteRef: null, ahead: 0, behind: 0, localOnly: 0, checks: null },
      head: { branch: null }, fetch: { hasRemote: true, at: null, error: null },
      checkouts: [], branches: [], remoteBranches: [], stashes: [], unpushed: null, pruned: [], committedSecrets: [],
      signals: [], next: null, requests: [], items: [], notes: [], request: "", tier: "attention", verdict: "Couldn't read this project",
    };
  }
  let cached = metaFromMemo(memo.github[repo]);
  let rem = await remotesOf(repo, cached?.parent ?? null);
  const due = Boolean(rem.truth) && fetchDue(cdir, repo, everyMs, force, memo);
  // Offline means no network at all: GitHub's answers come only from what was remembered.
  if (rem.truth && !offline && (due || !cached)) {
    const fresh = await githubMeta(rem);
    // A failed ask keeps the last good answer for a day rather than dropping every safeguard.
    if (fresh.ok || !cached?.ok || Date.now() - (cached.at ?? 0) > 86_400_000) {
      cached = { ...fresh, at: Date.now() };
      memo.github[repo] = cached;
    }
    rem = await remotesOf(repo, cached.parent ?? null);
  }
  const meta = cached?.ok ? cached : null;
  const deleted = memo.deleted[repo] ?? [];
  const fetch = await refreshRemote(repo, cdir, rem, due, memo, (names) => fetchNoting(repo, names, [meta?.defaultBranch ?? undefined, memo.heads[repo]], deleted));

  const truth = rem.truth;
  const main = await defaultBranch(repo, truth, [meta?.defaultBranch, memo.heads[repo]]);
  const localMain = Boolean(main) && (await git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${main}`)) !== null;
  let truthRef: string | null = truth && main ? `refs/remotes/${truth}/${main}` : null;
  if (truthRef && (await git(repo, "rev-parse", "--verify", "--quiet", truthRef)) === null) truthRef = null;
  // The source of truth is main on the remote; with no remote copy, the local main.
  const base = truthRef ?? (localMain ? `refs/heads/${main}` : null);
  const both = localMain && truthRef;
  const mainRef = truth && main ? `${truth}/${main}` : main || "main";

  const wts = await worktrees(repo);
  const held = new Map(wts.filter((w) => w.branch).map((w) => [w.branch as string, tilde(w.path)]));
  const checkouts: Checkout[] = await Promise.all(wts.map(async (w, i): Promise<Checkout> => {
    // git also calls a worktree prunable when it merely can't read the folder; only a folder that's gone is missing.
    const missing = !existsSync(w.path);
    const st = missing ? { changed: 0, untracked: 0, secrets: [], unreadable: false } : await folderStatus(w.path);
    const op = missing ? null : await operation(w.path);
    const keep = i === 0 || missing ? [] : await ignoredKeep(w.path);
    // Commits a detached HEAD holds that no branch, remote or tag does: lost the moment HEAD moves.
    const detached = !w.branch && w.head ? await count(repo, w.head, "--not", "--branches", "--remotes", "--tags") : 0;
    const rel = relative(repo, w.path);
    const label = i === 0 ? "main working tree" : !rel.startsWith("..") && !isAbsolute(rel) ? rel : w.path.split(sep).slice(-2).join("/");
    const unreadable = st.unreadable || keep === null;
    const tier: Tier = st.secrets.length || detached ? "at-risk" : st.changed + st.untracked || op || missing || unreadable ? "attention" : "safe";
    return { path: w.path, label, branch: w.branch, primary: i === 0, missing, changed: st.changed, untracked: st.untracked, secrets: st.secrets,
      operation: op, head: w.branch ? null : w.head, detachedCommits: detached, unreadable, ignoredKeep: keep ?? [],
      offline: missing && onMissingDrive(w.path), locked: w.locked, temporary: inTempFolder(w.path), tier };
  }));
  const host = rem.host ?? "the remote";
  const current = new Set(checkouts[0]?.branch ? [checkouts[0].branch] : []);
  const refspecs = rem.push ? (await git(repo, "config", "--get-all", `remote.${rem.push}.fetch`)) ?? "" : "";

  const draft: Draft = {
    name, slug: slugOf(name), path: repo, displayPath: tilde(repo), error: null, host: rem.host,
    remotes: { truth, push: rem.push, fork: rem.fork, localPath: rem.localPath, sameDisk: sameDisk(repo, rem.localPath) },
    github: { checked: Boolean(meta), reason: cached?.reason ?? null, host: meta?.host ?? null, slug: meta?.slug ?? null,
      prRepo: meta?.prRepo ?? null, autoDelete: meta?.autoDelete ?? null, canAdmin: meta?.canAdmin ?? false },
    limits: { shallow: (await git(repo, "rev-parse", "--is-shallow-repository")) === "true",
      singleBranch: Boolean(rem.push) && !refspecs.includes("refs/heads/*") },
    main: { name: main, local: localMain, remoteMain: truthRef !== null, remoteRef: truthRef ? mainRef : null,
      ahead: both ? await countOrNull(repo, `${truthRef}..refs/heads/${main}`) : 0,
      behind: both ? await countOrNull(repo, `refs/heads/${main}..${truthRef}`) : 0,
      localOnly: localMain ? await count(repo, `refs/heads/${main}`, "--not", "--remotes") : 0,
      checks: await checksOnMain(repo, truthRef, meta) },
    head: { branch: checkouts[0]?.branch ?? null },
    fetch, checkouts,
    branches: await branchFacts(repo, host, main, mainRef, base, meta, held, current),
    remoteBranches: await remoteBranches(repo, rem, main, base, meta),
    stashes: ((await git(repo, "stash", "list", "--format=%gs")) ?? "").split("\n").filter(Boolean).map((label) => ({ label })),
    unpushed: await countOrNull(repo, "--branches", "--not", "--remotes"),
    pruned: await prunedBranches(repo, deleted, meta),
    committedSecrets: await committedSecrets(repo),
  };
  const sigs = signals(draft);
  // Stop noting a deleted branch once its work is back on a branch, or git has thrown it away.
  const still = draft.pruned.map(({ name, sha, at }) => ({ name, sha, at }));
  if (still.length) memo.deleted[repo] = still;
  else delete memo.deleted[repo];
  const byKey = Object.fromEntries(sigs.map((s) => [s.key, s])) as Record<Signal["key"], Signal>;
  const tier = worst(sigs.map((s) => s.tier));
  const items = itemsFor(draft);
  return { ...draft, signals: sigs, next: nextStep(draft, byKey), requests: requestsFor(draft), items, notes: notesFor(draft),
    request: combinedRequest(repo, items), tier, verdict: VERDICT[tier] };
}

// --- scanning everything ------------------------------------------------------------

export interface ScanOptions {
  /** Fetch now, whatever the schedule says. */
  force?: boolean;
  /** Don't touch the network at all. */
  offline?: boolean;
  /** Check just the repo containing this folder. */
  only?: string;
}

const everyMs = (cfg: Config, opts: ScanOptions): number => (opts.offline ? 0 : cfg.fetchEveryMinutes * 60_000);

export async function buildOne(repo: string, force: boolean): Promise<Project> {
  const cfg = loadConfig();
  const memo = loadMemo();
  const project = await buildProject(repo, projectName(repo, cfg.roots.map((r) => resolve(untilde(r)))), everyMs(cfg, {}), force, memo);
  saveMemo(memo);
  saveMergeCache();
  return project;
}

export async function scan(opts: ScanOptions = {}): Promise<Snapshot> {
  try {
    await checkGit();
    const cfg = loadConfig();
    const memo = loadMemo();
    let roots: string[], watch: string[], found: number, blocked: string[];
    if (opts.only) {
      const top = await git(opts.only, "rev-parse", "--show-toplevel");
      if (!top) throw new CheckFailed("Not a git repository", `${tilde(resolve(opts.only))} isn't inside a git repository.`);
      const cdir = await commonDir(top);
      const owner = cdir && basename(cdir) === ".git" ? dirname(cdir) : top;
      [roots, watch, found, blocked] = [[dirname(owner)], [owner], 1, []];
    } else {
      ({ roots, watch, found, blocked } = await discover(cfg));
    }
    const force = Boolean(opts.force) && !opts.offline;
    const projects = await pool(watch, 6, (r) => buildProject(r, projectName(r, roots), everyMs(cfg, opts), force, memo, Boolean(opts.offline)));
    saveMemo(memo);
    saveMergeCache();
    const rank = { "at-risk": 0, attention: 1, safe: 2 } as const;
    projects.sort((a, b) => rank[a.tier] - rank[b.tier] || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return { version: VERSION, generatedAt: iso(Date.now()) ?? "", watching: projects.length, quiet: found - watch.length,
      activeDays: cfg.activeDays, configPath: tilde(CONFIG_FILE), blocked, notices: [...notices], error: null, projects };
  } catch (err) {
    if (!(err instanceof CheckFailed)) throw err;
    return { version: VERSION, generatedAt: iso(Date.now()) ?? "", watching: 0, quiet: 0, activeDays: 0,
      configPath: tilde(CONFIG_FILE), blocked: [], notices: [], error: { title: err.title, detail: err.detail }, projects: [] };
  }
}

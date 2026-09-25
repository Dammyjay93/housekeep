/** Remotes: which one is the source of truth, what the server is called, what GitHub knows, and fetching. */

import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Memo } from "./config.js";
import type { FetchInfo } from "./model.js";
import { ENV, HERE, HOME, type RunResult, asNumber, asString, git, isRecord, iso, parseJson, run, which } from "./proc.js";

const REMOTE_URL = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](?:\d+\/)?(.+?)(?:\.git)?\/*$/;
const HOST_NAMES: [string, string][] = [["github", "GitHub"], ["gitlab", "GitLab"], ["bitbucket", "Bitbucket"], ["codeberg", "Codeberg"]];

/** How a remote's server is named on screen: GitHub, GitLab, a server's own name, or "the remote". */
export function hostName(url: string): string {
  const m = REMOTE_URL.exec(url);
  if (!m || /^(\/|\.|~|file:)/.test(url) || /^[A-Za-z]:[\\/]/.test(url)) return "the remote";
  const host = (m[1] ?? "").toLowerCase();
  return HOST_NAMES.find(([key]) => host.includes(key))?.[1] ?? host;
}

/** [hostname, "owner/repo"] for a GitHub remote. An SSH alias such as github-work means github.com. */
export function githubRepo(url: string): [string, string] | null {
  const m = REMOTE_URL.exec(url);
  const host = (m?.[1] ?? "").toLowerCase();
  if (!m || !host.includes("github")) return null;
  const parts = (m[2] ?? "").replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2) return null;
  return [host.includes(".") ? host : "github.com", parts.slice(-2).join("/")];
}

export interface RemoteSet {
  truth: string | null;
  push: string | null;
  fork: boolean;
  host: string | null;
  urls: Record<string, string>;
  /** The push remote as a folder on this machine, when it isn't a server. */
  localPath: string | null;
}

/** A remote that's a folder rather than a server: /srv/app.git, ../app.git, file:///..., C:\\repos\\app. */
export function localPathOf(url: string, repo: string): string | null {
  if (url.startsWith("file://")) return decodeURIComponent(url.slice(7));
  if (url.startsWith("/") || /^[A-Za-z]:[\\/]/.test(url)) return url;
  if (url.startsWith("~")) return join(HOME, url.slice(1));
  // Anything else without a scheme or a host: separator is a path relative to the repo.
  if (url && !url.includes("://") && !url.includes(":")) return resolve(repo, url);
  return null;
}

/**
 * Which remote holds the source of truth, and which one your work is pushed to.
 *
 * Usually both are origin. In a fork, main is judged against the project everyone merges
 * into (the fork's parent as GitHub reports it, or whichever remote main tracks) while
 * your branches and backups go to your own copy.
 */
export async function remotesOf(repo: string, forkParent: string | null = null): Promise<RemoteSet> {
  const names = ((await git(repo, "remote")) ?? "").split(/\s+/).filter(Boolean);
  if (!names.length) return { truth: null, push: null, fork: false, host: null, urls: {}, localPath: null };
  const urls: Record<string, string> = {};
  for (const n of names) urls[n] = (await git(repo, "remote", "get-url", n)) ?? "";
  const pushDefault = await git(repo, "config", "--get", "remote.pushDefault");
  const push = pushDefault && names.includes(pushDefault) ? pushDefault : names.includes("origin") ? "origin" : (names[0] as string);
  const parent = forkParent
    ? names.find((n) => githubRepo(urls[n] ?? "")?.[1].toLowerCase() === forkParent.toLowerCase()) ?? null
    : null;
  let tracked: string | null = null;
  for (const b of ["main", "master", "trunk"]) {
    const r = await git(repo, "config", "--get", `branch.${b}.remote`);
    if (r && names.includes(r)) {
      tracked = r;
      break;
    }
  }
  const truth = parent ?? tracked ?? push;
  return { truth, push, fork: truth !== push, host: hostName(urls[truth] ?? ""), urls, localPath: localPathOf(urls[push] ?? "", repo) };
}

// --- GitHub -------------------------------------------------------------------

export const GH = which("gh");
export const GH_ENV: NodeJS.ProcessEnv = { ...ENV, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", NO_COLOR: "1" };

/** Run the GitHub CLI: [output, null], or [null, why it couldn't be asked]. */
export async function gh(args: string[], host: string): Promise<[string, null] | [null, string]> {
  if (!GH) return [null, "the GitHub CLI (gh) isn't installed"];
  const r = await run(GH, args, { env: { ...GH_ENV, GH_HOST: host }, cwd: HOME, network: true });
  if (r.timedOut) return [null, "GitHub didn't answer in time"];
  if (r.ok) return [r.stdout, null];
  const err = r.stderr.toLowerCase();
  if (err.includes("auth login") || err.includes("not logged") || err.includes("authentication")) return [null, "the GitHub CLI (gh) isn't logged in"];
  if (err.includes("404") || err.includes("not found") || err.includes("could not resolve")) return [null, "GitHub didn't recognise this repository"];
  return [null, "GitHub couldn't be asked"];
}

export interface PullRequest {
  number: number;
  url: string;
  head: string;
  base: string;
  own: boolean;
}

/** A pull request that's finished: merged into its base, or closed without merging. */
export interface ClosedPullRequest {
  number: number;
  url: string;
  head: string;
  /** The commit its head branch pointed at when it closed. */
  sha: string;
  merged: boolean;
}

/** What GitHub's checks said about the latest commit on main. */
export interface MainChecks {
  sha: string;
  /** failing: at least one check failed · pending: some still running · passing: all passed · none: nothing ran */
  state: "failing" | "pending" | "passing" | "none";
  /** Names of the checks that failed. */
  failed: string[];
}

export interface GitHubMeta {
  ok: boolean;
  reason: string | null;
  at?: number;
  host?: string;
  slug?: string;
  prRepo?: string;
  parent?: string | null;
  defaultBranch?: string | null;
  autoDelete?: boolean | null;
  canAdmin?: boolean;
  protected?: string[];
  prs?: PullRequest[];
  /** Your recent pull requests that were merged or closed, so a branch they came from counts as done. */
  closed?: ClosedPullRequest[];
  checks?: MainChecks | null;
}

/**
 * The finished pull request `name` came from, if its head was exactly `sha` when it closed. Anything
 * pushed to the branch after that isn't covered, so a branch that moved on still counts as work.
 */
export function closedPullRequest(meta: GitHubMeta | null, name: string, sha: string): ClosedPullRequest | null {
  return meta?.closed?.find((p) => p.head === name && p.sha === sha) ?? null;
}

/** GitHub's check runs and commit statuses (which services like Vercel use) on the tip of `branch`. */
async function mainChecks(host: string, slug: string, branch: string): Promise<MainChecks | null> {
  const [runsOut] = await gh(["api", `repos/${slug}/commits/${encodeURIComponent(branch)}/check-runs?per_page=100`], host);
  const [statusOut] = await gh(["api", `repos/${slug}/commits/${encodeURIComponent(branch)}/status`], host);
  const runs = runsOut === null ? null : parseJson(runsOut);
  const status = statusOut === null ? null : parseJson(statusOut);
  if (!isRecord(runs) && !isRecord(status)) return null;
  const sha = (isRecord(status) ? asString(status.sha) : null)
    ?? (isRecord(runs) && Array.isArray(runs.check_runs) && isRecord(runs.check_runs[0]) ? asString(runs.check_runs[0].head_sha) : null);
  if (!sha) return { sha: "", state: "none", failed: [] };
  const failed: string[] = [];
  let pending = false, any = false;
  for (const r of isRecord(runs) && Array.isArray(runs.check_runs) ? runs.check_runs : []) {
    if (!isRecord(r)) continue;
    const conclusion = asString(r.conclusion);
    if (conclusion === "skipped" || conclusion === "neutral") continue;
    any = true;
    if (r.status !== "completed") pending = true;
    else if (conclusion && !["success"].includes(conclusion)) failed.push(asString(r.name) ?? "A check");
  }
  for (const c of isRecord(status) && Array.isArray(status.statuses) ? status.statuses : []) {
    if (!isRecord(c)) continue;
    any = true;
    if (c.state === "pending") pending = true;
    else if (c.state === "failure" || c.state === "error") failed.push(asString(c.context) ?? "A status check");
  }
  return { sha, state: failed.length ? "failing" : pending ? "pending" : any ? "passing" : "none", failed: [...new Set(failed)] };
}

function closedFrom(listed: unknown, owner: string): ClosedPullRequest[] {
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((p) => {
    if (!isRecord(p)) return [];
    const number = asNumber(p.number), url = asString(p.url), head = asString(p.headRefName), sha = asString(p.headRefOid);
    const login = isRecord(p.headRepositoryOwner) ? asString(p.headRepositoryOwner.login) ?? "" : "";
    if (number === null || !url || !head || !sha || login.toLowerCase() !== owner) return [];
    return [{ number, url, head, sha, merged: p.state === "MERGED" }];
  });
}

/** What only GitHub knows: the default branch, protected branches, open pull requests, a fork's parent. */
export async function githubMeta(rem: RemoteSet): Promise<GitHubMeta> {
  const found = githubRepo(rem.urls[rem.push ?? ""] ?? "");
  if (!found) return { ok: false, reason: null };
  const [host, slug] = found;
  const [repoOut, repoWhy] = await gh(["api", `repos/${slug}`], host);
  if (repoOut === null) return { ok: false, reason: repoWhy };
  const info = parseJson(repoOut);
  if (!isRecord(info)) return { ok: false, reason: "GitHub sent something unreadable" };
  const parent = info.fork === true && isRecord(info.parent) ? info.parent : null;
  const [protectedOut, protectedWhy] = await gh(["api", "--paginate", `repos/${slug}/branches?protected=true&per_page=100`, "--jq", ".[].name"], host);
  if (protectedOut === null) return { ok: false, reason: protectedWhy };
  const prRepo = (parent && asString(parent.full_name)) || slug;
  const [prOut, prWhy] = await gh(["pr", "list", "--repo", `${host}/${prRepo}`, "--state", "open", "--limit", "500",
    "--json", "number,url,headRefName,baseRefName,headRepositoryOwner"], host);
  if (prOut === null) return { ok: false, reason: prWhy };
  const listed = parseJson(prOut);
  if (!Array.isArray(listed)) return { ok: false, reason: "GitHub sent something unreadable" };
  const owner = (slug.split("/")[0] ?? "").toLowerCase();
  const prs: PullRequest[] = [];
  for (const p of listed) {
    if (!isRecord(p)) continue;
    const number = asNumber(p.number);
    const url = asString(p.url);
    const head = asString(p.headRefName);
    const base = asString(p.baseRefName);
    if (number === null || !url || !head || !base) continue;
    const login = isRecord(p.headRepositoryOwner) ? asString(p.headRepositoryOwner.login) ?? "" : "";
    prs.push({ number, url, head, base, own: login.toLowerCase() === owner });
  }
  // Finished pull requests only add proof that work is done. If GitHub won't list them, nothing is lost:
  // those branches are judged by git alone, as before.
  const [closedOut] = await gh(["pr", "list", "--repo", `${host}/${prRepo}`, "--state", "closed", "--limit", "300",
    "--json", "number,url,headRefName,headRefOid,headRepositoryOwner,state"], host);
  const closed = closedOut === null ? [] : closedFrom(parseJson(closedOut), owner);
  const defaultBranch = asString((parent ?? info).default_branch);
  const checks = defaultBranch ? await mainChecks(host, prRepo, defaultBranch) : null;
  const permissions = isRecord(info.permissions) ? info.permissions : {};
  return {
    ok: true, reason: null, host, slug, prRepo, closed, checks,
    parent: parent ? asString(parent.full_name) : null,
    defaultBranch: asString((parent ?? info).default_branch),
    // GitHub only auto-deletes head branches in the same repository, so it's moot for a fork.
    autoDelete: parent ? null : info.delete_branch_on_merge === true,
    canAdmin: permissions.admin === true,
    protected: protectedOut.split(/\s+/).filter(Boolean),
    prs,
  };
}

/** Read a cached GitHub answer back from the memo, checking every field. */
export function metaFromMemo(v: unknown): GitHubMeta | null {
  if (!isRecord(v) || typeof v.ok !== "boolean") return null;
  const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  const prs: PullRequest[] = Array.isArray(v.prs)
    ? v.prs.flatMap((p) => {
      if (!isRecord(p)) return [];
      const number = asNumber(p.number), url = asString(p.url), head = asString(p.head), base = asString(p.base);
      return number !== null && url && head && base ? [{ number, url, head, base, own: p.own === true }] : [];
    })
    : [];
  return {
    ok: v.ok, reason: asString(v.reason), at: asNumber(v.at) ?? 0,
    host: asString(v.host) ?? undefined, slug: asString(v.slug) ?? undefined, prRepo: asString(v.prRepo) ?? undefined,
    parent: asString(v.parent), defaultBranch: asString(v.defaultBranch),
    autoDelete: typeof v.autoDelete === "boolean" ? v.autoDelete : null,
    canAdmin: v.canAdmin === true, protected: strings(v.protected), prs,
    closed: Array.isArray(v.closed)
      ? v.closed.flatMap((p) => {
        if (!isRecord(p)) return [];
        const number = asNumber(p.number), url = asString(p.url), head = asString(p.head), sha = asString(p.sha);
        return number !== null && url && head && sha ? [{ number, url, head, sha, merged: p.merged === true }] : [];
      })
      : [],
    checks: isRecord(v.checks) && typeof v.checks.sha === "string" && ["failing", "pending", "passing", "none"].includes(String(v.checks.state))
      ? { sha: v.checks.sha, state: v.checks.state as MainChecks["state"], failed: strings(v.checks.failed) }
      : null,
  };
}

// --- fetching -----------------------------------------------------------------

const mtime = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

export function fetchDue(cdir: string, key: string, everyMs: number, force: boolean, memo: Memo): boolean {
  const last = mtime(join(cdir, "FETCH_HEAD"));
  const tried = memo.tried[key] ?? 0;
  const now = Date.now();
  return force || (everyMs > 0 && (last === null || now - last > everyMs) && now - tried > everyMs);
}

/**
 * Bring the repo's picture of its remotes up to date if it's time. Only the remotes that matter.
 * `fetcher` does the fetch itself, so the caller can keep unmerged work that pruning would drop.
 */
export async function refreshRemote(repo: string, cdir: string, rem: RemoteSet, due: boolean, memo: Memo,
  fetcher: (names: string[]) => Promise<RunResult>): Promise<FetchInfo> {
  if (!rem.truth) return { hasRemote: false, at: null, error: null };
  const fetchHead = join(cdir, "FETCH_HEAD");
  let last = mtime(fetchHead);
  let error: string | null = null;
  const host = rem.host ?? "the remote";
  if (due) {
    memo.tried[repo] = Date.now();
    // Which branch the server calls its default. origin/HEAD is only set when you clone,
    // and goes stale when a project renames master to main.
    const head = await run("git", ["-C", repo, "ls-remote", "--symref", rem.truth, "HEAD"], { timeout: 30_000, network: true });
    const m = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(head.stdout);
    if (head.ok && m?.[1]) memo.heads[repo] = m[1];
    const names = [...new Set([rem.truth, rem.push].filter((n): n is string => Boolean(n)))];
    const r = await fetcher(names);
    if (!r.ok) {
      const err = r.stderr.toLowerCase();
      error = ["permission denied", "authentication", "could not read username", "publickey", "host key"].some((k) => err.includes(k))
        ? `${host} asked for a login, so this couldn't be re-checked`
        : `Couldn't reach ${host}, so this is what ${HERE} last knew`;
    } else {
      last = mtime(fetchHead) ?? Date.now();
    }
  } else if (last !== null && (memo.tried[repo] ?? 0) > last) {
    error = `Couldn't reach ${host} last time, so this is what ${HERE} last knew`;
  }
  return { hasRemote: true, at: iso(last), error };
}

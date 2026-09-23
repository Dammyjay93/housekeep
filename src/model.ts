/** The shape of what Housekeep knows about each project. The dashboard and `--json` read exactly this. */

export type Tier = "at-risk" | "attention" | "safe";
export type MergeKind = "merged" | "squashed";
export type SignalKey = "commit" | "push" | "sync" | "cleanup";
export type NextKind =
  | "assistant" | "push-all" | "pull" | "delete-merged" | "delete-remote"
  | "unset-upstream" | "fetch-all" | "prune-worktrees" | "restore-pruned";

export interface PullRequestRef {
  number: number;
  url: string;
}

export interface Checkout {
  path: string;
  label: string;
  branch: string | null;
  primary: boolean;
  missing: boolean;
  changed: number;
  untracked: number;
  secrets: string[];
  operation: string | null;
  /** The commit HEAD points at, when it's detached (on no branch). */
  head: string | null;
  /** Commits reachable only from this worktree's detached HEAD: on no branch and no remote. */
  detachedCommits: number;
  /** git couldn't read this working tree (timed out, or refused), so nothing here is known. */
  unreadable: boolean;
  /** Ignored files that only live here (e.g. .env.local), which removing the worktree would delete. */
  ignoredKeep: string[];
  /** The folder is on a drive that isn't connected, so git thinks it's gone when it isn't. */
  offline: boolean;
  /** Locked with git worktree lock, so git won't prune it. */
  locked: boolean;
  /** In a temporary folder the system empties (e.g. /tmp), so anything only here can vanish. */
  temporary: boolean;
  tier: Tier;
}

/** A remote branch deleted on the server while it held work that isn't in main; Housekeep kept its commits. */
export interface PrunedBranch {
  name: string;
  ref: string;
  commits: number;
}

export interface CommittedSecret {
  path: string;
  /** Also in a branch on the remote, so anyone with access to the repo can read it. */
  pushed: boolean;
}

export interface Branch {
  name: string;
  /** unpushed: commits exist only here · unmerged: pushed, not in main · merged: safe to delete · kept: long-lived or protected */
  state: "unpushed" | "unmerged" | "merged" | "kept";
  note: string;
  merged: MergeKind | null;
  aheadOfMain: number;
  localOnly: number;
  behindUpstream: number;
  upstreamGone: boolean;
  onRemote: boolean;
  upstreamIsMain: boolean;
  pushesToMain: boolean;
  pr: PullRequestRef | null;
  lastCommit: number | null;
  worktree: string | null;
  current: boolean;
}

export interface RemoteBranch {
  name: string;
  sha: string;
  merged: MergeKind | null;
  kept: string | null;
  blockedBy: string | null;
  deletable: boolean;
  backup: boolean;
  local: boolean;
  pr: PullRequestRef | null;
  aheadOfMain: number;
  lastCommit: number | null;
}

export interface Signal {
  key: SignalKey;
  label: string;
  tier: Tier;
  headline: string;
  hint: string;
  details: string[];
  cell: string;
  value: number | null;
  unit: string;
  count?: string;
  mergedHere?: number;
  mergedOnRemote?: number;
  prunable?: number;
  unmerged?: number;
}

export interface NextStep {
  tier: Tier;
  kind: NextKind | null;
  title: string;
  why: string;
  /** A request to paste into an AI coding assistant, for steps that need judgement. */
  ask: string;
}

export interface Remotes {
  truth: string | null;
  push: string | null;
  fork: boolean;
  /** The push remote is a folder, not a server. */
  localPath: string | null;
  /** ...and it's on the same disk as the repo, so it's no backup at all. */
  sameDisk: boolean;
}

export interface GitHubInfo {
  checked: boolean;
  reason: string | null;
  host: string | null;
  slug: string | null;
  prRepo: string | null;
  autoDelete: boolean | null;
  canAdmin: boolean;
}

export interface MainFacts {
  name: string;
  local: boolean;
  remoteMain: boolean;
  /** How git names the source of truth, e.g. "origin/main". */
  remoteRef: string | null;
  /** null when git couldn't compare them. */
  ahead: number | null;
  behind: number | null;
  localOnly: number;
}

export interface FetchInfo {
  hasRemote: boolean;
  at: string | null;
  error: string | null;
}

export interface Project {
  name: string;
  slug: string;
  path: string;
  displayPath: string;
  error: string | null;
  host: string | null;
  remotes: Remotes;
  github: GitHubInfo;
  limits: { shallow: boolean; singleBranch: boolean };
  main: MainFacts;
  head: { branch: string | null };
  fetch: FetchInfo;
  checkouts: Checkout[];
  branches: Branch[];
  remoteBranches: RemoteBranch[];
  stashes: { label: string }[];
  /** Unpushed commits on branches, or null if git couldn't count them. */
  unpushed: number | null;
  pruned: PrunedBranch[];
  committedSecrets: CommittedSecret[];
  signals: Signal[];
  next: NextStep | null;
  tier: Tier;
  verdict: string;
}

export interface Snapshot {
  version: string;
  generatedAt: string;
  watching: number;
  quiet: number;
  activeDays: number;
  configPath: string;
  /** Folders Housekeep wasn't allowed to look inside, e.g. macOS-protected Documents. */
  blocked: string[];
  /** Things about this machine worth knowing, e.g. a git too old to recognise squash merges. */
  notices: string[];
  error: { title: string; detail: string } | null;
  projects: Project[];
}

export const TIER_RANK: Record<Tier, number> = { "at-risk": 0, attention: 1, safe: 2 };
export const VERDICT: Record<Tier, string> = { "at-risk": "Could lose work", attention: "Needs attention", safe: "All clear" };

export const worst = (tiers: Tier[]): Tier =>
  tiers.reduce<Tier>((a, b) => (TIER_RANK[b] < TIER_RANK[a] ? b : a), "safe");

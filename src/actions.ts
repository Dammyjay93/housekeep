/**
 * What the dashboard's buttons do. Each one re-checks the repo right before it runs and
 * refuses, in plain English, whenever work could be lost. Nothing is ever force-pushed.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Project } from "./model.js";
import { ENV, HOME, count, git, plural, run, tilde } from "./proc.js";
import { GH, GH_ENV, githubMeta, remotesOf } from "./remote.js";
import { BACKUP_PREFIX, PRUNED_PREFIX, fetchPreserving, ignoredKeep, inMain, keptReason, onMissingDrive } from "./scan.js";

export class ActionError extends Error {}

export interface ActionResult {
  message: string;
  output: string;
}

export interface ActionBody {
  branches?: string[];
  branch?: string;
  path?: string;
  app?: string;
}

async function gitRun(cwd: string, args: string[], timeout = 120_000): Promise<string> {
  const network = ["fetch", "push", "ls-remote"].includes(args[0] ?? "");
  const r = await run("git", ["-C", cwd, ...args], { timeout, network });
  if (r.timedOut) throw new ActionError("git took too long and was stopped. Nothing else was changed.");
  const output = (r.stdout + r.stderr).trim();
  if (!r.ok) {
    const lines = output.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("hint:"));
    throw new ActionError((lines.at(-1) ?? "git refused.").replace(/^(fatal|error): /, ""));
  }
  return output;
}

const gitOk = async (cwd: string, ...args: string[]): Promise<boolean> => (await git(cwd, ...args)) !== null;

async function ghRun(p: Project, args: string[]): Promise<string> {
  if (!GH) throw new ActionError("This needs the GitHub CLI. Install it (brew install gh), then run gh auth login.");
  if (!p.github.checked || !p.github.host) throw new ActionError(`GitHub couldn't be asked about this project: ${p.github.reason ?? "it isn't on GitHub"}.`);
  const r = await run(GH, args, { env: { ...GH_ENV, GH_HOST: p.github.host }, cwd: HOME, timeout: 60_000, network: true });
  if (r.timedOut) throw new ActionError("GitHub didn't answer in time. Nothing was changed.");
  if (!r.ok) throw new ActionError(r.stderr.trim().split("\n").at(-1) || "GitHub refused.");
  return r.stdout.trim();
}

function remotes(p: Project): [string, string] {
  if (!p.remotes.truth || !p.remotes.push) throw new ActionError("This repo has no remote to work with.");
  return [p.remotes.truth, p.remotes.push];
}

const unique = (names: (string | null)[]): string[] => [...new Set(names.filter((n): n is string => Boolean(n)))];

/** The ref main is judged against right now: main on the source of truth, else the local main. */
async function truthMain(p: Project): Promise<string> {
  const main = p.main.name;
  if (!main) throw new ActionError("This repo has no main branch.");
  const ref = `refs/remotes/${p.remotes.truth}/${main}`;
  return p.remotes.truth && (await gitOk(p.path, "rev-parse", "--verify", "--quiet", ref)) ? ref : `refs/heads/${main}`;
}

async function liveCounts(p: Project): Promise<[number, number]> {
  const main = p.main.name;
  const remote = `refs/remotes/${p.remotes.truth}/${main}`;
  return [await count(p.path, `${remote}..refs/heads/${main}`), await count(p.path, `refs/heads/${main}..${remote}`)];
}

function branch(p: Project, name: string): Project["branches"][number] {
  const found = p.branches.find((b) => b.name === name);
  if (!found) throw new ActionError(`There's no branch called ${name} here any more.`);
  return found;
}

const mainHolder = (p: Project) => p.checkouts.find((c) => c.branch === p.main.name && !c.missing) ?? null;
const ref = (p: Project): string => p.main.remoteRef ?? p.main.name;

/** git fetch --prune for the remotes that matter, keeping any unmerged work a deleted branch held. */
async function fetchSafely(p: Project, timeout = 90_000): Promise<string> {
  const [truth, push] = remotes(p);
  const r = await fetchPreserving(p.path, unique([truth, push]), [p.main.name], timeout);
  if (r.timedOut) throw new ActionError("git took too long and was stopped. Nothing else was changed.");
  if (!r.ok) throw new ActionError((r.stderr.trim().split("\n").filter((l) => !l.startsWith("hint:")).at(-1) ?? "git fetch failed.").replace(/^(fatal|error): /, ""));
  return (r.stdout + r.stderr).trim();
}

async function fetchRemotes(p: Project): Promise<ActionResult> {
  return { message: `Fetched from ${p.host ?? "the remote"}`, output: await fetchSafely(p) };
}

async function pull(p: Project): Promise<ActionResult> {
  const main = p.main.name;
  const [truth] = remotes(p);
  if (!main || !p.main.remoteMain || !p.main.local) throw new ActionError(`There's no local ${main || "main"} and ${ref(p)} to pull between.`);
  const [ahead, behind] = await liveCounts(p);
  if (ahead) throw new ActionError(`${main} has commits ${ref(p)} doesn't, so it can't fast-forward. Ask your AI assistant to reconcile it.`);
  if (!behind) return { message: `${main} is already up to date with ${ref(p)}`, output: "" };
  const holder = mainHolder(p);
  // Only ever moves main forward; git refuses anything that would rewrite it.
  const out = holder
    ? await gitRun(holder.path, ["merge", "--ff-only", `refs/remotes/${truth}/${main}`])
    : await gitRun(p.path, ["fetch", ".", `refs/remotes/${truth}/${main}:refs/heads/${main}`]);
  return { message: `Fast-forwarded ${main} by ${plural(behind, "commit")}`, output: out };
}

async function push(p: Project, body: ActionBody): Promise<ActionResult> {
  const main = p.main.name;
  const [, remote] = remotes(p);
  const names = body.branches ?? [];
  if (!names.length) throw new ActionError("Pick at least one branch to push.");
  const outputs: string[] = [];
  for (const name of names) {
    if (name === main) {
      if (p.main.remoteMain && (await liveCounts(p))[1]) throw new ActionError(`${ref(p)} has commits your ${main} doesn't. Pull or reconcile before pushing ${main}.`);
      outputs.push(await gitRun(p.path, ["push", remote, `refs/heads/${main}:refs/heads/${main}`]));
    } else {
      branch(p, name);
      outputs.push(await gitRun(p.path, ["push", "-u", remote, `refs/heads/${name}:refs/heads/${name}`]));
    }
  }
  return { message: `Pushed ${plural(names.length, "branch", "branches")} to ${remote}`, output: outputs.join("\n") };
}

/**
 * Push every unpushed commit without touching main on the remote. Branches go up under their own
 * names; commits sitting on main go to a separate backup branch, because pushing main can deploy a site.
 */
async function pushAll(p: Project): Promise<ActionResult> {
  const main = p.main.name;
  const [, remote] = remotes(p);
  const outputs: string[] = [];
  const done: string[] = [];
  for (const b of p.branches) {
    if (await count(p.path, `refs/heads/${b.name}`, "--not", "--remotes")) {
      outputs.push(await gitRun(p.path, ["push", "-u", remote, `refs/heads/${b.name}:refs/heads/${b.name}`]));
      done.push(b.name);
    }
  }
  // Commits on a detached HEAD belong to no branch; give them one so they can be pushed.
  for (const c of p.checkouts) {
    if (!c.head || !(await count(p.path, c.head, "--not", "--branches", "--remotes", "--tags"))) continue;
    let name = `housekeep/detached-${c.head.slice(0, 7)}`;
    if (await gitOk(p.path, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`)) name += `-${Date.now()}`;
    await gitRun(p.path, ["branch", name, c.head]);
    outputs.push(await gitRun(p.path, ["push", "-u", remote, `refs/heads/${name}:refs/heads/${name}`]));
    done.push(`${name} (the detached HEAD in ${c.primary ? "the main working tree" : c.label})`);
  }
  if (main && p.main.local && (await count(p.path, `refs/heads/${main}`, "--not", "--remotes"))) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const backup = `${BACKUP_PREFIX}${main}-${stamp}`;
    outputs.push(await gitRun(p.path, ["push", remote, `refs/heads/${main}:refs/heads/${backup}`]));
    done.push(`${main} (as ${backup})`);
  }
  if (!done.length) return { message: `Everything was already pushed to ${remote}`, output: "" };
  return { message: `Pushed ${plural(done.length, "branch", "branches")} to ${remote}`, output: outputs.join("\n") };
}

/** Propose merging a branch into main on GitHub, so reviews and checks run and GitHub can tidy up after. */
async function openPr(p: Project, body: ActionBody): Promise<ActionResult> {
  const main = p.main.name;
  const [, remote] = remotes(p);
  const name = body.branch ?? "";
  const b = branch(p, name);
  if (b.pr) return { message: `${name} already has pull request #${b.pr.number}`, output: b.pr.url };
  if (!main || !p.main.remoteMain) throw new ActionError(`There's no ${ref(p)} to open a pull request against.`);
  const tip = await gitRun(p.path, ["rev-parse", `refs/heads/${name}`]);
  const remoteTip = await git(p.path, "rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${name}`);
  let pushed = "";
  // Push first unless the remote already has everything on this branch.
  if (!remoteTip || !(await gitOk(p.path, "merge-base", "--is-ancestor", tip, remoteTip))) {
    pushed = await gitRun(p.path, ["push", "-u", remote, `refs/heads/${name}:refs/heads/${name}`]);
  }
  const head = p.remotes.fork ? `${(p.github.slug ?? "").split("/")[0]}:${name}` : name;
  const url = await ghRun(p, ["pr", "create", "--repo", `${p.github.host}/${p.github.prRepo}`, "--base", main, "--head", head, "--fill"]);
  return { message: `Opened a pull request for ${name}`, output: [pushed, url].filter(Boolean).join("\n") };
}

/** Merge locally. Skips reviews and checks, so the dashboard only offers it under Advanced. */
async function merge(p: Project, body: ActionBody): Promise<ActionResult> {
  const main = p.main.name;
  const name = body.branch ?? "";
  branch(p, name);
  if (!main || !p.main.local) throw new ActionError("This repo has no local main to merge into.");
  if (p.remotes.truth && p.main.remoteMain && (await liveCounts(p))[1]) throw new ActionError(`Pull ${main} first, so the merge starts from the latest ${ref(p)}.`);
  if (!(await count(p.path, `refs/heads/${main}..refs/heads/${name}`))) return { message: `${name} is already merged into ${main}`, output: "" };
  const holder = mainHolder(p);
  if (holder) {
    if (await git(holder.path, "status", "--porcelain", "--untracked-files=no")) throw new ActionError(`The working tree with ${main} checked out has uncommitted changes. Commit or stash them first.`);
    try {
      const out = await gitRun(holder.path, ["merge", "--no-ff", "--no-edit", `refs/heads/${name}`]);
      return { message: `Merged ${name} into ${main}. Push ${main} to share it.`, output: out };
    } catch (err) {
      await git(holder.path, "merge", "--abort");
      throw new ActionError(`${name} conflicts with ${main}, so the merge was aborted and nothing changed. Ask your AI assistant to resolve it.`, { cause: err });
    }
  }
  // main isn't checked out anywhere: build the merge commit without touching any working tree.
  const r = await run("git", ["-C", p.path, "merge-tree", "--write-tree", `refs/heads/${main}`, `refs/heads/${name}`]);
  if (r.code === 1) throw new ActionError(`${name} conflicts with ${main}, so nothing was merged. Ask your AI assistant to resolve it.`);
  const tree = r.stdout.split(/\s/)[0];
  if (!r.ok || !tree) throw new ActionError(`git couldn't work out the merge here. With ${main} not checked out, merging needs git 2.38 or newer; or check out ${main} and try again.`);
  const old = await gitRun(p.path, ["rev-parse", `refs/heads/${main}`]);
  const tip = await gitRun(p.path, ["rev-parse", `refs/heads/${name}`]);
  const commit = await gitRun(p.path, ["commit-tree", tree, "-p", old, "-p", tip, "-m", `Merge branch '${name}'`]);
  await gitRun(p.path, ["update-ref", "-m", `housekeep: merge ${name}`, `refs/heads/${main}`, commit, old]);
  return { message: `Merged ${name} into ${main}. Push ${main} to share it.`, output: commit };
}

/** Delete local branches whose changes are already in main on the source of truth (squash merges included). */
async function deleteMerged(p: Project, body: ActionBody): Promise<ActionResult> {
  const names = body.branches ?? [];
  if (!names.length) throw new ActionError("Pick at least one branch to delete.");
  const base = await truthMain(p);
  const held = new Set(p.checkouts.map((c) => c.branch).filter(Boolean));
  for (const name of names) {
    const b = branch(p, name);
    if (held.has(name) || b.current) throw new ActionError(`${name} is checked out in a worktree, so nothing was deleted.`);
    if (keptReason(name, p.main.name, null)) throw new ActionError(`${name} is a long-lived branch, so nothing was deleted.`);
    const tip = await git(p.path, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`);
    // The only proof that matters: every change on it is already in main.
    if (!tip || !(await inMain(p.path, tip, base))) throw new ActionError(`${name} has work that isn't in ${ref(p)}, so nothing was deleted.`);
  }
  for (const name of names) await gitRun(p.path, ["branch", "-D", name]);
  return { message: `Deleted ${plural(names.length, "merged branch", "merged branches")}`, output: names.join("\n") };
}

/**
 * Delete branches on the remote whose work is already in main there. Everything is re-checked
 * against a fresh fetch, and against GitHub's protected branches and open pull requests when it can
 * be asked. Each delete only succeeds if the remote still has exactly the commit that was checked,
 * so work someone pushed in the meantime is never thrown away.
 */
async function deleteRemote(p: Project, body: ActionBody): Promise<ActionResult> {
  const main = p.main.name;
  const [truth, remote] = remotes(p);
  const names = body.branches ?? [];
  if (!names.length) throw new ActionError(`Pick at least one branch to delete on ${remote}.`);
  if (!main || !p.main.remoteMain) throw new ActionError(`There's no ${ref(p)} to check these branches against.`);
  const seen = new Map(p.remoteBranches.map((b) => [b.name, b]));
  await fetchSafely(p);
  const base = await gitRun(p.path, ["rev-parse", `refs/remotes/${truth}/${main}`]);
  const fresh = await githubMeta({ ...(await remotesOf(p.path)), push: remote });
  const meta = fresh.ok ? fresh : null;
  const prs = meta?.prs ?? [];
  const doomed: [string, string][] = [];
  for (const name of names) {
    const b = seen.get(name);
    if (!b) throw new ActionError(`${name} isn't one of the merged branches on ${remote}, so nothing was deleted.`);
    const why = keptReason(name, main, meta)
      ?? (prs.some((x) => x.own && x.head === name) ? "it has an open pull request" : null)
      ?? (!p.remotes.fork && prs.some((x) => x.base === name) ? "open pull requests are based on it" : null);
    if (why) throw new ActionError(`${name} was left alone: ${why.charAt(0).toLowerCase() + why.slice(1)}. Nothing was deleted.`);
    const tip = await git(p.path, "rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${name}`);
    if (!tip) continue;
    if (tip !== b.sha) throw new ActionError(`${name} changed on ${remote} since it was checked, so nothing was deleted. Look again.`);
    if (!(await inMain(p.path, tip, base))) throw new ActionError(`${name} has work that isn't in ${ref(p)}, so nothing was deleted.`);
    doomed.push([name, tip]);
  }
  if (!doomed.length) return { message: `Those branches were already gone from ${remote}`, output: "" };
  const outputs: string[] = [];
  for (const [name, tip] of doomed) {
    outputs.push(await gitRun(p.path, ["push", remote, `--force-with-lease=refs/heads/${name}:${tip}`, `:refs/heads/${name}`]));
  }
  return { message: `Deleted ${plural(doomed.length, "merged branch", "merged branches")} on ${remote}`, output: outputs.join("\n") };
}

/** Turn on GitHub's "Automatically delete head branches", so merged pull requests don't leave branches behind. */
async function autoDelete(p: Project): Promise<ActionResult> {
  if (p.github.autoDelete === null || !p.github.slug) throw new ActionError("GitHub can't tidy this repo's branches automatically.");
  await ghRun(p, ["api", "-X", "PATCH", `repos/${p.github.slug}`, "-F", "delete_branch_on_merge=true", "--jq", ".delete_branch_on_merge"]);
  return { message: "GitHub will now delete each pull request's branch once it's merged", output: "" };
}

/** Stop branches tracking main, so a plain git push from them can't update main. */
async function unsetUpstream(p: Project, body: ActionBody): Promise<ActionResult> {
  const names = body.branches ?? [];
  if (!names.length) throw new ActionError("Pick at least one branch.");
  for (const name of names) {
    branch(p, name);
    const upstream = (await git(p.path, "for-each-ref", "--format=%(upstream)", `refs/heads/${name}`)) ?? "";
    if (upstream.split("/").slice(3).join("/") !== p.main.name) throw new ActionError(`${name} doesn't track ${ref(p)} any more, so nothing was changed.`);
  }
  for (const name of names) await gitRun(p.path, ["branch", "--unset-upstream", name]);
  return { message: `Unset upstream on ${plural(names.length, "branch", "branches")}`, output: "" };
}

/** Turn a shallow or single-branch clone into a full one, so every check can see everything. */
async function fetchAll(p: Project): Promise<ActionResult> {
  const [truth, remote] = remotes(p);
  const outputs: string[] = [];
  for (const name of unique([truth, remote])) {
    const specs = (await git(p.path, "config", "--get-all", `remote.${name}.fetch`)) ?? "";
    if (!specs.includes("refs/heads/*")) {
      await gitRun(p.path, ["config", "--replace-all", `remote.${name}.fetch`, `+refs/heads/*:refs/remotes/${name}/*`]);
      outputs.push(`${name} now fetches every branch`);
    }
  }
  if ((await git(p.path, "rev-parse", "--is-shallow-repository")) === "true") outputs.push(await gitRun(p.path, ["fetch", "--unshallow", truth], 900_000));
  outputs.push(await fetchSafely(p, 300_000));
  return { message: "Fetched the full repository", output: outputs.filter(Boolean).join("\n") };
}

async function removeWorktree(p: Project, body: ActionBody): Promise<ActionResult> {
  const path = body.path ?? "";
  const checkout = p.checkouts.find((c) => c.path === path && !c.primary);
  if (!checkout || checkout.missing) throw new ActionError("That worktree isn't part of this repo any more.");
  if (await git(path, "status", "--porcelain", "--untracked-files=normal")) throw new ActionError("That worktree has uncommitted or untracked files, so it was left alone.");
  // git worktree remove deletes ignored files without asking, and a .env.local may exist nowhere else.
  const keep = await ignoredKeep(path);
  if (keep === null) throw new ActionError("git couldn't list the ignored files in that worktree, so it was left alone.");
  if (keep.length) {
    throw new ActionError(`That worktree has ignored files that only live there (${keep.slice(0, 3).join(", ")}${keep.length > 3 ? ", …" : ""}). ` +
      "Removing it would delete them, so it was left alone. Move anything you need out first.");
  }
  if (!checkout.branch) {
    const head = (await git(path, "rev-parse", "HEAD")) ?? "";
    if (!head || !(await git(p.path, "branch", "--all", "--contains", head))) {
      throw new ActionError("That worktree has commits that aren't on any branch, so it was left alone. Ask your AI assistant to rescue them.");
    }
  }
  const out = await gitRun(p.path, ["worktree", "remove", path]);
  return { message: `Removed the worktree at ${tilde(path)}`, output: out };
}

async function pruneWorktrees(p: Project): Promise<ActionResult> {
  const missing = p.checkouts.filter((c) => c.missing && !c.locked);
  // git prunes a worktree it can't read as if it were gone, though the folder and its work are still there.
  const unreadable = p.checkouts.find((c) => !c.primary && !c.missing && !c.locked && c.unreadable);
  if (unreadable) {
    throw new ActionError(`git can't read the worktree at ${tilde(unreadable.path)}, and pruning would make it forget a folder that still exists. ` +
      "Fix its permissions first. Nothing was pruned.");
  }
  const unplugged = missing.find((c) => onMissingDrive(c.path));
  if (unplugged) {
    throw new ActionError(`The worktree at ${tilde(unplugged.path)} is on a drive that isn't connected, so git only thinks it's gone. ` +
      "Connect the drive first. Nothing was pruned.");
  }
  for (const c of missing) {
    if (c.head && (await count(p.path, c.head, "--not", "--branches", "--remotes", "--tags"))) {
      throw new ActionError(`The worktree at ${tilde(c.path)} had commits on no branch. Push first, which saves them to a branch. Nothing was pruned.`);
    }
  }
  return { message: "Pruned worktrees whose folders are gone", output: await gitRun(p.path, ["worktree", "prune", "--verbose"]) };
}

/** Bring back branches deleted on the remote while they held unmerged work, as local branches. */
async function restorePruned(p: Project, body: ActionBody): Promise<ActionResult> {
  const names = body.branches ?? [];
  if (!names.length) throw new ActionError("Pick at least one branch to restore.");
  const restored: string[] = [];
  for (const name of names) {
    const kept = p.pruned.find((b) => b.name === name);
    if (!kept) throw new ActionError(`Housekeep isn't keeping a branch called ${name}.`);
    const sha = await git(p.path, "rev-parse", "--verify", "--quiet", kept.ref);
    if (!sha) continue;
    // origin/feature becomes feature, unless a branch of that name already exists.
    let local = name.split("/").slice(1).join("/") || name;
    if (await gitOk(p.path, "rev-parse", "--verify", "--quiet", `refs/heads/${local}`)) local += "-restored";
    if (await gitOk(p.path, "rev-parse", "--verify", "--quiet", `refs/heads/${local}`)) local += `-${Date.now()}`;
    await gitRun(p.path, ["branch", local, sha]);
    await gitRun(p.path, ["update-ref", "-d", kept.ref, sha]);
    restored.push(local);
  }
  return { message: `Restored ${plural(restored.length, "branch", "branches")}: ${restored.join(", ")}`, output: "" };
}

// Opening a folder in another app. Only the project's own working trees can be opened.
const MAC = process.platform === "darwin";
const MAC_APPS: Record<string, string> = { vscode: "/Applications/Visual Studio Code.app", cursor: "/Applications/Cursor.app" };

export const OPENERS: Record<string, { label: string; command: (path: string) => [string, string[]] | null }> = {
  files: { label: MAC ? "Finder" : "Files", command: (path) =>
    MAC ? ["open", [path]] : process.platform === "win32" ? ["explorer", [path]] : ["xdg-open", [path]] },
  terminal: { label: "Terminal", command: (path) => (MAC ? ["open", ["-a", "Terminal", path]] : null) },
  vscode: { label: "VS Code", command: (path) => (MAC ? ["open", ["-a", "Visual Studio Code", path]] : ["code", [path]]) },
  cursor: { label: "Cursor", command: (path) => (MAC ? ["open", ["-a", "Cursor", path]] : ["cursor", [path]]) },
};

async function openIn(p: Project, body: ActionBody): Promise<ActionResult> {
  const path = body.path ?? p.path;
  if (path !== p.path && !p.checkouts.some((c) => c.path === path && !c.missing)) throw new ActionError("That folder isn't part of this repo.");
  const opener = OPENERS[body.app ?? ""];
  const command = opener?.command(path);
  if (!opener || !command) throw new ActionError("That app isn't available here.");
  spawn(command[0], command[1], { env: ENV, detached: true, stdio: "ignore" }).unref();
  return { message: `Opened in ${opener.label}`, output: "" };
}

type Handler = (p: Project, body: ActionBody) => Promise<ActionResult>;

/** Each action, whether to re-check the project afterwards, and whether that re-check should also ask the remote. */
export const ACTIONS: Record<string, { run: Handler; rescan: boolean; refetch: boolean }> = {
  "fetch": { run: fetchRemotes, rescan: true, refetch: false },
  "pull": { run: pull, rescan: true, refetch: false },
  "push": { run: push, rescan: true, refetch: false },
  "push-all": { run: pushAll, rescan: true, refetch: false },
  "open-pr": { run: openPr, rescan: true, refetch: true },
  "merge": { run: merge, rescan: true, refetch: false },
  "delete-merged": { run: deleteMerged, rescan: true, refetch: false },
  "delete-remote": { run: deleteRemote, rescan: true, refetch: false },
  "auto-delete": { run: autoDelete, rescan: true, refetch: true },
  "unset-upstream": { run: unsetUpstream, rescan: true, refetch: false },
  "fetch-all": { run: fetchAll, rescan: true, refetch: true },
  "remove-worktree": { run: removeWorktree, rescan: true, refetch: false },
  "prune-worktrees": { run: pruneWorktrees, rescan: true, refetch: false },
  "restore-pruned": { run: restorePruned, rescan: true, refetch: false },
  "open": { run: openIn, rescan: false, refetch: false },
};

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

/**
 * What to fix, as a person would put it. Git's facts become items in three lanes (what could be lost,
 * what needs a look, what's safe to clear), each with a short step and a full request for an AI assistant.
 * The dashboard and the Mac app let you tick items and copy one request for all of them.
 */

import type { Branch, Item } from "./model.js";
import { capFirst, plural, tilde } from "./proc.js";
import type { Draft } from "./scan.js";

const CONVENTIONAL = /^(?:feat|fix|chore|refactor|perf|docs|style|test|build|ci|revert|wip)(?:\([^)]*\))?!?:\s*/i;
const GENERIC = /^(?:wip|work in progress|fix|fixes|update|updates|changes|misc|tmp|temp|test)\.?$/i;

/** A branch's work as a person would name it: its last commit's subject, else its name made readable. */
export function workName(b: Pick<Branch, "name" | "subject">): string {
  const subject = (b.subject ?? "").replace(CONVENTIONAL, "").replace(/\s*\(#\d+\)$/, "").trim();
  if (subject.length >= 4 && !GENERIC.test(subject)) return capFirst(subject.length > 64 ? `${subject.slice(0, 61).trimEnd()}…` : subject);
  const last = b.name.split("/").pop() ?? b.name;
  const words = last.replace(/[-_]\d{6,8}$/, "").replace(/[-_]+/g, " ").trim();
  return capFirst(words || b.name);
}

const one = (n: number, a: string, b: string): string => (n === 1 ? a : b);

export function itemsFor(p: Draft): Item[] {
  const at = `In ${p.path},`;
  const remote = p.remotes.push ?? "origin";
  const host = p.host ?? "the remote";
  const m = p.main;
  const main = m.name || "main";
  const ref = m.remoteRef ?? `${p.remotes.truth ?? remote}/${main}`;
  const mac: Item[] = [], check: Item[] = [], tidy: Item[] = [];

  // --- Only on this Mac: lost if the computer is ---------------------------------
  for (const s of p.committedSecrets) {
    mac.push({ id: `secret:${s.path}`, lane: "mac", title: `Secret file committed: ${s.path}`,
      why: s.pushed ? `It's on ${host}, so anyone with access can read it. Change the keys first if they're real.` : "It's in git's history. Take it out before you push.",
      where: s.path, step: `Check ${s.path} for real keys and take it out of git, without rewriting history`,
      ask: `${at} the file ${s.path} was committed${s.pushed ? ` and pushed to ${remote}` : ""}, and it looks like it holds secrets. ` +
        "Check whether the keys in it are real. If they are, tell me which services I need to change them on. Then take the file out of git " +
        "without deleting it from my computer, and make git ignore it from now on. Don't rewrite history or force-push without asking me first." });
  }
  const loose = [...new Set(p.checkouts.flatMap((c) => c.secrets))];
  for (const secret of loose) {
    mac.push({ id: `secret-file:${secret}`, lane: "mac", title: `Possible secret: ${secret}`,
      why: "It looks like a password or key file, and git isn't ignoring it.", where: secret,
      step: `Check ${secret} and make git ignore it if it holds real keys`,
      ask: `${at} check whether ${secret} contains real secrets (API keys, passwords, tokens). If it only has placeholders, tell me and leave it. ` +
        "If it has real secrets, make git ignore it and check it was never committed. Tell me what you found before changing anything, and don't push." });
  }
  if (!p.fetch.hasRemote) {
    mac.push({ id: "no-remote", lane: "mac", title: "The whole project",
      why: "It isn't on GitHub or any other server, so it exists only on this computer.", where: p.displayPath,
      step: "Put it on a new private GitHub repository, asking before creating anything",
      ask: `The git repo in ${p.path} has no remote. Walk me through creating a private GitHub repository for it and pushing it there, step by step. Ask before creating anything.` });
  }
  if (p.remotes.sameDisk) {
    mac.push({ id: "same-disk", lane: "mac", title: "Pushed only to this disk",
      why: `${remote} is a folder on the same disk, so it's no backup if this computer is lost.`, where: tilde(p.remotes.localPath ?? ""),
      step: "Add a private GitHub repository and push everything there",
      ask: `${at} the remote ${remote} is a folder on the same disk (${p.remotes.localPath ?? ""}), so it isn't a real backup. ` +
        "Walk me through adding a private GitHub repository as a second remote and pushing everything there. Ask before creating anything." });
  }
  for (const b of p.pruned) {
    const name = b.name.split("/").slice(1).join("/") || b.name;
    mac.push({ id: `pruned:${b.name}`, lane: "mac", title: `Deleted branch ${name}`,
      why: `Deleted on ${remote} while holding ${plural(b.commits, "commit")} that aren't in ${ref}. Git will throw them away eventually.`,
      where: name, step: `Bring ${name} back as a branch and tell you what's on it`,
      ask: `${at} the branch ${name} was deleted on ${remote} while still holding work that isn't in ${ref}; its last commit was ${b.sha}. ` +
        `Bring it back as a local branch with the same name (add "-restored" if the name is taken), then tell me what's on it and whether that work already landed somewhere else. Don't push or delete anything without asking.` });
  }
  if (m.localOnly && p.fetch.hasRemote) { // with no remote at all, "the whole project" already covers it
    mac.push({ id: "main-commits", lane: "mac", title: `${plural(m.localOnly, "commit")} on ${main}`,
      why: `Committed straight to ${main}, and not on ${host}.`, where: main,
      step: `Move them to a branch of their own and push it, not ${main}`,
      ask: `${at} ${main} has ${plural(m.localOnly, "commit")} that exist only on this computer. Put them on a branch of their own and push that, not ${main}, ` +
        `because pushing ${main} can put the site live. Then tell me the right way to get them into ${ref}, usually a pull request. Don't force-push.` });
  }
  for (const b of p.branches.filter((x) => x.state === "unpushed")) {
    mac.push({ id: `push:${b.name}`, lane: "mac", title: workName(b),
      why: `${plural(b.localOnly, "commit")}, never pushed`, where: b.name, step: `Push ${b.name}`,
      ask: `${at} push the branch ${b.name} to ${remote}: it has ${plural(b.localOnly, "commit")} that ${one(b.localOnly, "exists", "exist")} only on this computer. Don't push ${main} or anything else, and don't force-push.` });
  }
  for (const c of p.checkouts.filter((x) => x.detachedCommits)) {
    mac.push({ id: `detached:${c.path}`, lane: "mac", title: `${plural(c.detachedCommits, "commit")} on no branch`,
      why: "They'll be lost the moment this folder switches to another branch.", where: c.primary ? "main folder" : tilde(c.path),
      step: "Give them a branch and push it",
      ask: `${at} the ${c.primary ? "main working tree" : `worktree at ${c.path}`} has ${plural(c.detachedCommits, "commit")} on a detached HEAD, on no branch. ` +
        `Give them a branch with a clear name and push it to ${remote}. Don't change ${ref}, and don't force-push.` });
  }
  for (const c of p.checkouts.filter((x) => !x.missing && x.changed + x.untracked > 0)) {
    const n = c.changed + c.untracked;
    const where = c.primary ? "main folder" : tilde(c.path);
    mac.push({ id: `changes:${c.path}`, lane: "mac", title: `${plural(n, "change")}${c.primary ? "" : ` in ${c.label}`}`,
      why: c.temporary ? "Never committed, in a temporary folder the system empties on its own." : "Edited, never committed",
      where, step: `Commit the ${plural(n, "change")} on a new branch and push it`,
      ask: `${at} there ${one(n, "is", "are")} ${plural(n, "uncommitted change")} in ${c.primary ? "the main working tree" : c.path}. Look at what changed, ` +
        `group it into sensible commits on a new branch (not ${main}), and push that branch to ${remote} so the work is backed up. ` +
        "Leave out anything that looks like a secret or a build artefact, and show me the plan before committing." });
  }
  if (p.stashes.length) {
    const n = p.stashes.length;
    mac.push({ id: "stashes", lane: "mac", title: plural(n, "stash", "stashes"), why: "Changes set aside and easy to forget", where: "git stash",
      step: `Show you what's in ${one(n, "the stash", "each stash")} and ask what to keep`,
      ask: `${at} there ${one(n, "is", "are")} ${plural(n, "stash", "stashes")}. For each, tell me in plain English what it contains and whether it's already committed. Recommend apply or drop, and don't drop anything without asking.` });
  }

  // --- Needs a check: nothing lost yet ----------------------------------------------
  const op = p.checkouts.find((c) => c.operation)?.operation;
  if (op) {
    check.push({ id: "operation", lane: "check", title: capFirst(op), why: "Until it's finished or aborted, git won't behave normally here.", where: "main folder",
      step: `Explain the ${op.toLowerCase()} and finish or abort it safely`,
      ask: `${at} git has a ${op.toLowerCase()}. Explain what's going on and how to finish or abort it safely. Don't discard any work without asking.` });
  }
  if (p.checkouts.some((c) => c.unreadable) || p.unpushed === null) {
    check.push({ id: "unreadable", lane: "check", title: "Git can't read part of this repo", why: "A git command failed or took too long, so Housekeep can't tell if your work is safe.",
      where: p.displayPath, step: "Find out why git is failing here",
      ask: `${at} git is failing or very slow (checking the status, or comparing branches with the remote). Find out why ` +
        "(a huge folder that should be ignored, a broken index, permissions, a corrupt object) and tell me how to fix it. Don't change or delete files without asking." });
  }
  if (m.name && m.remoteMain && m.local && m.ahead && m.behind) {
    check.push({ id: "main", lane: "check", title: `${main} has split from ${host}'s`, why: `Each side has commits the other doesn't: ${m.ahead} here, ${m.behind} there.`,
      where: `${main} ⇄ ${ref}`, step: `Explain both sides and ask how to bring ${main} back together`,
      ask: `${at} ${main} and ${ref} have gone different ways: ${plural(m.ahead, "commit")} only here and ${plural(m.behind, "commit")} only there. ` +
        "Explain what's on each side in plain English and suggest the safest way to bring them back together. Don't push, force-push or delete anything without asking." });
  } else if (m.name && m.remoteMain && m.local && m.behind) {
    check.push({ id: "main", lane: "check", title: `Update ${main}`, why: `${host} has ${plural(m.behind, "commit")} this computer doesn't. Nothing is lost.`,
      where: `${main} ← ${ref}`, step: `Update ${main} from ${host}, only by adding the new commits`,
      ask: `${at} bring ${main} up to date with ${ref}, only by adding the new commits on top (a fast-forward). If that isn't possible, explain why and stop.` });
  }
  if (m.checks?.state === "failing") {
    const names = m.checks.failed;
    check.push({ id: "checks", lane: "check", title: `Checks are failing on ${ref}`,
      why: `${names.slice(0, 2).join(", ")}${names.length > 2 ? ` and ${names.length - 2} more` : ""} failed on the latest commit, so ${ref} can't be trusted yet.`,
      where: ref, step: `Find out why ${ref}'s checks fail and tell you`,
      ask: `${at} the checks on the latest commit of ${ref} are failing: ${names.join(", ")}. Find out why, for example with gh run list and gh run view, ` +
        "and tell me what it would take to fix them. If they didn't start at all, check whether GitHub Actions is blocked, for example by billing. Don't change code yet." });
  }
  for (const b of p.branches.filter((x) => x.upstreamGone && !x.merged && x.state !== "unpushed")) {
    check.push({ id: `lookup:${b.name}`, lane: "check", title: workName(b),
      why: `Deleted on ${remote}, and its ${plural(b.aheadOfMain, "commit")} aren't in ${ref}. Your assistant will look and tell you.`,
      where: b.name, step: `Look at ${b.name} and report back`,
      ask: `${at} the branch ${b.name} was deleted on ${remote}, but it has ${plural(b.aheadOfMain, "commit")} whose changes aren't in ${ref}. Tell me what that work is and whether it's still needed. Don't delete anything without asking.` });
  }
  for (const b of p.branches.filter((x) => x.pushesToMain && x.state !== "unpushed")) {
    check.push({ id: `upstream:${b.name}`, lane: "check", title: `${b.name} pushes straight to ${ref}`,
      why: `A plain git push from it would change ${ref} directly.`, where: b.name, step: `Stop ${b.name} pushing to ${ref}`,
      ask: `${at} ${b.name} is set up so that a plain push would change ${ref} directly. Stop it tracking ${ref}, so it pushes to a branch of its own. Don't push anything.` });
  }
  if (p.limits.shallow || p.limits.singleBranch) {
    const what = p.limits.shallow ? "the full history" : "all branches";
    check.push({ id: "clone", lane: "check", title: `This copy is missing ${what}`, why: `It's a ${p.limits.shallow ? "shallow" : "single-branch"} clone, so it can't be fully compared with ${host}.`,
      where: p.displayPath, step: `Fetch ${what}`,
      ask: `${at} the clone is ${p.limits.shallow ? "shallow" : "single-branch"}, so it's missing part of the project. Fetch every branch${p.limits.shallow ? " and the whole history" : ""}, without changing any of my branches or files.` });
  }

  // --- Tidy up: already in main, safe to clear ----------------------------------------
  const local = p.branches.filter((b) => b.state === "merged" && !b.current && !b.worktree);
  const onRemote = p.remoteBranches.filter((b) => b.deletable);
  const names = new Set([...local.map((b) => b.name), ...onRemote.map((b) => b.name)]);
  if (names.size) {
    const parts = [
      local.length ? `Delete the local ${one(local.length, "branch", "branches")} ${local.map((b) => b.name).join(", ")}. Before deleting, check each one again: every change on it should already be in ${ref}. ` +
        "Some were squash-merged or merged through a pull request, so compare the changes, not the commits." : "",
      onRemote.length ? `Delete ${one(onRemote.length, "the branch", "the branches")} ${onRemote.map((b) => b.name).join(", ")} on ${remote}, after asking me. Fetch first and check again, and skip any that has new commits ` +
        `(${onRemote.map((b) => `${b.name} should still be at ${b.sha.slice(0, 7)}`).join(", ")}), is protected, or has an open pull request.` : "",
    ].filter(Boolean);
    tidy.push({ id: "merged", lane: "tidy", title: plural(names.size, "finished branch", "finished branches"), why: "Their work is already in main",
      where: [local.length ? `${local.length} here` : "", onRemote.length ? `${onRemote.length} on ${host}` : ""].filter(Boolean).join(" · "),
      step: `Delete the ${plural(names.size, "finished branch", "finished branches")}${onRemote.length ? `, asking before ${host}` : ""}`,
      ask: `${at} some branches are already in ${ref} and can be cleaned up. ${parts.join(" ")} Don't touch ${main}, and don't force-push.` });
  }
  const byName = new Map(p.branches.map((b) => [b.name, b]));
  const gone = p.checkouts.filter((c) => c.missing && !c.offline && !c.locked);
  const idle = p.checkouts.filter((c) => !c.primary && !c.missing && !c.unreadable && !c.operation && c.changed + c.untracked === 0
    && !c.ignoredKeep.length && !c.detachedCommits && (c.branch === null || byName.get(c.branch)?.state === "merged"));
  if (gone.length + idle.length) {
    const n = gone.length + idle.length;
    tidy.push({ id: "folders", lane: "tidy", title: plural(n, "extra folder"), why: gone.length && !idle.length ? "Deleted folders git still lists" : "Worktrees with nothing that isn't already in main",
      where: plural(n, "worktree"), step: `Remove the ${plural(n, "extra folder")}`,
      ask: `${at} clean up these worktrees: ${[...idle.map((c) => c.path), ...gone.map((c) => `${c.path} (folder already deleted)`)].join(", ")}. ` +
        "First check each has no uncommitted or new files, no files git ignores that are worth keeping (like .env.local), and no commits that aren't on a branch; " +
        "for deleted folders, make sure they're really gone and not on a drive that isn't plugged in. Don't touch the main working tree." });
  }
  return [...mac, ...check, ...tidy];
}

/** Worth knowing, nothing to do: work that's safe on the remote, waiting for a pull request. */
export function notesFor(p: Draft): string[] {
  const host = p.host ?? "the remote";
  const waiting = p.branches.filter((b) => b.state === "unmerged" && b.onRemote && !b.pr && !b.upstreamGone && !b.pushesToMain).map((b) => b.name);
  const withPr = p.branches.filter((b) => b.state === "unmerged" && b.pr).map((b) => `#${b.pr?.number}`);
  return [
    waiting.length ? `On ${host}, waiting for a pull request: ${waiting.slice(0, 3).join(", ")}${waiting.length > 3 ? ` and ${waiting.length - 3} more` : ""}. They're safe.` : "",
    withPr.length ? `Open pull ${one(withPr.length, "request", "requests")} ${withPr.join(", ")}: safe on ${host}, nothing to do here.` : "",
  ].filter(Boolean);
}

/** One request for every item, in order, with the backup and the checks it needs first. */
export function combinedRequest(path: string, items: Item[]): string {
  if (!items.length) return "";
  const prefix = `In ${path}, `;
  const steps = items.map((it, i) => `${i + 1}. ${capFirst(it.ask.startsWith(prefix) ? it.ask.slice(prefix.length) : it.ask)}`);
  return `In ${path}, please do the following, in this order.\n\n` +
    "Before changing anything, back up: save a git bundle of every branch and a patch of any uncommitted changes, outside the repo, and tell me where they are. " +
    "Ask me before pushing to main, deleting anything on the remote, or force-pushing.\n\n" +
    `${steps.join("\n\n")}\n\nWhen you're done, tell me what you did and anything you left alone.`;
}

---
name: housekeep
description: Plain-language check of whether git work is safe and tidy, using the Housekeep tool — committed, pushed, local main up to date with origin/main, and no merged branches or stale worktrees left behind — for the current repo or every repo worked on recently. Use when the user asks "am I clean", "is my work saved", "what's dirty", "what needs committing", "did I push everything", "is main up to date", "clean up my branches", "don't lose my progress", "housekeep", or "check status"; when switching branches or worktrees; and before a deploy, release, a long break, or telling the user a task is done. Reports what's at risk in git's own terms with plain-English explanations, gives the single next step, and asks before changing anything.
---

# Housekeep

Housekeep checks every repo against one target: **everything committed and pushed, local `main` up to date with `origin/main` (the source of truth), and nothing merged or stale left lying around.** It only reads; it never changes a repo. Your job: run it, explain the result in plain language, and only with the user's OK, walk them to that target.

## Run it

This repo (or the repo containing a path):

```sh
npx -y git-housekeep . --json
```

Every repo the user has worked on recently:

```sh
npx -y git-housekeep --json
```

If the user installed it (`npm install -g git-housekeep`), `housekeep` works in place of `npx -y git-housekeep`.

- **Before any cleanup** (deleting branches, syncing main), add `--fetch` so "merged" and "up to date" are judged against the remote as it is now, not the last fetch. Deleting a branch because it looked merged against stale refs is how work gets lost.
- **Exit code:** `0` all clear, `1` needs attention, `2` could lose work, `3` couldn't check.

## Reading the result

Each project in `projects` has:

- `tier`: `at-risk` (work could be lost), `attention`, or `safe`.
- `signals`: the four checks, each with git's term as `label`, a `headline` and a plain-English `hint`:
  - **Working tree**: uncommitted changes, stashes, a merge or rebase in progress, secret-looking files (committed or not), or work in a temporary folder.
  - **Push**: unpushed commits, including commits on a detached HEAD, and work on a branch deleted on the remote (see `pruned`). "Pushed, but only to this disk" means the remote is a folder on the same disk, which is no backup.
  - **Sync**: local `main` ahead of, behind, or diverged from `origin/main`.
  - **Cleanup**: merged branches (squash merges included), locally and on the remote, and stale worktrees.
- `next`: the single most important step, with `title`, `why` and `ask`. `ask` is a request written for you, in plain words, with the checks the change needs. Treat it as the user's request, and confirm with them before acting on it.
- `requests`: every other request, one per thing that needs something (`about` is `branch`, `remote`, `main`, `worktree`, or a group like `merged`), each with a short `does` and a full `ask`. Use these when the user wants more than the next step.
- `pruned`: branches deleted on the remote while holding work that isn't in `main`, each with the commit it pointed at, so the work can be brought back while git still has it.

The `branches`, `remoteBranches` and `checkouts` arrays hold the detail when you need it.

When the report says it **couldn't check** something, say so. Never present "couldn't check" as clean.

## How to report

- Lead with the verdict in one line, then one line per project that needs attention, worst first.
- Use git's terms (unpushed, merged, upstream, worktree, detached HEAD) and explain each in plain words the first time.
- Separate fact from advice. "git shows main is 2 behind origin/main" is a fact; "pull before you start new work" is advice.
- End with the next step, and ask before doing it.

## Walking to clean

Do one project, and one logical group of changes, at a time. Follow the request's checks before you change anything, and run Housekeep again after each change to confirm it landed.

1. **Could lose work comes first.** Unpushed commits, committed secrets, work in temporary folders, work on deleted branches.
2. **Needs the user's OK every time:** pushes, merges, opening pull requests, deleting branches (locally or on the remote), removing worktrees, committing or stashing files.

**Never:**
- force-push, hard-reset, or drop a stash
- push `main` directly, or merge into it when the project uses pull requests
- delete a branch Housekeep doesn't show as merged
- remove a worktree that has uncommitted changes or ignored files only it holds (`ignoredKeep`, e.g. `.env.local`)
- resolve a diverged `main` without the user saying how

A committed or pushed secret means changing the keys first. Say so plainly; don't rewrite history without asking.

End by confirming the target out loud: everything committed and pushed, `main` up to date with `origin/main`, nothing merged or stale left.

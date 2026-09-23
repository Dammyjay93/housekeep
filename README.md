<img src="assets/logo.svg" width="56" height="56" alt="">

# Housekeep

Is your git work committed, pushed, in sync with main, and cleaned up? One command tells you, for every repo you've worked on recently, in git's own words with a plain-English explanation of each. A live visual map shows why, and fixes what's safe to fix.

```bash
npx git-housekeep
```

```
  housekeep  ·  5 repos  ·  fetched 4 min ago

  ● portfolio    Could lose work
    → Remove a committed secret: .env
      secret committed  ·  1 unpushed  ·  1 ahead of origin/main

  ● shop-app     Could lose work
    → Push 3 unpushed commits
      3 uncommitted  ·  3 unpushed  ·  1 merged branch on origin

  ● api          Needs attention
    → Pull main (fast-forward)
      4 behind origin/main  ·  2 merged branches (2 local, 2 on origin)

  ● mobile-app   Needs attention
    → Review 1 stash
      1 stashed  ·  1 prunable worktree (folder deleted)

  ✓ blog         All clear

  2 could lose work  ·  2 need attention  ·  1 all clear

  o open the map   q quit
```

Press `o` for the map: every repo's branches drawn like a transit map, with buttons for the fixes.

Try it without touching anything of yours: `npx git-housekeep --demo` shows the report for five made-up projects, and `npx git-housekeep open --demo` opens the map, where every button shows what it would do.

## The four checks

| Check | Clean when |
| --- | --- |
| **Working tree** | No uncommitted changes, stashes, half-finished merges or rebases, or password-looking files git isn't ignoring. |
| **Push** | No unpushed commits: everything is on the remote, so losing this computer loses nothing. |
| **Sync** | Your `main` is up to date with `origin/main`, the source of truth. |
| **Cleanup** | No merged branches left locally or on the remote, and no stale worktrees. |

Every term in the report and the map has a "?" beside it that explains it, so you learn the words git, GitHub and your AI assistant all use.

## Usage

`npx git-housekeep` runs it once. To keep it, `npm install -g git-housekeep` gives you the `housekeep` command (and `git housekeep`, since git runs any `git-*` command on your path).

```
housekeep               Check every repo you've worked on recently
housekeep <path>        Check one repo in detail (e.g. housekeep .)
housekeep serve         Run the live map in this terminal
housekeep open          Open the live map in your browser
housekeep install       macOS: keep the live map running from login, with a menu bar light (SwiftBar)
housekeep uninstall     macOS: undo housekeep install

--json                  The full result as JSON, for scripts and AI assistants
--fetch                 Fetch from every remote now, whatever the schedule
--offline               Don't touch the network
--port <n>              Port for the live map (default 47219)
--demo                  Try it on made-up projects: nothing on your computer is read or changed
```

Exit codes: `0` all clear, `1` needs attention, `2` could lose work, `3` couldn't check. So `npx git-housekeep . || echo "not clean"` works in scripts, and an AI assistant can run `npx git-housekeep . --json` before it says it's done.

Needs Node 20 or newer and git 2.25 or newer (2.38 or newer to recognise squash merges; older versions say so). It has no dependencies.

For GitHub repos, install and log in to the [GitHub CLI](https://cli.github.com) (`gh auth login`). Housekeep then also knows which branches are protected, which have open pull requests, a fork's parent and the real default branch, and it can open pull requests for you. Without it everything still works, but branches are judged by name alone, and the map says so.

## How it decides

- **The source of truth is `main` on the remote**, not your local copy. `main` is whatever the remote calls its default branch, so `master`, `trunk` and renamed defaults work.
- **In a fork**, `main` is compared with the project you forked from, while your branches and pushes go to your own copy.
- **A branch is merged when all of its changes are in `main`**, including squash and rebase merges. If merging it into `main` would change nothing, it's merged.
- **Some branches are never offered for deletion**, whatever they contain:
  - the default branch
  - protected branches
  - branches with an open pull request, or that pull requests are based on
  - long-lived names like `develop`, `staging`, `production`, `release/*` and `gh-pages`
- **When it can't see everything, it says so** instead of showing green: shallow clones, single-branch clones, unreachable remotes, and folders your operating system won't let it read (like `~/Documents` on macOS, until you allow your terminal).

## What it changes on its own

Housekeep reads your repos. Without you pressing anything, it does two things:

- **It fetches.** Every `fetchEveryMinutes` (default 10) it runs `git fetch --prune` for the remotes that matter, plus `git ls-remote` to learn the default branch.
  - That updates your remote-tracking branches and forgets ones deleted on the remote.
  - It runs without a terminal, so it can't stop to ask for an SSH passphrase. A hardware key or 1Password's SSH agent may still ask you to approve.
  - Use `--offline`, or set `fetchEveryMinutes` to `0`, to fetch only when you ask.
- **The squash-merge check writes temporary objects** into the repo. Nothing refers to them, and git's normal cleanup removes them.

Your files, branches, commits and settings only change when you press a button in the map. Nothing leaves your computer except git's own traffic with your remotes, and GitHub's API when `gh` is installed. There's no telemetry.

## The map's buttons

**Run straight away:** Pull (fast-forward only), Fetch, Prune worktrees, and Open in Finder, Terminal, VS Code or Cursor.

**Ask first, showing the exact command:**
- Push
- Open pull request (GitHub, needs `gh`)
- Delete merged branches, locally or on the remote
- Unset upstream on branches that would push into `main`
- Fetch all branches or the full history
- Let GitHub delete merged branches
- Remove worktree
- Under Advanced actions: Merge and Push main. Both skip pull request reviews and checks.

**Every button re-checks the repo right before it runs, and refuses when work could be lost:**
- A branch is only deleted if all of its changes are in `main` on the remote, and never while it's checked out.
- A branch on the remote is only deleted after a fresh fetch shows the same commit, and not if it's protected or has open pull requests. The delete uses `--force-with-lease`, so anything pushed in the meantime makes it fail rather than be lost.
- Unpushed commits on `main` are pushed to a separate `housekeep/backup-…` branch, never to `main` itself, because pushing `main` can put a site live.
- Nothing is ever force-pushed.

Anything that needs judgement gets a **Copy request** button: a plain-English request to paste into your AI coding assistant. That covers committing, stashes, possible secrets, and a diverged `main`.

The map only listens on `127.0.0.1`, and every request needs a token from the page it served, so other websites can't send it commands.

## Settings

`~/.config/housekeep/config.json`, created on first run:

- `roots`, `maxDepth`: where to look for repos (default your home folder, 4 levels deep).
- `activeDays`: watch repos you've committed to or switched branches in during this many days (default 45).
- `watch`: folders to always watch, however old. `ignore`: folders never to watch.
- `fetchEveryMinutes`: how often to fetch (default 10; `0` means only when you ask).
- `port`: where the map listens (default 47219; any free port if it's taken).

State (the last result, what the remotes said) lives in `~/.local/state/housekeep`.

## Fonts

The map uses [Geist](https://vercel.com/font) (SIL Open Font License, `assets/fonts/OFL-Geist.txt`). To use your own font, put its files in `~/.config/housekeep/fonts` with a `faces.json`:

```json
{ "faces": [{ "file": "Mine-Regular.otf", "weight": "400" }, { "file": "Mine-Medium.otf", "weight": "500" }], "labelLift": "0px" }
```

## Development

```bash
npm install
npm test
node dist/src/cli.js
```

The tests build throwaway repos, each with a local bare repo standing in for the remote.

The demo (`--demo`, and the website's live map) is built from scripted throwaway repos by the real scanner: `npm run demo:build` regenerates `assets/demo.json`.

The website is plain HTML in `site/`. `npm run site:build` adds the live demo page, the fonts, and the terminal report from the demo. On Cloudflare Pages, set the build command to `npm ci && npm run site:build` and the output folder to `site` (Node comes from `.nvmrc`).

## License

MIT

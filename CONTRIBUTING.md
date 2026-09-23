# Contributing

Thanks for helping. Housekeep has a few rules that every change follows, because people trust it with work they can't get back.

## The rules

1. **Only read.** Housekeep never changes a repo. The one exception is `git fetch`, which updates git's record of the remote. Every fix is a request for the person's AI assistant.
2. **Never lose work.** A request says what to check before anything changes: only delete what's provably in `main` on the remote, never force-push, never push `main`.
3. **Git's own words.** Say "unpushed commits", "origin/main", "worktree", not invented terms, and explain each one where it appears.
4. **No dependencies.** The CLI runs on Node's standard library and the `git` already installed. `gh` is optional.
5. **Say when you can't see.** If a check can't run, show "couldn't check", never green.

## Setup

```bash
npm install
```

```bash
npm test
```

The tests build throwaway repos, each with a local bare repo standing in for the remote, so they never touch yours. Add a test for any change to what Housekeep decides, or to what a request asks for.

To try your build without touching your own repos:

```bash
npm run build && node dist/src/cli.js --demo
```

```bash
node dist/src/cli.js open --demo
```

## Where things live

- `src/scan.ts` decides: what's committed, pushed, merged, safe to delete, and the next step.
- `src/open.ts` opens a project's folder in another app, the one thing the map does on your computer.
- `assets/dashboard.html` is the live map; `src/report.ts` the terminal report.
- `scripts/make-demo.ts` builds the demo repos; `npm run demo:build` regenerates `assets/demo.json` after a change to what the scanner reports.
- `site/` is the website; `npm run site:build` builds it.

## Code

TypeScript, strict. No `any`, no `console.log`, no empty `catch`. Match the code around yours, and keep comments to the why.

## Pull requests

Keep each one to one change, say what it fixes or adds in plain words, and make sure `npm test` passes. For a change to a request, say what your assistant should check before acting on it.

## Security

Anything that could change a repo, lose work, or let something other than the person use the map: see [SECURITY.md](SECURITY.md) and report it privately.

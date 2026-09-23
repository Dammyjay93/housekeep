# Contributing

Thanks for helping. Housekeep has a few rules that every change follows, because people trust it with work they can't get back.

## The rules

1. **Never lose work.** A button refuses rather than guesses. Before anything changes, it checks again, and it only deletes what's provably in `main` on the remote. Nothing is ever force-pushed.
2. **Ask first.** Nothing changes a repo until the person presses a button, and the button shows the exact git command.
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

The tests build throwaway repos, each with a local bare repo standing in for the remote, so they never touch yours. Add a test for any change to what Housekeep decides or does, including the case where it should refuse.

To try your build without touching your own repos:

```bash
npm run build && node dist/src/cli.js --demo
```

```bash
node dist/src/cli.js open --demo
```

## Where things live

- `src/scan.ts` decides: what's committed, pushed, merged, safe to delete, and the next step.
- `src/actions.ts` changes things, each action re-checking before it runs.
- `assets/dashboard.html` is the live map; `src/report.ts` the terminal report.
- `scripts/make-demo.ts` builds the demo repos; `npm run demo:build` regenerates `assets/demo.json` after a change to what the scanner reports.
- `site/` is the website; `npm run site:build` builds it.

## Code

TypeScript, strict. No `any`, no `console.log`, no empty `catch`. Match the code around yours, and keep comments to the why.

## Pull requests

Keep each one to one change, say what it fixes or adds in plain words, and make sure `npm test` passes. For a change to what a button does, describe the case it refuses.

## Security

Anything that could lose work or let something other than the person trigger a change: see [SECURITY.md](SECURITY.md) and report it privately.

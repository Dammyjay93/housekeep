# Security

Housekeep reads your repos, and when you press a button it changes them: it pushes, pulls, and deletes branches and worktrees. A bug that loses work, or lets something other than you trigger a change, is a security bug. Please report it privately.

## Reporting a problem

Use [GitHub's private vulnerability reporting](https://github.com/Dammyjay93/housekeep/security/advisories/new). Please don't open a public issue for anything below. Include what you ran, what you expected, and what happened; a throwaway repo that reproduces it is ideal.

You'll get a reply within a week. Fixes for work-loss bugs are released as soon as they're ready.

## What counts

- Work lost: a button deleting, overwriting or force-pushing anything whose changes aren't in `main` on the remote, or anything Housekeep said it would keep.
- A change without your say-so: anything that modifies a repo without you pressing a button, beyond the fetches and temporary objects the README describes.
- The live map: another website or local program getting it to act. It listens only on `127.0.0.1` and every request needs a token from the page it served.
- Secrets: Housekeep printing, storing or sending a secret it found, or a credential from a remote URL showing up in its output.
- Its files: the state it keeps in `~/.local/state/housekeep` and `~/.config/housekeep` being readable by other users.

## What doesn't

- Git's own behaviour, your remote's, or GitHub's.
- A secret Housekeep failed to notice. It looks for common names like `.env`; it isn't a secret scanner.

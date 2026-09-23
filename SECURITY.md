# Security

Housekeep only reads your repos. Every fix is a request you copy to your AI assistant, and those requests tell it what to check before it pushes or deletes anything. A bug that changes a repo, gives your assistant a request that could lose work, or lets something other than you use the map, is a security bug. Please report it privately.

## Reporting a problem

Use [GitHub's private vulnerability reporting](https://github.com/Dammyjay93/housekeep/security/advisories/new). Please don't open a public issue for anything below. Include what you ran, what you expected, and what happened; a throwaway repo that reproduces it is ideal.

You'll get a reply within a week. Fixes for anything that could lose work are released as soon as they're ready.

## What counts

- A change to a repo: anything Housekeep does beyond the fetches and temporary objects the README describes.
- A request that could lose work: one that would have your assistant delete, overwrite or force-push something whose changes aren't in `main` on the remote, or push `main`.
- The live map: another website or local program getting it to act. It listens only on `127.0.0.1` and every request to it needs a token from the page it served.
- Secrets: Housekeep printing, storing or sending a secret it found, or a credential from a remote URL showing up in its output.
- Its files: the state it keeps in `~/.local/state/housekeep` and `~/.config/housekeep` being readable by other users.

## What doesn't

- Git's own behaviour, your remote's, or GitHub's.
- A secret Housekeep failed to notice. It looks for common names like `.env`; it isn't a secret scanner.

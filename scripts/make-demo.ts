/**
 * Builds assets/demo.json: what Housekeep says about five made-up projects. The projects are real
 * throwaway repos, checked by the real scanner, so the demo shows exactly what Housekeep would show.
 *
 * Run with: npm run demo:build
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { devNull, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
// Not the system's temp folder: Housekeep would rightly flag every repo as living somewhere temporary.
const work = join(repoRoot, ".demo-build");
const code = join(work, "code");
const remotes = join(work, "remotes");
rmSync(work, { recursive: true, force: true });
mkdirSync(code, { recursive: true });
mkdirSync(remotes, { recursive: true });

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "You", GIT_AUTHOR_EMAIL: "you@example.com",
  GIT_COMMITTER_NAME: "You", GIT_COMMITTER_EMAIL: "you@example.com",
  HOUSEKEEP_CONFIG_DIR: join(work, "config"), HOUSEKEEP_STATE_DIR: join(work, "state"),
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Commit a file, dated some days ago, so "last commit" reads like real work. */
function commit(repo: string, file: string, daysAgo: number, message = `Update ${file}`): void {
  const path = join(repo, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${message}\n${Math.random()}\n`);
  const when = new Date(Date.now() - daysAgo * 86_400_000 - Math.floor(Math.random() * 7_200_000)).toISOString();
  git(repo, "add", file);
  execFileSync("git", ["-C", repo, "commit", "-qm", message], { env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
}

/** A project with a GitHub remote (a local bare repo underneath, renamed to look like GitHub once pushed). */
function project(name: string): { repo: string; remote: string } {
  const remote = join(remotes, `${name}.git`);
  const repo = join(code, name);
  git(work, "init", "-q", "--bare", "-b", "main", remote);
  git(work, "clone", "-q", remote, repo);
  git(repo, "switch", "-qc", "main");
  commit(repo, "README.md", 60, "First commit");
  commit(repo, "src/index.ts", 40, "Set up the app");
  git(repo, "push", "-q", "-u", "origin", "main");
  return { repo, remote };
}

const branch = (repo: string, name: string, files: [string, number][], push = true): void => {
  git(repo, "switch", "-qc", name, "main");
  for (const [f, d] of files) commit(repo, f, d);
  if (push) git(repo, "push", "-q", "-u", "origin", name);
  git(repo, "switch", "-q", "main");
};

const lookLikeGitHub = (repo: string, name: string): void => {
  git(repo, "remote", "set-url", "origin", `git@github.com:you/${name}.git`);
};

// shop-app: work only on this Mac, and leftovers on GitHub.
{
  const { repo } = project("shop-app");
  branch(repo, "fix/cart-total", [["src/cart.ts", 12]]);
  git(repo, "merge", "-q", "--no-ff", "fix/cart-total", "-m", "Merge fix/cart-total");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "branch", "-q", "-D", "fix/cart-total");
  branch(repo, "feat/checkout-redesign", [["src/checkout.tsx", 5]]);
  git(repo, "switch", "-q", "feat/checkout-redesign");
  commit(repo, "src/checkout.css", 1, "Style the new checkout");
  commit(repo, "src/payment.tsx", 0, "Add Apple Pay");
  commit(repo, "src/summary.tsx", 0, "Order summary");
  for (const f of ["src/checkout.tsx", "src/payment.tsx"]) writeFileSync(join(repo, f), "work in progress\n");
  writeFileSync(join(repo, "src/receipt.tsx"), "new file\n");
  lookLikeGitHub(repo, "shop-app");
}

// portfolio: a secret committed by accident.
{
  const { repo } = project("portfolio");
  writeFileSync(join(repo, ".env"), "RESEND_API_KEY=re_live_example\n");
  git(repo, "add", ".env");
  execFileSync("git", ["-C", repo, "commit", "-qm", "Add contact form"]);
  lookLikeGitHub(repo, "portfolio");
}

// api: behind GitHub, squash-merged branches, and an AI agent's worktree holding .env.local.
{
  const { repo, remote } = project("api");
  writeFileSync(join(repo, ".gitignore"), ".env.local\nnode_modules/\n");
  git(repo, "add", ".gitignore");
  execFileSync("git", ["-C", repo, "commit", "-qm", "Ignore local env"]);
  git(repo, "push", "-q", "origin", "main");
  branch(repo, "feat/rate-limit", [["src/limit.ts", 9], ["src/limit.test.ts", 8]]);
  branch(repo, "fix/auth-timeout", [["src/auth.ts", 6]]);
  branch(repo, "feat/webhooks", [["src/webhooks.ts", 2]]);
  // Someone else squash-merges two branches on GitHub and adds more to main.
  const teammate = join(work, "teammate-api");
  git(work, "clone", "-q", remote, teammate);
  for (const [b, title] of [["feat/rate-limit", "Rate-limit the public API (#11)"], ["fix/auth-timeout", "Fix auth timeout (#12)"]] as const) {
    git(teammate, "merge", "-q", "--squash", `origin/${b}`);
    execFileSync("git", ["-C", teammate, "commit", "-qm", title]);
  }
  commit(teammate, "src/health.ts", 1, "Health check");
  commit(teammate, "docs/api.md", 0, "Document the API");
  git(teammate, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "--prune");
  const agent = join(code, ".worktrees", "api-codex");
  git(repo, "worktree", "add", "-q", agent, "-b", "codex/add-logging");
  commit(agent, "src/log.ts", 0, "Structured logging");
  git(agent, "push", "-q", "-u", "origin", "codex/add-logging");
  writeFileSync(join(agent, ".env.local"), "DATABASE_URL=postgres://localhost/api\n");
  lookLikeGitHub(repo, "api");
}

// mobile-app: a forgotten stash, and a worktree whose folder was deleted.
{
  const { repo } = project("mobile-app");
  writeFileSync(join(repo, "src/index.ts"), "half-finished idea\n");
  git(repo, "stash", "push", "-q", "-m", "try new onboarding");
  const old = join(code, "mobile-app-release");
  git(repo, "worktree", "add", "-q", old, "-b", "release/1.2");
  git(old, "push", "-q", "-u", "origin", "release/1.2");
  rmSync(old, { recursive: true, force: true });
  lookLikeGitHub(repo, "mobile-app");
}

// blog: all clear.
{
  const { repo } = project("blog");
  commit(repo, "posts/hello.md", 3, "First post");
  git(repo, "push", "-q", "origin", "main");
  lookLikeGitHub(repo, "blog");
}

mkdirSync(join(work, "config"), { recursive: true });
writeFileSync(join(work, "config", "config.json"), JSON.stringify({ roots: [code], maxDepth: 2, activeDays: 365, fetchEveryMinutes: 0 }));

const { scan } = await import("../src/scan.js");
const snap = await scan({ offline: true });

// What GitHub would have said, had it been asked.
const now = Date.now();
for (const p of snap.projects) {
  const slug = `you/${p.name}`;
  p.github = { checked: true, reason: null, host: "github.com", slug, prRepo: slug, autoDelete: p.name === "api" ? false : true, canAdmin: true };
  if (p.fetch.hasRemote) p.fetch = { hasRemote: true, at: new Date(now - 4 * 60_000).toISOString(), error: null };
  for (const b of p.branches) if (b.name === "codex/add-logging") b.pr = { number: 14, url: `https://github.com/${slug}/pull/14` };
  for (const b of p.remoteBranches) if (b.name === "codex/add-logging") b.pr = { number: 14, url: `https://github.com/${slug}/pull/14` };
}
snap.generatedAt = new Date(now).toISOString();
snap.configPath = "~/.config/housekeep/config.json";
snap.activeDays = 45;
snap.quiet = 12;

// Real paths out, a stranger's home folder in.
let json = JSON.stringify(snap, null, 2)
  .split(code).join("/Users/you/code")
  .split(code.replace(homedir(), "~")).join("~/code");
for (const leak of [homedir(), repoRoot.replace(/\/$/, "")]) {
  if (json.includes(leak)) throw new Error(`the demo still mentions ${leak}`);
}
json = json.replace(/"displayPath": "\/Users\/you\//g, '"displayPath": "~/');
writeFileSync(join(repoRoot, "assets", "demo.json"), json + "\n");
rmSync(work, { recursive: true, force: true });
process.stdout.write(`Wrote assets/demo.json: ${snap.projects.map((p) => `${p.name} (${p.tier})`).join(", ")}\n`);

/**
 * End-to-end checks against throwaway repos, each with a local bare repo standing in for the remote.
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

// Isolate from this machine's git settings (signing, hooks, default branch) and from real Housekeep state.
const scratch = mkdtempSync(join(tmpdir(), "housekeep-test-"));
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
  HOUSEKEEP_CONFIG_DIR: join(scratch, "config"), HOUSEKEEP_STATE_DIR: join(scratch, "state"),
});

// Loaded after the environment is set: modules read it when they load.
const { buildProject, checkGit, folderStatus, gitSupport, inMain, lastActivity, onMissingDrive, remoteBranches, scan } = await import("../src/scan.js");
const { startServer } = await import("../src/server.js");
const { SERVER_FILE, STATE_DIR, CONFIG_FILE } = await import("../src/config.js");
const { githubRepo, hostName, localPathOf, remotesOf } = await import("../src/remote.js");
const { OpenError, openIn } = await import("../src/open.js");
const { menubar } = await import("../src/menubar.js");
const { loadDemo } = await import("../src/demo.js");
const { renderDashboard } = await import("../src/render.js");
type Project = import("../src/model.js").Project;
type Memo = import("../src/config.js").Memo;

const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function commit(repo: string, name: string): string {
  const path = join(repo, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, name);
  run(repo, "add", name);
  run(repo, "commit", "-qm", name);
  return run(repo, "rev-parse", "HEAD");
}

const freshMemo = (): Memo => ({ tried: {}, heads: {}, github: {}, deleted: {} });

class Sandbox {
  readonly server: string;
  readonly repo: string;

  constructor(readonly root: string) {
    this.server = join(root, "server.git");
    this.repo = join(root, "work");
    run(root, "init", "-q", "--bare", "-b", "main", this.server);
    run(root, "clone", "-q", this.server, this.repo);
    run(this.repo, "switch", "-qc", "main");
    commit(this.repo, "README");
    run(this.repo, "push", "-q", "-u", "origin", "main");
  }

  branch(name: string, files: string[], push = true): void {
    run(this.repo, "switch", "-qc", name, "main");
    for (const f of files) commit(this.repo, f);
    if (push) run(this.repo, "push", "-q", "-u", "origin", name);
    run(this.repo, "switch", "-q", "main");
  }

  clone(name: string): string {
    const path = join(this.root, name);
    run(this.root, "clone", "-q", this.server, path);
    return path;
  }

  project(repo = this.repo, memo = freshMemo()): Promise<Project> {
    return buildProject(repo, "work", 0, false, memo);
  }

  remoteNames(): string[] {
    return run(this.server, "branch", "--format=%(refname:short)").split("\n");
  }
}

const sig = (p: Project, key: string) => {
  const s = p.signals.find((x) => x.key === key);
  assert.ok(s, `no ${key} signal`);
  return s;
};
const branchOf = (p: Project, name: string) => {
  const b = p.branches.find((x) => x.name === name);
  assert.ok(b, `no local branch ${name}`);
  return b;
};
const remoteOf = (p: Project, name: string) => {
  const b = p.remoteBranches.find((x) => x.name === name);
  assert.ok(b, `no remote branch ${name}`);
  return b;
};

let count = 0;
const sandbox = (): Sandbox => {
  const root = join(scratch, `sb${count++}`);
  mkdirSync(root);
  return new Sandbox(root);
};

before(async () => {
  await checkGit(); // the suite only means something on a git new enough for squash detection
});
after(() => rmSync(scratch, { recursive: true, force: true }));

describe("parsing remotes", () => {
  it("names the server", () => {
    assert.equal(hostName("git@github.com:me/app.git"), "GitHub");
    assert.equal(hostName("git@github-work:me/app.git"), "GitHub");
    assert.equal(hostName("https://gitlab.com/me/app"), "GitLab");
    assert.equal(hostName("ssh://git@git.example.com:2222/me/app.git"), "git.example.com");
    assert.equal(hostName("/srv/repos/app.git"), "the remote");
  });

  it("finds the GitHub repo", () => {
    assert.deepEqual(githubRepo("git@github.com:me/app.git"), ["github.com", "me/app"]);
    assert.deepEqual(githubRepo("git@github-work:me/app.git"), ["github.com", "me/app"]);
    assert.deepEqual(githubRepo("https://github.com/me/app/"), ["github.com", "me/app"]);
    assert.deepEqual(githubRepo("ssh://git@github.example.com:22/team/app.git"), ["github.example.com", "team/app"]);
    assert.equal(githubRepo("https://gitlab.com/me/app"), null);
  });
});

describe("merges", () => {
  it("counts merged and squash-merged branches, here and on the remote, once each", async () => {
    const sb = sandbox();
    sb.branch("feat/merged", ["a"]);
    sb.branch("feat/squashed", ["b1", "b2"]);
    run(sb.repo, "merge", "-q", "--no-ff", "feat/merged", "-m", "merge");
    run(sb.repo, "merge", "-q", "--squash", "feat/squashed");
    run(sb.repo, "commit", "-qm", "squash");
    run(sb.repo, "push", "-q", "origin", "main");
    const p = await sb.project();
    assert.deepEqual([branchOf(p, "feat/merged").state, branchOf(p, "feat/merged").merged], ["merged", "merged"]);
    assert.deepEqual([branchOf(p, "feat/squashed").state, branchOf(p, "feat/squashed").merged], ["merged", "squashed"]);
    assert.ok(remoteOf(p, "feat/merged").deletable && remoteOf(p, "feat/squashed").deletable);
    assert.equal(sig(p, "cleanup").value, 2);
    assert.equal(p.next?.kind, "delete-merged");
  });

  it("judges branches against main on the remote, not the local copy", async () => {
    const sb = sandbox();
    sb.branch("feat/landed", ["c"]);
    const other = sb.clone("other");
    run(other, "merge", "-q", "--no-ff", "origin/feat/landed", "-m", "merged elsewhere");
    run(other, "push", "-q", "origin", "main");
    run(sb.repo, "fetch", "-q", "--prune");
    const p = await sb.project();
    assert.equal(p.main.behind, 2);
    assert.equal(branchOf(p, "feat/landed").state, "merged");
  });

  it("notices a branch landing in main, even after it was checked while unmerged", async () => {
    const sb = sandbox();
    sb.branch("feat/later", ["later-1", "later-2"]);
    const tip = run(sb.repo, "rev-parse", "feat/later");
    assert.equal(await inMain(sb.repo, tip, "refs/remotes/origin/main"), null);
    run(sb.repo, "merge", "-q", "--squash", "feat/later");
    run(sb.repo, "commit", "-qm", "squash");
    run(sb.repo, "push", "-q", "origin", "main");
    assert.equal(await inMain(sb.repo, tip, "refs/remotes/origin/main"), "squashed");
  });

  it("treats unmerged work as work, not mess", async () => {
    const sb = sandbox();
    sb.branch("feat/wip", ["d"]);
    const p = await sb.project();
    assert.equal(branchOf(p, "feat/wip").state, "unmerged");
    assert.equal(remoteOf(p, "feat/wip").deletable, false);
    assert.equal(sig(p, "cleanup").tier, "safe");
  });

  it("never calls a branch merged when its upstream has newer work", async () => {
    const sb = sandbox();
    sb.branch("feat/shared", ["e"]);
    run(sb.repo, "merge", "-q", "--no-ff", "feat/shared", "-m", "merge");
    run(sb.repo, "push", "-q", "origin", "main");
    const other = sb.clone("other");
    run(other, "switch", "-q", "feat/shared");
    commit(other, "more");
    run(other, "push", "-q", "origin", "feat/shared");
    run(sb.repo, "fetch", "-q");
    const b = branchOf(await sb.project(), "feat/shared");
    assert.deepEqual([b.state, b.behindUpstream, b.aheadOfMain], ["unmerged", 1, 1]);
  });
});

describe("branches that stay", () => {
  it("keeps long-lived and protected branches", async () => {
    const sb = sandbox();
    run(sb.repo, "push", "-q", "origin", "main:production", "main:guarded");
    const p = await sb.project();
    assert.equal(remoteOf(p, "production").deletable, false);
    assert.equal(remoteOf(p, "guarded").deletable, true);
    const found = await remoteBranches(sb.repo, await remotesOf(sb.repo), "main", "refs/remotes/origin/main",
      { ok: true, reason: null, protected: ["guarded"], prs: [] });
    assert.equal(found.find((b) => b.name === "guarded")?.kept, "Protected on GitHub");
  });

  it("keeps branches with open pull requests, or that pull requests build on", async () => {
    const sb = sandbox();
    run(sb.repo, "push", "-q", "origin", "main:feat/pr-head", "main:feat/pr-base");
    const found = await remoteBranches(sb.repo, await remotesOf(sb.repo), "main", "refs/remotes/origin/main", {
      ok: true, reason: null, protected: [], prs: [
        { number: 7, url: "u", head: "feat/pr-head", base: "main", own: true },
        { number: 8, url: "u", head: "feat/child", base: "feat/pr-base", own: true },
      ],
    });
    const byName = new Map(found.map((b) => [b.name, b]));
    assert.equal(byName.get("feat/pr-head")?.blockedBy, "Open pull request #7");
    assert.match(byName.get("feat/pr-base")?.blockedBy ?? "", /Base of 1 open pull request/);
    assert.ok(!byName.get("feat/pr-head")?.deletable && !byName.get("feat/pr-base")?.deletable);
  });
});

describe("remotes", () => {
  it("compares a fork's main with upstream and lists branches from origin", async () => {
    const sb = sandbox();
    const upstream = join(sb.root, "upstream.git");
    run(sb.root, "clone", "-q", "--bare", sb.server, upstream);
    run(sb.repo, "remote", "add", "upstream", upstream);
    run(sb.repo, "fetch", "-q", "upstream");
    run(sb.repo, "branch", "-q", "--set-upstream-to=upstream/main", "main");
    const maintainer = join(sb.root, "maintainer");
    run(sb.root, "clone", "-q", upstream, maintainer);
    commit(maintainer, "upstream-change");
    run(maintainer, "push", "-q", "origin", "main");
    run(sb.repo, "fetch", "-q", "upstream");
    sb.branch("feat/mine", ["f"]);
    const p = await sb.project();
    assert.deepEqual([p.remotes.truth, p.remotes.push, p.remotes.fork], ["upstream", "origin", true]);
    assert.equal(p.main.behind, 1);
    assert.ok(p.remoteBranches.some((b) => b.name === "feat/mine"));
  });

  it("takes the default branch from the remote, not a stale origin/HEAD", async () => {
    const sb = sandbox();
    run(sb.repo, "push", "-q", "origin", "main:trunk");
    run(sb.server, "symbolic-ref", "HEAD", "refs/heads/trunk");
    const memo = freshMemo();
    const p = await buildProject(sb.repo, "work", 600_000, true, memo);
    assert.equal(memo.heads[sb.repo], "trunk");
    assert.equal(p.main.name, "trunk");
  });

  it("doesn't call a shallow, single-branch clone clean, and asks for the rest", async () => {
    const sb = sandbox();
    sb.branch("feat/hidden", ["g"]);
    const narrow = join(sb.root, "narrow");
    run(sb.root, "clone", "-q", "--single-branch", "--depth", "1", `file://${sb.server}`, narrow);
    const p = await sb.project(narrow);
    assert.deepEqual(p.limits, { shallow: true, singleBranch: true });
    assert.notEqual(sig(p, "cleanup").tier, "safe");
    assert.notEqual(sig(p, "sync").tier, "safe");
    assert.equal(p.next?.kind, "fetch-all");
    assert.match(p.next?.ask ?? "", /whole history/);
  });
});

describe("working trees", () => {
  it("spots secret files and follows renames", async () => {
    const sb = sandbox();
    writeFileSync(join(sb.repo, ".env"), "KEY=1");
    writeFileSync(join(sb.repo, ".env.example"), "KEY=");
    run(sb.repo, "mv", "README", "README.md");
    const st = await folderStatus(sb.repo);
    assert.deepEqual(st.secrets, [".env"]);
    assert.deepEqual([st.changed, st.untracked], [1, 2]);
  });

  it("flags a branch that tracks main only when a plain push would update main", async () => {
    const sb = sandbox();
    run(sb.repo, "branch", "-q", "--track", "feat/linked", "origin/main");
    const b = branchOf(await sb.project(), "feat/linked");
    assert.deepEqual([b.upstreamIsMain, b.pushesToMain], [true, false]);
    run(sb.repo, "config", "push.default", "upstream");
    const p = await sb.project();
    assert.equal(branchOf(p, "feat/linked").pushesToMain, true);
    assert.equal(p.next?.kind, "unset-upstream");
    assert.match(p.next?.ask ?? "", /feat\/linked/);
  });
});

describe("requests for your AI assistant", () => {
  it("names only the merged branches to clean up, here and on the remote, and changes nothing itself", async () => {
    const sb = sandbox();
    sb.branch("feat/done", ["h"]);
    sb.branch("feat/squash", ["i1", "i2"]);
    sb.branch("feat/open", ["j"]);
    run(sb.repo, "merge", "-q", "--no-ff", "feat/done", "-m", "merge");
    run(sb.repo, "merge", "-q", "--squash", "feat/squash");
    run(sb.repo, "commit", "-qm", "squash");
    run(sb.repo, "push", "-q", "origin", "main", "main:production");
    const before = sb.remoteNames();
    const p = await sb.project();
    assert.equal(p.next?.kind, "delete-merged");
    const ask = p.next?.ask ?? "";
    for (const name of ["feat/done", "feat/squash"]) assert.ok(ask.includes(name), name);
    for (const name of ["feat/open", "production"]) assert.ok(!ask.includes(name), name);
    assert.match(ask, /don't force-push/);
    assert.doesNotMatch(ask, /git branch|git push/); // plain words, not commands
    // Every other request is in the JSON too: one per branch here and on the remote, and the groups.
    const about = p.requests.map((r) => `${r.about}:${r.name ?? ""}`);
    for (const k of ["branch:feat/done", "branch:feat/squash", "remote:feat/done", "remote:feat/squash", "merged:", "merged-remote:"]) assert.ok(about.includes(k), k);
    assert.ok(!about.some((k) => k.includes("production") || k.includes("feat/open")));
    for (const r of p.requests) assert.doesNotMatch(r.ask, /git branch|git push|--/);
    assert.deepEqual(sb.remoteNames(), before);
  });

  it("asks to push everything without ever pushing main", async () => {
    const sb = sandbox();
    sb.branch("feat/unpushed", ["n"], false);
    commit(sb.repo, "unpushed-on-main"); // after branching, so only main carries it
    const serverMain = run(sb.server, "rev-parse", "main");
    const p = await sb.project();
    assert.equal(sig(p, "push").tier, "at-risk");
    assert.equal(p.next?.kind, "push-all");
    assert.match(p.next?.ask ?? "", /Don't push main itself/);
    assert.equal(run(sb.server, "rev-parse", "main"), serverMain);
  });
});

describe("work that could be lost", () => {
  it("counts commits on a detached HEAD, and asks for a branch before pushing", async () => {
    const sb = sandbox();
    run(sb.repo, "switch", "-q", "--detach");
    commit(sb.repo, "detached-work");
    const p = await sb.project();
    assert.equal(p.checkouts[0]?.detachedCommits, 1);
    assert.equal(sig(p, "push").tier, "at-risk");
    assert.equal(p.next?.kind, "push-all");
    assert.match(p.next?.ask ?? "", /give them a branch first/);
  });

  it("notices ignored files that exist only in a worktree", async () => {
    const sb = sandbox();
    writeFileSync(join(sb.repo, ".gitignore"), ".env\nnode_modules/\n");
    run(sb.repo, "add", ".gitignore");
    run(sb.repo, "commit", "-qm", "ignore");
    const wt = join(sb.root, "wt");
    run(sb.repo, "worktree", "add", "-q", wt, "-b", "feat/wt");
    writeFileSync(join(wt, ".env"), "SECRET=1");
    mkdirSync(join(wt, "node_modules"));
    writeFileSync(join(wt, "node_modules", "x.js"), "");
    const p = await sb.project();
    const c = p.checkouts.find((x) => x.path.endsWith("/wt"));
    assert.deepEqual(c?.ignoredKeep, [".env"]);
  });

  // Root reads any folder whatever its permissions, so this can only be shown as an ordinary user.
  it("says it couldn't check, instead of clean, when git can't read a working tree", { skip: process.getuid?.() === 0 ? "running as root, which can read any folder" : false }, async () => {
    const sb = sandbox();
    const wt = join(sb.root, "locked-out");
    run(sb.repo, "worktree", "add", "-q", wt, "-b", "feat/unreadable");
    chmodSync(wt, 0o000);
    try {
      const p = await sb.project();
      const c = p.checkouts.find((x) => x.path.endsWith("/locked-out"));
      assert.equal(c?.unreadable, true);
      assert.equal(c?.missing, false);
      assert.notEqual(sig(p, "commit").tier, "safe");
      assert.equal(sig(p, "commit").cell, "Couldn't check");
    } finally {
      chmodSync(wt, 0o755);
    }
  });

  it("notes unmerged work when its branch is deleted on the remote, without writing to the repo", async () => {
    const sb = sandbox();
    sb.branch("feat/lost", ["lost-work"]);
    sb.branch("feat/landed", ["landed-1", "landed-2"]);
    const lost = run(sb.repo, "rev-parse", "feat/lost");
    run(sb.repo, "merge", "-q", "--squash", "feat/landed");
    run(sb.repo, "commit", "-qm", "squash");
    run(sb.repo, "push", "-q", "origin", "main");
    run(sb.repo, "branch", "-q", "-D", "feat/lost", "feat/landed");
    const other = sb.clone("other");
    run(other, "push", "-q", "origin", "--delete", "feat/lost", "feat/landed");
    const memo = freshMemo();
    const p = await buildProject(sb.repo, "work", 600_000, true, memo);
    assert.deepEqual(p.pruned.map((b) => [b.name, b.sha]), [["origin/feat/lost", lost]]); // the squash-merged one isn't noted
    assert.equal(sig(p, "push").tier, "at-risk");
    assert.equal(p.next?.kind, "restore-pruned");
    assert.ok(p.next?.ask.includes(`feat/lost, whose last commit was ${lost}`));
    assert.equal(run(sb.repo, "for-each-ref", "refs/housekeep/"), ""); // nothing written into the repo
    assert.equal(memo.deleted[sb.repo]?.length, 1);
    // Once the work is on a branch again, Housekeep stops noting it.
    run(sb.repo, "branch", "feat/lost", lost);
    const after = await sb.project(sb.repo, memo);
    assert.equal(after.pruned.length, 0);
    assert.equal(memo.deleted[sb.repo], undefined);
  });

  it("doesn't call a worktree on a drive that isn't connected prunable", async () => {
    assert.equal(onMissingDrive("/Volumes/housekeep-no-such-drive/app"), process.platform === "darwin" || process.platform === "linux");
    assert.equal(onMissingDrive(join(scratch, "gone")), false);
    const sb = sandbox();
    const wt = join(sb.root, "external");
    run(sb.repo, "worktree", "add", "-q", wt, "-b", "feat/external");
    // Point git's record at an unplugged drive, as if the disk had been ejected.
    const admin = join(sb.repo, ".git", "worktrees", "external");
    writeFileSync(join(admin, "gitdir"), "/Volumes/housekeep-no-such-drive/external/.git\n");
    rmSync(wt, { recursive: true, force: true });
    const p = await sb.project();
    const c = p.checkouts.find((x) => x.path.includes("housekeep-no-such-drive"));
    assert.equal(c?.offline, true);
    assert.equal(sig(p, "cleanup").prunable, 0);
    assert.ok(existsSync(admin));
  });

  it("flags secrets that are committed, and ones already pushed", async () => {
    const sb = sandbox();
    writeFileSync(join(sb.repo, ".env"), "KEY=1");
    writeFileSync(join(sb.repo, ".env.example"), "KEY=");
    run(sb.repo, "add", ".env", ".env.example");
    run(sb.repo, "commit", "-qm", "oops");
    let p = await sb.project();
    assert.deepEqual(p.committedSecrets, [{ path: ".env", pushed: false }]);
    assert.equal(sig(p, "commit").headline, "Secret committed: .env");
    run(sb.repo, "push", "-q", "origin", "main");
    p = await sb.project();
    assert.equal(sig(p, "commit").headline, "Secret pushed: .env");
    assert.equal(p.tier, "at-risk");
  });
});

describe("the live map", () => {
  it("never runs git: it only opens the project's own folders", async () => {
    const sb = sandbox();
    const p = await sb.project();
    assert.throws(() => openIn(p, scratch, "files"), OpenError);
    assert.throws(() => openIn(p, sb.repo, "no-such-app"), OpenError);
  });

  it("keeps its token and state readable only by you", async () => {
    mkdirSync(join(scratch, "nothing-here"), { recursive: true });
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify({ roots: [join(scratch, "nothing-here")], fetchEveryMinutes: 0 }));
    const server = await startServer({ port: 0 });
    try {
      assert.equal(statSync(SERVER_FILE).mode & 0o777, 0o600);
      assert.equal(statSync(STATE_DIR).mode & 0o777, 0o700);
    } finally {
      await server.close();
    }
  });
});

describe("finding and trusting repos", () => {
  const scanOnly = async (root: string) => {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify({ roots: [root], fetchEveryMinutes: 0, activeDays: 45, maxDepth: 4 }));
    return scan({ offline: true });
  };

  it("finds repos inside a repo, like a home folder kept as a dotfiles repo, but not submodules", async () => {
    const home = join(scratch, "dotfiles-home");
    mkdirSync(join(home, "code"), { recursive: true });
    run(scratch, "init", "-q", "-b", "main", home);
    commit(home, ".zshrc");
    const lib = join(scratch, "lib-source");
    run(scratch, "init", "-q", "-b", "main", lib);
    commit(lib, "lib.js");
    const app = join(home, "code", "app");
    run(scratch, "init", "-q", "-b", "main", app);
    commit(app, "index.js");
    run(app, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib");
    run(app, "commit", "-qm", "add lib");
    const found = (await scanOnly(home)).projects.map((p) => p.path).sort();
    assert.deepEqual(found, [home, app].sort());
  });

  it("honours ignore whatever its capitalisation, where the file system ignores case", async () => {
    const top = join(scratch, "case-test");
    const repo = join(top, "Keep", "old-thing");
    mkdirSync(repo, { recursive: true });
    run(scratch, "init", "-q", "-b", "main", repo);
    commit(repo, "a");
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify({ roots: [top], ignore: [join(top, "keep", "old-thing")], fetchEveryMinutes: 0 }));
    const found = (await scan({ offline: true })).projects.map((p) => p.path);
    const insensitive = process.platform === "darwin" || process.platform === "win32";
    assert.deepEqual(found, insensitive ? [] : [repo]);
  });

  it("notices a repo that keeps no reflog", async () => {
    const repo = join(scratch, "no-reflog", "repo");
    mkdirSync(repo, { recursive: true });
    run(scratch, "init", "-q", "-b", "main", repo);
    commit(repo, "a");
    rmSync(join(repo, ".git", "logs"), { recursive: true, force: true });
    assert.ok(lastActivity(repo) > Date.now() - 60_000);
    assert.deepEqual((await scanOnly(join(scratch, "no-reflog"))).projects.map((p) => p.path), [repo]);
  });

  it("handles a brand-new repo with no commits", async () => {
    const repo = join(scratch, "brand-new");
    run(scratch, "init", "-q", "-b", "main", repo);
    writeFileSync(join(repo, "notes.md"), "hi");
    const p = await buildProject(repo, "brand-new", 0, false, freshMemo());
    assert.equal(p.error, null);
    assert.equal(sig(p, "push").headline, "No remote");
    assert.equal(sig(p, "commit").value, 1);
  });

  it("works on older git, without squash detection", () => {
    assert.deepEqual(gitSupport("git version 2.46.0"), { ok: true, squash: true, version: "2.46.0" });
    assert.deepEqual(gitSupport("git version 2.34.1"), { ok: true, squash: false, version: "2.34.1" });
    assert.deepEqual(gitSupport("git version 2.39.5 (Apple Git-154)"), { ok: true, squash: true, version: "2.39.5 (Apple Git-154)" });
    assert.equal(gitSupport("git version 2.20.1").ok, false);
  });
});

describe("backups that aren't", () => {
  it("knows a remote that's a folder from one that's a server", () => {
    assert.equal(localPathOf("git@github.com:me/app.git", "/r"), null);
    assert.equal(localPathOf("https://github.com/me/app", "/r"), null);
    assert.equal(localPathOf("/srv/app.git", "/r"), "/srv/app.git");
    assert.equal(localPathOf("file:///srv/app.git", "/r"), "/srv/app.git");
    assert.equal(localPathOf("../app.git", "/r/work"), "/r/app.git");
  });

  it("doesn't call a remote on the same disk a backup", async () => {
    const sb = sandbox();
    const p = await sb.project();
    assert.equal(p.remotes.sameDisk, true);
    assert.equal(sig(p, "push").headline, "Pushed, but only to this disk");
    assert.equal(sig(p, "push").tier, "attention");
  });

  it("warns about work in a temporary folder the system empties", async () => {
    const sb = sandbox();
    const wt = join(sb.root, "scratch-wt");
    run(sb.repo, "worktree", "add", "-q", wt, "-b", "feat/tmp");
    writeFileSync(join(wt, "draft.md"), "unsaved thoughts");
    const p = await sb.project();
    const c = p.checkouts.find((x) => x.path.endsWith("/scratch-wt"));
    assert.equal(c?.temporary, true); // the test sandbox itself lives in the system's temp folder
    assert.match(sig(p, "commit").headline, /^Work in a temporary folder/);
    assert.equal(p.next?.title, "Move a worktree out of a temporary folder");
  });
});

describe("the menu bar", () => {
  it("shows how many projects need you, and keeps SwiftBar's format intact", async () => {
    const sb = sandbox();
    commit(sb.repo, "unpushed");
    const p = await sb.project();
    p.name = "weird | name";
    const snap = { version: "t", generatedAt: new Date().toISOString(), watching: 1, quiet: 0, activeDays: 45, configPath: "",
      blocked: [], notices: [], error: null, projects: [p] };
    const text = menubar(snap, "http://127.0.0.1:1/", { node: "/path with space/node", script: "/x/cli.js" });
    const [first] = text.split("\n");
    assert.match(first ?? "", /^1 need you \| sfimage=circle\.fill/);
    assert.ok(text.includes("weird / name |"), "a | in a name would start SwiftBar's parameters");
    assert.ok(text.includes('bash="/path with space/node" param1="/x/cli.js" param2=copy'));
  });
});

describe("the demo", () => {
  it("looks freshly checked, and mentions nobody's real machine", () => {
    const demo = loadDemo();
    assert.ok(Date.now() - new Date(demo.generatedAt).getTime() < 5000);
    assert.deepEqual(demo.projects.map((p) => p.tier), ["at-risk", "at-risk", "attention", "attention", "safe"]);
    const text = JSON.stringify(demo);
    for (const p of demo.projects) assert.ok(p.path.startsWith("/Users/you/code/"), p.path);
    assert.ok(!text.includes(process.env.HOME ?? "/nonexistent-home"));
  });

  it("renders a page that answers its own buttons, in the bundled font", () => {
    const html = renderDashboard(loadDemo(), { token: "demo", openers: [], demo: true });
    assert.ok(html.includes('"demo":true'));
    assert.ok(html.includes("font/woff2"), "the demo page uses Geist, whatever font this machine prefers");
  });
});

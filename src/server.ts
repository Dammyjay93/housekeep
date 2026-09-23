/**
 * The live dashboard: watches your projects, streams changes to the open page, and runs its buttons.
 *
 * Only this machine can reach it (it listens on 127.0.0.1), and every request has to carry a token
 * baked into the page it served, so other websites can't drive it. Buttons map to a fixed list of
 * git operations, each re-checked against the repo right before it runs.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { join } from "node:path";
import { ACTIONS, ActionError, type ActionBody, availableOpeners } from "./actions.js";
import { MAP_FILE, SERVER_FILE, SNAPSHOT_FILE, STATE_DIR, loadConfig, readJson, secureDir, writeAtomic } from "./config.js";
import { TIER_RANK, type Project, type Snapshot } from "./model.js";
import { isRecord, run } from "./proc.js";
import { swiftBarApp } from "./install.js";
import { PLUGIN_NAME } from "./menubar.js";
import { renderDashboard } from "./render.js";
import { VERSION, buildOne, commonDir, scan } from "./scan.js";

const REF_TICK_MS = 1500;
const STATUS_EVERY = 2; // ticks
const REDISCOVER_MS = 5 * 60_000;

// --- shared state -----------------------------------------------------------------

class Hub {
  data: Snapshot;
  private listeners = new Set<ServerResponse>();
  private lights = "";
  private nudged = 0;

  constructor(initial: Snapshot) {
    this.data = initial;
  }

  publish(data: Snapshot): void {
    this.data = data;
    const payload = `event: state\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.listeners) res.write(payload);
    writeAtomic(SNAPSHOT_FILE, JSON.stringify(data));
    writeAtomic(MAP_FILE, renderDashboard(data, null));
    this.nudgeMenuBar(data);
  }

  /** Ask SwiftBar to redraw the light, but only when a project's colour actually changed. */
  private nudgeMenuBar(data: Snapshot): void {
    const lights = data.projects.map((p) => `${p.path}:${p.tier}:${p.signals.map((s) => s.tier).join(",")}`).join("|");
    if (lights === this.lights || Date.now() - this.nudged < 5000 || !swiftBarApp()) return;
    this.lights = lights;
    this.nudged = Date.now();
    void run("open", ["-g", `swiftbar://refreshplugin?name=${PLUGIN_NAME}`]);
  }

  replaceProject(project: Project): void {
    const others = this.data.projects.filter((p) => p.path !== project.path);
    const projects = [...others, project].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.name.localeCompare(b.name));
    this.publish({ ...this.data, projects, generatedAt: new Date().toISOString() });
  }

  project(path: string): Project | undefined {
    return this.data.projects.find((p) => p.path === path);
  }

  subscribe(res: ServerResponse): void {
    this.listeners.add(res);
  }

  unsubscribe(res: ServerResponse): void {
    this.listeners.delete(res);
  }

  heartbeat(): void {
    for (const res of this.listeners) res.write(": still here\n\n");
  }
}

// --- watching ---------------------------------------------------------------------

function stamp(path: string): string {
  try {
    const st = statSync(path);
    return `${path}:${st.mtimeMs}:${st.size}`;
  } catch {
    return `${path}:-`;
  }
}

function walkFiles(dir: string, into: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, into);
    else into.push(full);
  }
}

/** Everything git rewrites when you commit, switch, stash, fetch, or add or remove a worktree. */
function refPrint(cdir: string): string {
  const files = ["HEAD", "packed-refs", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD", "logs/HEAD", "refs/stash"].map((f) => join(cdir, f));
  for (const sub of ["refs/heads", "refs/remotes", "refs/tags"]) walkFiles(join(cdir, sub), files);
  try {
    for (const w of readdirSync(join(cdir, "worktrees"))) {
      for (const f of ["HEAD", "gitdir", "MERGE_HEAD"]) files.push(join(cdir, "worktrees", w, f));
    }
  } catch {
    // No linked worktrees.
  }
  return files.map(stamp).join("|");
}

/** What `git status` says in every working tree; catches edits that never touch .git. */
async function statusPrint(paths: string[]): Promise<string> {
  const hash = createHash("sha1");
  for (const path of paths) {
    const r = await run("git", ["-C", path, "status", "--porcelain=v1", "-z", "--untracked-files=normal"], { timeout: 15_000 });
    hash.update(path + "\0" + (r.ok ? r.stdout : ""));
  }
  return hash.digest("hex");
}

class Watcher {
  private refs = new Map<string, string>();
  private status = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private generation = 0;
  private waiters: { target: number; resolve: () => void }[] = [];
  private fullWanted = false;
  private fullFetch = false;
  private busy = false;
  private tick = 0;
  private lastFull = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private hub: Hub) {}

  /** Checks run one at a time, so a watcher tick and a button press never race. */
  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch((err: unknown) => {
      process.stderr.write(`housekeep: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    });
    return this.chain;
  }

  fullScan(force: boolean): Promise<void> {
    return this.serial(async () => {
      const data = await scan({ force });
      await this.remember(data.projects);
      this.hub.publish(data);
      this.lastFull = Date.now();
      this.generation += 1;
      this.waiters = this.waiters.filter((w) => (w.target <= this.generation ? (w.resolve(), false) : true));
    });
  }

  rescan(repo: string, force = false): Promise<void> {
    return this.serial(async () => {
      const project = await buildOne(repo, force);
      await this.remember([project]);
      this.hub.replaceProject(project);
    });
  }

  private async remember(projects: Project[]): Promise<void> {
    for (const p of projects) {
      const cdir = await commonDir(p.path);
      if (cdir) this.refs.set(p.path, refPrint(cdir));
      this.status.set(p.path, await statusPrint(p.checkouts.filter((c) => !c.missing).map((c) => c.path)));
    }
  }

  /** Ask for a full check; resolves when one that started after this call has finished. */
  requestFull(force: boolean, timeoutMs: number): Promise<void> {
    const target = this.generation + (this.busy ? 2 : 1);
    this.fullWanted = true;
    this.fullFetch = this.fullFetch || force;
    return new Promise((resolve) => {
      const done = (): void => resolve();
      this.waiters.push({ target, resolve: done });
      setTimeout(done, timeoutMs);
    });
  }

  start(): void {
    void this.fullScan(false);
    this.timer = setInterval(() => void this.step(), REF_TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async step(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.tick += 1;
      if (this.fullWanted || Date.now() - this.lastFull > REDISCOVER_MS) {
        const force = this.fullFetch;
        this.fullWanted = false;
        this.fullFetch = false;
        await this.fullScan(force);
        return;
      }
      const deep = this.tick % STATUS_EVERY === 0;
      for (const p of this.hub.data.projects) {
        if (await this.changed(p, deep)) await this.rescan(p.path);
      }
    } finally {
      this.busy = false;
    }
  }

  private async changed(p: Project, deep: boolean): Promise<boolean> {
    const cdir = await commonDir(p.path);
    if (cdir && refPrint(cdir) !== this.refs.get(p.path)) return true;
    if (!deep) return false;
    return (await statusPrint(p.checkouts.filter((c) => !c.missing).map((c) => c.path))) !== this.status.get(p.path);
  }
}

// --- http ---------------------------------------------------------------------------

export interface LiveServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

/** Start the dashboard server. Uses the configured port, or any free one if something else has it. */
export async function startServer(opts: { port?: number } = {}): Promise<LiveServer> {
  // Earlier versions left state readable by everyone on this machine; the token must be yours alone.
  secureDir(STATE_DIR);
  const token = randomBytes(32).toString("base64url");
  const cached = readJson(SNAPSHOT_FILE);
  // Serve something straight away: the last known state from this version, or a quick check that
  // skips the network. The watcher's first full check, fetches included, replaces it moments later.
  const initial: Snapshot = isRecord(cached) && cached.version === VERSION && Array.isArray(cached.projects)
    ? (cached as unknown as Snapshot) : await scan({ offline: true });
  const hub = new Hub(initial);
  const watcher = new Watcher(hub);
  const openers = await availableOpeners();
  const busyProjects = new Set<string>();
  let hosts = new Set<string>();

  const send = (res: ServerResponse, status: number, payload: unknown): void => {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
    res.end(body);
  };

  const allowed = (req: IncomingMessage, res: ServerResponse, needToken: boolean): boolean => {
    // Host blocks DNS rebinding; Origin blocks other websites; the token proves the caller got it from our page.
    if (!hosts.has(req.headers.host ?? "")) {
      send(res, 403, { error: "Housekeep only answers on 127.0.0.1." });
      return false;
    }
    const origin = req.headers.origin;
    if (origin && !hosts.has(origin.replace(/^http:\/\//, ""))) {
      send(res, 403, { error: "Requests from other sites aren't allowed." });
      return false;
    }
    if (needToken) {
      const given = String(req.headers["x-housekeep-token"] ?? new URL(req.url ?? "/", "http://x").searchParams.get("token") ?? "");
      const a = Buffer.from(given);
      const b = Buffer.from(token);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        send(res, 401, { error: "Reload the page; Housekeep restarted." });
        return false;
      }
    }
    return true;
  };

  const readBody = (req: IncomingMessage): Promise<string | null> => new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= 65_536) chunks.push(c);
    });
    req.on("end", () => resolve(size > 65_536 ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });

  const perform = async (body: Record<string, unknown>): Promise<unknown> => {
    const project = hub.project(String(body.project ?? ""));
    if (!project) throw new ActionError("That project isn't being watched.");
    const spec = ACTIONS[String(body.action ?? "")];
    if (!spec) throw new ActionError("Unknown action.");
    if (busyProjects.has(project.path)) throw new ActionError("Something is already running for this project. Try again in a moment.");
    const args: ActionBody = {
      branches: Array.isArray(body.branches) ? body.branches.filter((b): b is string => typeof b === "string") : undefined,
      branch: typeof body.branch === "string" ? body.branch : undefined,
      path: typeof body.path === "string" ? body.path : undefined,
      app: typeof body.app === "string" ? body.app : undefined,
    };
    busyProjects.add(project.path);
    let result;
    try {
      result = await spec.run(project, args);
    } finally {
      busyProjects.delete(project.path);
    }
    if (spec.rescan) await watcher.rescan(project.path, spec.refetch);
    return { ok: true, message: result.message, output: result.output.slice(-4000) };
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void (async () => {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        if (!allowed(req, res, false)) return;
        const html = renderDashboard(hub.data, { token, openers });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html), "Cache-Control": "no-store" });
        res.end(html);
      } else if (req.method === "GET" && url.pathname === "/api/state") {
        if (allowed(req, res, true)) send(res, 200, hub.data);
      } else if (req.method === "GET" && url.pathname === "/api/events") {
        if (!allowed(req, res, true)) return;
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.write(`event: state\ndata: ${JSON.stringify(hub.data)}\n\n`);
        hub.subscribe(res);
        req.on("close", () => hub.unsubscribe(res));
      } else if (req.method === "POST") {
        // Read the body before any refusal, or it's left on the kept-alive connection.
        const raw = await readBody(req);
        if (raw === null) return send(res, 413, { error: "Request too large." });
        if (!allowed(req, res, true)) return;
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) as unknown : {};
        } catch {
          return send(res, 400, { error: "Request wasn't valid JSON." });
        }
        if (!isRecord(body)) return send(res, 400, { error: "Request wasn't a JSON object." });
        if (url.pathname === "/api/check") {
          const waiting = watcher.requestFull(true, 80_000);
          if (url.searchParams.get("wait") === "1") {
            await waiting;
            send(res, 200, hub.data);
          } else send(res, 202, { ok: true });
        } else if (url.pathname === "/api/action") {
          try {
            send(res, 200, await perform(body));
          } catch (err) {
            if (err instanceof ActionError) send(res, 409, { error: err.message });
            else throw err;
          }
        } else send(res, 404, { error: "Not found" });
      } else send(res, 404, { error: "Not found" });
    })().catch((err: unknown) => {
      process.stderr.write(`housekeep: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) send(res, 500, { error: "Something went wrong. See the terminal running Housekeep." });
    });
  });

  const wanted = opts.port ?? loadConfig().port;
  let port: number;
  try {
    port = await listen(server, wanted);
  } catch (err) {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "EADDRINUSE") throw err;
    port = await listen(server, 0);
  }
  hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const url = `http://127.0.0.1:${port}/`;
  writeAtomic(SERVER_FILE, JSON.stringify({ port, url, token, pid: process.pid }));
  const beat = setInterval(() => hub.heartbeat(), 15_000);
  watcher.start();

  return {
    url,
    port,
    close: () => new Promise((resolve) => {
      watcher.stop();
      clearInterval(beat);
      try {
        unlinkSync(SERVER_FILE);
      } catch {
        // Already gone.
      }
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** The running server's state, re-checking every remote first when `force` is set. Null if it doesn't answer. */
export async function serverState(server: { url: string; token: string }, force: boolean): Promise<Snapshot | null> {
  try {
    const res = await fetch(new URL(force ? "api/check?wait=1" : "api/state", server.url), {
      method: force ? "POST" : "GET",
      headers: { "X-Housekeep-Token": server.token, "Content-Type": "application/json" },
      body: force ? "{}" : undefined,
      signal: AbortSignal.timeout(force ? 90_000 : 3000),
    });
    const body: unknown = await res.json();
    return res.ok && isRecord(body) && Array.isArray(body.projects) ? (body as unknown as Snapshot) : null;
  } catch {
    return null;
  }
}

/** A Housekeep server that's already running on this machine, if it answers. */
export async function runningServer(): Promise<{ url: string; token: string } | null> {
  const info = readJson(SERVER_FILE);
  if (!isRecord(info) || typeof info.url !== "string" || typeof info.token !== "string") return null;
  try {
    const res = await fetch(new URL("api/state", info.url), { headers: { "X-Housekeep-Token": info.token }, signal: AbortSignal.timeout(1500) });
    return res.ok ? { url: info.url, token: info.token } : null;
  } catch {
    return null;
  }
}

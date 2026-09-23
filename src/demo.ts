/** Made-up projects for trying Housekeep, screenshots and the website. Built by scripts/make-demo.ts. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "./model.js";
import { isRecord, parseJson } from "./proc.js";

const DEMO_FILE = fileURLToPath(new URL("../../assets/demo.json", import.meta.url));

/** The demo as if it had just been checked: every time in it moves forward to now. */
export function loadDemo(): Snapshot {
  const raw = parseJson(readFileSync(DEMO_FILE, "utf8"));
  if (!isRecord(raw) || !Array.isArray(raw.projects)) throw new Error("assets/demo.json is missing or unreadable; run npm run demo:build");
  const snap = raw as unknown as Snapshot;
  const shift = Date.now() - new Date(snap.generatedAt).getTime();
  const later = (iso: string | null): string | null => (iso ? new Date(new Date(iso).getTime() + shift).toISOString() : iso);
  const laterUnix = (unix: number | null): number | null => (unix === null ? null : unix + Math.round(shift / 1000));
  snap.generatedAt = later(snap.generatedAt) ?? snap.generatedAt;
  for (const p of snap.projects) {
    p.fetch.at = later(p.fetch.at);
    for (const b of p.branches) b.lastCommit = laterUnix(b.lastCommit);
    for (const b of p.remoteBranches) b.lastCommit = laterUnix(b.lastCommit);
  }
  return snap;
}

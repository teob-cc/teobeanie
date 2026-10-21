// lock.ts — <config>/teobeanie.lock.json: per installed package, where it came from,
// which version, and the content hash it had when it was installed. A package whose
// files no longer hash to that is "modified": the house changed it, and an update
// never overwrites it. A starter package the house removed stays removed (unless an
// instance needs it again).
//
//   {
//     "lockfileVersion": 1,
//     "packages": {
//       "door-watch": { "origin": "starter", "version": "1.0.0", "hash": "sha256-…" },
//       "hold": { "origin": "starter", "version": "1.0.0", "hash": "sha256-…", "modified": true }
//     }
//   }

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export const LOCK_FILE = "teobeanie.lock.json";

/** "starter" (shipped with the add-on), "local" (put there by hand); later a git URL. */
export type Origin = "starter" | "local" | (string & {});

export interface LockEntry {
  origin: Origin;
  version: string;
  /** The content hash as installed. */
  hash: string;
  /** Its files differ from what was installed. */
  modified?: boolean;
  /** A starter package the house removed: not installed again unless an instance needs it. */
  removed?: boolean;
  /** The add-on ships another version than the one installed (offered as a diff later). */
  upstream?: { version: string; hash: string };
}

export interface Lock {
  lockfileVersion: 1;
  packages: Record<string, LockEntry>;
}

export const emptyLock = (): Lock => ({ lockfileVersion: 1, packages: {} });

/** A package's files (dot files and node_modules left out), as sorted slash-separated paths. */
export function packageFiles(dir: string, sub = dir): string[] {
  return readdirSync(sub, { withFileTypes: true })
    .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
    .flatMap((e) => (e.isDirectory() ? packageFiles(dir, join(sub, e.name)) : [relative(dir, join(sub, e.name)).split("\\").join("/")]))
    .sort();
}

/** The content hash of a package folder: every file's path and bytes, line endings aside. */
export function packageHash(dir: string): string {
  const h = createHash("sha256");
  for (const f of packageFiles(dir)) h.update(`${f}\0`).update(readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n")).update("\0");
  return `sha256-${h.digest("hex")}`;
}

/** The lock file of a config folder; none (or an unreadable one): empty. */
export function readLock(configDir: string): Lock {
  const path = join(configDir, LOCK_FILE);
  if (!existsSync(path)) return emptyLock();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Lock>;
    return { lockfileVersion: 1, packages: typeof parsed.packages === "object" && parsed.packages !== null ? parsed.packages : {} };
  } catch {
    return emptyLock();
  }
}

/** The lock as written: packages by name, fields in a fixed order. */
export function lockText(lock: Lock): string {
  const packages = Object.fromEntries(
    Object.keys(lock.packages)
      .sort()
      .map((name) => {
        const e = lock.packages[name]!;
        return [
          name,
          {
            origin: e.origin,
            version: e.version,
            hash: e.hash,
            ...(e.modified ? { modified: true } : {}),
            ...(e.removed ? { removed: true } : {}),
            ...(e.upstream !== undefined ? { upstream: e.upstream } : {}),
          },
        ];
      }),
  );
  return `${JSON.stringify({ lockfileVersion: 1, packages }, null, 2)}\n`;
}

/** Write the lock when its text changes; whether it did. */
export function writeLock(configDir: string, lock: Lock): boolean {
  const path = join(configDir, LOCK_FILE);
  const text = lockText(lock);
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  writeFileSync(path, text);
  return true;
}

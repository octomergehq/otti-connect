import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "./config";

/**
 * Lock files that name the Otti Connect process holding them:
 *
 * - `connect.lock` in the config folder: one Otti Connect per sign-in. A
 *   second process with the same sign-in would poll for the same agent host
 *   and make the first one's turns look lost, so it refuses to start while
 *   the lock's process lives.
 * - `.install.lock` in the agents folder (src/install.ts): one installer at a
 *   time; another waits for it.
 *
 * A lock whose process is gone (it crashed, the computer or the container
 * restarted) is taken over.
 */

export const LOCK_FILE = "connect.lock";

export class LockError extends Error {
  constructor(message: string, readonly pid: number) {
    super(message);
    this.name = "LockError";
  }
}

function holderOf(path: string): number | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 ? value.pid : null;
  } catch {
    return null;
  }
}

/** Whether `pid` is a live Otti Connect (a container that restarted gives the same process numbers to other programs). */
function liveConnector(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  if (process.platform !== "linux") return true;
  try {
    const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    return command.includes("otti-connect") || (!!process.argv[1] && command.includes(process.argv[1]));
  } catch {
    return true;
  }
}

/**
 * Takes the lock file at `path` for this process until it releases it or
 * exits: its release, or the live Otti Connect that holds it. Throws
 * ConfigError when the file can't be written.
 */
export function tryLock(path: string): { release: () => void } | { holder: number } {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      } finally {
        closeSync(descriptor);
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.off("exit", release);
        try {
          if (holderOf(path) === process.pid) unlinkSync(path);
        } catch {
          // Gone already.
        }
      };
      process.on("exit", release);
      return { release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new ConfigError(`Otti Connect can't take its lock ${path}: ${(error as Error).message}`);
    }
    const pid = holderOf(path);
    if (pid && liveConnector(pid)) return { holder: pid };
    // Its process is gone: the lock is stale.
    try {
      unlinkSync(path);
    } catch {
      // Another process took it over meanwhile; the next attempt sees.
    }
  }
  throw new ConfigError(`Otti Connect can't take its lock ${path}: another process keeps replacing it.`);
}

/** The live process that holds the lock of `dir`, if one does. */
export function lockHolder(dir: string): number | null {
  const pid = holderOf(join(dir, LOCK_FILE));
  return pid && liveConnector(pid) ? pid : null;
}

/** Takes the lock of `dir` for this process until it exits; throws LockError when a live Otti Connect holds it. */
export function takeLock(dir: string): () => void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new ConfigError(`Otti Connect can't create ${dir}: ${(error as Error).message}`);
  }
  const lock = tryLock(join(dir, LOCK_FILE));
  if ("holder" in lock)
    throw new LockError(`Otti Connect already runs with the sign-in in ${dir} (process ${lock.holder}). Stop that one first, or give this one a sign-in of its own with --config-dir.`, lock.holder);
  return lock.release;
}

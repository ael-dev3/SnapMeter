import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, type PathLike } from "node:fs";
import { dirname } from "node:path";

export interface ProcessLock {
  path: string;
  release(): void;
}

export function acquireProcessLock(path: string, pid = process.pid): ProcessLock {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify({ pid, startedAt: new Date().toISOString() }), { encoding: "utf8" });
      } finally {
        closeSync(descriptor);
      }
      let released = false;
      return {
        path,
        release(): void {
          if (released) return;
          released = true;
          try {
            const owner = parsePid(path);
            if (owner === pid) unlinkSync(path);
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        }
      };
    } catch (error) {
      if (!isExists(error)) throw error;
      const owner = parsePid(path);
      if (owner !== null && processExists(owner)) {
        throw new Error(`another SnapMeter collector is already running (pid ${owner})`, { cause: error });
      }
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if (!isMissing(unlinkError)) throw unlinkError;
      }
    }
  }
  throw new Error("could not acquire the collector process lock");
}

function parsePid(path: PathLike): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

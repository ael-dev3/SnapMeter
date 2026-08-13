import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireProcessLock } from "./lock.js";

describe("collector process lock", () => {
  it("prevents duplicate collectors and releases only its own lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "snapmeter-lock-test-"));
    const path = join(directory, "collector.lock");
    try {
      const lock = acquireProcessLock(path);
      expect(() => acquireProcessLock(path)).toThrow(/already running/);
      lock.release();
      expect(() => acquireProcessLock(path).release()).not.toThrow();
    } finally {
      const resolved = resolve(directory);
      if (resolved.startsWith(resolve(tmpdir()))) rmSync(resolved, { recursive: true, force: true });
    }
  });
});

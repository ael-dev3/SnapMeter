import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

describe("structured logging", () => {
  it("redacts sensitive fields and configured secrets", () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line), now: () => 0, secrets: ["private-value"] });
    logger.info("test", { authorization: "Bearer private-value", nested: { message: "failure private-value", token: "abc" } });
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record.authorization).toBe("[REDACTED]");
    expect(JSON.stringify(record)).not.toContain("private-value");
    expect(JSON.stringify(record)).not.toContain("abc");
  });
});

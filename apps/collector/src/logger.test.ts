import { describe, expect, it } from "vitest";
import { createLogger, sensitiveEnvironmentValues } from "./logger.js";

describe("structured logging", () => {
  it("redacts sensitive fields and configured secrets", () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line), now: () => 0, secrets: ["private-value"] });
    logger.info("test", {
      authorization: "Bearer private-value",
      apiKey: "neynar-key",
      actorPseudonymKey: "pseudonym-private-value",
      hash_key: "hash-private-value",
      nested: { message: "failure private-value", token: "abc" }
    });
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record.authorization).toBe("[REDACTED]");
    expect(JSON.stringify(record)).not.toContain("private-value");
    expect(JSON.stringify(record)).not.toContain("neynar-key");
    expect(JSON.stringify(record)).not.toContain("abc");
    expect(JSON.stringify(record)).not.toContain("pseudonym-private-value");
    expect(JSON.stringify(record)).not.toContain("hash-private-value");
  });

  it("collects only sensitive environment values for fatal-error scrubbing", () => {
    expect(sensitiveEnvironmentValues({
      SNAPMETER_INGEST_SECRET: "  secret-value  ",
      SNAPCHAIN_GRPC_API_KEY: "api-key-value",
      SNAPCHAIN_GRPC_URL: "public.example:443"
    })).toEqual(expect.arrayContaining(["  secret-value  ", "secret-value", "api-key-value"]));
    expect(sensitiveEnvironmentValues({ SNAPCHAIN_GRPC_URL: "public.example:443" })).toEqual([]);
  });
});

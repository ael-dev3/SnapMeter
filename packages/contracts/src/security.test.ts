import { describe, expect, it } from "vitest";
import { constantTimeEqual, isFreshTimestamp, signIngest, verifyIngestSignature } from "./security";

describe("ingest HMAC", () => {
  it("signs and verifies the raw body", async () => {
    const signature = await signIngest("secret-value", "1700000000000", "batch-a", "{\"a\":1}");
    await expect(verifyIngestSignature("secret-value", "1700000000000", "batch-a", "{\"a\":1}", signature)).resolves.toBe(true);
    await expect(verifyIngestSignature("secret-value", "1700000000000", "batch-a", "{\"a\":2}", signature)).resolves.toBe(false);
    await expect(verifyIngestSignature("secret-value", "1700000000000", "batch-a", "{\"a\":1}", signature.slice(3))).resolves.toBe(false);
    await expect(verifyIngestSignature("secret-value", "1700000000000", "batch-a", "{\"a\":1}", signature.toUpperCase())).resolves.toBe(false);
  });

  it("rejects malformed or stale timestamps", () => {
    expect(isFreshTimestamp("1000", 400_001)).toBe(false);
    expect(isFreshTimestamp("not-time", 1000)).toBe(false);
    expect(isFreshTimestamp("1000", 301_000)).toBe(true);
  });

  it("compares unequal lengths without accepting prefixes", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBe(false);
  });
});

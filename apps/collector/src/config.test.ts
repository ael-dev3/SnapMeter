import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("collector configuration", () => {
  it("uses the platform-local app-data root and allows endpoint TLS/auth overrides", () => {
    const localAppData = resolve("test-local-app-data");
    const config = loadConfig({
      LOCALAPPDATA: localAppData,
      SNAPCHAIN_GRPC_URL: "snap.example:443",
      SNAPCHAIN_GRPC_TLS: "true",
      SNAPCHAIN_GRPC_AUTHORIZATION: "Bearer private",
      HYPERSNAP_GRPC_URL: "[::1]:4383"
    });
    expect(config.dataDir).toBe(join(localAppData, "SnapMeter"));
    expect(config.endpoints.snapchain).toMatchObject({
      url: "snap.example:443",
      tls: true,
      authorization: "Bearer private",
      sourceMode: "verified"
    });
    expect(config.endpoints.hypersnap.sourceMode).toBe("derived");
    expect(config.retentionDays).toBeGreaterThanOrEqual(31);
  });

  it("requires ingest URL and secret together", () => {
    expect(() => loadConfig({ SNAPMETER_INGEST_URL: "https://example.test/api/v1/ingest/batch" })).toThrow(/configured together/);
    expect(() => loadConfig({
      SNAPMETER_INGEST_URL: "https://example.test/api/v1/ingest/batch",
      SNAPMETER_INGEST_SECRET: "too-short"
    })).toThrow(/at least 32/);
  });

  it("rejects verified Hypersnap without a dedicated verified-write adapter", () => {
    expect(() => loadConfig({ HYPERSNAP_SOURCE_MODE: "verified" })).toThrow(/only implements derived or unavailable/);
  });

  it("does not mislabel canonical Snapchain activity as derived", () => {
    expect(() => loadConfig({ SNAPCHAIN_SOURCE_MODE: "derived" })).toThrow(/verified or unavailable/);
  });

  it("rejects schemes and invalid booleans in gRPC configuration", () => {
    expect(() => loadConfig({ SNAPCHAIN_GRPC_URL: "http://localhost:3383" })).toThrow(/host:port/);
    expect(() => loadConfig({ SNAPCHAIN_GRPC_TLS: "sometimes" })).toThrow(/true or false/);
  });
});

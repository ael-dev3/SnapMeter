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
      SNAPCHAIN_GRPC_API_KEY: "neynar-private",
      SNAPCHAIN_RPC_MIN_INTERVAL_MS: "250",
      HYPERSNAP_GRPC_URL: "[::1]:4383"
    });
    expect(config.dataDir).toBe(join(localAppData, "SnapMeter"));
    expect(config.endpoints.snapchain).toMatchObject({
      url: "snap.example:443",
      tls: true,
      authorization: "Bearer private",
      apiKey: "neynar-private",
      getEventsMinIntervalMs: 250,
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

  it("requires protected remote ingest and rejects URL credential channels", () => {
    const secret = "test-secret-with-at-least-32-characters";
    expect(loadConfig({
      SNAPMETER_INGEST_URL: "http://127.0.0.1:5173/api/v1/ingest/batch",
      SNAPMETER_INGEST_SECRET: secret
    }).ingestUrl).toBe("http://127.0.0.1:5173/api/v1/ingest/batch");
    expect(() => loadConfig({
      SNAPMETER_INGEST_URL: "http://example.test/api/v1/ingest/batch",
      SNAPMETER_INGEST_SECRET: secret
    })).toThrow(/must use HTTPS/);
    expect(() => loadConfig({
      SNAPMETER_INGEST_URL: "https://user:password@example.test/api/v1/ingest/batch",
      SNAPMETER_INGEST_SECRET: secret
    })).toThrow(/must not contain credentials/);
    expect(() => loadConfig({
      SNAPMETER_INGEST_URL: "https://example.test/api/v1/ingest/batch?secret=value",
      SNAPMETER_INGEST_SECRET: secret
    })).toThrow(/query string or fragment/);
  });

  it("rejects verified Hypersnap without a dedicated verified-write adapter", () => {
    expect(() => loadConfig({ HYPERSNAP_SOURCE_MODE: "verified" })).toThrow(/only implements derived or unavailable/);
  });

  it("does not mislabel canonical Snapchain activity as derived", () => {
    expect(() => loadConfig({ SNAPCHAIN_SOURCE_MODE: "derived" })).toThrow(/verified or unavailable/);
  });

  it("rejects schemes and invalid booleans in gRPC configuration", () => {
    expect(() => loadConfig({ SNAPCHAIN_GRPC_URL: "http://localhost:3383" })).toThrow(/host:port/);
    expect(() => loadConfig({ SNAPCHAIN_GRPC_URL: "user@localhost:3383" })).toThrow(/host:port/);
    expect(() => loadConfig({ SNAPCHAIN_GRPC_URL: "localhost/path:3383" })).toThrow(/host:port/);
    expect(() => loadConfig({ SNAPCHAIN_GRPC_TLS: "sometimes" })).toThrow(/true or false/);
  });

  it("never sends RPC credentials over a non-loopback plaintext endpoint", () => {
    expect(() => loadConfig({
      SNAPCHAIN_GRPC_URL: "snap.example:3383",
      SNAPCHAIN_GRPC_API_KEY: "private-key"
    })).toThrow(/GRPC_TLS must be true/);
    expect(loadConfig({
      SNAPCHAIN_GRPC_URL: "127.0.0.2:3383",
      SNAPCHAIN_GRPC_API_KEY: "local-key"
    }).endpoints.snapchain.apiKey).toBe("local-key");
    expect(() => loadConfig({
      SNAPCHAIN_GRPC_AUTHORIZATION: "Bearer value\nInjected: value"
    })).toThrow(/control characters/);
  });

  it("defaults RPC pacing to zero and rejects invalid minimum intervals", () => {
    expect(loadConfig({}).endpoints.snapchain.getEventsMinIntervalMs).toBe(0);
    expect(() => loadConfig({ SNAPCHAIN_RPC_MIN_INTERVAL_MS: "-1" })).toThrow(/SNAPCHAIN_RPC_MIN_INTERVAL_MS/);
    expect(() => loadConfig({ HYPERSNAP_RPC_MIN_INTERVAL_MS: "2.5" })).toThrow(/HYPERSNAP_RPC_MIN_INTERVAL_MS/);
  });
});

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
      transport: "grpc",
      tls: true,
      authorization: "Bearer private",
      apiKey: "neynar-private",
      getEventsMinIntervalMs: 250,
      sourceMode: "verified"
    });
    expect(config.endpoints.hypersnap.sourceMode).toBe("derived");
    expect(config.endpoints.hypersnap.timeoutMs).toBe(5_000);
    expect(config.retentionDays).toBeGreaterThanOrEqual(31);
  });

  it("configures a peer-pinned HTTPS Hypersnap fallback independently", () => {
    const config = loadConfig({
      HYPERSNAP_FALLBACK_HTTP_URL: "https://public.example",
      HYPERSNAP_FALLBACK_EXPECTED_PEER_ID: "12D3KooWMYfkXiNcn9LifPkLYiHtGmXYnknYG1yFBD53rUseUMUc",
      HYPERSNAP_FALLBACK_EXPECTED_VERSION: "0.13.3",
      HYPERSNAP_FALLBACK_POLL_INTERVAL_MS: "750",
      HYPERSNAP_FALLBACK_RPC_MIN_INTERVAL_MS: "300",
      HYPERSNAP_FAILOVER_AFTER_FAILURES: "2",
      HYPERSNAP_PREFERRED_RECOVERY_SUCCESSES: "4"
    });
    expect(config.endpoints.hypersnap).toMatchObject({
      transport: "grpc",
      failoverAfterFailures: 2,
      preferredRecoverySuccesses: 4,
      fallback: {
        url: "https://public.example/",
        transport: "https-json",
        tls: true,
        expectedPeerId: "12D3KooWMYfkXiNcn9LifPkLYiHtGmXYnknYG1yFBD53rUseUMUc",
        expectedVersion: "0.13.3",
        pollIntervalMs: 750,
        getEventsMinIntervalMs: 300
      }
    });
  });

  it("fails closed for unpinned, plaintext, or malformed public fallbacks", () => {
    expect(() => loadConfig({
      HYPERSNAP_FALLBACK_HTTP_URL: "https://public.example"
    })).toThrow(/EXPECTED_PEER_ID is required/);
    expect(() => loadConfig({
      HYPERSNAP_FALLBACK_HTTP_URL: "http://127.0.0.1:3381",
      HYPERSNAP_FALLBACK_EXPECTED_PEER_ID: "12D3KooWMYfkXiNcn9LifPkLYiHtGmXYnknYG1yFBD53rUseUMUc",
      HYPERSNAP_FALLBACK_EXPECTED_VERSION: "0.13.3"
    })).toThrow(/must use HTTPS/);
    expect(() => loadConfig({
      HYPERSNAP_FALLBACK_EXPECTED_PEER_ID: "12D3KooWMYfkXiNcn9LifPkLYiHtGmXYnknYG1yFBD53rUseUMUc"
    })).toThrow(/require HYPERSNAP_FALLBACK_HTTP_URL/);
    expect(() => loadConfig({
      HYPERSNAP_FALLBACK_HTTP_URL: "https://public.example",
      HYPERSNAP_FALLBACK_EXPECTED_PEER_ID: "not-a-peer!",
      HYPERSNAP_FALLBACK_EXPECTED_VERSION: "0.13.3"
    })).toThrow(/base58 peer identifier/);
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
      SNAPCHAIN_GRPC_URL: "public.example:3383"
    })).toThrow(/GRPC_TLS must be true/);
    expect(() => loadConfig({
      SNAPCHAIN_GRPC_URL: "snap.example:3383",
      SNAPCHAIN_GRPC_API_KEY: "private-key"
    })).toThrow(/GRPC_TLS must be true/);
    expect(loadConfig({
      SNAPCHAIN_GRPC_URL: "127.0.0.2:3383",
      SNAPCHAIN_GRPC_API_KEY: "local-key"
    }).endpoints.snapchain.apiKey).toBe("local-key");
    expect(() => loadConfig({
      SNAPCHAIN_GRPC_URL: "10.0.0.2:3383",
      SNAPCHAIN_GRPC_API_KEY: "private-key"
    })).toThrow(/credentials are configured for a non-loopback endpoint/);
    expect(() => loadConfig({
      SNAPCHAIN_GRPC_URL: "host.docker.internal:3383",
      SNAPCHAIN_GRPC_AUTHORIZATION: "Bearer private"
    })).toThrow(/credentials are configured for a non-loopback endpoint/);
    expect(loadConfig({ SNAPCHAIN_GRPC_URL: "192.168.1.2:3383" }).endpoints.snapchain.tls).toBe(false);
    expect(() => loadConfig({
      SNAPCHAIN_GRPC_AUTHORIZATION: "Bearer value\nInjected: value"
    })).toThrow(/control characters/);
  });

  it("accepts the checked-in Docker host-gateway endpoints as private plaintext transports", () => {
    const config = loadConfig({
      SNAPCHAIN_GRPC_URL: "host.docker.internal:3383",
      SNAPCHAIN_GRPC_TLS: "false",
      HYPERSNAP_GRPC_URL: "host.docker.internal:4383",
      HYPERSNAP_GRPC_TLS: "false"
    });
    expect(config.endpoints.snapchain).toMatchObject({ url: "host.docker.internal:3383", tls: false });
    expect(config.endpoints.hypersnap).toMatchObject({ url: "host.docker.internal:4383", tls: false });
  });

  it("defaults RPC pacing to zero and rejects invalid minimum intervals", () => {
    expect(loadConfig({}).endpoints.snapchain.getEventsMinIntervalMs).toBe(0);
    expect(() => loadConfig({ SNAPCHAIN_RPC_MIN_INTERVAL_MS: "-1" })).toThrow(/SNAPCHAIN_RPC_MIN_INTERVAL_MS/);
    expect(() => loadConfig({ HYPERSNAP_RPC_MIN_INTERVAL_MS: "2.5" })).toThrow(/HYPERSNAP_RPC_MIN_INTERVAL_MS/);
  });
});

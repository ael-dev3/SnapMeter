#!/usr/bin/env node
import { statSync } from "node:fs";
import { loadConfig, type RpcEndpointConfig } from "./config.js";
import { CollectorRuntime } from "./collector.js";
import { CollectorDatabase } from "./database.js";
import { runDoctor } from "./doctor.js";
import { acquireProcessLock } from "./lock.js";
import { createLogger, redact, sensitiveEnvironmentValues } from "./logger.js";

const command = process.argv[2] ?? "help";

async function main(): Promise<void> {
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  assertSupportedNode();
  const config = loadConfig();
  const secrets = [
    config.ingestSecret ?? "",
    config.endpoints.snapchain.authorization ?? "",
    config.endpoints.snapchain.apiKey ?? "",
    config.endpoints.hypersnap.authorization ?? "",
    config.endpoints.hypersnap.apiKey ?? ""
  ];
  const logger = createLogger({
    secrets,
    minimumLevel: process.env.SNAPMETER_LOG_LEVEL === "debug" ? "debug" : "info"
  });
  const database = new CollectorDatabase(config.databasePath);
  try {
    if (command === "status") {
      const report = {
        checkedAtMs: Date.now(),
        database: database.status(),
        integrity: database.integrityCheck(),
        databaseBytes: fileSize(config.databasePath),
        cursors: database.getCursors(),
        sources: database.sourceHealth(),
        configuration: {
          dataDir: config.dataDir,
          ingestConfigured: Boolean(config.ingestUrl),
          endpoints: {
            snapchain: endpointSummary(config.endpoints.snapchain),
            hypersnap: endpointSummary(config.endpoints.hypersnap)
          },
          retentionDays: config.retentionDays
        }
      };
      process.stdout.write(`${JSON.stringify(redact(report, secrets), null, 2)}\n`);
      return;
    }
    if (command === "doctor") {
      const report = await runDoctor({ config, database });
      process.stdout.write(`${JSON.stringify(redact(report, secrets), null, 2)}\n`);
      if (!report.ok) process.exitCode = 1;
      return;
    }
    if (command === "run" || command === "backfill") {
      const lock = acquireProcessLock(config.lockPath);
      const runtime = new CollectorRuntime({ config, database, logger });
      const removeSignals = installSignalHandlers(() => runtime.stop());
      try {
        if (command === "run") await runtime.run();
        else await runtime.backfill();
      } finally {
        removeSignals();
        lock.release();
      }
      return;
    }
    throw new Error(`unknown collector command: ${command}`);
  } finally {
    database.close();
  }
}

function assertSupportedNode(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 24) {
    throw new Error(`SnapMeter collector requires Node.js 24 or newer for stable node:sqlite; found ${process.version}`);
  }
}

function endpointSummary(endpoint: RpcEndpointConfig): Record<string, unknown> {
  return {
    url: endpoint.url,
    transport: endpoint.transport,
    tls: endpoint.tls,
    sourceMode: endpoint.sourceMode,
    authorizationConfigured: Boolean(endpoint.authorization),
    apiKeyConfigured: Boolean(endpoint.apiKey),
    getEventsMinIntervalMs: endpoint.getEventsMinIntervalMs,
    identityPinned: Boolean(endpoint.expectedPeerId || endpoint.expectedVersion),
    fallback: endpoint.fallback ? {
      transport: endpoint.fallback.transport,
      tls: endpoint.fallback.tls,
      identityPinned: Boolean(endpoint.fallback.expectedPeerId && endpoint.fallback.expectedVersion),
      getEventsMinIntervalMs: endpoint.fallback.getEventsMinIntervalMs,
      pollIntervalMs: endpoint.fallback.pollIntervalMs
    } : null
  };
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function installSignalHandlers(shutdown: () => void): () => void {
  const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
  for (const signal of signals) process.once(signal, shutdown);
  return () => {
    for (const signal of signals) process.removeListener(signal, shutdown);
  };
}

function printHelp(): void {
  process.stdout.write([
    "SnapMeter Windows collector",
    "",
    "Usage: pnpm collector <command>",
    "",
    "Commands:",
    "  doctor    Check RPCs, shard coverage, SQLite, clocks, cloud auth, cursors and disk",
    "  run       Subscribe continuously, reconcile gaps and deliver signed micro-batches",
    "  status    Print local state without contacting upstream services",
    "  backfill  Replay durable cursors without emitting live pulses",
    ""
  ].join("\n"));
}

void main().catch((error: unknown) => {
  createLogger({
    write: (line) => process.stderr.write(`${line}\n`),
    secrets: sensitiveEnvironmentValues(process.env),
    minimumLevel: "error"
  }).error("collector.fatal", { error });
  process.exitCode = 1;
});

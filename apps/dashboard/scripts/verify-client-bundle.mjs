import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import {
  expectedThirdPartyNotice,
  NOTICE_FILE_NAME,
  WARPKEEP_NOTICE_COPYRIGHT,
  WARPKEEP_SOURCE_COMMIT
} from "./generate-third-party-licenses.mjs";

const root = resolve(import.meta.dirname, "..");
const clientRoot = join(root, "dist", "client");
const workerRoot = join(root, "dist", "snapmeter");
const forbidden = [
  ["server-only ingest secret name", "SNAPMETER_INGEST_SECRET"],
  ["server-only Snapchain credential name", "SNAPCHAIN_GRPC_API_KEY"],
  ["server-only Hypersnap credential name", "HYPERSNAP_GRPC_API_KEY"],
  ["Cloudflare deployment credential name", "CLOUDFLARE_API_TOKEN"],
  ["unused LGPL RPC package", "rpc-websockets"],
  ["unused RPC client implementation", "generate_request_id"],
  ["unused Solana wallet implementation", "SolanaConnection"]
];
const forbiddenNoticeInventory = [
  "rpc-websockets",
  "text-encoding-utf-8",
  "@solana/web3.js"
];

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const violations = [];
const generatedDevVars = join(workerRoot, ".dev.vars");
if (existsSync(generatedDevVars)) {
  violations.push(`${relative(root, generatedDevVars)} must not survive a production build`);
}
for (const path of files(clientRoot)) {
  const stats = statSync(path);
  if (stats.size > 5 * 1024 * 1024) {
    violations.push(`${relative(clientRoot, path)} exceeds the 5 MiB review limit`);
    continue;
  }
  if (!/\.(?:html|js|json|mjs|css)$/u.test(path)) continue;
  const content = readFileSync(path, "utf8");
  for (const [label, marker] of forbidden) {
    if (content.includes(marker)) violations.push(`${relative(clientRoot, path)} contains ${label}`);
  }
}

let expectedNotice;
try {
  expectedNotice = expectedThirdPartyNotice();
} catch (error) {
  violations.push(error instanceof Error ? error.message : String(error));
}

if (expectedNotice !== undefined) {
  for (const outputRoot of [clientRoot, workerRoot]) {
    const noticePath = join(outputRoot, NOTICE_FILE_NAME);
    let actualNotice;
    try {
      actualNotice = readFileSync(noticePath, "utf8");
    } catch {
      violations.push(`${relative(root, noticePath)} is missing`);
      continue;
    }
    if (actualNotice !== expectedNotice) {
      violations.push(`${relative(root, noticePath)} is stale or incomplete`);
    }
  }

  const requiredInventory = [
    "Warpkeep-derived Mini App code",
    `https://github.com/ael-dev3/Warpkeep/tree/${WARPKEEP_SOURCE_COMMIT}`,
    WARPKEEP_NOTICE_COPYRIGHT,
    "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION",
    "END OF TERMS AND CONDITIONS",
    "## @farcaster/miniapp-sdk - 0.3.0 (MIT)",
    "## @farcaster/quick-auth - 0.0.8 (MIT)",
    "## comlink - 4.4.2 (Apache-2.0)",
    "## jose - 5.10.0 (MIT)",
    "## react-dom - 19.2.8 (MIT)",
    "## react - 19.2.8 (MIT)",
    "## scheduler - 0.27.0 (MIT)",
    "## zod - 4.4.3 (MIT)",
    "Copyright 2019 Google LLC",
    "Copyright (c) 2025 Farcaster"
  ];
  for (const marker of requiredInventory) {
    if (!expectedNotice.includes(marker)) {
      violations.push(`${NOTICE_FILE_NAME} is missing required notice marker: ${marker}`);
    }
  }
  for (const marker of forbiddenNoticeInventory) {
    if (expectedNotice.includes(`## ${marker} -`)) {
      violations.push(`${NOTICE_FILE_NAME} unexpectedly includes unused dependency: ${marker}`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write("Client bundle safety check failed:\n");
  for (const violation of violations) process.stderr.write(`- ${violation}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Bundle safety check passed: no server credentials or unused wallet/RPC stack detected, and browser/Worker redistribution notices are current.\n");
}

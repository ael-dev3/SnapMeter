import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";

export const NOTICE_FILE_NAME = "THIRD_PARTY_LICENSES.txt";
export const ENVIRONMENT_NOTICE_PATH = join(".vite", "third-party-licenses.md");

const dashboardRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(dashboardRoot, "..", "..");
const distRoot = join(dashboardRoot, "dist");
const generatedDevVarsPath = join(distRoot, "snapmeter", ".dev.vars");
const apacheLicensePath = join(repositoryRoot, "LICENSES", "Apache-2.0.txt");
const APACHE_LICENSE_SHA256 = "283ea6cc2997a1a70da0049e09adf9317bb60ca1b51279b65196b83a69e1996b";
export const WARPKEEP_SOURCE_COMMIT = "96e49cdb60b2fc8483e63f9df58447e5acbc6b92";
export const WARPKEEP_NOTICE_COPYRIGHT = "Copyright 2026 Warpkeep contributors";
const APACHE_ATTRIBUTIONS = new Map([
  ["comlink", "Copyright 2019 Google LLC"]
]);
const REVIEWED_MISSING_LICENSE_TEXTS = new Map([
  // @farcaster/quick-auth 0.0.8 declares MIT but its published `files` list
  // omits LICENSE. This is the MIT text and Farcaster notice reviewed at the
  // package's upstream 0.0.8 version-bump commit.
  ["@farcaster/quick-auth", [
    "Upstream notice source: https://github.com/farcasterxyz/quick-auth/blob/79e064d75c3d03ca797401d49e8e8cc33a3bdfc9/hono-cloudflare-worker/LICENSE",
    "",
    "MIT License",
    "",
    "Copyright (c) 2025 Farcaster",
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    "of this software and associated documentation files (the \"Software\"), to deal",
    "in the Software without restriction, including without limitation the rights",
    "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
    "copies of the Software, and to permit persons to whom the Software is",
    "furnished to do so, subject to the following conditions:",
    "",
    "The above copyright notice and this permission notice shall be included in all",
    "copies or substantial portions of the Software.",
    "",
    "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR",
    "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
    "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
    "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
    "SOFTWARE."
  ].join("\n")]
]);

function normalized(value) {
  return value.replaceAll("\r\n", "\n").trim();
}

function warpkeepAdaptationNotice() {
  let license;
  try {
    license = normalized(readFileSync(apacheLicensePath, "utf8"));
  } catch {
    throw new Error(`missing Apache-2.0 license: ${relative(repositoryRoot, apacheLicensePath)}`);
  }
  const digest = createHash("sha256").update(license).digest("hex");
  if (digest !== APACHE_LICENSE_SHA256) {
    throw new Error(`Apache-2.0 license is incomplete or stale: ${relative(repositoryRoot, apacheLicensePath)}`);
  }
  return [
    "Warpkeep-derived Mini App code",
    "--------------------------------",
    "",
    "Portions of the browser Mini App runtime and provider were adapted and",
    "modified from Warpkeep under the Apache License 2.0.",
    `Source: https://github.com/ael-dev3/Warpkeep/tree/${WARPKEEP_SOURCE_COMMIT}`,
    "",
    "Applicable upstream NOTICE:",
    "",
    "Warpkeep",
    WARPKEEP_NOTICE_COPYRIGHT,
    "",
    "Apache License 2.0",
    "------------------",
    "",
    license
  ].join("\n");
}

function withRequiredAttributions(source) {
  const completed = source.replace(
    /^(## ([^\s]+) - [^\n]+\(([^)]+)\)\n)\n(?=## |$)/gmu,
    (_match, heading, packageName, license) => {
      const reviewedText = REVIEWED_MISSING_LICENSE_TEXTS.get(packageName);
      if (license !== "MIT" || !reviewedText) {
        throw new Error(`${packageName} (${license}) has no bundled license text and requires review`);
      }
      return `${heading}\n${reviewedText}\n\n`;
    }
  );
  const attributed = completed.replace(
    /^(## ([^\s]+) - [^\n]+\(Apache-2\.0\)\n)/gmu,
    (_match, heading, packageName) => {
      const attribution = APACHE_ATTRIBUTIONS.get(packageName);
      if (!attribution) {
        throw new Error(`Apache-2.0 dependency ${packageName} requires a reviewed attribution rule`);
      }
      return `${heading}\n${attribution}\n`;
    }
  );
  const emptyLicenseEntry = attributed.match(
    /^## ([^\s]+) - [^\n]+\(([^)]+)\)\n\n(?=## |$)/mu
  );
  if (emptyLicenseEntry) {
    throw new Error(`${emptyLicenseEntry[1]} (${emptyLicenseEntry[2]}) has no bundled license text and requires review`);
  }
  return attributed;
}

function readEnvironmentNotice(environment) {
  const path = join(distRoot, environment, ENVIRONMENT_NOTICE_PATH);
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    throw new Error(`missing Vite license inventory: ${relative(dashboardRoot, path)}`);
  }
  const content = normalized(source);
  if (!content.startsWith("# Licenses\n")) {
    throw new Error(`invalid Vite license inventory: ${relative(dashboardRoot, path)}`);
  }
  return withRequiredAttributions(content);
}

export function expectedThirdPartyNotice() {
  const warpkeep = warpkeepAdaptationNotice();
  const client = readEnvironmentNotice("client");
  const worker = readEnvironmentNotice("snapmeter");
  return [
    "SnapMeter third-party redistribution notices",
    "============================================",
    "",
    "This file combines the required notice for adapted project code with licenses",
    "generated from the exact production modules bundled by Vite. It covers both",
    "the public browser assets and the Cloudflare Worker bundle.",
    "The source release and its separately vendored protocol notices are documented",
    "in the repository root THIRD_PARTY_NOTICES.md.",
    "",
    warpkeep,
    "",
    "Browser bundle",
    "--------------",
    "",
    client,
    "",
    "Cloudflare Worker bundle",
    "------------------------",
    "",
    worker,
    ""
  ].join("\n");
}

export function writeThirdPartyNotice() {
  try {
    const notice = expectedThirdPartyNotice();
    const clientPath = join(distRoot, "client", NOTICE_FILE_NAME);
    const workerPath = join(distRoot, "snapmeter", NOTICE_FILE_NAME);
    writeFileSync(clientPath, notice, "utf8");
    writeFileSync(workerPath, notice, "utf8");
    return { clientPath, workerPath };
  } finally {
    // Cloudflare's Vite build may materialize process.env secrets for local
    // preview. It is not a deployment input and must not survive either a
    // successful build or a failed notice-generation/review step.
    rmSync(generatedDevVarsPath, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const paths = writeThirdPartyNotice();
    process.stdout.write(
      `Third-party license notice generated for ${relative(dashboardRoot, paths.clientPath)} and ${relative(dashboardRoot, paths.workerPath)}.\n`
    );
  } catch (error) {
    process.stderr.write(`Third-party license generation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

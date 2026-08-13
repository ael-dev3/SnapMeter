import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import process from "node:process";

const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const allowedEnvironmentFiles = new Set([".env.example"]);
const forbiddenDirectories = new Set([
  ".wrangler",
  "blob-report",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
  "work"
]);
const forbiddenExtensions = new Set([
  ".db",
  ".key",
  ".log",
  ".p12",
  ".pem",
  ".pfx",
  ".sqlite",
  ".sqlite3"
]);

const secretPatterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/u],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/u],
  ["Stripe live secret", /\bsk_live_[0-9A-Za-z]{16,}\b/u],
  ["credential-bearing URL", /https?:\/\/[^\s/:]+:[^\s/@]+@/iu]
];

function trackedFiles() {
  const raw = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" });
  return raw.split("\0").filter(Boolean);
}

function pathViolation(path) {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (parts.some((part) => forbiddenDirectories.has(part))) return "generated/runtime directory";

  const name = basename(normalized).toLowerCase();
  if ((name === ".env" || name.startsWith(".env.") || name.startsWith(".dev.vars") || name === ".collector.env")
    && !allowedEnvironmentFiles.has(name)) {
    return "environment or secret file";
  }

  const extension = extname(name);
  if (forbiddenExtensions.has(extension) || /\.(?:db|sqlite|sqlite3)-(?:journal|shm|wal)$/u.test(name)) {
    return "credential, database, or log extension";
  }
  return null;
}

const violations = [];
for (const path of trackedFiles()) {
  const pathProblem = pathViolation(path);
  if (pathProblem) violations.push(`${path}: ${pathProblem}`);

  let stats;
  try {
    stats = statSync(path);
  } catch {
    violations.push(`${path}: tracked path is missing from the working tree`);
    continue;
  }
  if (!stats.isFile() || stats.size > MAX_TEXT_BYTES) continue;

  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8").replaceAll(
    "https://user:password@example.test/",
    "https://example.test/"
  );
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(text)) violations.push(`${path}: possible ${label}`);
  }
}

if (violations.length > 0) {
  process.stderr.write("Publication safety check failed:\n");
  for (const violation of violations) process.stderr.write(`- ${violation}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Publication safety check passed: tracked paths and high-confidence secret patterns are clean.\n");
}

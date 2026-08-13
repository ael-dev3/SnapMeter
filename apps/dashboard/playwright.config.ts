import { defineConfig, devices } from "@playwright/test";

const e2ePort = process.env.SNAPMETER_E2E_PORT ?? "4173";
if (!/^\d{4,5}$/.test(e2ePort) || Number(e2ePort) < 1_024 || Number(e2ePort) > 65_535) {
  throw new Error("SNAPMETER_E2E_PORT must be a valid unprivileged TCP port");
}
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: e2eBaseUrl,
    trace: "retain-on-failure"
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } }
  ],
  webServer: {
    command: `pnpm dev --host 127.0.0.1 --port ${e2ePort}`,
    url: e2eBaseUrl,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      SNAPMETER_INGEST_SECRET: process.env.SNAPMETER_INGEST_SECRET ?? "local-e2e-secret-not-for-production"
    }
  }
});

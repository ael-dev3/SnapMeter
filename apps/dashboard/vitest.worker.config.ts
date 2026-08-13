import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("../../migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            SNAPMETER_INGEST_SECRET: "worker-test-secret-with-32-characters",
            TEST_MIGRATIONS: migrations
          }
        }
      })
    ],
    test: {
      include: ["worker/**/*.worker.test.ts"],
      setupFiles: ["./worker/test-setup.ts"],
      // Durable Object + D1 integration can exceed Vitest's 5s unit-test
      // default on a busy development host without indicating a product SLA.
      testTimeout: 15_000
    }
  };
});

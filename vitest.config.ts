import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/collector/src/**/*.test.ts"],
    maxWorkers: 4,
    // Real SQLite/WAL migration and network-free collector integration tests
    // can contend on Windows when four workers run concurrently.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/*/src/**/*.ts", "apps/collector/src/**/*.ts", "apps/dashboard/worker/**/*.ts"]
    },
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**", "apps/dashboard/**"]
  }
});

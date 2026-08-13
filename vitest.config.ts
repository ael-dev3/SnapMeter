import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/collector/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/*/src/**/*.ts", "apps/collector/src/**/*.ts", "apps/dashboard/worker/**/*.ts"]
    },
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**", "apps/dashboard/**"]
  }
});

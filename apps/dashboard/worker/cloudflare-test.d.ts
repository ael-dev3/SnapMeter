import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare module "cloudflare:workers" {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      LIVE_ROOM: DurableObjectNamespace;
      SNAPMETER_INGEST_SECRET: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

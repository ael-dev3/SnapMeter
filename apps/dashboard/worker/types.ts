export interface Env {
  DB: D1Database;
  LIVE_ROOM: DurableObjectNamespace;
  SNAPMETER_INGEST_SECRET: string;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ScheduledControllerLike {
  cron: string;
  scheduledTime: number;
}

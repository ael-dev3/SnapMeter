import type { NodeInfo, RawHubEvent } from "@snapmeter/protocol";
import { FARCASTER_EPOCH_MS } from "@snapmeter/protocol";
import { shouldEmitPulse } from "@snapmeter/metrics";
import type { Source, SourceMode, SourceStatus } from "@snapmeter/contracts";
import type { CollectorConfig } from "./config.js";
import { defaultActivityAdapterFactory, type ActivityAdapterFactory, type SourceActivityAdapter } from "./adapter.js";
import { CollectorDatabase, compareEventIds, maxEventId, type SourceHealthRecord } from "./database.js";
import {
  OutboxDispatcher,
  PulseAccumulator,
  asHealthUpdate,
  buildComparisonSnapshot,
  buildMetricSnapshot,
  enqueueIngestBatch,
  type FetchLike,
  type HealthUpdate
} from "./delivery.js";
import type { Logger } from "./logger.js";
import { abortableDelay, exponentialBackoffMs, reconcileEvents } from "./reconcile.js";
import { defaultRpcFactory, rawEventId, rawEventShard, rawEventType, type CollectorRpc, type RpcFactory, type RpcSubscription } from "./rpc.js";

interface SourceRuntimeState {
  source: Source;
  sourceMode: SourceMode;
  version: string;
  shardIds: Set<number>;
  expectedShardCount: number;
  connectedShards: Set<number>;
  replayingShards: Set<number>;
  reconnectCount: number;
  reconciliationState: "ok" | "checking" | "gap" | "unknown";
  height: number | null;
  blockDelaySeconds: number | null;
  mempoolSize: number | null;
  synchronized: boolean;
  lastContactAtMs: number | null;
  lastError: string | null;
}

interface ShardWorker {
  controller: AbortController;
  promise: Promise<void>;
}

export interface CollectorRuntimeOptions {
  config: CollectorConfig;
  database: CollectorDatabase;
  logger: Logger;
  rpcFactory?: RpcFactory;
  fetcher?: FetchLike;
  now?: () => number;
  random?: () => number;
  activityAdapterFactory?: ActivityAdapterFactory;
}

export class CollectorRuntime {
  readonly #config: CollectorConfig;
  readonly #database: CollectorDatabase;
  readonly #logger: Logger;
  readonly #rpcFactory: RpcFactory;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #pulse = new PulseAccumulator();
  readonly #dispatcher: OutboxDispatcher;
  readonly #adapters = new Map<Source, SourceActivityAdapter>();
  readonly #controller = new AbortController();
  readonly #states = new Map<Source, SourceRuntimeState>();
  readonly #subscriptions = new Set<RpcSubscription>();
  readonly #clients = new Set<CollectorRpc>();
  #running = false;

  constructor(options: CollectorRuntimeOptions) {
    this.#config = options.config;
    this.#database = options.database;
    this.#logger = options.logger;
    this.#rpcFactory = options.rpcFactory ?? defaultRpcFactory;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#dispatcher = new OutboxDispatcher(
      options.database,
      options.config,
      options.logger,
      options.fetcher,
      this.#now,
      this.#random
    );
    const adapterFactory = options.activityAdapterFactory ?? defaultActivityAdapterFactory;
    for (const source of sources()) {
      const mode = options.config.endpoints[source].sourceMode;
      this.#states.set(source, initialState(source, mode));
      this.#adapters.set(source, adapterFactory(source, mode));
    }
  }

  async run(): Promise<void> {
    if (this.#running) throw new Error("collector runtime is already running");
    this.#running = true;
    this.#database.cleanup(this.#now(), this.#config.retentionDays);
    this.#database.setMetadata("collector_started_at_ms", String(this.#now()));
    this.#logger.info("collector.started", {
      collectorId: this.#database.collectorId,
      version: this.#config.collectorVersion,
      dataDir: this.#config.dataDir,
      ingestConfigured: Boolean(this.#config.ingestUrl)
    });
    const sourceTasks = sources().map((source) => this.#runSource(source, this.#controller.signal));
    const periodicTask = this.#runPeriodic(this.#controller.signal);
    try {
      await Promise.all([...sourceTasks, periodicTask]);
    } finally {
      this.#cancelSubscriptions();
      for (const client of this.#clients) client.close();
      this.#clients.clear();
      await this.#flushFinal();
      this.#database.setMetadata("collector_stopped_at_ms", String(this.#now()));
      this.#running = false;
      this.#logger.info("collector.stopped");
    }
  }

  stop(): void {
    if (this.#controller.signal.aborted) return;
    this.#logger.info("collector.shutdown_requested");
    this.#controller.abort();
    this.#cancelSubscriptions();
  }

  async backfill(): Promise<void> {
    const cutoffMs = this.#now() - this.#config.backfillDays * 86_400_000;
    this.#logger.info("backfill.started", { days: this.#config.backfillDays, cutoffMs });
    for (const source of sources()) {
      const endpoint = this.#config.endpoints[source];
      if (endpoint.sourceMode === "unavailable") continue;
      const rpc = this.#rpcFactory(endpoint);
      try {
        const info = await rpc.getInfo();
        const shardIds = discoveredShardIds(info);
        if (shardIds.length === 0) throw new Error("node reported no shards");
        for (const shard of shardIds) {
          const cursor = this.#database.getCursor(source, shard);
          const result = await reconcileEvents({
            rpc,
            shard,
            startId: "0",
            onEvent: (event) => this.#handleEvent(source, endpoint.sourceMode, shard, event, true, cutoffMs)
          });
          if (compareEventIds(result.lastEventId, cursor) > 0) {
            this.#database.checkpointCursor(source, shard, result.lastEventId, this.#now());
          }
          this.#logger.info("backfill.shard_complete", { source, shard, ...result });
        }
        this.#updateInfo(source, info);
        const state = this.#state(source);
        for (const shard of shardIds) state.connectedShards.add(shard);
        state.lastContactAtMs = this.#now();
        this.#publishHealth(source);
      } finally {
        rpc.close();
      }
    }
    this.#database.cleanup(this.#now(), this.#config.retentionDays);
    const snapshots = sources().map((source) => buildMetricSnapshot(this.#database, this.#config, source, this.#now()));
    enqueueIngestBatch(this.#database, this.#config, {
      snapshots,
      comparisonSnapshots: [buildComparisonSnapshot(this.#database, snapshots, this.#now())],
      health: this.#healthUpdates()
    }, this.#now());
    await this.#dispatcher.drainOnce();
    this.#logger.info("backfill.completed");
  }

  async #runSource(source: Source, signal: AbortSignal): Promise<void> {
    const endpoint = this.#config.endpoints[source];
    if (endpoint.sourceMode === "unavailable") {
      this.#publishHealth(source, "source configured as unavailable");
      await untilAborted(signal);
      return;
    }
    const rpc = this.#rpcFactory(endpoint);
    this.#clients.add(rpc);
    const workers = new Map<number, ShardWorker>();
    let discoveryFailures = 0;
    try {
      while (!signal.aborted) {
        try {
          const info = await rpc.getInfo();
          this.#updateInfo(source, info);
          const shardIds = discoveredShardIds(info);
          if (shardIds.length === 0) throw new Error("node reported zero discoverable shards");
          const desired = new Set(shardIds);
          for (const [shard, worker] of workers) {
            if (!desired.has(shard)) {
              worker.controller.abort();
              workers.delete(shard);
              this.#state(source).connectedShards.delete(shard);
              this.#state(source).replayingShards.delete(shard);
              this.#logger.warn("source.shard_removed", { source, shard });
            }
          }
          for (const shard of shardIds) {
            if (workers.has(shard)) continue;
            const controller = linkedAbortController(signal);
            const promise = this.#runShard(source, shard, rpc, controller.signal)
              .catch((error) => this.#logger.error("source.shard_worker_failed", { source, shard, error }));
            workers.set(shard, { controller, promise });
            this.#logger.info("source.shard_discovered", { source, shard });
          }
          discoveryFailures = 0;
          this.#state(source).lastContactAtMs = this.#now();
          this.#publishHealth(source);
          await abortableDelay(this.#config.discoveryIntervalMs, signal);
        } catch (error) {
          discoveryFailures += 1;
          const state = this.#state(source);
          state.lastError = errorMessage(error);
          state.synchronized = false;
          this.#publishHealth(source, "rpc_unavailable");
          const delayMs = exponentialBackoffMs(discoveryFailures - 1, { random: this.#random });
          this.#logger.warn("source.discovery_failed", { source, attempt: discoveryFailures, delayMs, error });
          await abortableDelay(delayMs, signal);
        }
      }
    } finally {
      for (const worker of workers.values()) worker.controller.abort();
      await Promise.all([...workers.values()].map((worker) => worker.promise));
      rpc.close();
      this.#clients.delete(rpc);
    }
  }

  async #runShard(source: Source, shard: number, rpc: CollectorRpc, signal: AbortSignal): Promise<void> {
    const mode = this.#config.endpoints[source].sourceMode;
    let reconnectAttempt = 0;
    while (!signal.aborted) {
      let subscription: RpcSubscription | null = null;
      let streamError: Error | null = null;
      let catchup = true;
      let highestSeen = this.#database.getCursor(source, shard);
      const subscriptionStartedAtMs = this.#now();
      try {
        const fromId = highestSeen;
        subscription = rpc.subscribe(
          shard,
          fromId,
          (event) => {
            const eventId = rawEventId(event);
            if (eventId) highestSeen = maxEventId(highestSeen, eventId);
            this.#handleEvent(source, mode, shard, event, catchup);
          },
          (error) => { streamError = error; }
        );
        this.#subscriptions.add(subscription);
        const state = this.#state(source);
        state.connectedShards.add(shard);
        state.replayingShards.add(shard);
        state.lastContactAtMs = this.#now();
        this.#publishHealth(source);

        const initial = await reconcileEvents({
          rpc,
          shard,
          startId: fromId,
          onEvent: (event) => {
            const eventId = rawEventId(event);
            if (eventId) highestSeen = maxEventId(highestSeen, eventId);
            this.#handleEvent(source, mode, shard, event, true);
          }
        });
        const catchupWatermark = maxEventId(initial.lastEventId, highestSeen);
        if (compareEventIds(catchupWatermark, initial.lastEventId) > 0) {
          await this.#reconcileFixed(source, mode, shard, rpc, fromId, catchupWatermark);
        }
        if (compareEventIds(catchupWatermark, fromId) > 0) {
          this.#database.checkpointCursor(source, shard, catchupWatermark, this.#now());
        }
        catchup = false;
        state.replayingShards.delete(shard);
        state.reconciliationState = "ok";
        state.lastContactAtMs = this.#now();
        this.#publishHealth(source);
        this.#logger.info("source.catchup_complete", { source, shard, cursor: catchupWatermark, events: initial.eventCount });

        while (!signal.aborted) {
          const streamEnded = await streamOrTimeout(subscription.done, this.#config.reconcileIntervalMs, signal);
          if (streamEnded) break;
          const bound = highestSeen;
          const cursor = this.#database.getCursor(source, shard);
          if (compareEventIds(bound, cursor) > 0) {
            await this.#reconcileFixed(source, mode, shard, rpc, cursor, bound);
            this.#database.checkpointCursor(source, shard, bound, this.#now());
          } else {
            // Even an idle stream is checked at a fixed, already durable bound.
            state.reconciliationState = "ok";
          }
          state.lastContactAtMs = this.#now();
          if (this.#now() - subscriptionStartedAtMs >= 30_000) reconnectAttempt = 0;
          this.#publishHealth(source);
        }
        if (!signal.aborted) throw streamError ?? new Error("subscription ended");
      } catch (error) {
        if (signal.aborted) break;
        const state = this.#state(source);
        state.connectedShards.delete(shard);
        state.replayingShards.delete(shard);
        state.reconnectCount += 1;
        state.lastError = errorMessage(error);
        state.reconciliationState = "gap";
        this.#publishHealth(source, "subscription_interrupted");
        const delayMs = exponentialBackoffMs(reconnectAttempt, { random: this.#random });
        reconnectAttempt += 1;
        this.#logger.warn("source.subscription_reconnecting", { source, shard, delayMs, error });
        await abortableDelay(delayMs, signal);
      } finally {
        if (subscription) {
          subscription.cancel();
          this.#subscriptions.delete(subscription);
        }
      }
    }
    const state = this.#state(source);
    state.connectedShards.delete(shard);
    state.replayingShards.delete(shard);
  }

  async #reconcileFixed(
    source: Source,
    mode: SourceMode,
    shard: number,
    rpc: CollectorRpc,
    startId: string,
    bound: string
  ): Promise<void> {
    const state = this.#state(source);
    state.reconciliationState = "checking";
    this.#publishHealth(source);
    const result = await reconcileEvents({
      rpc,
      shard,
      startId,
      stopId: bound,
      onEvent: (event) => this.#handleEvent(source, mode, shard, event, true)
    });
    state.reconciliationState = "ok";
    this.#logger.debug("source.reconciled", { source, shard, startId, bound, ...result });
  }

  #handleEvent(
    source: Source,
    mode: SourceMode,
    fallbackShard: number,
    event: RawHubEvent,
    replay: boolean,
    cutoffMs = this.#now() - this.#config.retentionDays * 86_400_000
  ): void {
    const eventId = rawEventId(event);
    if (!eventId) {
      this.#logger.warn("event.invalid_id", { source, shard: fallbackShard });
      return;
    }
    const receivedAtMs = this.#now();
    const shard = rawEventShard(event, fallbackShard);
    const adapter = this.#adapters.get(source);
    if (!adapter || adapter.sourceMode !== mode) throw new Error(`missing ${source} activity adapter for ${mode} mode`);
    let activity = adapter.normalize(event, receivedAtMs, replay);
    const authoritativeAtMs = activity?.actionAtMs ?? eventTimeMs(event);
    if (authoritativeAtMs !== null) this.#database.recordHistoryCoverage(source, shard, authoritativeAtMs);
    if (activity && activity.actionAtMs < cutoffMs) activity = null;
    if (!activity && authoritativeAtMs !== null && authoritativeAtMs < cutoffMs) return;
    const result = this.#database.recordEvent({
      source,
      shard,
      eventId,
      eventType: rawEventType(event),
      receivedAtMs,
      activity
    });
    if (result.actionInserted && activity && shouldEmitPulse(activity)) this.#pulse.add({ activity, eventId });
    const state = this.#state(source);
    state.lastContactAtMs = receivedAtMs;
  }

  async #runPeriodic(signal: AbortSignal): Promise<void> {
    let lastSnapshotAtMs = 0;
    let lastCleanupAtMs = this.#now();
    while (!signal.aborted) {
      const nowMs = this.#now();
      const pulses = this.#pulse.drain(nowMs);
      const snapshotDue = nowMs - lastSnapshotAtMs >= this.#config.snapshotIntervalMs;
      const snapshots = snapshotDue
        ? sources().map((source) => buildMetricSnapshot(this.#database, this.#config, source, nowMs))
        : [];
      if (snapshotDue) {
        lastSnapshotAtMs = nowMs;
        this.#database.setMetadata("collector_heartbeat_at_ms", String(nowMs));
      }
      if (pulses.length > 0 || snapshots.length > 0) {
        const health = snapshotDue ? this.#healthUpdates() : [];
        const comparisonSnapshots = snapshotDue ? [buildComparisonSnapshot(this.#database, snapshots, nowMs)] : [];
        const batch = enqueueIngestBatch(this.#database, this.#config, { pulses, snapshots, comparisonSnapshots, health }, nowMs);
        if (!batch && this.#config.ingestUrl) this.#logger.warn("outbox.capacity_reached", { maximumRows: this.#config.maxOutboxRows });
      }
      const minute = Math.floor(nowMs / 60_000) * 60_000;
      for (let batchIndex = 0; batchIndex < 3 && this.#database.hasUnqueuedAggregates(minute); batchIndex += 1) {
        if (!enqueueIngestBatch(this.#database, this.#config, {}, nowMs)) break;
      }
      await this.#dispatcher.drainOnce();
      if (nowMs - lastCleanupAtMs >= 60 * 60_000) {
        this.#database.cleanup(nowMs, this.#config.retentionDays);
        lastCleanupAtMs = nowMs;
      }
      await abortableDelay(this.#config.pulseIntervalMs, signal);
    }
  }

  async #flushFinal(): Promise<void> {
    const nowMs = this.#now();
    const snapshots = sources().map((source) => buildMetricSnapshot(this.#database, this.#config, source, nowMs));
    enqueueIngestBatch(this.#database, this.#config, {
      pulses: this.#pulse.drain(nowMs),
      snapshots,
      comparisonSnapshots: [buildComparisonSnapshot(this.#database, snapshots, nowMs)],
      health: this.#healthUpdates()
    }, nowMs);
    await this.#dispatcher.drainOnce();
  }

  #updateInfo(source: Source, info: NodeInfo): void {
    const state = this.#state(source);
    const shardIds = discoveredShardIds(info);
    const dataShardInfos = info.shardInfos.filter((shard) => shardIds.includes(shard.shardId));
    state.version = info.version;
    state.shardIds = new Set(shardIds);
    state.expectedShardCount = Math.max(shardIds.length, info.numShards);
    state.height = nullableMaximum(dataShardInfos.map((shard) => shard.maxHeight));
    state.blockDelaySeconds = nullableMaximum(dataShardInfos.map((shard) => shard.blockDelay));
    const mempools = dataShardInfos.map((shard) => shard.mempoolSize);
    state.mempoolSize = mempools.some((value) => value === 0xffff_ffff)
      ? null
      : mempools.reduce((sum, value) => sum + Math.max(0, value), 0);
    state.synchronized = state.blockDelaySeconds !== null && state.blockDelaySeconds <= 30;
    state.lastContactAtMs = this.#now();
    state.lastError = null;
  }

  #publishHealth(source: Source, message?: string | null): void {
    const state = this.#state(source);
    const nowMs = this.#now();
    const historyCoverageStartMs = this.#database.historyCoverageStart(
      source,
      [...state.shardIds],
      state.expectedShardCount
    );
    const completeHistory = historyComplete(historyCoverageStartMs, nowMs);
    const status = sourceStatus(state, nowMs, this.#config, completeHistory);
    const record: SourceHealthRecord = {
      source,
      sourceMode: state.sourceMode,
      status,
      observedAtMs: state.lastContactAtMs ?? nowMs,
      node: {
        version: state.version,
        shardCount: state.expectedShardCount,
        coveredShards: state.connectedShards.size,
        height: state.height,
        blockDelaySeconds: state.blockDelaySeconds,
        mempoolSize: state.mempoolSize,
        synchronized: state.synchronized,
        reconnectCount: state.reconnectCount,
        reconciliationState: state.reconciliationState,
        clockSkewMs: null,
        historyCoverageStartMs,
        historyComplete: completeHistory
      },
      message: message ?? (state.lastError ? "source_unavailable" : null)
    };
    this.#database.upsertSourceHealth(record);
  }

  #healthUpdates(): HealthUpdate[] {
    return this.#database.sourceHealth().map(asHealthUpdate);
  }

  #state(source: Source): SourceRuntimeState {
    const state = this.#states.get(source);
    if (!state) throw new Error(`missing source runtime state: ${source}`);
    return state;
  }

  #cancelSubscriptions(): void {
    for (const subscription of this.#subscriptions) subscription.cancel();
    this.#subscriptions.clear();
  }
}

export function discoveredShardIds(info: NodeInfo): number[] {
  const explicit = info.shardInfos
    .map((shard) => shard.shardId)
    .filter((shard) => Number.isSafeInteger(shard) && shard > 0);
  if (explicit.length > 0) return [...new Set(explicit)].sort((left, right) => left - right);
  return [];
}

function initialState(source: Source, sourceMode: SourceMode): SourceRuntimeState {
  return {
    source,
    sourceMode,
    version: "unknown",
    shardIds: new Set(),
    expectedShardCount: 0,
    connectedShards: new Set(),
    replayingShards: new Set(),
    reconnectCount: 0,
    reconciliationState: "unknown",
    height: null,
    blockDelaySeconds: null,
    mempoolSize: null,
    synchronized: false,
    lastContactAtMs: null,
    lastError: null
  };
}

function sourceStatus(state: SourceRuntimeState, nowMs: number, config: CollectorConfig, completeHistory: boolean): SourceStatus {
  if (state.sourceMode === "unavailable") return "disconnected";
  if (state.lastContactAtMs === null || nowMs - state.lastContactAtMs > config.disconnectedAfterMs) return "disconnected";
  if (state.replayingShards.size > 0) return "replaying";
  if (state.shardIds.size === 0 || state.connectedShards.size === 0) return "reconnecting";
  if (nowMs - state.lastContactAtMs > config.staleAfterMs || !state.synchronized) return "stale";
  if (state.connectedShards.size < state.expectedShardCount || !completeHistory) return "partial";
  return state.sourceMode === "derived" ? "derived" : "live";
}

function nullableMaximum(values: readonly number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0);
  return finite.length === 0 ? null : Math.max(...finite);
}

function linkedAbortController(parent: AbortSignal): AbortController {
  const child = new AbortController();
  if (parent.aborted) child.abort();
  else parent.addEventListener("abort", () => child.abort(), { once: true });
  return child;
}

async function streamOrTimeout(done: Promise<void>, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const timeoutPromise = new Promise<"timeout" | "abort">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), timeoutMs);
    abortListener = () => resolve("abort");
    signal.addEventListener("abort", abortListener, { once: true });
  });
  const result = await Promise.race([done.then(() => "stream" as const), timeoutPromise]);
  if (timeout) clearTimeout(timeout);
  if (abortListener) signal.removeEventListener("abort", abortListener);
  return result !== "timeout";
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function sources(): readonly Source[] {
  return ["snapchain", "hypersnap"];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function eventTimeMs(event: RawHubEvent): number | null {
  const raw = Number(event.timestamp ?? event.mergeMessageBody?.message?.data?.timestamp ?? 0);
  if (!Number.isSafeInteger(raw) || raw <= 0) return null;
  return FARCASTER_EPOCH_MS + raw * 1_000;
}

function historyComplete(startMs: number | null, nowMs: number): boolean {
  return startMs !== null && startMs <= nowMs - 30 * 86_400_000;
}

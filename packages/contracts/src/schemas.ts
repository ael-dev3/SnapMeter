import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

export const SourceSchema = z.enum(["snapchain", "hypersnap"]);
export type Source = z.infer<typeof SourceSchema>;

export const SourceModeSchema = z.enum(["verified", "derived", "unavailable"]);
export type SourceMode = z.infer<typeof SourceModeSchema>;

export const SourceStatusSchema = z.enum([
  "loading",
  "live",
  "derived",
  "stale",
  "disconnected",
  "reconnecting",
  "replaying",
  "partial",
  "protocol-mismatch",
  "empty",
  "demo"
]);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export const QualitySchema = z.enum(["high", "derived", "degraded", "unavailable"]);
export type Quality = z.infer<typeof QualitySchema>;

export const ActionFamilySchema = z.enum([
  "cast",
  "reaction",
  "link",
  "verification",
  "user-data",
  "username-proof",
  "storage-lending",
  "key",
  "channel",
  "other"
]);
export type ActionFamily = z.infer<typeof ActionFamilySchema>;

export const TrendLabelSchema = z.enum(["Improving", "Worsening", "Stable", "Insufficient data"]);

export const DailyDatumSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  activeFids: z.number().int().nonnegative(),
  actions: z.number().int().nonnegative()
});

export const TrendSchema = z.object({
  label: TrendLabelSchema,
  currentSevenDayAverage: z.number().nonnegative(),
  previousSevenDayAverage: z.number().nonnegative(),
  absoluteChange: z.number(),
  percentChange: z.number().nullable(),
  slope30d: z.number(),
  usefulSamples: z.number().int().nonnegative(),
  explanation: z.string()
});

export const NodeHealthSchema = z.object({
  version: z.string().default("unknown"),
  shardCount: z.number().int().nonnegative().default(0),
  coveredShards: z.number().int().nonnegative().default(0),
  height: z.number().int().nonnegative().nullable().default(null),
  blockDelaySeconds: z.number().nonnegative().nullable().default(null),
  mempoolSize: z.number().int().nonnegative().nullable().default(null),
  synchronized: z.boolean().default(false),
  reconnectCount: z.number().int().nonnegative().default(0),
  reconciliationState: z.enum(["ok", "checking", "gap", "unknown"]).default("unknown"),
  clockSkewMs: z.number().nullable().default(null),
  historyCoverageStartMs: z.number().int().nonnegative().nullable().default(null),
  historyComplete: z.boolean().default(false)
});
export type NodeHealth = z.infer<typeof NodeHealthSchema>;

export const SourceMetricsSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  source: SourceSchema,
  sourceMode: SourceModeSchema,
  status: SourceStatusSchema,
  quality: QualitySchema,
  updatedAtMs: z.number().int().nonnegative(),
  lastActionAtMs: z.number().int().nonnegative().nullable(),
  lastCollectorAtMs: z.number().int().nonnegative().nullable(),
  rolling24h: z.number().int().nonnegative(),
  previous24h: z.number().int().nonnegative(),
  changeAbsolute: z.number().int(),
  changePercent: z.number().nullable(),
  todayUtc: z.number().int().nonnegative(),
  rolling30d: z.number().int().nonnegative(),
  dailyMedian30d: z.number().nonnegative(),
  dailyPeak30d: z.number().int().nonnegative(),
  activeFids5m: z.number().int().nonnegative(),
  actionsPerMinute1m: z.number().nonnegative(),
  actionsPerMinute5m: z.number().nonnegative(),
  actionCounts: z.partialRecord(ActionFamilySchema, z.number().int().nonnegative()),
  daily: z.array(DailyDatumSchema).length(30),
  trend: TrendSchema,
  ingestLatencyP50Ms: z.number().nonnegative().nullable(),
  ingestLatencyP95Ms: z.number().nonnegative().nullable(),
  node: NodeHealthSchema,
  caveat: z.string().nullable()
});
export type SourceMetrics = z.infer<typeof SourceMetricsSchema>;

export const ComparisonSchema = z.object({
  overlap24h: z.number().int().nonnegative().nullable(),
  overlapPercent: z.number().nullable(),
  eligibleActionCoveragePercent: z.number().nullable(),
  eventParityPercent: z.number().nullable(),
  effectivelyIdentical: z.boolean(),
  explanation: z.string()
});

export const ComparisonSnapshotSchema = ComparisonSchema.extend({
  generatedAtMs: z.number().int().nonnegative()
});
export type ComparisonSnapshot = z.infer<typeof ComparisonSnapshotSchema>;

export const SummarySchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  generatedAtMs: z.number().int().nonnegative(),
  demo: z.boolean(),
  sources: z.object({
    snapchain: SourceMetricsSchema,
    hypersnap: SourceMetricsSchema
  }),
  comparison: ComparisonSchema,
  warnings: z.array(z.string())
});
export type Summary = z.infer<typeof SummarySchema>;

export const PulsePacketSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  source: SourceSchema,
  sourceMode: SourceModeSchema,
  windowStartMs: z.number().int().nonnegative(),
  windowEndMs: z.number().int().nonnegative(),
  eventCount: z.number().int().positive(),
  uniqueFids: z.number().int().positive(),
  actionCounts: z.partialRecord(ActionFamilySchema, z.number().int().nonnegative()),
  lastActionAtMs: z.number().int().nonnegative(),
  maxEventId: z.string(),
  isReplay: z.literal(false)
});
export type PulsePacket = z.infer<typeof PulsePacketSchema>;

export const MinuteBucketSchema = z.object({
  source: SourceSchema,
  minuteStartMs: z.number().int().nonnegative(),
  actions: z.number().int().nonnegative(),
  uniqueFids: z.number().int().nonnegative(),
  actionCounts: z.partialRecord(ActionFamilySchema, z.number().int().nonnegative())
});
export type MinuteBucket = z.infer<typeof MinuteBucketSchema>;

export const ActorDaySchema = z.object({
  source: SourceSchema,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fidHash: z.string().min(16).max(128)
});
export type ActorDay = z.infer<typeof ActorDaySchema>;

export const CursorSchema = z.object({
  source: SourceSchema,
  shard: z.number().int().positive(),
  eventId: z.string().regex(/^\d+$/),
  verifiedAtMs: z.number().int().nonnegative()
});
export type Cursor = z.infer<typeof CursorSchema>;

export const HealthUpdateSchema = z.object({
  source: SourceSchema,
  sourceMode: SourceModeSchema,
  status: SourceStatusSchema,
  observedAtMs: z.number().int().nonnegative(),
  node: NodeHealthSchema,
  message: z.string().max(500).nullable()
});
export type HealthUpdate = z.infer<typeof HealthUpdateSchema>;

export const IngestBatchSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  batchId: z.string().uuid(),
  collectorId: z.string().min(8).max(128),
  collectorVersion: z.string().min(1).max(64),
  sentAtMs: z.number().int().nonnegative(),
  pulses: z.array(PulsePacketSchema).max(100),
  snapshots: z.array(SourceMetricsSchema).max(4),
  comparisonSnapshots: z.array(ComparisonSnapshotSchema).max(2).default([]),
  minuteBuckets: z.array(MinuteBucketSchema).max(500),
  actorDays: z.array(ActorDaySchema).max(5000),
  cursors: z.array(CursorSchema).max(128),
  health: z.array(HealthUpdateSchema).max(8)
});
export type IngestBatch = z.infer<typeof IngestBatchSchema>;

const DeliveryIdSchema = z.string().regex(/^[0-9a-f-]{36}:(?:pulse|status|snapshot):\d+$/i);

export const LiveEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), schemaVersion: z.literal(SCHEMA_VERSION), sequence: z.number().int().nonnegative(), deliveryId: DeliveryIdSchema.optional(), data: SummarySchema }),
  z.object({ type: z.literal("pulse"), schemaVersion: z.literal(SCHEMA_VERSION), sequence: z.number().int().nonnegative(), deliveryId: DeliveryIdSchema, deliveryIds: z.array(DeliveryIdSchema).min(1).max(500).optional(), data: PulsePacketSchema }),
  z.object({ type: z.literal("status"), schemaVersion: z.literal(SCHEMA_VERSION), sequence: z.number().int().nonnegative(), deliveryId: DeliveryIdSchema, data: HealthUpdateSchema }),
  z.object({ type: z.literal("freshness"), schemaVersion: z.literal(SCHEMA_VERSION), sequence: z.number().int().nonnegative(), serverTimeMs: z.number().int().nonnegative() })
]);
export type LiveEnvelope = z.infer<typeof LiveEnvelopeSchema>;

export const MetadataSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  service: z.literal("SnapMeter"),
  timezone: z.literal("UTC"),
  metricsPolicyVersion: z.string(),
  hypersnapClassifierVersion: z.string(),
  upstream: z.object({ snapchain: z.string(), hypersnap: z.string() })
});

export const IngestResponseSchema = z.object({
  ok: z.literal(true),
  batchId: z.string().uuid(),
  duplicate: z.boolean(),
  acceptedAtMs: z.number().int().nonnegative()
});

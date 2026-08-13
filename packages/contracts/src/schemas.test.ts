import { describe, expect, it } from "vitest";
import { ActorDaySchema, DailyDatumSchema, UtcDaySchema } from "./schemas";

describe("UTC calendar-day schemas", () => {
  it.each(["2024-02-29", "2026-08-13", "0000-01-01", "9999-12-31"])(
    "accepts a canonical real day: %s",
    (day) => expect(UtcDaySchema.safeParse(day).success).toBe(true)
  );

  it.each(["2023-02-29", "2026-02-30", "2026-13-01", "2026-00-01", "2026-1-01", "not-a-day"])(
    "rejects an impossible or noncanonical day: %s",
    (day) => expect(UtcDaySchema.safeParse(day).success).toBe(false)
  );

  it("applies the strict day check to daily metrics and actor membership", () => {
    expect(DailyDatumSchema.safeParse({ day: "2026-02-30", activeFids: 1, actions: 1 }).success).toBe(false);
    expect(ActorDaySchema.safeParse({ source: "snapchain", day: "2026-02-30", fidHash: "a".repeat(64) }).success).toBe(false);
  });

  it("requires the collector's exact keyed actor pseudonym format", () => {
    expect(ActorDaySchema.safeParse({ source: "snapchain", day: "2026-08-13", fidHash: "a".repeat(64) }).success).toBe(true);
    expect(ActorDaySchema.safeParse({ source: "snapchain", day: "2026-08-13", fidHash: "raw-fid-12345678" }).success).toBe(false);
    expect(ActorDaySchema.safeParse({ source: "snapchain", day: "2026-08-13", fidHash: "A".repeat(64) }).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { SummarySchema } from "@snapmeter/contracts";
import { createDemoSummary, DEMO_CLOCK_MS } from "./demo";

describe("seeded demo summary", () => {
  it("is deterministic, valid, and explicit", () => {
    const first = createDemoSummary();
    const second = createDemoSummary();
    expect(first).toEqual(second);
    expect(SummarySchema.safeParse(first).success).toBe(true);
    expect(first.demo).toBe(true);
    expect(first.generatedAtMs).toBe(DEMO_CLOCK_MS);
    expect(first.sources.snapchain.daily).toHaveLength(30);
    expect(first.sources.hypersnap.sourceMode).toBe("derived");
  });

  it("changes predictably with a different seed", () => {
    expect(createDemoSummary(1).sources.snapchain.daily).not.toEqual(createDemoSummary(2).sources.snapchain.daily);
  });
});

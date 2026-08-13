import { describe, expect, it } from "vitest";
import { buildHeartbeatGeometry, HEARTBEAT_GEOMETRY_POINTS } from "./heartbeatGeometry";

describe("heartbeat geometry", () => {
  it("is deterministic, bounded, and returns quietly to baseline", () => {
    const first = buildHeartbeatGeometry("snapchain", 17, 24);
    const again = buildHeartbeatGeometry("snapchain", 17, 24);

    expect(first).toEqual(again);
    expect(first.samples).toHaveLength(HEARTBEAT_GEOMETRY_POINTS);
    expect(first.depths).toHaveLength(HEARTBEAT_GEOMETRY_POINTS);
    expect(first.torsion).toHaveLength(HEARTBEAT_GEOMETRY_POINTS);
    expect(first.samples[0]).toBe(0);
    expect(first.samples.at(-1)).toBe(0);
    expect(first.depths[0]).toBe(0);
    expect(first.depths.at(-1)).toBe(0);
    expect(Math.max(...first.samples.map(Math.abs))).toBeLessThanOrEqual(0.78);
    expect(Math.max(...first.depths)).toBeLessThanOrEqual(1);
  });

  it("varies successive pulses and gives each source a distinct anatomy", () => {
    const first = buildHeartbeatGeometry("snapchain", 18, 24);
    const next = buildHeartbeatGeometry("snapchain", 19, 24);
    const hyper = buildHeartbeatGeometry("hypersnap", 18, 24);

    expect(next.samples).not.toEqual(first.samples);
    expect(next.torsion).not.toEqual(first.torsion);
    expect(hyper.samples).not.toEqual(first.samples);
  });

  it("uses event volume for size without increasing luminance or escaping its cap", () => {
    const quiet = buildHeartbeatGeometry("snapchain", 9, 1);
    const active = buildHeartbeatGeometry("snapchain", 9, 10_000);

    expect(active.amplitude).toBeGreaterThan(quiet.amplitude);
    expect(active.amplitude).toBe(0.78);
  });
});

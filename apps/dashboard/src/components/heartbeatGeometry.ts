import type { Source } from "@snapmeter/contracts";

export const HEARTBEAT_GEOMETRY_POINTS = 20;

export interface HeartbeatGeometry {
  samples: number[];
  depths: number[];
  torsion: number[];
  amplitude: number;
}

function gaussian(value: number, center: number, width: number): number {
  const distance = (value - center) / width;
  return Math.exp(-0.5 * distance * distance);
}

function seededUnit(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Builds a bounded, deterministic pulse form. Event count changes its scale,
 * while pulse identity changes its proportions so live activity never becomes
 * a repeated ECG stamp.
 */
export function buildHeartbeatGeometry(source: Source, pulseId: number, count: number): HeartbeatGeometry {
  const safePulseId = Number.isSafeInteger(pulseId) ? Math.max(0, pulseId) : 0;
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const sourceSeed = source === "snapchain" ? 0x51a7c4d3 : 0x8f31b5e7;
  const random = seededUnit((safePulseId ^ sourceSeed) >>> 0);
  const centerShift = (random() - 0.5) * 0.055;
  const spread = 0.91 + random() * 0.18;
  const secondary = 0.82 + random() * 0.3;
  const phase = random() * Math.PI * 2;
  const topology = Math.floor(random() * 3);
  const amplitude = Math.min(0.78, 0.24 + Math.log2(safeCount + 1) / 11);
  const raw: number[] = [];
  const depths: number[] = [];
  const torsion: number[] = [];

  for (let index = 0; index < HEARTBEAT_GEOMETRY_POINTS; index += 1) {
    const t = index / (HEARTBEAT_GEOMETRY_POINTS - 1);
    const envelope = Math.sin(Math.PI * t) ** 1.45;
    let value: number;

    if (source === "snapchain") {
      value =
        0.14 * gaussian(t, 0.18 + centerShift, 0.065 * spread)
        - 0.18 * gaussian(t, 0.32 + centerShift, 0.052 * spread)
        + (0.94 + topology * 0.045) * gaussian(t, 0.47 + centerShift, 0.084 * spread)
        - 0.42 * gaussian(t, 0.61 + centerShift, 0.072 * spread)
        + 0.28 * secondary * gaussian(t, 0.76 + centerShift * 0.4, 0.095 * spread);
    } else {
      value =
        0.2 * gaussian(t, 0.16 + centerShift * 0.5, 0.07 * spread)
        - 0.12 * gaussian(t, 0.29 + centerShift, 0.055 * spread)
        + 0.67 * secondary * gaussian(t, 0.43 + centerShift, 0.1 * spread)
        - 0.29 * gaussian(t, 0.57 + centerShift, 0.07 * spread)
        + (0.78 + topology * 0.05) * gaussian(t, 0.7 - centerShift * 0.5, 0.086 * spread)
        - 0.26 * gaussian(t, 0.83, 0.065 * spread);
    }

    value += Math.sin(t * Math.PI * (2.1 + topology * 0.28) + phase) * envelope * 0.045;
    raw.push(index === 0 || index === HEARTBEAT_GEOMETRY_POINTS - 1 ? 0 : value);
    depths.push(index === 0 || index === HEARTBEAT_GEOMETRY_POINTS - 1
      ? 0
      : envelope * (0.46 + 0.16 * Math.sin(t * Math.PI + phase) ** 2));
    torsion.push(index === 0 || index === HEARTBEAT_GEOMETRY_POINTS - 1
      ? 0
      : envelope * Math.sin(t * Math.PI * (1.65 + topology * 0.16) + phase) * 0.62);
  }

  const maximum = Math.max(...raw.map((value) => Math.abs(value)), 1);
  const samples = raw.map((value, index) => index === 0 || index === raw.length - 1
    ? 0
    : Math.max(-0.78, Math.min(0.78, (value / maximum) * amplitude)));

  return { samples, depths, torsion, amplitude };
}

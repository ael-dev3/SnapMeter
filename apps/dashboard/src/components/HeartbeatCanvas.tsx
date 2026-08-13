import { useEffect, useRef } from "react";
import type { Source } from "@snapmeter/contracts";
import type { PulseState } from "../hooks/useLiveMetrics";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { ageFrom } from "../lib/format";
import { buildHeartbeatGeometry } from "./heartbeatGeometry";

const POINTS = 156;

interface PendingSample {
  value: number;
  depth: number;
  torsion: number;
}

interface TracePoint {
  x: number;
  y: number;
}

function smoothPath(context: CanvasRenderingContext2D, points: TracePoint[]): void {
  if (points.length === 0) return;
  context.moveTo(points[0]!.x, points[0]!.y);
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index]!;
    const next = points[index + 1]!;
    context.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
  }
  const last = points.at(-1)!;
  context.lineTo(last.x, last.y);
}

export function HeartbeatCanvas({
  source,
  pulse,
  signalAtMs,
  now
}: {
  source: Source;
  pulse: PulseState;
  signalAtMs: number | null;
  now: number;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({
    samples: new Float32Array(POINTS),
    depths: new Float32Array(POINTS),
    torsion: new Float32Array(POINTS),
    cursor: 0,
    pending: [] as PendingSample[],
    pendingIndex: 0,
    lastAdvance: 0,
    pulseId: 0
  });
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (pulse.id <= stateRef.current.pulseId || pulse.count <= 0) return;
    stateRef.current.pulseId = pulse.id;
    const geometry = buildHeartbeatGeometry(source, pulse.id, pulse.count);
    stateRef.current.pending = geometry.samples.map((value, index) => ({
      value,
      depth: geometry.depths[index] ?? 0,
      torsion: geometry.torsion[index] ?? 0
    }));
    stateRef.current.pendingIndex = 0;
  }, [pulse.count, pulse.id, source]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let frame = 0;
    let stopped = false;

    const draw = (time = performance.now()): void => {
      if (stopped) return;
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      const state = stateRef.current;
      if (!reducedMotion && time - state.lastAdvance >= 28) {
        const next = state.pendingIndex < state.pending.length
          ? state.pending[state.pendingIndex] ?? { value: 0, depth: 0, torsion: 0 }
          : { value: 0, depth: 0, torsion: 0 };
        state.samples[state.cursor] = next.value;
        state.depths[state.cursor] = next.depth;
        state.torsion[state.cursor] = next.torsion;
        state.cursor = (state.cursor + 1) % POINTS;
        if (state.pendingIndex < state.pending.length) state.pendingIndex += 1;
        state.lastAdvance = time;
      } else if (reducedMotion && state.pendingIndex < state.pending.length) {
        for (const sample of state.pending) {
          state.samples[state.cursor] = sample.value;
          state.depths[state.cursor] = sample.depth;
          state.torsion[state.cursor] = sample.torsion;
          state.cursor = (state.cursor + 1) % POINTS;
        }
        state.pendingIndex = state.pending.length;
      }

      context.clearRect(0, 0, width, height);
      const baseline = Math.round(height * 0.52) + 0.5;
      const color = source === "snapchain" ? "75, 221, 255" : "188, 127, 255";

      context.strokeStyle = `rgba(${color}, .09)`;
      context.lineWidth = 1;
      context.setLineDash([2, 7]);
      context.beginPath();
      context.moveTo(0, baseline);
      context.lineTo(width, baseline);
      context.stroke();
      context.setLineDash([]);

      const front: TracePoint[] = [];
      const rear: TracePoint[] = [];
      const depthPixels = Math.max(0.8, Math.min(2.5, height * 0.036));
      for (let index = 0; index < POINTS; index += 1) {
        const bufferIndex = (state.cursor + index) % POINTS;
        const sample = state.samples[bufferIndex] ?? 0;
        const depth = state.depths[bufferIndex] ?? 0;
        const torsion = state.torsion[bufferIndex] ?? 0;
        const x = (index / (POINTS - 1)) * width;
        front.push({
          x: x + torsion * depthPixels * 0.22,
          y: baseline - sample * height * 0.34 - torsion * depthPixels * 0.16
        });
        rear.push({
          x: x - depth * depthPixels * 0.46,
          y: baseline - sample * height * 0.305 + depth * depthPixels + torsion * depthPixels * 0.32
        });
      }

      const trace = (points: TracePoint[]): void => {
        context.beginPath();
        smoothPath(context, points);
        context.stroke();
      };

      context.lineJoin = "round";
      context.lineCap = "round";

      context.beginPath();
      smoothPath(context, front);
      for (let index = rear.length - 1; index >= 0; index -= 1) {
        context.lineTo(rear[index]!.x, rear[index]!.y);
      }
      context.closePath();
      context.fillStyle = `rgba(${color}, .032)`;
      context.fill();

      context.strokeStyle = `rgba(${color}, .13)`;
      context.lineWidth = 2.2;
      trace(rear);
      context.strokeStyle = `rgba(${color}, .05)`;
      context.lineWidth = 4.2;
      trace(front);
      context.strokeStyle = `rgba(${color}, .7)`;
      context.lineWidth = 1.1;
      trace(front);

      if (!reducedMotion) frame = window.requestAnimationFrame(draw);
    };

    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => draw()) : null;
    resize?.observe(canvas);
    draw();

    return () => {
      stopped = true;
      resize?.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [reducedMotion, source, pulse.id]);

  const signalAge = signalAtMs === null ? null : ageFrom(signalAtMs, now);
  const eventText = pulse.lastActionAtMs === null
    ? signalAge === null
      ? "No qualifying action recorded"
      : `Last recorded action ${signalAge} · awaiting a live pulse`
    : `${pulse.count.toLocaleString()} qualifying ${pulse.count === 1 ? "action" : "actions"} · last action ${signalAge}`;

  return (
    <div className="heartbeat" data-testid={`heartbeat-${source}`} data-pulse-id={pulse.id}>
      {pulse.id > 0 && !reducedMotion && <span className="heartbeat-bloom" aria-hidden="true" key={`${source}-${pulse.id}`} />}
      <div className="heartbeat-heading">
        <span>Action heartbeat</span>
        <span className="heartbeat-event" aria-live="polite" aria-atomic="true">{eventText}</span>
      </div>
      <canvas ref={canvasRef} aria-hidden="true" />
      {reducedMotion && <span className="motion-note">Motion reduced</span>}
    </div>
  );
}

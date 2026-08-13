import { useEffect, useRef } from "react";
import type { Source } from "@snapmeter/contracts";
import type { PulseState } from "../hooks/useLiveMetrics";
import { useReducedMotion } from "../hooks/useReducedMotion";

const POINTS = 156;

function signature(source: Source, amplitude: number): number[] {
  const shape = source === "snapchain"
    ? [0, 0.08, -0.16, 0.95, -0.48, 0.22, 0.05, 0]
    : [0, 0.18, -0.1, 0.62, -0.3, 0.86, -0.42, 0.16, 0];
  return shape.map((point) => point * amplitude);
}

export function HeartbeatCanvas({ source, pulse }: { source: Source; pulse: PulseState }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({
    samples: new Float32Array(POINTS),
    cursor: 0,
    pending: [] as number[],
    pendingIndex: 0,
    lastAdvance: 0,
    pulseId: 0
  });
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (pulse.id <= stateRef.current.pulseId || pulse.count <= 0) return;
    stateRef.current.pulseId = pulse.id;
    const amplitude = Math.min(1, 0.34 + Math.log2(pulse.count + 1) / 7);
    stateRef.current.pending = signature(source, amplitude);
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
        const next = state.pendingIndex < state.pending.length ? state.pending[state.pendingIndex] ?? 0 : 0;
        state.samples[state.cursor] = next;
        state.cursor = (state.cursor + 1) % POINTS;
        if (state.pendingIndex < state.pending.length) state.pendingIndex += 1;
        state.lastAdvance = time;
      } else if (reducedMotion && state.pendingIndex < state.pending.length) {
        for (const value of state.pending) {
          state.samples[state.cursor] = value;
          state.cursor = (state.cursor + 1) % POINTS;
        }
        state.pendingIndex = state.pending.length;
      }

      context.clearRect(0, 0, width, height);
      const baseline = Math.round(height * 0.52) + 0.5;
      const color = source === "snapchain" ? "75, 221, 255" : "188, 127, 255";

      context.strokeStyle = `rgba(${color}, .13)`;
      context.lineWidth = 1;
      context.setLineDash([2, 7]);
      context.beginPath();
      context.moveTo(0, baseline);
      context.lineTo(width, baseline);
      context.stroke();
      context.setLineDash([]);

      const trace = (): void => {
        context.beginPath();
        for (let index = 0; index < POINTS; index += 1) {
          const sample = state.samples[(state.cursor + index) % POINTS] ?? 0;
          const x = (index / (POINTS - 1)) * width;
          const y = baseline - sample * height * 0.39;
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      };

      context.lineJoin = "round";
      context.lineCap = "round";
      context.strokeStyle = `rgba(${color}, .18)`;
      context.lineWidth = 7;
      trace();
      context.strokeStyle = `rgba(${color}, .92)`;
      context.lineWidth = 1.4;
      trace();

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

  const eventText = pulse.observedAtMs === null
    ? "No live pulse received in this session"
    : `${pulse.count.toLocaleString()} qualifying ${pulse.count === 1 ? "event" : "events"} in the latest live pulse`;

  return (
    <div className="heartbeat" data-testid={`heartbeat-${source}`} data-pulse-id={pulse.id}>
      <div className="heartbeat-heading">
        <span>Live heartbeat</span>
        <span className="heartbeat-event" aria-live="polite" aria-atomic="true">{eventText}</span>
      </div>
      <canvas ref={canvasRef} aria-hidden="true" />
      {reducedMotion && <span className="motion-note">Motion reduced</span>}
    </div>
  );
}

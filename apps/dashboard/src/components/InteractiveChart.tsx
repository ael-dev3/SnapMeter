import { useEffect, useMemo, useRef, useState } from "react";
import { exact } from "../lib/format";

export interface ChartPoint {
  label: string;
  value: number;
}

export interface ChartSeries {
  name: string;
  color: string;
  points: ChartPoint[];
}

function chartDescription(series: ChartSeries[]): string {
  return series.map((item) => {
    const values = item.points.map((point) => point.value);
    const latest = item.points.at(-1);
    if (!latest || values.length === 0) return `${item.name}: no samples.`;
    return `${item.name}: latest ${exact(latest.value)} on ${latest.label}; range ${exact(Math.min(...values))} to ${exact(Math.max(...values))}.`;
  }).join(" ");
}

export function InteractiveChart({
  id,
  series,
  variant = "line"
}: {
  id: string;
  series: ChartSeries[];
  variant?: "line" | "bars";
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const count = Math.max(0, ...series.map((item) => item.points.length));
  const description = useMemo(() => chartDescription(series), [series]);

  useEffect(() => setActive(null), [series]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const draw = (): void => {
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      const allValues = series.flatMap((item) => item.points.map((point) => point.value));
      const max = Math.max(1, ...allValues);
      const min = Math.min(0, ...allValues);
      const plotTop = 14;
      const plotBottom = height - 27;
      const plotHeight = Math.max(1, plotBottom - plotTop);
      const left = 6;
      const right = width - 6;
      const plotWidth = Math.max(1, right - left);
      const xFor = (index: number): number => count <= 1 ? left + plotWidth / 2 : left + (index / (count - 1)) * plotWidth;
      const yFor = (value: number): number => plotBottom - ((value - min) / Math.max(1, max - min)) * plotHeight;

      context.lineWidth = 1;
      context.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
      context.textBaseline = "middle";
      for (let row = 0; row <= 3; row += 1) {
        const y = plotTop + (plotHeight * row) / 3;
        context.strokeStyle = "rgba(255,255,255,.075)";
        context.beginPath();
        context.moveTo(left, y + 0.5);
        context.lineTo(right, y + 0.5);
        context.stroke();
      }

      if (variant === "bars") {
        const groupWidth = Math.min(28, plotWidth / Math.max(1, count));
        const barWidth = Math.max(1.5, (groupWidth - 3) / Math.max(1, series.length));
        series.forEach((item, seriesIndex) => {
          context.fillStyle = item.color;
          item.points.forEach((point, index) => {
            const x = xFor(index) - groupWidth / 2 + seriesIndex * barWidth + 1.5;
            const y = yFor(point.value);
            context.globalAlpha = active === null || active === index ? 0.92 : 0.28;
            context.fillRect(x, y, barWidth, Math.max(1, plotBottom - y));
          });
        });
        context.globalAlpha = 1;
      } else {
        series.forEach((item) => {
          context.strokeStyle = item.color;
          context.lineWidth = 1.8;
          context.lineJoin = "round";
          context.beginPath();
          item.points.forEach((point, index) => {
            const x = xFor(index);
            const y = yFor(point.value);
            if (index === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          });
          context.stroke();

          item.points.forEach((point, index) => {
            if (active !== index && index !== item.points.length - 1) return;
            context.fillStyle = "#080a0d";
            context.strokeStyle = item.color;
            context.lineWidth = 1.5;
            context.beginPath();
            context.arc(xFor(index), yFor(point.value), active === index ? 4 : 2.5, 0, Math.PI * 2);
            context.fill();
            context.stroke();
          });
        });
      }

      if (active !== null) {
        const x = xFor(active);
        context.strokeStyle = "rgba(255,255,255,.4)";
        context.lineWidth = 1;
        context.setLineDash([2, 4]);
        context.beginPath();
        context.moveTo(x, plotTop);
        context.lineTo(x, plotBottom);
        context.stroke();
        context.setLineDash([]);
      }

      const firstLabel = series[0]?.points[0]?.label ?? "";
      const lastLabel = series[0]?.points.at(-1)?.label ?? "";
      context.fillStyle = "rgba(222,231,240,.56)";
      context.textAlign = "left";
      context.fillText(firstLabel, left, height - 9);
      context.textAlign = "right";
      context.fillText(lastLabel, right, height - 9);
    };

    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(draw) : null;
    resize?.observe(canvas);
    draw();
    return () => resize?.disconnect();
  }, [active, count, series, variant]);

  const chooseFromPointer = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (count < 1) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
    setActive(Math.round(position * (count - 1)));
  };

  const handleKey = (event: React.KeyboardEvent<HTMLCanvasElement>): void => {
    if (count < 1) return;
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) event.preventDefault();
    if (event.key === "Home") setActive(0);
    if (event.key === "End") setActive(count - 1);
    if (event.key === "ArrowLeft") setActive((current) => Math.max(0, (current ?? count) - 1));
    if (event.key === "ArrowRight") setActive((current) => Math.min(count - 1, (current ?? -1) + 1));
    if (event.key === "Escape") setActive(null);
  };

  const activeLabel = active === null ? null : series[0]?.points[active]?.label;

  return (
    <div className="interactive-chart" data-testid={id}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="img"
        aria-label={`${description} Focus and use arrow keys to inspect exact values.`}
        aria-describedby={`${id}-instructions`}
        onPointerMove={chooseFromPointer}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture?.(event.pointerId);
          chooseFromPointer(event);
        }}
        onKeyDown={handleKey}
      />
      <span className="sr-only" id={`${id}-instructions`}>Use left and right arrow keys, Home, or End to inspect samples. Press Escape to clear.</span>
      <div className="chart-tooltip" data-visible={active !== null || undefined} aria-live="polite">
        {active !== null && (
          <>
            <strong>{activeLabel}</strong>
            {series.map((item) => (
              <span key={item.name}><i style={{ background: item.color }} />{item.name} <b>{exact(item.points[active]?.value ?? 0)}</b></span>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

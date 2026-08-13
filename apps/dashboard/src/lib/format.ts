export function compact(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1_000_000 ? 2 : value >= 10_000 ? 1 : 0
  }).format(value);
}

export function exact(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

export function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${exact(value)}`;
}

export function percent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

export function ageFrom(timestamp: number | null, now: number): string {
  if (timestamp === null) return "No activity";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 5) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function latency(value: number | null): string {
  if (value === null) return "Unavailable";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(2)} s`;
}

export function titleCase(value: string): string {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

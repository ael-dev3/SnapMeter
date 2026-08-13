import { LiveEnvelopeSchema, SummarySchema, type Source, type SourceMetrics, type Summary } from "@snapmeter/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createDemoSummary, DEMO_CLOCK_MS } from "../data/demo";

export type TransportState = "loading" | "connecting" | "live" | "reconnecting" | "offline" | "error" | "demo";

export interface PulseState {
  id: number;
  count: number;
  observedAtMs: number | null;
}

const EMPTY_PULSE: Record<Source, PulseState> = {
  snapchain: { id: 0, count: 0, observedAtMs: null },
  hypersnap: { id: 0, count: 0, observedAtMs: null }
};

export function applyClientFreshness(summary: Summary, nowMs: number): Summary {
  if (summary.demo) return summary;
  const refresh = (metrics: SourceMetrics): SourceMetrics => {
    const age = metrics.lastCollectorAtMs === null ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - metrics.lastCollectorAtMs);
    if (age > 120_000) return { ...metrics, status: "disconnected", quality: "unavailable" };
    if (age > 30_000) return { ...metrics, status: "stale", quality: "degraded" };
    if (metrics.sourceMode === "unavailable") return { ...metrics, status: "disconnected", quality: "unavailable" };
    if (!["live", "derived"].includes(metrics.status)) return metrics;
    if (!metrics.node.synchronized) return { ...metrics, status: "stale", quality: "degraded" };
    if (metrics.node.reconciliationState !== "ok") return { ...metrics, status: "partial", quality: "degraded" };
    if (!metrics.node.historyComplete || metrics.node.shardCount <= 0 || metrics.node.coveredShards < metrics.node.shardCount) {
      return { ...metrics, status: "partial", quality: "degraded" };
    }
    return metrics;
  };
  return {
    ...summary,
    sources: {
      snapchain: refresh(summary.sources.snapchain),
      hypersnap: refresh(summary.sources.hypersnap)
    }
  };
}

function liveUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/v1/live`;
}

export function useLiveMetrics(): {
  summary: Summary | null;
  transport: TransportState;
  pulses: Record<Source, PulseState>;
  error: string | null;
  now: number;
  retry: () => void;
  demo: boolean;
} {
  const demo = new URLSearchParams(window.location.search).get("demo") === "1";
  const [summary, setSummary] = useState<Summary | null>(() => (demo ? createDemoSummary() : null));
  const [transport, setTransport] = useState<TransportState>(demo ? "demo" : "loading");
  const [pulses, setPulses] = useState<Record<Source, PulseState>>(EMPTY_PULSE);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(demo ? DEMO_CLOCK_MS : Date.now());
  const [attempt, setAttempt] = useState(0);
  const sequenceRef = useRef(-1);
  const deliveryIdsRef = useRef<string[]>([]);
  const deliveryIdSetRef = useRef(new Set<string>());
  const socketRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const closedRef = useRef(false);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (demo) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [demo]);

  useEffect(() => {
    if (demo) return;

    closedRef.current = false;
    sequenceRef.current = -1;
    deliveryIdsRef.current = [];
    deliveryIdSetRef.current.clear();
    let reconnectAttempt = 0;

    const hydrate = async (): Promise<boolean> => {
      if (!navigator.onLine) {
        setTransport("offline");
        return false;
      }
      setTransport((current) => (current === "reconnecting" ? current : "loading"));
      try {
        const response = await fetch("/api/v1/summary", {
          headers: { Accept: "application/json" },
          cache: "no-store"
        });
        if (!response.ok) throw new Error(`Summary request failed (${response.status})`);
        const parsed = SummarySchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("The server returned an unsupported summary schema");
        setSummary(parsed.data);
        setError(null);
        return true;
      } catch (reason) {
        setTransport(navigator.onLine ? "error" : "offline");
        setError(reason instanceof Error ? reason.message : "Unable to load activity data");
        return false;
      }
    };

    const scheduleReconnect = (): void => {
      if (closedRef.current || !navigator.onLine || retryTimerRef.current !== null) return;
      reconnectAttempt += 1;
      setTransport("reconnecting");
      const cap = Math.min(30_000, 750 * 2 ** Math.min(reconnectAttempt, 6));
      const delay = Math.round(cap * (0.65 + Math.random() * 0.7));
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        connect();
      }, delay);
    };

    const connect = (): void => {
      if (closedRef.current || !navigator.onLine) {
        setTransport("offline");
        return;
      }
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      const previous = socketRef.current;
      socketRef.current = null;
      previous?.close();
      sequenceRef.current = -1;
      setTransport((current) => current === "error" ? current : (current === "loading" ? "connecting" : "reconnecting"));
      const socket = new WebSocket(liveUrl());
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (socketRef.current !== socket) return;
        reconnectAttempt = 0;
        setTransport("live");
        setError(null);
      });

      socket.addEventListener("message", (event) => {
        if (socketRef.current !== socket) return;
        let payload: unknown;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const parsed = LiveEnvelopeSchema.safeParse(payload);
        if (!parsed.success || parsed.data.sequence <= sequenceRef.current) return;
        const deliveryIds = envelopeDeliveryIds(parsed.data);
        if (deliveryIds.some((value) => deliveryIdSetRef.current.has(value))) return;
        sequenceRef.current = parsed.data.sequence;
        for (const value of deliveryIds) {
          deliveryIdSetRef.current.add(value);
          deliveryIdsRef.current.push(value);
          if (deliveryIdsRef.current.length > 2_048) {
            const expired = deliveryIdsRef.current.shift();
            if (expired) deliveryIdSetRef.current.delete(expired);
          }
        }
        const envelope = parsed.data;

        if (envelope.type === "snapshot") {
          setSummary(envelope.data);
        } else if (envelope.type === "pulse") {
          setPulses((current) => ({
            ...current,
            [envelope.data.source]: {
              id: current[envelope.data.source].id + 1,
              count: envelope.data.eventCount,
              observedAtMs: envelope.data.windowEndMs
            }
          }));
        } else if (envelope.type === "status") {
          setSummary((current) => current ? {
            ...current,
            sources: {
              ...current.sources,
              [envelope.data.source]: {
                ...current.sources[envelope.data.source],
                sourceMode: envelope.data.sourceMode,
                status: envelope.data.status,
                updatedAtMs: envelope.data.observedAtMs,
                node: envelope.data.node,
                caveat: envelope.data.message
              }
            }
          } : current);
        } else if (envelope.type === "freshness") {
          setNow(envelope.serverTimeMs);
        }
      });

      socket.addEventListener("close", () => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        scheduleReconnect();
      });

      socket.addEventListener("error", () => socket.close());
    };

    const handleOffline = (): void => {
      setTransport("offline");
      socketRef.current?.close();
    };
    const handleOnline = (): void => {
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      setTransport("reconnecting");
      void hydrate().then(connect);
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    void hydrate().then(() => connect());

    return () => {
      closedRef.current = true;
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [attempt, demo]);

  const freshSummary = useMemo(() => summary ? applyClientFreshness(summary, now) : null, [now, summary]);
  return { summary: freshSummary, transport, pulses, error, now, retry, demo };
}

function envelopeDeliveryIds(envelope: object): string[] {
  if ("deliveryIds" in envelope && Array.isArray(envelope.deliveryIds)) return envelope.deliveryIds.filter((value): value is string => typeof value === "string");
  if ("deliveryId" in envelope && typeof envelope.deliveryId === "string") return [envelope.deliveryId];
  return [];
}

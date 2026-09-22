"use client";

/**
 * Shared client-side SSE stream provider (Phase 2 realtime infra).
 *
 * Opens a SINGLE EventSource to /api/stream once per app, shared via React
 * context, so pages subscribe without each opening their own connection.
 * The backend starts from the latest event cursor on connect (no replay of
 * history) and only pushes NEW frames; EventSource auto-resumes on reconnect
 * via the `Last-Event-ID` header (id: fields).
 *
 * Refetch strategy (deliberately simple, per Phase 2):
 *  - `sequence` increments on every event/notification frame received. A page
 *    that wants live data just runs its REST loader in a `useEffect` keyed on
 *    `sequence` — "an event arrived, refetch my list" — which is preferred over
 *    a complex event-typed state machine.
 *  - `on(handler)` subscribes to raw typed frames for callers that need the
 *    payload (e.g. appending a live event to a task timeline).
 *
 * Degrades silently when the engine/web is offline: EventSource retries on its
 * own; connection status is exposed for a subtle indicator but the UI never
 * errors from it.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RealtimeEvent } from "@/shared/types";

export type StreamStatus = "connecting" | "open" | "closed";

interface VelarisStreamValue {
  /** 'connecting' while EventSource reconnects, 'open' when live. */
  status: StreamStatus;
  /**
   * Monotonic tick, bumped for every event/notification frame. Consumers
   * trigger REST refetches by depending on this value.
   */
  sequence: number;
  /** Subscribe to raw typed stream frames; returns an unsubscribe fn. */
  on: (handler: (frame: RealtimeEvent) => void) => () => void;
  /** The latest execution-event cursor seen (id of last event frame). */
  lastEventId: number | null;
}

const VelarisStreamContext = createContext<VelarisStreamValue | null>(null);

export function VelarisStreamProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [sequence, setSequence] = useState(0);
  const lastEventIdRef = useRef<number | null>(null);
  const listenersRef = useRef<Set<(frame: RealtimeEvent) => void>>(new Set());

  useEffect(() => {
    let es: EventSource | null = null;
    let disposed = false;

    const emit = (frame: RealtimeEvent) => {
      if (disposed) return;
      if (frame.type === "event") {
        if (frame.event.id > (lastEventIdRef.current ?? -1)) {
          lastEventIdRef.current = frame.event.id;
        }
      }
      // Bump the refetch tick for anything except the initial handshake.
      if (frame.type === "event" || frame.type === "notification") {
        setSequence((s) => s + 1);
      }
      for (const fn of Array.from(listenersRef.current)) {
        fn(frame);
      }
    };

    const open = () => {
      if (!disposed) setStatus("open");
    };

    es = new EventSource("/api/stream");
    es.onopen = open;
    es.onerror = () => {
      // EventSource auto-reconnects; surface a subtle "connecting" state.
      if (!disposed) setStatus((s) => (s === "open" ? "connecting" : s));
    };
    es.onmessage = (msg) => {
      try {
        emit(JSON.parse(msg.data) as RealtimeEvent);
      } catch {
        /* ignore malformed keepalive / non-JSON frames */
      }
    };

    return () => {
      disposed = true;
      es?.close();
    };
  }, []);

  const on = useCallback((handler: (frame: RealtimeEvent) => void) => {
    listenersRef.current.add(handler);
    return () => {
      listenersRef.current.delete(handler);
    };
  }, []);

  const value = useMemo<VelarisStreamValue>(
    () => ({
      status,
      sequence,
      lastEventId: lastEventIdRef.current,
      on,
    }),
    [status, sequence, on],
  );

  return (
    <VelarisStreamContext.Provider value={value}>
      {children}
    </VelarisStreamContext.Provider>
  );
}

/** Access the shared realtime stream. Must be rendered under the provider. */
export function useVelarisStream(): VelarisStreamValue {
  const ctx = useContext(VelarisStreamContext);
  if (!ctx) {
    throw new Error("useVelarisStream must be used within a VelarisStreamProvider");
  }
  return ctx;
}

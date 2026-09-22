import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import { getDb } from "@/lib/db";
import {
  listEventsAfter,
  getLatestEventId,
  listNotificationsNewerThan,
} from "@/server/repositories/execution-repo";
import type { RealtimeEvent } from "@/shared/types";

export const dynamic = "force-dynamic";

/**
 * /api/stream — SSE change-feed hub (Phase 2).
 *
 * Emits `RealtimeEvent` frames to the browser:
 *   data: {type:"hello", cursor}            — on connect (cursor = starting event id)
 *   id:<n>
 *   data: {type:"event", event}             — one per new execution_events row (id = event id)
 *   data: {type:"notification", notification} — new notification rows
 *   : ping                                   — keepalive comment every 15s
 *
 * Cursors (ARCHITECTURE §4):
 *  - execution_events use INTEGER autoincrement `id > lastSeenId` (lossless,
 *    reconnect-friendly — EventSource auto-resumes from the `id:` field via the
 *    Last-Event-ID header, which we also honour on first connect).
 *  - notifications use uuid ids so their cursor is a (createdAt, id) tuple,
 *    advanced per tick and initialized to "now" on connect so a reconnect does
 *    not re-dump history (fresh state is loaded via GET /api/notifications once).
 */
export async function GET(req: NextRequest) {
  bootstrapDb();

  // Honor reduced-motion/abort semantics gracefully.
  if (req.signal?.aborted) {
    return new Response(null, { status: 200 });
  }

  const db = getDb();

  // Initial event cursor: Last-Event-ID header (EventSource auto-sends on
  // reconnect) beats ?lastEventId= query param beats the latest event id at
  // connect (clients only receive NEW events after connect).
  const lastEventIdHeader = req.headers.get("last-event-id");
  const queryEventId = req.nextUrl.searchParams.get("lastEventId");
  let lastSeenId: number;
  const rawCursor = lastEventIdHeader ?? queryEventId;
  if (rawCursor !== null && rawCursor !== "" && Number.isFinite(Number(rawCursor))) {
    lastSeenId = Math.max(0, Number(rawCursor));
  } else {
    lastSeenId = getLatestEventId(db);
  }

  // Notification cursor starts at "now" so a fresh/reconnecting client only
  // receives notifications created after this connect (history via REST once).
  const nowIso = new Date().toISOString();
  let notifAfterCreatedAt: string | null = nowIso;
  let notifAfterId: string | null = null;

  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (keepalive) {
      clearInterval(keepalive);
      keepalive = null;
    }
  };

  const stream = new ReadableStream({
    start(controller) {
      const hello: RealtimeEvent = { type: "hello", cursor: lastSeenId };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(hello)}\n\n`));

      const tick = async () => {
        // Feed new execution events (id > lastSeenId).
        const events = listEventsAfter(db, lastSeenId, 500);
        for (const ev of events) {
          const payload: RealtimeEvent = { type: "event", event: ev };
          controller.enqueue(
            encoder.encode(`id: ${ev.id}\ndata: ${JSON.stringify(payload)}\n\n`),
          );
          if (ev.id > lastSeenId) lastSeenId = ev.id;
        }

        // Feed new notifications (cursor = createdAt + id tuple).
        const notifs = listNotificationsNewerThan(db, notifAfterCreatedAt, notifAfterId);
        if (notifs.length > 0) {
          // listNotificationsNewerThan orders by createdAt DESC, so the first
          // row carries the max createdAt. All tie rows at that timestamp are
          // present in this batch; advance the cursor past them.
          notifAfterCreatedAt = notifs[0].createdAt;
          notifAfterId = notifs[0].id;
          for (const n of notifs) {
            const payload: RealtimeEvent = { type: "notification", notification: n };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          }
        }
      };

      interval = setInterval(() => {
        void (async () => {
          try {
            await tick();
          } catch {
            /* DB read error on a tick — stream stays alive, retried next tick. */
          }
        })();
      }, 2_000);

      // Keepalive comment every 15s (SSE comments are ignored by EventSource).
      keepalive = setInterval(() => {
        controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
      }, 15_000);

      const onAbort = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal?.addEventListener?.("abort", onAbort, { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

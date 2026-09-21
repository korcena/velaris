import { NextRequest } from "next/server";
import { bootstrapDb } from "@/server/bootstrap";
import type { RealtimeEvent } from "@/shared/types";

export const dynamic = "force-dynamic";

/**
 * /api/stream — SSE stub (Phase 1).
 *
 * Phase 1 only emits an initial `{type:'hello'}` connect event and then keeps
 * the connection alive with `: heartbeat` comments every 15s. Phase 2 wires
 * the DB change-feed into this stream.
 */
export async function GET(req: NextRequest) {
  bootstrapDb();

  // Honor reduced-motion/abort semantics gracefully.
  if (req.signal?.aborted) {
    return new Response(null, { status: 200 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const hello: RealtimeEvent = { type: "hello", cursor: 0 };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(hello)}\n\n`));

      let lastComment = 0;
      const interval = setInterval(() => {
        // Keepalive comment (SSE spec comments are ignored by EventSource).
        const isComment = lastComment++ % 2 === 0;
        if (isComment) {
          controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
        } else {
          controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
        }
      }, 15_000);

      // Cleanup.
      const cleanup = () => {
        clearInterval(interval);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal?.addEventListener?.("abort", cleanup);
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

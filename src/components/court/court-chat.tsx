"use client";

/**
 * Court chat (Phase 4 §7.2 + addendum D2e) — history + composer.
 *
 * The composer stays enabled while a plan is active; submit branches:
 *  - active plan (latest parent non-terminal) → POST /api/court/steer
 *  - otherwise → POST /api/court/instructions
 *
 * A 409 (steer race / busy) surfaces as a toast and keeps the draft so the
 * user can retry. Optimistically appends the user message; the High Lord's
 * reply arrives via the engine and is picked up on the next history refetch.
 */

import { useEffect, useRef, useState } from "react";
import { Send, Loader2, Settings2, Crown } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useVelarisStream } from "@/components/realtime/velaris-stream";
import { apiFetch } from "@/lib/api-client";
import type { CourtMessageDto } from "@/shared/types";

export function CourtChat({
  highLordHouseId,
  activePlanId,
  onPlanCreated,
}: {
  highLordHouseId: string | null;
  /** The latest non-terminal parent task id (drives steer vs instruct). */
  activePlanId: string | null;
  /** Called when a new parent task is created so the plan board refetches. */
  onPlanCreated: (taskId: string) => void;
}) {
  const { sequence } = useVelarisStream();
  const [messages, setMessages] = useState<CourtMessageDto[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!highLordHouseId) {
      setMessages([]);
      return;
    }
    apiFetch<{ messages: CourtMessageDto[] }>("/api/court/history")
      .then((res) => setMessages(res.messages))
      .catch(() => setMessages([]));
  }, [highLordHouseId, sequence]);

  // Autoscroll to the newest message when history grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  async function submit() {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      if (activePlanId) {
        const res = await apiFetch<{ accepted: boolean; sessionId: string }>(
          "/api/court/steer",
          { method: "POST", body: JSON.stringify({ parentTaskId: activePlanId, message: content }) },
        );
        if (res.accepted) {
          setMessages((prev) => [
            ...prev,
            {
              id: `local-${Date.now()}`,
              role: "user",
              content,
              createdAt: new Date().toISOString(),
              taskId: activePlanId,
            },
          ]);
          setDraft("");
          toast.success("The High Lord considers your counsel");
          return;
        }
      }
      // No active plan → new instruction (create a parent task).
      const res = await apiFetch<{ task: { id: string } }>("/api/court/instructions", {
        method: "POST",
        body: JSON.stringify({ instruction: content }),
      });
      onPlanCreated(res.task.id);
      setMessages((prev) => [
        ...prev,
        {
          id: `local-${Date.now()}`,
          role: "user",
          content,
          createdAt: new Date().toISOString(),
          taskId: res.task.id,
        },
      ]);
      setDraft("");
      toast.success("The High Lord convenes the court…");
    } catch (err) {
      const apiErr = err as { status?: number; message?: string };
      if (apiErr.status === 409) {
        toast("The High Lord is mid-counsel — try again in a moment");
      } else {
        toast.error(apiErr.message ?? "Failed to send to the High Lord");
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2 font-serif-display text-xl">
            <Crown className="h-5 w-5 text-velaris-gold" />
            Counsel the High Lord
          </CardTitle>
          {highLordHouseId ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/houses/${highLordHouseId}`}>
                <Settings2 className="mr-1 h-3.5 w-3.5" /> Configure the High Lord
              </Link>
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Instructions become plans; plans become quests.
        </p>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        <ScrollArea className="min-h-0 flex-1 rounded-lg border border-border bg-card/30 p-3">
          <div ref={scrollRef} className="flex h-full flex-col gap-2 overflow-hidden">
            {messages.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <p className="py-10 text-center text-sm italic text-muted-foreground">
                  The court is silent. Speak, and the High Lord shall plan.
                </p>
              </div>
            ) : (
              messages.map((m, i) => (
                <div
                  key={`${m.id}-${i}`}
                  className={`max-w-[85%] rounded-lg border px-3 py-2 text-sm ${
                    m.role === "user"
                      ? "ml-auto border-primary/40 bg-primary/15 text-foreground"
                      : "border-border bg-card/50 text-muted-foreground"
                  }`}
                >
                  <div className="mb-1 text-[0.7rem] font-medium uppercase tracking-wide opacity-60">
                    {m.role === "user" ? "You" : "The High Lord"}
                  </div>
                  <p className="whitespace-pre-wrap">{m.content}</p>
                </div>
              ))
            )}
          </div>
        </ScrollArea>

        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Instruct the High Lord…"
            rows={2}
            className="min-h-14 resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <Button type="submit" size="icon" disabled={sending || !draft.trim()}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            <span className="sr-only">Send</span>
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

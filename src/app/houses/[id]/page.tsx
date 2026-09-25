"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Send, Castle, ArrowLeft, Loader2, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RuntimeStatusBadge } from "@/components/houses/runtime-status-badge";
import { ApprovalList } from "@/components/approvals/approvals-list";
import { HouseOverview } from "@/components/houses/overview/house-overview";
import { ActivityTimeline } from "@/components/houses/activity/activity-timeline";
import { TaskResults } from "@/components/houses/results/task-results";
import { useVelarisStream } from "@/components/realtime/velaris-stream";
import { apiFetch } from "@/lib/api-client";
import type {
  HouseDetailDto,
  ExecutionEventDto,
  AgentMessageDto,
} from "@/shared/types";

export default function HouseDetailPage() {
  const params = useParams<{ id: string }>();
  const houseId = params?.id ?? "";
  const { sequence, on } = useVelarisStream();

  const [house, setHouse] = useState<HouseDetailDto | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [, setLoadingDetail] = useState(true);

  const [events, setEvents] = useState<ExecutionEventDto[]>([]);
  const [messages, setMessages] = useState<AgentMessageDto[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pausing, setPausing] = useState(false);

  // Realtime: subscribe to event frames so we can append a task's events live.
  // Since a single stream serves the whole app, we filter frames by taskId.
  const eventTaskIdRef = useRef<string | null>(null);
  eventTaskIdRef.current = activeTaskId;

  useEffect(() => {
    if (!houseId) return;
    let alive = true;
    setLoadingDetail(true);
    apiFetch<{ house: HouseDetailDto }>(`/api/houses/${houseId}`)
      .then((res) => {
        if (!alive) return;
        setHouse(res.house);
        setActiveTaskId(res.house.activeTask?.id ?? null);
      })
      .catch((err) => {
        if (!alive) return;
        if (err && err.status === 404) setNotFound(true);
        toast.error(err instanceof Error ? err.message : "Failed to load house");
      })
      .finally(() => {
        if (alive) setLoadingDetail(false);
      });
    return () => {
      alive = false;
    };
  }, [houseId, sequence]);

  // Load task events for the active task.
  const loadEvents = useCallback(async (taskId: string) => {
    try {
      const res = await apiFetch<{ events: ExecutionEventDto[] }>(
        `/api/tasks/${taskId}/events`,
      );
      setEvents(res.events);
    } catch {
      setEvents([]);
    }
  }, []);

  useEffect(() => {
    if (activeTaskId) {
      void loadEvents(activeTaskId);
    } else {
      setEvents([]);
    }
  }, [activeTaskId, loadEvents, houseId, sequence]);

  // Load agent chat for the active session.
  useEffect(() => {
    if (!houseId) return;
    apiFetch<{ messages: AgentMessageDto[] }>(`/api/houses/${houseId}/messages`)
      .then((res) => setMessages(res.messages))
      .catch(() => {
        /* silence */
      });
  }, [houseId, sequence]);

  // Live-append execution events for the current task from the stream.
  useEffect(() => {
    return on((frame) => {
      if (frame.type === "event" && frame.event.taskId === eventTaskIdRef.current) {
        setEvents((prev) => {
          if (prev.some((e) => e.id === frame.event.id)) return prev;
          return [...prev, frame.event];
        });
      }
    });
  }, [on]);

  async function sendMessage() {
    const content = draft.trim();
    if (!content) return;
    setSending(true);
    try {
      const res = await apiFetch<{ accepted: boolean; sessionId: string }>(
        `/api/houses/${houseId}/messages`,
        { method: "POST", body: JSON.stringify({ content }) },
      );
      if (res.accepted) {
        // Optimistically append the user's message; the agent reply arrives via
        // the engine (polled / realtime) and is loaded with the next refetch.
        setMessages((prev) => [
          ...prev,
          {
            id: `local-${Date.now()}`,
            sessionId: res.sessionId,
            role: "user",
            content,
            createdAt: new Date().toISOString(),
          },
        ]);
        setDraft("");
        toast.success("Message sent to the house");
        // Refetch shortly after so the relayed reply appears (engine relays async).
        setTimeout(() => {
          apiFetch<{ messages: AgentMessageDto[] }>(
            `/api/houses/${houseId}/messages`,
          )
            .then((m) => setMessages(m.messages))
            .catch(() => {
              /* ignore */
            });
        }, 1500);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  const hasActiveSession = house?.runtimeStatus !== "idle";
  const hasTask = !!activeTaskId;
  const isQuiet = !hasTask || !hasActiveSession;

  const houseName = house?.name ?? "House";

  // Phase 5 native pause/resume: only `executionProvider='ollama'` houses can
  // suspend a running loop in place (decision Q10). The web records intent via
  // the pause/resume routes; the engine does the actual suspend/resume.
  const isOllama = house?.configuration.executionProvider === "ollama";
  const isPaused = house?.activeTask?.status === "paused";

  async function togglePause() {
    if (!activeTaskId || !isOllama) return;
    setPausing(true);
    try {
      const endpoint = isPaused ? "/resume" : "/pause";
      const res = await apiFetch<{ task: { status: string } }>(
        `/api/tasks/${activeTaskId}${endpoint}`,
        { method: "POST" },
      );
      toast.success(isPaused ? "Quest resumed" : "Quest paused");
      void res;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to pause/resume quest");
    } finally {
      setPausing(false);
    }
  }

  if (notFound) {
    return (
      <div>
        <PageHeader title="House not found" />
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            This house does not exist.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={house?.name ?? "House"}
        subtitle={
          house
            ? `${house.agent.name ?? "Unnamed"} · ${house.agent.role ?? ""}`.trim()
            : undefined
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/houses">
              <ArrowLeft className="mr-1 h-4 w-4" /> Back to houses
            </Link>
          </Button>
        }
      />

      {house ? (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <RuntimeStatusBadge runtimeStatus={house.runtimeStatus} />
          {house.activeTask?.id ? (
            <Badge variant="outline">
              Quest: {house.activeTask.title ?? "Untitled"}
              {house.activeTask.status ? ` · ${house.activeTask.status}` : ""}
            </Badge>
          ) : (
            <Badge variant="outline">No active quest</Badge>
          )}

          {isOllama && activeTaskId ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void togglePause()}
              disabled={pausing}
              aria-label={isPaused ? "Resume quest" : "Pause quest"}
            >
              {pausing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isPaused ? (
                <Play className="h-4 w-4" />
              ) : (
                <Pause className="h-4 w-4" />
              )}
              <span>{isPaused ? "Resume" : "Pause"}</span>
            </Button>
          ) : null}
        </div>
      ) : null}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="chat">Agent Chat</TabsTrigger>
          <TabsTrigger value="results">Task Results</TabsTrigger>
          <TabsTrigger value="approvals">Approvals</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-4">
          {house ? (
            <HouseOverview house={house} />
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground">
              Loading the house…
            </p>
          )}
        </TabsContent>

        <TabsContent value="activity" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="font-serif-display text-xl">Activity feed</CardTitle>
            </CardHeader>
            <CardContent>
              {hasTask ? (
                <ActivityTimeline events={events} />
              ) : (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  This house has no active quest yet — its timeline will appear when a task begins.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="chat" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="font-serif-display text-xl">Agent chat</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <ScrollArea className="h-[22rem] rounded-lg border border-border bg-card/30 p-3">
                {messages.length === 0 ? (
                  <p className="py-10 text-center text-sm italic text-muted-foreground">
                    No messages yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {messages.map((m) => (
                      <div
                        key={m.id}
                        className={`max-w-[85%] rounded-lg border px-3 py-2 text-sm ${
                          m.role === "user"
                            ? "ml-auto border-primary/40 bg-primary/15 text-foreground"
                            : "border-border bg-card/50 text-muted-foreground"
                        }`}
                      >
                        <div className="mb-1 text-[0.7rem] font-medium uppercase tracking-wide opacity-60">
                          {m.role === "user" ? "You" : house?.agent.name ?? "Agent"}
                        </div>
                        <p className="whitespace-pre-wrap">{m.content}</p>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>

              {isQuiet ? (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-card/30 px-4 py-6 text-sm text-muted-foreground">
                  <Castle className="h-5 w-5 text-velaris-silver-muted" />
                  <p>
                    The house is quiet — start a quest on the{" "}
                    <Link href="/quests" className="text-primary hover:underline">
                      Quest Board
                    </Link>{" "}
                    to begin a conversation.
                  </p>
                </div>
              ) : (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void sendMessage();
                  }}
                >
                  <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={
                      house?.runtimeStatus === "awaiting_input"
                        ? "Answer the house's question…"
                        : "Send a message to the house…"
                    }
                  />
                  <Button type="submit" size="icon" disabled={sending || !draft.trim()}>
                    {sending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                    <span className="sr-only">Send</span>
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="results" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="font-serif-display text-xl">Task results</CardTitle>
            </CardHeader>
            <CardContent>
              <TaskResults houseId={houseId} refreshKey={sequence} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="approvals" className="pt-4">
          <ApprovalList houseId={houseId} refreshKey={sequence} />
        </TabsContent>
      </Tabs>

      <Separator className="mt-8" />
    </div>
  );
}

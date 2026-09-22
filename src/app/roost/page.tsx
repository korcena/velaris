"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Bird, Castle, CheckCheck, ScrollText } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { ApprovalList } from "@/components/approvals/approvals-list";
import { ApprovalHistory } from "@/components/roost/approval-history";
import { useVelarisStream } from "@/components/realtime/velaris-stream";
import { apiFetch } from "@/lib/api-client";
import type { NotificationDto, NotificationType } from "@/shared/types";

const NOTIF_BADGE: Record<NotificationType, { label: string; className: string }> = {
  approval: { label: "approval", className: "bg-velaris-gold/15 text-velaris-gold" },
  completion: { label: "complete", className: "bg-velaris-teal/15 text-velaris-teal" },
  failure: { label: "failure", className: "bg-velaris-crimson/15 text-velaris-crimson" },
  system: { label: "system", className: "bg-velaris-purple/15 text-velaris-purple" },
};

// Select options use the same labels as the badges for consistency.
const TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All types" },
  { value: "approval", label: NOTIF_BADGE.approval.label },
  { value: "completion", label: NOTIF_BADGE.completion.label },
  { value: "failure", label: NOTIF_BADGE.failure.label },
  { value: "system", label: NOTIF_BADGE.system.label },
];

export default function MessengerRoostPage() {
  const { sequence } = useVelarisStream();

  const [notifications, setNotifications] = useState<NotificationDto[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [marking, setMarking] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<"all" | NotificationType>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);

  const load = useCallback(async () => {
    try {
      const q = unreadOnly ? "?unreadOnly=1" : "";
      const res = await apiFetch<{ notifications: NotificationDto[]; unread: number }>(
        `/api/notifications${q}`,
      );
      setNotifications(res.notifications);
      setUnread(res.unread);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load the roost");
    } finally {
      setLoading(false);
    }
  }, [unreadOnly]);

  useEffect(() => {
    void load();
  }, [load, sequence]);

  const visible = useMemo(
    () =>
      typeFilter === "all"
        ? notifications
        : notifications.filter((n) => n.type === typeFilter),
    [notifications, typeFilter],
  );

  async function markRead(id: string) {
    setMarking(id);
    try {
      await apiFetch(`/api/notifications/${id}/read`, { method: "POST" });
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
      );
      setUnread((u) => Math.max(0, u - 1));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to mark read");
    } finally {
      setMarking(null);
    }
  }

  async function markAllRead() {
    try {
      await apiFetch("/api/notifications/read-all", { method: "POST" });
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnread(0);
      toast.success("All birds acknowledged");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to mark all read");
    }
  }

  return (
    <div>
      <PageHeader
        title="Messenger Roost"
        subtitle="Approvals and clarifications, delivered by bird."
        actions={
          unread > 0 ? (
            <Button variant="outline" onClick={markAllRead}>
              <CheckCheck className="mr-2 h-4 w-4" /> Mark all read
            </Button>
          ) : null
        }
      />

      <div className="mb-6 rounded-lg border border-border bg-card/40 px-4 py-3 text-sm text-muted-foreground">
        {unread > 0 ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-velaris-gold status-glow-active" />
            {unread} unread message{unread !== 1 ? "s" : ""}. The birds are awaiting your attention.
          </span>
        ) : (
          <span className="inline-flex items-center gap-2">
            <Bird className="h-4 w-4 text-velaris-teal" />
            The roost is quiet — no unread messages.
          </span>
        )}
      </div>

      <Tabs defaultValue="notifications">
        <TabsList>
          <TabsTrigger value="notifications">
            Notifications
            {unread > 0 ? (
              <Badge variant="outline" className="ml-1 min-w-4 justify-center px-1">
                {unread}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="approvals">Pending approvals</TabsTrigger>
        </TabsList>

        {/* Notifications feed */}
        <TabsContent value="notifications" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="font-serif-display text-xl">Messages</CardTitle>
              {/* Filter bar: type Select + Unread-only Switch */}
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Select
                  value={typeFilter}
                  onValueChange={(v) => setTypeFilter((v as "all" | NotificationType) ?? "all")}
                >
                  <SelectTrigger className="w-44">
                    <SelectValue placeholder="All types" />
                  </SelectTrigger>
                  <SelectContent>
                    {TYPE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Switch checked={unreadOnly} onCheckedChange={setUnreadOnly} />
                  Unread only
                </label>
              </div>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Listening for the birds…
                </p>
              ) : visible.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-16 text-center">
                  <Bird className="h-8 w-8 text-velaris-silver-muted" />
                  <p className="font-serif-display text-xl text-foreground">The roost is quiet.</p>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {notifications.length === 0
                      ? "No birds have been sent. When a house needs an approval — a permission, a command, or a clarification — a messenger bird will land here."
                      : "No birds match this filter."}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {visible.map((n) => {
                    const badge = NOTIF_BADGE[n.type] ?? NOTIF_BADGE.system;
                    const houseHref = n.houseId ? `/houses/${n.houseId}` : null;
                    const questHref = !houseHref && n.taskId ? `/quests` : null;
                    return (
                      <div
                        key={n.id}
                        className={`rounded-lg border p-3 ${
                          n.read
                            ? "border-border bg-card/30 opacity-70"
                            : "border-velaris-gold/40 bg-velaris-gold/5"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span
                              className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                                n.read ? "bg-border" : "bg-velaris-gold status-glow-active"
                              }`}
                            />
                            <Badge variant="outline" className={badge.className}>
                              {badge.label}
                            </Badge>
                            <span className="truncate font-medium text-foreground">{n.title}</span>
                          </div>
                          {!n.read ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => markRead(n.id)}
                              disabled={marking === n.id}
                            >
                              Mark read
                            </Button>
                          ) : null}
                        </div>
                        {n.body ? (
                          <p className="mt-1 whitespace-pre-wrap pl-4 text-sm text-muted-foreground">
                            {n.body}
                          </p>
                        ) : null}
                        <p className="mt-1 pl-4 text-xs text-muted-foreground">
                          {new Date(n.createdAt).toLocaleString()}
                        </p>
                        {houseHref || questHref ? (
                          <div className="mt-1 pl-4">
                            {houseHref ? (
                              <Link
                                href={houseHref}
                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                              >
                                <Castle className="h-3 w-3" /> View house
                              </Link>
                            ) : questHref ? (
                              <Link
                                href={questHref}
                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                              >
                                <ScrollText className="h-3 w-3" /> View quest
                              </Link>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Pending approvals across all houses + resolved history */}
        <TabsContent value="approvals" className="pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="font-serif-display text-xl">Pending approvals</CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <ApprovalList refreshKey={sequence} bare />
            </CardContent>
          </Card>
          <Separator className="my-6" />
          <div>
            <h3 className="font-serif-display mb-3 text-lg text-foreground">Resolved history</h3>
            <ApprovalHistory refreshKey={sequence} />
          </div>
        </TabsContent>
      </Tabs>

      <Separator className="mt-8" />
    </div>
  );
}

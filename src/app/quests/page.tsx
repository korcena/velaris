"use client";

import { Fragment, useEffect, useState, useCallback } from "react";
import { Activity, Loader2, Plus, XCircle } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/layout/page-header";
import { TaskStatusBadge, isTerminalStatus } from "@/components/houses/task-status-badge";
import { useVelarisStream } from "@/components/realtime/velaris-stream";
import { apiFetch } from "@/lib/api-client";
import { taskCreateSchema } from "@/shared/schemas/task";
import { DEFAULT_TASK_TYPES, TASK_PRIORITIES } from "@/shared/constants";
import type { TaskDto, HouseDto, ProjectDto, ExecutionEventDto } from "@/shared/types";

type TaskFormValues = z.infer<typeof taskCreateSchema>;

export default function QuestBoardPage() {
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [houses, setHouses] = useState<HouseDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // Expandable per-task activity feed (Job F.3).
  const [activityOpen, setActivityOpen] = useState<string | null>(null);
  const [eventsByTask, setEventsByTask] = useState<Record<string, ExecutionEventDto[]>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const { sequence } = useVelarisStream();

  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskCreateSchema),
    defaultValues: {
      title: "",
      description: "",
      type: "general",
      priority: "medium",
      houseId: null,
      projectId: null,
      workingDirectory: null,
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = form;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [taskRes, houseRes, projectRes] = await Promise.all([
        apiFetch<{ tasks: TaskDto[] }>("/api/tasks"),
        apiFetch<{ houses: HouseDto[] }>("/api/houses?includeArchived=false"),
        apiFetch<{ projects: ProjectDto[] }>("/api/projects"),
      ]);
      setTasks(taskRes.tasks);
      setHouses(houseRes.houses);
      setProjects(projectRes.projects);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load Quest Board");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, sequence]);

  useEffect(() => {
    if (!activityOpen) return;
    apiFetch<{ events: ExecutionEventDto[] }>(`/api/tasks/${activityOpen}/events`)
      .then((res) => setEventsByTask((prev) => ({ ...prev, [activityOpen]: res.events })))
      .catch(() => setEventsByTask((prev) => ({ ...prev, [activityOpen]: [] })));
  }, [activityOpen, sequence]);

  async function cancelTask(id: string) {
    setBusyId(id);
    try {
      const res = await apiFetch<{ task: TaskDto; cancelled: boolean }>(
        `/api/tasks/${id}/cancel`,
        { method: "POST" },
      );
      if (res.cancelled) toast.success("Quest cancelled");
      else toast.info("Quest already completed");
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? res.task : t)),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel quest");
    } finally {
      setBusyId(null);
    }
  }

  const selectedProject = watch("projectId");

  async function onSubmit(values: TaskFormValues) {
    setSaving(true);
    try {
      const payload = {
        ...values,
        // working_directory defaults to the project directory if a project is chosen.
        workingDirectory: values.workingDirectory ?? (selectedProject
          ? projects.find((p) => p.id === selectedProject)?.directory ?? null
          : null),
      };
      const res = await apiFetch<{ task: TaskDto }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      toast.success(`Quest '${res.task.title}' logged`);
      setTasks((prev) => [res.task, ...prev]);
      reset();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create quest");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Quest Board"
        subtitle="Log tasks for your houses and track their execution in real time."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> New quest
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="font-serif-display text-xl">Postings</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Reading the board…</p>
          ) : tasks.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No quests have been posted yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Assigned to</TableHead>
                  <TableHead>Activity</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => (
                  <FragmentRow
                    key={task.id}
                    task={task}
                    houseName={houses.find((h) => h.id === task.houseId)?.name ?? "—"}
                    activityOpen={activityOpen === task.id}
                    events={eventsByTask[task.id] ?? null}
                    busy={busyId === task.id}
                    onToggleActivity={() =>
                      setActivityOpen((cur) => (cur === task.id ? null : task.id))
                    }
                    onCancel={() => cancelTask(task.id)}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="font-serif-display text-2xl">Post a new quest</DialogTitle>
            <DialogDescription>
              Describe the work for a house to undertake.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="taskTitle">Title</Label>
              <Input id="taskTitle" {...register("title")} placeholder="Fix the login bug" />
              {errors.title && <p className="text-xs text-velaris-crimson">{errors.title.message}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="taskDesc">Description</Label>
              <Textarea
                id="taskDesc"
                {...register("description")}
                placeholder="What should the house accomplish?"
                rows={4}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select
                  value={watch("type")}
                  onValueChange={(v) => setValue("type", v)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {DEFAULT_TASK_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Select
                  value={watch("priority")}
                  onValueChange={(v) =>
                    setValue("priority", v as (typeof TASK_PRIORITIES)[number])
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TASK_PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Assigned house</Label>
                <Select
                  value={watch("houseId") ?? ""}
                  onValueChange={(v) => setValue("houseId", v || null)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {houses.map((h) => (
                      <SelectItem key={h.id} value={h.id}>
                        {h.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Project (optional)</Label>
                <Select
                  value={watch("projectId") ?? ""}
                  onValueChange={(v) => setValue("projectId", v || null)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="workdir">Working directory (override)</Label>
                <Input
                  id="workdir"
                  {...register("workingDirectory")}
                  placeholder="/abs/path (defaults to project dir)"
                  className="font-mono text-xs"
                />
              </div>
            </div>

            <Separator />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Posting…" : "Post quest"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FragmentRow({
  task,
  houseName,
  activityOpen,
  events,
  busy,
  onToggleActivity,
  onCancel,
}: {
  task: TaskDto;
  houseName: string;
  activityOpen: boolean;
  events: ExecutionEventDto[] | null;
  busy: boolean;
  onToggleActivity: () => void;
  onCancel: () => void;
}) {
  const cancellable = !isTerminalStatus(task.status);
  return (
    <FragmentRowContent
      task={task}
      houseName={houseName}
      activityOpen={activityOpen}
      events={events}
      busy={busy}
      onToggleActivity={onToggleActivity}
      onCancel={onCancel}
      cancellable={cancellable}
    />
  );
}

function FragmentRowContent({
  task,
  houseName,
  activityOpen,
  events,
  busy,
  onToggleActivity,
  onCancel,
  cancellable,
}: {
  task: TaskDto;
  houseName: string;
  activityOpen: boolean;
  events: ExecutionEventDto[] | null;
  busy: boolean;
  onToggleActivity: () => void;
  onCancel: () => void;
  cancellable: boolean;
}) {
  return (
    <Fragment>
      <TableRow>
        <TableCell className="font-medium text-foreground">{task.title}</TableCell>
        <TableCell>{task.type}</TableCell>
        <TableCell>
          <PriorityBadge priority={task.priority} />
        </TableCell>
        <TableCell>
          <TaskStatusBadge status={task.status} />
        </TableCell>
        <TableCell className="text-muted-foreground">{houseName}</TableCell>
        <TableCell>
          <Button variant="ghost" size="sm" onClick={onToggleActivity} aria-expanded={activityOpen}>
            <Activity className="mr-1 h-3.5 w-3.5" />
            {activityOpen ? "Hide" : "View"}
          </Button>
        </TableCell>
        <TableCell className="text-right">
          {cancellable && (
            <Button
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={busy}
              className="text-velaris-crimson hover:bg-velaris-crimson/10"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <XCircle className="h-3.5 w-3.5" />
              )}
              Cancel
            </Button>
          )}
        </TableCell>
      </TableRow>
      {activityOpen ? (
        <TableRow>
          <TableCell colSpan={7}>
            <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-card/30 p-3 font-mono text-xs">
              {events === null ? (
                <p className="italic text-muted-foreground">Loading activity…</p>
              ) : events.length === 0 ? (
                <p className="italic text-muted-foreground">No activity recorded yet.</p>
              ) : (
                <ol className="space-y-2">
                  {events.map((ev) => (
                    <li key={ev.id} className="rounded border border-border bg-card/40 px-2 py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <Badge variant="outline">{ev.type}</Badge>
                        <span className="text-muted-foreground">
                          {new Date(ev.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      {ev.payload && Object.keys(ev.payload).length > 0 ? (
                        <pre className="mt-1 overflow-x-auto text-[0.7rem] text-muted-foreground">
                          {JSON.stringify(ev.payload)}
                        </pre>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </Fragment>
  );
}

function PriorityBadge({ priority }: { priority: TaskDto["priority"] }) {
  const map = {
    low: { className: "bg-muted text-muted-foreground", label: "low" },
    medium: { className: "bg-velaris-purple/15 text-velaris-purple", label: "medium" },
    high: { className: "bg-velaris-crimson/15 text-velaris-crimson", label: "high" },
    urgent: { className: "bg-velaris-gold/15 text-velaris-gold", label: "urgent" },
  } as const;
  const s = map[priority];
  return <Badge variant="outline" className={s.className}>{s.label}</Badge>;
}

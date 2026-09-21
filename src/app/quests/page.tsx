"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus } from "lucide-react";
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
import { apiFetch } from "@/lib/api-client";
import { taskCreateSchema } from "@/shared/schemas/task";
import { DEFAULT_TASK_TYPES, TASK_PRIORITIES } from "@/shared/constants";
import type { TaskDto, HouseDto, ProjectDto } from "@/shared/types";

type TaskFormValues = z.infer<typeof taskCreateSchema>;

export default function QuestBoardPage() {
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [houses, setHouses] = useState<HouseDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

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
  }, [load]);

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
        subtitle="Log tasks for your houses. In Phase 1, quests wait in queue — execution arrives with the engine in Phase 2."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> New quest
          </Button>
        }
      />

      <Card className="mb-6">
        <CardContent className="flex items-center gap-3 border-b-0 py-3 text-sm text-muted-foreground">
          <span className="h-2 w-2 rounded-full bg-velaris-gold" />
          <span>
            Status is locked to <Badge variant="outline" className="align-middle">queued</Badge> and{" "}
            <Badge variant="outline" className="align-middle">cancelled</Badge> in Phase 1{" "}
            <span className="italic">— awaiting the engine.</span>
          </span>
        </CardContent>
      </Card>

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
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell className="font-medium text-foreground">{task.title}</TableCell>
                    <TableCell>{task.type}</TableCell>
                    <TableCell>
                      <PriorityBadge priority={task.priority} />
                    </TableCell>
                    <TableCell>
                      <Badge variant={task.status === "cancelled" ? "secondary" : "default"}>
                        {task.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {houses.find((h) => h.id === task.houseId)?.name ?? "—"}
                    </TableCell>
                  </TableRow>
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
              Describe the work for a house to undertake. Execution begins in Phase 2.
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

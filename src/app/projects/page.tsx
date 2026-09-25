"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, GitBranch, GitCommitHorizontal, GitMerge, Folder, Sparkles } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PageHeader } from "@/components/layout/page-header";
import { TemplatePickerDialog } from "@/components/templates/template-picker-dialog";
import { apiFetch } from "@/lib/api-client";
import { projectCreateSchema } from "@/shared/schemas/project";
import { isAbsolutePath } from "@/shared/path-helpers";
import type { ProjectDto } from "@/shared/types";

type ProjectFormValues = z.infer<typeof projectCreateSchema>;

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectDto | undefined>(undefined);

  const form = useForm<ProjectFormValues>({
    resolver: zodResolver(projectCreateSchema),
    defaultValues: { name: "", description: "", directory: "", defaultModel: null, instructions: null },
  });
  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = form;

  const dirValue = watch("directory");
  const dirAbs = dirValue ? isAbsolutePath(dirValue.trim()) : false;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ projects: ProjectDto[] }>("/api/projects");
      setProjects(res.projects);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSubmit(values: ProjectFormValues) {
    setSaving(true);
    try {
      const res = await apiFetch<{ project: ProjectDto }>("/api/projects", {
        method: "POST",
        body: JSON.stringify(values),
      });
      toast.success(`Project '${res.project.name}' registered`);
      setProjects((prev) => [res.project, ...prev]);
      reset();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to register project");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await apiFetch(`/api/projects/${deleteTarget.id}`, { method: "DELETE" });
      setProjects((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      toast.success(`Project '${deleteTarget.name}' removed`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete project");
    } finally {
      setDeleteTarget(undefined);
    }
  }

  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle="Working directories and repositories your houses operate within. Directories are validated to exist and must be unique."
        actions={
          <>
            <Button variant="outline" onClick={() => setTemplateOpen(true)} data-testid="new-from-template">
              <Sparkles className="mr-2 h-4 w-4" /> New from template
            </Button>
            <Button onClick={() => setOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> Register project
            </Button>
          </>
        }
      />

      {loading ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Consulting the city records…
          </CardContent>
        </Card>
      ) : projects.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <p className="font-serif-display text-xl text-foreground">No projects registered.</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Register a working directory to give the houses somewhere to build.
            </p>
            <Button className="mt-6" onClick={() => setOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> Register a project
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {projects.map((project) => (
            <Card key={project.id}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
                      <Folder className="h-4 w-4" />
                    </div>
                    <div>
                      <CardTitle className="font-serif-display text-lg">{project.name}</CardTitle>
                      {project.description ? (
                        <p className="text-sm text-muted-foreground">{project.description}</p>
                      ) : null}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(project)}>
                    Remove
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p className="font-mono text-xs">{project.directory}</p>
                <GitInfo gitInfo={project.gitInfo} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="font-serif-display text-2xl">Register a project</DialogTitle>
            <DialogDescription>
              Provide an absolute path to an existing directory. Git info is auto-detected.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="projName">Name</Label>
              <Input id="projName" {...register("name")} placeholder="Velaris" />
              {errors.name && <p className="text-xs text-velaris-crimson">{errors.name.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="projDir">Directory (absolute)</Label>
              <Input
                id="projDir"
                {...register("directory")}
                placeholder="/home/you/projects/velaris"
                className="font-mono text-xs"
              />
              {dirValue && !dirAbs ? (
                <p className="text-xs text-velaris-gold">Path must be absolute (start with /).</p>
              ) : null}
              {errors.directory && (
                <p className="text-xs text-velaris-crimson">{errors.directory.message}</p>
              )}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="projModel">Default model</Label>
                <Input id="projModel" {...register("defaultModel")} placeholder="glm-5.3" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="projDesc">Description</Label>
                <Input id="projDesc" {...register("description")} placeholder="Optional" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="projInstr">Instructions (optional)</Label>
              <Textarea id="projInstr" {...register("instructions")} rows={3} />
            </div>
            <Separator />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Registering…" : "Register project"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <TemplatePickerDialog
        kind="project"
        open={templateOpen}
        onOpenChange={setTemplateOpen}
        onInstantiated={(res) => {
          if (res.project) {
            setProjects((prev) => [res.project!, ...prev]);
            toast.success(`Project '${res.project.name}' registered from a template`);
          }
        }}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove project?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the project record. Blocked if any quests reference it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function GitInfo({ gitInfo }: { gitInfo: ProjectDto["gitInfo"] }) {
  if (!gitInfo.branch) {
    return <p className="text-xs italic">No git repository detected.</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant="outline" className="gap-1">
        <GitBranch className="h-3 w-3" /> {gitInfo.branch}
      </Badge>
      {gitInfo.remote ? (
        <Badge variant="outline" className="gap-1">
          <GitMerge className="h-3 w-3" /> {gitInfo.remote}
        </Badge>
      ) : null}
      <Badge
        variant="outline"
        className={gitInfo.dirty ? "gap-1 text-velaris-gold" : "gap-1"}
      >
        {gitInfo.dirty ? <GitCommitHorizontal className="h-3 w-3" /> : null}
        {gitInfo.dirty ? "dirty" : "clean"}
      </Badge>
    </div>
  );
}

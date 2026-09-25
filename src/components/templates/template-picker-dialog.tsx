"use client";

/**
 * Template picker dialog (Phase 6 Stage C) — pick a template and instantiate a
 * fully configured house or project.
 *
 * The heavy lifting stays server-side: the instantiate endpoint merges the
 * template payload with these overrides and runs the SAME house/project schemas
 * as normal creation. This dialog only collects the instantiation inputs:
 * name (+ optional agent name) for a house, name + required directory for a
 * project.
 *
 * Motion: only opacity/hover transitions; the global reduced-motion CSS covers
 * it (no transform-based animation).
 */

import { useCallback, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { apiFetch } from "@/lib/api-client";
import type { HouseDto, ProjectDto, TemplateDto, TemplateKind } from "@/shared/types";

interface Props {
  kind: TemplateKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the created house/project so the page can navigate/refresh. */
  onInstantiated: (result: { house?: HouseDto; project?: ProjectDto }) => void;
}

export function TemplatePickerDialog({ kind, open, onOpenChange, onInstantiated }: Props) {
  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [agentName, setAgentName] = useState("");
  const [directory, setDirectory] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ templates: TemplateDto[] }>(`/api/templates?kind=${kind}`);
      setTemplates(res.templates);
      setSelectedId((cur) => cur ?? res.templates[0]?.id ?? null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const selected = templates.find((t) => t.id === selectedId) ?? null;

  // Default the name to the template name whenever the selection changes.
  useEffect(() => {
    if (selected) setName(selected.name);
  }, [selected]);

  async function instantiate() {
    if (!selected) return;
    if (kind === "project" && !directory.trim()) {
      toast.error("A directory is required to instantiate a project template");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (name.trim()) body.name = name.trim();
      if (kind === "house" && agentName.trim()) body.agentName = agentName.trim();
      if (kind === "project") body.directory = directory.trim();

      const res = await apiFetch<{ house?: HouseDto; project?: ProjectDto }>(
        `/api/templates/${selected.id}/instantiate`,
        { method: "POST", body: JSON.stringify(body) },
      );
      onInstantiated(res);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to instantiate template");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="template-picker">
        <DialogHeader>
          <DialogTitle className="font-serif-display text-2xl">
            {kind === "house" ? "Found a house from a template" : "Register a project from a template"}
          </DialogTitle>
          <DialogDescription>
            Choose a template. The created {kind} is fully configured and editable afterwards.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading templates…</p>
        ) : templates.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No {kind} templates available. Create one in Settings or seed a default on boot.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Template</Label>
              <div className="grid max-h-52 gap-2 overflow-y-auto">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSelectedId(t.id)}
                    data-testid={`template-option-${t.id}`}
                    className={`rounded-lg border p-3 text-left transition-colors ${
                      selectedId === t.id
                        ? "border-primary bg-primary/10"
                        : "border-border bg-card/40 hover:bg-card/70"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{t.name}</span>
                      {t.isSeeded ? (
                        <Badge variant="secondary" className="gap-1">
                          <Sparkles className="h-3 w-3" /> default
                        </Badge>
                      ) : null}
                    </div>
                    {t.description ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="tpl-name">{kind === "house" ? "House name" : "Project name"}</Label>
              <Input
                id="tpl-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={selected?.name ?? "Name"}
              />
            </div>

            {kind === "house" ? (
              <div className="space-y-2">
                <Label htmlFor="tpl-agent">Agent name (optional)</Label>
                <Input
                  id="tpl-agent"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="Leave blank to use the template's agent"
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="tpl-dir">Directory (absolute)</Label>
                <Input
                  id="tpl-dir"
                  value={directory}
                  onChange={(e) => setDirectory(e.target.value)}
                  placeholder="/home/you/projects/repo"
                  className="font-mono text-xs"
                />
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void instantiate()}
            disabled={saving || !selected}
            data-testid="template-instantiate"
          >
            {saving ? "Instantiating…" : "Instantiate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

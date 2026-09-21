"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, Trash2, Star, Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api-client";
import { DEFAULT_TASK_TYPES } from "@/shared/constants";
import type { ProviderConfigDto, ProviderConfigType } from "@/shared/types";
import type { StoredTaskTypes } from "@/shared/types";

const TASK_TYPES_KEY = "velaris.taskTypes";
const REDUCED_MOTION_KEY = "velaris.reducedMotion";

export default function SettingsPage() {
  // Provider configs
  const [providerConfigs, setProviderConfigs] = useState<ProviderConfigDto[]>([]);
  const [loading, setLoading] = useState(true);

  // New provider form
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<ProviderConfigType>("opencode");
  const [newBaseUrl, setNewBaseUrl] = useState("");
  const [newIsDefault, setNewIsDefault] = useState(false);

  // Task types
  const [taskTypes, setTaskTypes] = useState<string[]>(DEFAULT_TASK_TYPES as unknown as string[]);
  const [newTaskType, setNewTaskType] = useState("");

  // Appearance
  const [reducedMotion, setReducedMotion] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ providerConfigs: ProviderConfigDto[] }>("/api/provider-configs");
      setProviderConfigs(res.providerConfigs);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load provider configs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    loadLocalSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadLocalSettings() {
    try {
      const storedTypes = localStorage.getItem(TASK_TYPES_KEY);
      if (storedTypes) {
        const parsed = JSON.parse(storedTypes) as StoredTaskTypes;
        setTaskTypes(parsed.types?.length ? parsed.types : (DEFAULT_TASK_TYPES as unknown as string[]));
      }
    } catch {
      /* ignore */
    }
    try {
      const storedMotion = localStorage.getItem(REDUCED_MOTION_KEY);
      if (storedMotion === "true") setReducedMotion(true);
    } catch {
      /* ignore */
    }
  }

  function applyReducedMotionClass(enabled: boolean) {
    document.documentElement.classList.toggle("velaris-reduced-motion", enabled);
    try {
      localStorage.setItem(REDUCED_MOTION_KEY, String(enabled));
    } catch {
      /* ignore */
    }
  }

  function toggleReducedMotion() {
    setReducedMotion((prev) => {
      applyReducedMotionClass(!prev);
      return !prev;
    });
  }

  async function createProviderConfig(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ providerConfig: ProviderConfigDto }>("/api/provider-configs", {
        method: "POST",
        body: JSON.stringify({
          name: newName,
          type: newType,
          baseUrl: newBaseUrl,
          isDefault: newIsDefault,
        }),
      });
      setProviderConfigs((prev) => {
        // If this became default, clear the previous default of that type in the UI.
        if (res.providerConfig.isDefault) {
          return prev
            .map((c) =>
              c.type === res.providerConfig.type ? { ...c, isDefault: false } : c,
            )
            .concat(res.providerConfig);
        }
        return [...prev, res.providerConfig];
      });
      toast.success("Provider config created");
      setNewName("");
      setNewBaseUrl("");
      setNewIsDefault(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create provider config");
    }
  }

  async function updateProviderConfig(id: string, patch: { isDefault?: boolean; baseUrl?: string }) {
    try {
      const res = await apiFetch<{ providerConfig: ProviderConfigDto }>(
        `/api/provider-configs/${id}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      );
      setProviderConfigs((prev) =>
        prev
          .map((c) =>
            c.id === id
              ? res.providerConfig
              : res.providerConfig.isDefault && c.type === res.providerConfig.type
                ? { ...c, isDefault: false }
                : c,
          ),
      );
      toast.success("Provider config updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update provider config");
    }
  }

  async function deleteProviderConfig(id: string) {
    try {
      await apiFetch(`/api/provider-configs/${id}`, { method: "DELETE" });
      setProviderConfigs((prev) => prev.filter((c) => c.id !== id));
      toast.success("Provider config deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete provider config");
    }
  }

  function addCustomTaskType() {
    const t = newTaskType.trim();
    if (!t) return;
    if (taskTypes.includes(t)) {
      toast.info("That task type already exists");
      return;
    }
    const next = [...taskTypes, t];
    setTaskTypes(next);
    persistTaskTypes(next);
    setNewTaskType("");
    toast.success(`Added task type '${t}'`);
  }

  function removeCustomTaskType(t: string) {
    if (DEFAULT_TASK_TYPES.includes(t as (typeof DEFAULT_TASK_TYPES)[number])) {
      toast.info("Default task types cannot be removed");
      return;
    }
    const next = taskTypes.filter((x) => x !== t);
    setTaskTypes(next);
    persistTaskTypes(next);
    toast.success(`Removed task type '${t}'`);
  }

  function persistTaskTypes(types: string[]) {
    const payload: StoredTaskTypes = { types };
    try {
      localStorage.setItem(TASK_TYPES_KEY, JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="max-w-4xl space-y-8">
      <div>
        <h1 className="font-serif-display text-3xl text-foreground">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Provider endpoints, task types, and appearance. Provider configs persist to the database;
          task types and appearance are stored in your browser for now.
        </p>
      </div>

      {/* Provider configs */}
      <Card>
        <CardHeader>
          <CardTitle className="font-serif-display text-xl">Provider Configs</CardTitle>
          <CardDescription>
            Endpoints for the execution engines. The default marks the active base URL per type
            (OpenCode / Ollama).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading providers…</p>
          ) : (
            <div className="space-y-2">
              {providerConfigs.map((config) => (
                <div
                  key={config.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card/40 p-3"
                >
                  <div className="min-w-[8rem]">
                    <div className="flex items-center gap-2 font-medium text-foreground">
                      {config.name}
                      {config.isDefault ? (
                        <Star className="h-3.5 w-3.5 text-velaris-gold" />
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline">{config.type}</Badge>
                      <span className="font-mono">{config.baseUrl}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={config.isDefault}
                      onCheckedChange={(checked) => updateProviderConfig(config.id, { isDefault: checked })}
                      aria-label={`Set ${config.name} as default`}
                    />
                    <Button variant="ghost" size="icon" onClick={() => deleteProviderConfig(config.id)}>
                      <Trash2 className="h-4 w-4 text-velaris-crimson" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <Separator />

          <form onSubmit={createProviderConfig} className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1">
                <Label htmlFor="pcName">Name</Label>
                <Input
                  id="pcName"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="OpenCode (local)"
                  required
                />
              </div>
              <div className="space-y-1">
                <Label>Type</Label>
                <Select
                  value={newType}
                  onValueChange={(v) => setNewType(v as ProviderConfigType)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="opencode">opencode</SelectItem>
                    <SelectItem value="ollama">ollama</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="pcBase">Base URL</Label>
                <Input
                  id="pcBase"
                  value={newBaseUrl}
                  onChange={(e) => setNewBaseUrl(e.target.value)}
                  placeholder="http://127.0.0.1:4096"
                  required
                />
              </div>
              <div className="flex items-end gap-2">
                <div className="flex items-center gap-2 pb-1">
                  <Switch
                    id="pcDefault"
                    checked={newIsDefault}
                    onCheckedChange={setNewIsDefault}
                  />
                  <Label htmlFor="pcDefault" className="text-xs">Default</Label>
                </div>
                <Button type="submit" className="ml-auto">
                  <Plus className="mr-1 h-4 w-4" /> Add
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Task types */}
      <Card>
        <CardHeader>
          <CardTitle className="font-serif-display text-xl">Task Types</CardTitle>
          <CardDescription>
            Quest categories. Add custom strings; these are combined with the built-in defaults.
            Persisted to your browser for now.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {taskTypes.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 text-xs text-foreground"
              >
                {t}
                {!DEFAULT_TASK_TYPES.includes(t as (typeof DEFAULT_TASK_TYPES)[number]) ? (
                  <button onClick={() => removeCustomTaskType(t)} aria-label={`Remove ${t}`}>
                    <Trash2 className="h-3 w-3 text-muted-foreground hover:text-velaris-crimson" />
                  </button>
                ) : null}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={newTaskType}
              onChange={(e) => setNewTaskType(e.target.value)}
              placeholder="my_custom_type"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustomTaskType();
                }
              }}
            />
            <Button variant="outline" onClick={addCustomTaskType}>
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Appearance */}
      <Card>
        <CardHeader>
          <CardTitle className="font-serif-display text-xl">Appearance</CardTitle>
          <CardDescription>
            Reduce motion across the city's animations. This also respects your OS
            &ldquo;prefers-reduced-motion&rdquo; setting.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-lg border border-border bg-card/40 p-3">
            <div>
              <p className="font-medium text-foreground">Reduced motion</p>
              <p className="text-xs text-muted-foreground">
                Replace animations with static indicators (Phase 3 honors this globally).
              </p>
            </div>
            <Switch checked={reducedMotion} onCheckedChange={toggleReducedMotion} />
          </div>
          <Button
            className="mt-4"
            variant="outline"
            onClick={() => {
              // Save nothing server-side for now — placeholder to indicate persistence.
              toast.success("Appearance preferences saved locally");
            }}
          >
            <Save className="mr-2 h-4 w-4" /> Save appearance
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

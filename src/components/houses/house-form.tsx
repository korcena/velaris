"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api-client";
import { houseCreateSchema, houseUpdateSchema } from "@/shared/schemas/house";
import {
  EXECUTION_PROVIDERS,
  APPROVAL_POLICIES,
  PERMISSION_MODES,
  DEFAULT_MODEL_ID,
} from "@/shared/constants";
import type { HouseDto, HouseStatus } from "@/shared/types";

type HouseFormValues = z.infer<typeof houseCreateSchema>;

/** Model entry shape returned by GET /api/models (Job G). */
interface ModelOption {
  id: string;
  providerName: string | null;
  displayName: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided, edits this house; otherwise creates a new one. */
  existing?: HouseDto;
  onSaved: (house: HouseDto) => void;
}

const PERMISSION_KEYS = ["fileSystem", "shell", "network", "git"] as const;

export function HouseForm({ open, onOpenChange, existing, onSaved }: Props) {
  const isEdit = !!existing;
  const [saving, setSaving] = useState(false);

  // Local form state (using plain useState for simple array editing).
  const [workspaceAllowlist, setWorkspaceAllowlist] = useState<string[]>(
    existing?.configuration.workspaceAllowlist ?? [],
  );
  const [tools, setTools] = useState<string[]>(existing?.configuration.tools ?? []);
  const [allowlistInput, setAllowlistInput] = useState("");
  const [toolInput, setToolInput] = useState("");
  const [permissions, setPermissions] = useState<
    Record<(typeof PERMISSION_KEYS)[number], string>
  >(
    existing?.configuration.permissions ?? {
      fileSystem: "ask",
      shell: "ask",
      network: "deny",
      git: "allow",
    },
  );

  const form = useForm<HouseFormValues>({
    resolver: zodResolver(isEdit ? houseUpdateSchema : houseCreateSchema),
    defaultValues: existing
      ? {
          name: existing.name,
          description: existing.description ?? "",
          agent: existing.agent,
          configuration: {
            systemPrompt: existing.configuration.systemPrompt,
            executionProvider: existing.configuration.executionProvider,
            aiProvider: existing.configuration.aiProvider,
            modelId: existing.configuration.modelId,
            workspaceAllowlist: existing.configuration.workspaceAllowlist,
            tools: existing.configuration.tools,
            permissions: existing.configuration.permissions,
            approvalPolicy: existing.configuration.approvalPolicy,
            concurrency: existing.configuration.concurrency,
          },
        }
      : {
          name: "",
          description: "",
          agent: { name: "", role: "" },
          configuration: {
            systemPrompt: "",
            executionProvider: "opencode",
            aiProvider: "ollama-cloud",
            modelId: DEFAULT_MODEL_ID,
            workspaceAllowlist: [],
            tools: [],
            permissions: {
              fileSystem: "ask",
              shell: "ask",
              network: "deny",
              git: "allow",
            },
            approvalPolicy: "always",
            concurrency: 1,
          },
        },
  });

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = form;

  const execProvider = watch("configuration.executionProvider");

  // Job G + Phase 5 Q8 — model picker. Fetch GET /api/models against the SELECTED
  // execution provider (opencode → OpenCode models; ollama → Ollama /api/tags).
  // When the server is unreachable (or the list empty) we fall back to free-text
  // so house creation works with the engine off (E2E hits this fallback path).
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsAvailable, setModelsAvailable] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(true);
  const modelId = watch("configuration.modelId");

  useEffect(() => {
    let alive = true;
    setModelsLoading(true);
    setModels([]);
    const providerParam = execProvider;
    apiFetch<{ models: ModelOption[]; available: boolean }>(`/api/models?providerId=${encodeURIComponent(providerParam)}`)
      .then((res) => {
        if (!alive) return;
        setModels(res.models ?? []);
        setModelsAvailable(!!res.available && (res.models?.length ?? 0) > 0);
      })
      .catch(() => {
        if (alive) setModelsAvailable(false);
      })
      .finally(() => {
        if (alive) setModelsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [execProvider]);

  const groupedModels = useMemo(() => {
    const byProvider = new Map<string, ModelOption[]>();
    for (const m of models) {
      const key = m.providerName ?? "other";
      const list = byProvider.get(key) ?? [];
      list.push(m);
      byProvider.set(key, list);
    }
    return Array.from(byProvider.entries());
  }, [models]);

  // The current model value must remain selectable even when it's absent from
  // the live list (kept intact when editing an existing house).
  const modelIsInList = models.some((m) => m.id === modelId);
  const showPicker = modelsAvailable && !modelsLoading && (groupedModels.length > 0 || modelIsInList);

  function setModel(value: string) {
    form.setValue("configuration.modelId", value);
  }

  function addAllowlist() {
    const v = allowlistInput.trim();
    if (!v) return;
    if (!workspaceAllowlist.includes(v)) {
      setWorkspaceAllowlist((prev) => [...prev, v]);
    }
    setAllowlistInput("");
  }
  function removeAllowlist(idx: number) {
    setWorkspaceAllowlist((prev) => prev.filter((_, i) => i !== idx));
  }
  function addTool() {
    const v = toolInput.trim();
    if (!v) return;
    if (!tools.includes(v)) setTools((prev) => [...prev, v]);
    setToolInput("");
  }
  function removeTool(idx: number) {
    setTools((prev) => prev.filter((_, i) => i !== idx));
  }

  async function onSubmit(values: HouseFormValues) {
    setSaving(true);
    try {
      const payload = {
        ...values,
        configuration: {
          ...values.configuration,
          workspaceAllowlist,
          tools,
          permissions: {
            fileSystem: permissions.fileSystem,
            shell: permissions.shell,
            network: permissions.network,
            git: permissions.git,
          },
        },
      };

      if (isEdit && existing) {
        const res = await apiFetch<{ house: HouseDto }>(`/api/houses/${existing.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        toast.success(`House '${res.house.name}' updated`);
        onSaved(res.house);
      } else {
        const res = await apiFetch<{ house: HouseDto }>("/api/houses", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        toast.success(`House '${res.house.name}' established`);
        onSaved(res.house);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save house");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-serif-display text-2xl">
            {isEdit ? `Edit — ${existing?.name}` : "Found a new House"}
          </DialogTitle>
          <DialogDescription>
            Define the agent's identity, execution engine, workspace, and permissions.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Tabs defaultValue="identity">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="identity">Identity</TabsTrigger>
              <TabsTrigger value="agent">Agent</TabsTrigger>
              <TabsTrigger value="execution">Execution</TabsTrigger>
              <TabsTrigger value="workspace">Workspace</TabsTrigger>
            </TabsList>

            {/* Identity */}
            <TabsContent value="identity" className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" {...register("name")} placeholder="House of Shadows" />
                {errors.name && (
                  <p className="text-xs text-velaris-crimson">{errors.name.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  {...register("description")}
                  placeholder="Quiet, precise engineering work after dark"
                  rows={3}
                />
              </div>
            </TabsContent>

            {/* Agent */}
            <TabsContent value="agent" className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label htmlFor="agentName">Agent name</Label>
                <Input id="agentName" {...register("agent.name")} placeholder="Azriel" />
                {errors.agent?.name && (
                  <p className="text-xs text-velaris-crimson">{errors.agent.name.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="agentRole">Agent role</Label>
                <Input
                  id="agentRole"
                  {...register("agent.role")}
                  placeholder="Shadow-singer · senior engineer"
                />
                {errors.agent?.role && (
                  <p className="text-xs text-velaris-crimson">{errors.agent.role.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="systemPrompt">System prompt</Label>
                <Textarea
                  id="systemPrompt"
                  {...register("configuration.systemPrompt")}
                  placeholder="You are Azriel…"
                  rows={8}
                  className="min-h-[160px] font-mono text-xs"
                />
                {errors.configuration?.systemPrompt && (
                  <p className="text-xs text-velaris-crimson">
                    {errors.configuration.systemPrompt.message}
                  </p>
                )}
              </div>
            </TabsContent>

            {/* Execution */}
            <TabsContent value="execution" className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label>Execution provider</Label>
                <Select
                  value={execProvider}
                  onValueChange={(v) =>
                    form.setValue(
                      "configuration.executionProvider",
                      v as (typeof EXECUTION_PROVIDERS)[number],
                    )
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {EXECUTION_PROVIDERS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p === "opencode" ? "OpenCode" : "Ollama"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {execProvider === "ollama" ? (
                  <p className="text-xs text-velaris-teal">
                    Native runtime — supports in-place pause/resume. The model runs directly against
                    your Ollama server; costs are estimates priced from Settings.
                  </p>
                ) : null}
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="aiProvider">AI provider</Label>
                  <Input
                    id="aiProvider"
                    {...register("configuration.aiProvider")}
                    placeholder="ollama-cloud"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="modelId">Model</Label>
                  {showPicker ? (
                    <>
                      <Select value={modelId || undefined} onValueChange={setModel}>
                        <SelectTrigger id="modelId" className="w-full">
                          <SelectValue placeholder="Select a model" />
                        </SelectTrigger>
                        <SelectContent>
                          {groupedModels.map(([providerName, providerModels]) => (
                            <SelectGroup key={providerName}>
                              <SelectLabel>{providerName}</SelectLabel>
                              {providerModels.map((m) => (
                                <SelectItem key={m.id} value={m.id}>
                                  {m.id}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          ))}
                          {modelId && !modelIsInList ? (
                            <SelectItem key={modelId} value={modelId}>
                              {modelId} (custom)
                            </SelectItem>
                          ) : null}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Current value:{" "}
                        <span className="font-mono">{modelId || "none"}</span>
                      </p>
                    </>
                  ) : (
                    <>
                      <Input
                        id="modelId"
                        {...register("configuration.modelId")}
                        placeholder="e.g. deepseek-v4.1-flash"
                      />
                      {modelsLoading ? (
                        <p className="text-xs text-muted-foreground">Querying the engine…</p>
                      ) : (
                        <p className="text-xs text-velaris-gold">
                          OpenCode server offline — enter model id manually. It will be validated
                          when the engine starts.
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="concurrency">Concurrency</Label>
                  <Input
                    id="concurrency"
                    type="number"
                    min={1}
                    {...register("configuration.concurrency", {
                      valueAsNumber: true,
                    })}
                  />
                  {errors.configuration?.concurrency && (
                    <p className="text-xs text-velaris-crimson">
                      {errors.configuration.concurrency.message}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>Approval policy</Label>
                  <Select
                    value={watch("configuration.approvalPolicy")}
                    onValueChange={(v) =>
                      form.setValue(
                        "configuration.approvalPolicy",
                        v as (typeof APPROVAL_POLICIES)[number],
                      )
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {APPROVAL_POLICIES.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </TabsContent>

            {/* Workspace */}
            <TabsContent value="workspace" className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label>Workspace allowlist (absolute paths)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    value={allowlistInput}
                    onChange={(e) => setAllowlistInput(e.target.value)}
                    placeholder="/home/you/projects/repo"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addAllowlist();
                      }
                    }}
                  />
                  <Button type="button" variant="outline" onClick={addAllowlist}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                <TagList items={workspaceAllowlist} onRemove={removeAllowlist} variant="path" />
              </div>

              <div className="space-y-2">
                <Label>Tools</Label>
                <div className="flex items-center gap-2">
                  <Input
                    value={toolInput}
                    onChange={(e) => setToolInput(e.target.value)}
                    placeholder="fs, shell, git"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addTool();
                      }
                    }}
                  />
                  <Button type="button" variant="outline" onClick={addTool}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                <TagList items={tools} onRemove={removeTool} variant="tool" />
              </div>

              <div className="space-y-2 rounded-lg border border-border p-3">
                <Label>Permissions</Label>
                <div className="space-y-2">
                  {PERMISSION_KEYS.map((key) => (
                    <div
                      key={key}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="text-sm capitalize text-muted-foreground">{key}</span>
                      <Select
                        value={permissions[key]}
                        onValueChange={(v) =>
                          setPermissions((prev) => ({ ...prev, [key]: v }))
                        }
                      >
                        <SelectTrigger className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PERMISSION_MODES.map((m) => (
                            <SelectItem key={m} value={m}>
                              {m}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
                {permissions.network === "deny" ? (
                  <p className="text-xs text-muted-foreground">
                    Network is denied — the web-fetch tool stays out of the runtime&apos;s registry
                    unless Network is allowed (per-house opt-in).
                  </p>
                ) : null}
              </div>
            </TabsContent>
          </Tabs>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : isEdit ? "Save changes" : "Create house"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TagList({
  items,
  onRemove,
  variant,
}: {
  items: string[];
  onRemove: (idx: number) => void;
  variant: "path" | "tool";
}) {
  if (items.length === 0) return <p className="text-xs text-muted-foreground">None yet.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item, idx) => (
        <span
          key={`${item}-${idx}`}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-xs text-foreground"
        >
          <span className={variant === "path" ? "font-mono" : ""}>{item}</span>
          <button
            type="button"
            onClick={() => onRemove(idx)}
            className="text-muted-foreground hover:text-velaris-crimson"
            aria-label={`Remove ${item}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

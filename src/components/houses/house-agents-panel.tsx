"use client";

/**
 * House agents panel (Phase 6 Stage B) — manage the extra agents under a house.
 *
 * The house form's existing "Agent" tab edits the house DEFAULT agent (the
 * oldest, PATCH /api/houses/{id}). This panel manages the additional agents via
 * the dedicated CRUD routes, each with its own configuration. The default agent
 * cannot be deleted here (the house must always keep one agent — the API also
 * enforces this with 409).
 */

import { useEffect, useState } from "react";
import { Plus, Trash2, UserPlus } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { apiFetch } from "@/lib/api-client";
import { EXECUTION_PROVIDERS, APPROVAL_POLICIES } from "@/shared/constants";
import type { HouseAgentDto, HouseConfiguration } from "@/shared/types";

type AgentConfiguration = HouseConfiguration;

interface Props {
  houseId: string;
  /** All agents, oldest-first; index 0 is the house default. */
  agents: HouseAgentDto[];
  /** Called after a successful create/update/delete so the parent can refetch. */
  onChanged: () => void;
}

interface AgentDraft {
  name: string;
  role: string;
  systemPrompt: string;
  executionProvider: AgentConfiguration["executionProvider"];
  aiProvider: string;
  modelId: string;
  approvalPolicy: AgentConfiguration["approvalPolicy"];
  concurrency: number;
}

function draftFrom(agent: HouseAgentDto): AgentDraft {
  return {
    name: agent.name,
    role: agent.role,
    systemPrompt: agent.configuration.systemPrompt,
    executionProvider: agent.configuration.executionProvider,
    aiProvider: agent.configuration.aiProvider,
    modelId: agent.configuration.modelId,
    approvalPolicy: agent.configuration.approvalPolicy,
    concurrency: agent.configuration.concurrency,
  };
}

/** Apply a draft onto a full config, inheriting list/permission fields. */
function configFrom(draft: AgentDraft, base: AgentConfiguration): AgentConfiguration {
  return {
    ...base,
    systemPrompt: draft.systemPrompt,
    executionProvider: draft.executionProvider,
    aiProvider: draft.aiProvider,
    modelId: draft.modelId,
    approvalPolicy: draft.approvalPolicy,
    concurrency: draft.concurrency,
  };
}

export function HouseAgentsPanel({ houseId, agents, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<HouseAgentDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // A stable base config to inherit workspace/tools/permissions from.
  const defaultAgent = agents[0];
  const baseConfig: AgentConfiguration = defaultAgent?.configuration ?? {
    systemPrompt: "",
    executionProvider: "opencode",
    aiProvider: "ollama-cloud",
    modelId: "",
    workspaceAllowlist: [],
    tools: [],
    permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
    approvalPolicy: "always",
    concurrency: 1,
  };

  const [draft, setDraft] = useState<AgentDraft>(() => draftFrom(defaultAgent ?? emptyAgent()));

  useEffect(() => {
    if (!open) return;
    setDraft(editing ? draftFrom(editing) : draftFrom(defaultAgent ?? emptyAgent()));
  }, [open, editing, defaultAgent]);

  function set<K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function openCreate() {
    setEditing(null);
    setOpen(true);
  }

  function openEdit(agent: HouseAgentDto) {
    setEditing(agent);
    setOpen(true);
  }

  async function submit() {
    if (!draft.name.trim()) {
      toast.error("Agent name is required");
      return;
    }
    if (!draft.role.trim()) {
      toast.error("Agent role is required");
      return;
    }
    if (!draft.systemPrompt.trim()) {
      toast.error("System prompt is required");
      return;
    }
    setSaving(true);
    try {
      const configuration = configFrom(draft, editing?.configuration ?? baseConfig);
      if (editing) {
        await apiFetch<{ agent: HouseAgentDto }>(
          `/api/houses/${houseId}/agents/${editing.id}`,
          { method: "PATCH", body: JSON.stringify({ name: draft.name, role: draft.role, configuration }) },
        );
        toast.success(`Agent '${draft.name}' updated`);
      } else {
        await apiFetch<{ agent: HouseAgentDto }>(`/api/houses/${houseId}/agents`, {
          method: "POST",
          body: JSON.stringify({ name: draft.name, role: draft.role, configuration }),
        });
        toast.success(`Agent '${draft.name}' sworn to the house`);
      }
      setOpen(false);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save agent");
    } finally {
      setSaving(false);
    }
  }

  async function remove(agent: HouseAgentDto, isDefault: boolean) {
    if (isDefault) {
      toast.error("The house default agent cannot be removed");
      return;
    }
    setBusyId(agent.id);
    try {
      await apiFetch(`/api/houses/${houseId}/agents/${agent.id}`, { method: "DELETE" });
      toast.success(`Agent '${agent.name}' dismissed`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove agent");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4" data-testid="house-agents-panel">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">House agents</p>
          <p className="text-xs text-muted-foreground">
            Each agent has its own configuration. The oldest agent is the house default, used when a
            quest does not target a specific agent.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={openCreate}>
          <UserPlus className="mr-1 h-3.5 w-3.5" /> Add agent
        </Button>
      </div>

      <ul className="space-y-2">
        {agents.map((agent, idx) => {
          const isDefault = idx === 0;
          return (
            <li
              key={agent.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card/40 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-foreground">{agent.name}</span>
                  {isDefault ? (
                    <Badge variant="outline" className="text-velaris-gold">
                      default
                    </Badge>
                  ) : null}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {agent.role}
                  {agent.configuration.modelId
                    ? ` · ${agent.configuration.aiProvider || "?"}/${agent.configuration.modelId}`
                    : ""}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button type="button" variant="ghost" size="sm" onClick={() => openEdit(agent)}>
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isDefault || busyId === agent.id}
                  onClick={() => remove(agent, isDefault)}
                  aria-label={`Remove ${agent.name}`}
                  className="text-velaris-crimson hover:bg-velaris-crimson/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="font-serif-display text-2xl">
              {editing ? `Edit — ${editing.name}` : "Swear a new agent"}
            </DialogTitle>
            <DialogDescription>
              Give the agent an identity, execution engine, model and system prompt.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="agentName">Name</Label>
                <Input
                  id="agentName"
                  value={draft.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="Azriel"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="agentRole">Role</Label>
                <Input
                  id="agentRole"
                  value={draft.role}
                  onChange={(e) => set("role", e.target.value)}
                  placeholder="Shadow-singer · senior engineer"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Execution provider</Label>
                <Select
                  value={draft.executionProvider}
                  onValueChange={(v) =>
                    set("executionProvider", v as AgentConfiguration["executionProvider"])
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXECUTION_PROVIDERS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p === "opencode" ? "OpenCode" : "Ollama"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Approval policy</Label>
                <Select
                  value={draft.approvalPolicy}
                  onValueChange={(v) =>
                    set("approvalPolicy", v as AgentConfiguration["approvalPolicy"])
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

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="agentAiProvider">AI provider</Label>
                <Input
                  id="agentAiProvider"
                  value={draft.aiProvider}
                  onChange={(e) => set("aiProvider", e.target.value)}
                  placeholder="ollama-cloud"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="agentModelId">Model</Label>
                <Input
                  id="agentModelId"
                  value={draft.modelId}
                  onChange={(e) => set("modelId", e.target.value)}
                  placeholder="glm-5.3"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="agentSystemPrompt">System prompt</Label>
              <Textarea
                id="agentSystemPrompt"
                value={draft.systemPrompt}
                onChange={(e) => set("systemPrompt", e.target.value)}
                rows={6}
                className="font-mono text-xs"
                placeholder="You are Azriel…"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="agentConcurrency">Concurrency</Label>
              <Input
                id="agentConcurrency"
                type="number"
                min={1}
                value={draft.concurrency}
                onChange={(e) => set("concurrency", Math.max(1, Number(e.target.value) || 1))}
              />
            </div>

            <p className="text-xs text-muted-foreground">
              Workspace allowlist, tools and permissions are inherited from the house default agent.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" onClick={submit} disabled={saving}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {saving ? "Saving…" : editing ? "Save agent" : "Add agent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function emptyAgent(): HouseAgentDto {
  return {
    id: "",
    name: "",
    role: "",
    configuration: {
      systemPrompt: "",
      executionProvider: "opencode",
      aiProvider: "ollama-cloud",
      modelId: "",
      workspaceAllowlist: [],
      tools: [],
      permissions: { fileSystem: "ask", shell: "ask", network: "deny", git: "allow" },
      approvalPolicy: "always",
      concurrency: 1,
    },
  };
}

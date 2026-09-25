"use client";

/**
 * Settings template manager card (Phase 6 Stage C).
 *
 * Lists seeded + user-created house/project templates and lets the user delete
 * user-created ones. Seeded defaults are immutable (the delete button is hidden
 * and the API returns 409 if attempted). Instantiation lives on the Houses /
 * Projects pages.
 *
 * Motion: only opacity/hover transitions (reduced-motion safe).
 */

import { useCallback, useEffect, useState } from "react";
import { Trash2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { apiFetch } from "@/lib/api-client";
import type { TemplateDto } from "@/shared/types";

export function TemplateManagerCard() {
  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ templates: TemplateDto[] }>("/api/templates");
      setTemplates(res.templates);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(template: TemplateDto) {
    try {
      await apiFetch(`/api/templates/${template.id}`, { method: "DELETE" });
      setTemplates((prev) => prev.filter((t) => t.id !== template.id));
      toast.success(`Template '${template.name}' deleted`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete template");
    }
  }

  return (
    <Card data-testid="template-manager-card">
      <CardHeader>
        <CardTitle className="font-serif-display text-xl">Templates</CardTitle>
        <CardDescription>
          Reusable house and project blueprints. Seeded defaults are immutable; instantiate them
          from the Houses or Projects pages.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            data-testid="template-manager-refresh"
          >
            <RefreshCw className="mr-1 h-4 w-4" /> Refresh
          </Button>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading templates…</p>
        ) : templates.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="template-manager-empty">
            No templates yet.
          </p>
        ) : (
          <div className="space-y-2" data-testid="template-manager-list">
            {templates.map((t) => (
              <div
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card/40 p-3"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant="outline">{t.kind}</Badge>
                  <span className="font-medium text-foreground">{t.name}</span>
                  {t.isSeeded ? <Badge variant="secondary">seeded</Badge> : null}
                  {t.description ? (
                    <span className="truncate text-xs text-muted-foreground">{t.description}</span>
                  ) : null}
                </div>
                {!t.isSeeded ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete template ${t.name}`}
                    onClick={() => void remove(t)}
                  >
                    <Trash2 className="h-4 w-4 text-velaris-crimson" />
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

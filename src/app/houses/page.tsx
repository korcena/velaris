"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { HouseCard, type HouseCardData } from "@/components/houses/house-card";
import { HouseForm } from "@/components/houses/house-form";
import { useVelarisStream } from "@/components/realtime/velaris-stream";
import { apiFetch } from "@/lib/api-client";
import type { HouseDto } from "@/shared/types";

export default function HousesPage() {
  const [houses, setHouses] = useState<HouseCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<HouseDto | undefined>(undefined);
  // Bumped on every dialog open so <HouseForm key={...}> remounts with fresh
  // initial values. HouseForm reads `existing` only in useState/useForm
  // initializers, so without a remount a previously-opened house's values
  // would linger and silently overwrite the next target on save.
  const [formSession, setFormSession] = useState(0);
  const [confirmTarget, setConfirmTarget] = useState<
    { house: HouseDto; action: "archive" | "delete" | "disable" | "enable" } | undefined
  >(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ houses: HouseCardData[] }>(
        `/api/houses?includeArchived=${includeArchived}`,
      );
      setHouses(res.houses);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load houses");
    } finally {
      setLoading(false);
    }
  }, [includeArchived]);

  const { sequence } = useVelarisStream();

  useEffect(() => {
    void load();
  }, [load, sequence]);

  function openCreate() {
    setEditing(undefined);
    setFormSession((n) => n + 1);
    setFormOpen(true);
  }
  function openEdit(house: HouseDto) {
    setEditing(house);
    setFormSession((n) => n + 1);
    setFormOpen(true);
  }

  async function handleSaved(house: HouseDto) {
    // The form returns a plain HouseDto; enrich with default runtime fields
    // (the next list refetch will provide accurate values).
    const enriched: HouseCardData = {
      ...house,
      runtimeStatus: "idle",
      pendingApprovals: 0,
    };
    setHouses((prev) => {
      const idx = prev.findIndex((h) => h.id === enriched.id);
      if (idx === -1) return [enriched, ...prev];
      const next = [...prev];
      next[idx] = enriched;
      return next;
    });
  }

  async function runConfirmAction() {
    if (!confirmTarget) return;
    const { house, action } = confirmTarget;
    try {
      if (action === "archive") {
        const res = await apiFetch<{ house: HouseDto }>(`/api/houses/${house.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "archived" }),
        });
        // Re-load so the archived house leaves the default list (or stays
        // visible when the archived filter is active) — §5.5.
        await handleSaved(res.house);
        await load();
        toast.success(`'${house.name}' archived`);
      } else if (action === "disable" || action === "enable") {
        const res = await apiFetch<{ house: HouseDto }>(`/api/houses/${house.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: action === "disable" ? "disabled" : "active" }),
        });
        await handleSaved(res.house);
        toast.success(`'${house.name}' ${action === "disable" ? "disabled" : "enabled"}`);
      } else if (action === "delete") {
        await apiFetch(`/api/houses/${house.id}`, { method: "DELETE" });
        setHouses((prev) => prev.filter((h) => h.id !== house.id));
        toast.success(`'${house.name}' deleted`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setConfirmTarget(undefined);
    }
  }

  const confirmTitle = confirmTarget
    ? {
        archive: `Archive ${confirmTarget.house.name}?`,
        delete: `Delete ${confirmTarget.house.name}?`,
        disable: `Disable ${confirmTarget.house.name}?`,
        enable: `Enable ${confirmTarget.house.name}?`,
      }[confirmTarget.action]
    : "";

  const confirmDesc = confirmTarget
    ? {
        archive: "The house will be hidden from the default list. This can be reversed.",
        delete: "This permanently deletes the house, its agent, and its configuration.",
        disable: "The house will be inactive and will not accept new quests.",
        enable: "The house will become active again.",
      }[confirmTarget.action]
    : "";

  return (
    <div>
      <PageHeader
        title="The Houses"
        subtitle="Your agents — each with an identity, an execution engine, and its own workspace permissions."
        actions={
          <>
            <Button
              variant={includeArchived ? "secondary" : "ghost"}
              onClick={() => setIncludeArchived((v) => !v)}
              disabled={loading}
            >
              {includeArchived ? "Showing archived" : "Show archived"}
            </Button>
            <Button onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" /> New house
            </Button>
          </>
        }
      />

      {loading ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Summoning the houses…
          </CardContent>
        </Card>
      ) : houses.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <p className="font-serif-display text-xl text-foreground">
              The city's great houses lie empty.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Found your first house to begin assigning quests.
            </p>
            <Button className="mt-6" onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" /> Found a house
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {houses.map((house) => (
            <HouseCard
              key={house.id}
              house={house}
              onEdit={() => openEdit(house)}
              onToggle={() =>
                setConfirmTarget({
                  house,
                  action: house.status === "active" ? "disable" : "enable",
                })
              }
              onArchive={() => setConfirmTarget({ house, action: "archive" })}
              onDelete={() => setConfirmTarget({ house, action: "delete" })}
            />
          ))}
        </div>
      )}

      {/* Remount on every open (formSession) so the form initializes from
          the CURRENT target's data. */}
      <HouseForm
        key={`house-form-${formSession}`}
        open={formOpen}
        onOpenChange={setFormOpen}
        existing={editing}
        onSaved={handleSaved}
      />

      <AlertDialog
        open={!!confirmTarget}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{confirmDesc}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runConfirmAction}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

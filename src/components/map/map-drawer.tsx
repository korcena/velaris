"use client";

/**
 * MapDrawer — the lightweight house detail drawer (spec §6). It shows the house
 * name, agent role, a status pill, the current task title/status (fetched from
 * `/api/houses/{id}` on open — the list endpoint omits `activeTask`, plan Q7),
 * and a pending-approval callout. Its actions are DEEP LINKS only: "Open house →"
 * to `/houses/<id>` and "Messenger Roost →" to `/roost` (plan Q8). Approvals,
 * steering and cancel stay on those surfaces (spec §6 — no inline actions).
 */

import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api-client";
import { EFFECT_COLORS } from "./palette";
import { EFFECT_LABELS, type MapEffect } from "./status-effects";
import type { HouseCardData } from "@/components/houses/house-card";
import type { HouseDetailDto } from "@/shared/types";

export function MapDrawer({
  house,
  effect,
  open,
  onClose,
}: {
  house: HouseCardData | null;
  effect: MapEffect;
  open: boolean;
  onClose: () => void;
}) {
  // Active task is only present on the detail endpoint — fetch on open.
  const [activeTask, setActiveTask] = useState<HouseDetailDto["activeTask"] | null>(null);
  const houseId = house?.id ?? null;

  useEffect(() => {
    if (!open || !houseId) {
      setActiveTask(null);
      return;
    }
    let alive = true;
    setActiveTask(null);
    apiFetch<{ house: HouseDetailDto }>(`/api/houses/${houseId}`)
      .then((res) => {
        if (alive) setActiveTask(res.house.activeTask);
      })
      .catch(() => {
        /* ignore — drawer still renders list-level data */
      });
    return () => {
      alive = false;
    };
  }, [open, houseId]);

  if (!open || !house) return null;

  const hasActiveTask = !!activeTask?.id;
  const pending = house.pendingApprovals ?? 0;

  return (
    <aside
      className="map-drawer open"
      data-testid="map-drawer"
      aria-live="polite"
      aria-label="House details"
    >
      <button type="button" className="map-drawer-close" aria-label="Close details" onClick={onClose}>
        ×
      </button>

      <h2 className="map-drawer-title">{house.name}</h2>
      <p className="map-drawer-role">{house.agent.role || "Agent"}</p>
      <span
        className="map-status-pill"
        style={{ "--c": EFFECT_COLORS[effect] } as CSSProperties}
        data-testid="map-drawer-status"
      >
        {EFFECT_LABELS[effect]}
      </span>

      <h3>Current quest</h3>
      <p className="map-drawer-task">
        {hasActiveTask ? (
          <>
            <span>{activeTask?.title ?? "Untitled quest"}</span>
            <span className="map-drawer-task-status">{activeTask?.status ?? ""}</span>
          </>
        ) : (
          <span className="italic opacity-70">No active quest</span>
        )}
      </p>

      {pending > 0 ? (
        <div className="map-drawer-ask" data-testid="map-drawer-approval">
          <strong>
            Messenger bird{pending === 1 ? "" : "s"} awaiting
          </strong>
          <p>
            {pending} approval{pending === 1 ? "" : "s"} need{pending === 1 ? "s" : ""} your answer.
          </p>
        </div>
      ) : null}

      <div className="map-drawer-actions">
        <Link href={`/houses/${house.id}`} className="map-drawer-link">
          Open house →
        </Link>
        {pending > 0 ? (
          <Link href="/roost" className="map-drawer-link">
            Messenger Roost →
          </Link>
        ) : null}
      </div>
    </aside>
  );
}

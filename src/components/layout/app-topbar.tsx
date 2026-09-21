"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Loader2 } from "lucide-react";
import { NAV_SECTIONS } from "@/shared/constants";
import { cn } from "@/lib/utils";
import type { HealthDto } from "@/shared/types";

type EngineState =
  | { kind: "checking" }
  | { kind: "online"; heartbeatAt: string | null }
  | { kind: "offline" };

export function AppTopbar() {
  const pathname = usePathname();
  const [engine, setEngine] = useState<EngineState>({ kind: "checking" });

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = (await res.json()) as HealthDto;
        if (data.status === "ok") {
          if (alive) setEngine({ kind: "online", heartbeatAt: data.engineHeartbeatAt });
        } else {
          if (alive) setEngine({ kind: "offline" });
        }
      } catch {
        if (alive) setEngine({ kind: "offline" });
      }
      // Re-poll periodically for liveness.
      setTimeout(poll, 8000);
    }
    poll();
    return () => {
      alive = false;
    };
  }, []);

  // Derive the current section title from the pathname.
  const section = NAV_SECTIONS.find((s) => {
    const href = s.path === "" ? "/" : s.path;
    return pathname === href || pathname.startsWith(href + "/");
  });

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border/60 bg-background/70 px-6 backdrop-blur-sm">
      {/* Breadcrumb-style title */}
      <div className="flex items-center gap-2 text-sm">
        <span className="font-serif-display text-lg text-primary">Velaris</span>
        {section && section.path !== "" && (
          <>
            <span className="text-muted-foreground">/</span>
            <span className="text-muted-foreground">{section.name}</span>
          </>
        )}
      </div>

      {/* Engine status pill */}
      <div className="flex items-center gap-2">
        <EnginePill state={engine} />
      </div>
    </header>
  );
}

function EnginePill({ state }: { state: EngineState }) {
  if (state.kind === "checking") {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Engine…
      </span>
    );
  }
  if (state.kind === "online") {
    const stale = state.heartbeatAt
      ? Date.now() - new Date(state.heartbeatAt).getTime() > 15_000
      : true;
    const online = !stale;
    return (
      <span
        className={cn(
          "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs",
          online
            ? "border-velaris-teal/40 bg-velaris-teal/10 text-velaris-teal"
            : "border-velaris-crimson/40 bg-velaris-crimson/10 text-velaris-crimson",
        )}
      >
        <span className={cn("h-2 w-2 rounded-full", online ? "bg-velaris-teal" : "bg-velaris-crimson")} />
        {online ? "Engine connected" : "Engine stale"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-velaris-crimson/40 bg-velaris-crimson/10 px-3 py-1 text-xs text-velaris-crimson">
      <span className="h-2 w-2 rounded-full bg-velaris-crimson" />
      Engine offline
    </span>
  );
}

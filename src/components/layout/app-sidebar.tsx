"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Sparkles,
  Crown,
  Castle,
  ScrollText,
  Bird,
  Library,
  FolderKanban,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { NAV_SECTIONS } from "@/shared/constants";
import { cn } from "@/lib/utils";
import { useVelarisStream } from "@/components/realtime/velaris-stream";

const ICONS: Record<string, LucideIcon> = {
  Sparkles,
  Crown,
  Castle,
  ScrollText,
  Bird,
  Library,
  FolderKanban,
  Settings,
};

/** Paths that never carry the roost unread badge. */
const ROOST_PATH = "/roost";
const POLL_MS = 30_000;

export function AppSidebar() {
  const pathname = usePathname();
  const { sequence } = useVelarisStream();

  // Unread count for the Messenger Roost nav item. Refreshes on realtime ticks
  // AND via a 30s polling fallback so it stays correct when the engine is off
  // (no SSE frames, but the count can still change from REST writes).
  const [unread, setUnread] = useState(0);
  const [unreadErr, setUnreadErr] = useState(false);
  const seqRef = useRef(sequence);
  seqRef.current = sequence;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function fetchUnread() {
      try {
        const res = await fetch("/api/notifications?unreadOnly=1", { cache: "no-store" });
        if (!res.ok) {
          if (alive) setUnreadErr(true);
          return;
        }
        const data = (await res.json()) as { unread: number };
        if (alive) {
          setUnread(data.unread ?? 0);
          setUnreadErr(false);
        }
      } catch {
        if (alive) setUnreadErr(true);
      }
      timer = setTimeout(fetchUnread, POLL_MS);
    }

    void fetchUnread();

    // Also refetch quickly whenever a realtime tick bumps the sequence.
    if (seqRef.current) {
      void fetchUnread();
    }

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [sequence]);

  return (
    <aside className="sticky top-0 hidden h-screen w-72 shrink-0 flex-col overflow-y-auto border-r border-border/60 bg-card/40 backdrop-blur-sm md:flex lg:w-80">
      {/* Brand mark */}
      <div className="flex items-center gap-3 px-6 pt-7 pb-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary velaris-card-shadow">
          <Sparkles className="h-5 w-5" />
        </div>
        <div className="font-serif-display text-2xl tracking-wide text-foreground">
          Velaris
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {NAV_SECTIONS.map((section) => {
          const href = section.path === "" ? "/" : section.path;
          const active = pathname === href;
          const Icon = ICONS[section.icon] ?? Sparkles;
          const isRoost = section.path === ROOST_PATH;
          return (
            <Link
              key={section.path || "velaris"}
              href={href}
              aria-label={isRoost && unread > 0 ? `${section.name} (${unread} unread)` : section.name}
              className={cn(
                "group flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors",
                active
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", active ? "text-primary" : "text-velaris-silver-muted")} />
              <span className="flex min-w-0 flex-col">
                <span className={cn("flex items-center gap-2 text-sm font-medium", active ? "text-foreground" : "")}>
                  {section.name}
                  {isRoost && unread > 0 && (
                    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-velaris-gold/50 bg-velaris-gold/15 px-1.5 text-[10px] font-semibold text-velaris-gold status-glow-active">
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </span>
                <span className="text-xs leading-tight text-muted-foreground">
                  {section.subtitle}
                </span>
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border/60 px-6 py-4 text-xs text-muted-foreground">
        <p>Phase 3 · The City Illuminated</p>
        <p className="mt-1">Beneath the stars, the city waits.</p>
      </div>
    </aside>
  );
}

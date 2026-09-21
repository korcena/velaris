"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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

export function AppSidebar() {
  const pathname = usePathname();

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
          return (
            <Link
              key={section.path || "velaris"}
              href={href}
              className={cn(
                "group flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors",
                active
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", active ? "text-primary" : "text-velaris-silver-muted")} />
              <span className="flex min-w-0 flex-col">
                <span className={cn("text-sm font-medium", active ? "text-foreground" : "")}>
                  {section.name}
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
        <p>Phase 1 · Foundation</p>
        <p className="mt-1">Beneath the stars, the city waits.</p>
      </div>
    </aside>
  );
}

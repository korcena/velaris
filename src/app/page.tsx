import Link from "next/link";
import { Sparkles, Castle, Map as MapIcon, ScrollText, Bird, Crown } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { UsagePanel } from "@/components/dashboard/usage-panel";
import { MonitoringPanel } from "@/components/dashboard/monitoring-panel";

export default function HomePage() {
  return (
    <div className="space-y-12">
      <section className="relative flex min-h-[38vh] flex-col items-start justify-center">
        {/* Atlas hero — CSS starfield is in globals.css */}
        <h1 className="font-serif-display text-6xl leading-tight text-foreground md:text-7xl">
          Velaris
        </h1>
        <p className="mt-4 max-w-2xl text-xl text-muted-foreground">
          Where AI agents become <span className="text-velaris-gold">houses</span> in a night-lit
          city. Send them <span className="text-velaris-purple">quests</span>, watch them work, and
          answer their <span className="text-velaris-teal">messenger birds</span>.
        </p>
        <p className="mt-6 text-sm text-muted-foreground">
          Phase 3 · The City Illuminated — your houses live and work beneath the stars.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/houses"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Castle className="h-4 w-4" /> Visit the Houses
          </Link>
          <Link
            href="/quests"
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card/40 px-5 py-2.5 text-sm text-foreground hover:bg-accent"
          >
            <ScrollText className="h-4 w-4" /> Quest Board
          </Link>
        </div>
      </section>

      <section>
        <PageHeader title="The City at a Glance" subtitle="What awaits beneath the stars." />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <QuickLink href="/map" icon={MapIcon} title="City Map" subtitle="Pan and zoom the city at night." />
          <QuickLink href="/houses" icon={Castle} title="The Houses" subtitle="Create and configure your agents." />
          <QuickLink href="/quests" icon={ScrollText} title="Quest Board" subtitle="Log tasks for your houses." />
          <QuickLink href="/high-lord" icon={Crown} title="High Lord's Court" subtitle="Orchestration — arriving in Phase 4." />
          <QuickLink href="/roost" icon={Bird} title="Messenger Roost" subtitle="Answer your houses' messenger birds." />
        </div>
      </section>

      {/* Phase 6 E/F — monitoring + usage live on the root dashboard (Q7),
          avoiding a 10th NAV_SECTIONS entry. */}
      <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <MonitoringPanel />
        <UsagePanel />
      </section>

      <section className="rounded-2xl border border-border bg-card/30 p-6">
        <div className="flex items-center gap-3 text-velaris-purple">
          <Sparkles className="h-5 w-5" />
          <h2 className="font-serif-display text-xl text-foreground">A note from the Loremaster</h2>
        </div>
        <p className="mt-3 max-w-3xl text-sm text-muted-foreground">
          The city of Velaris stands at the edge of the known map. Within its walls your houses
          work through the night — running quests, asking for guidance, and leaving finished
          work in the Archives. The machinery beneath them — databases, migration runners, and a
          watchful engine — keeps the heartbeat of the city alive.
        </p>
      </section>
    </div>
  );
}

function QuickLink({
  href,
  icon: Icon,
  title,
  subtitle,
}: {
  href: string;
  icon: typeof Castle;
  title: string;
  subtitle: string;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-2 rounded-xl border border-border bg-card/40 p-4 transition-colors hover:border-primary/40 hover:bg-accent"
    >
      <Icon className="h-5 w-5 text-primary" />
      <span className="font-serif-display text-lg text-foreground">{title}</span>
      <span className="text-sm text-muted-foreground">{subtitle}</span>
    </Link>
  );
}

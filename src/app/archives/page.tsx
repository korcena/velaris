import { Library } from "lucide-react";
import { PlaceholderPage } from "@/components/layout/placeholder-page";

export default function ArchivesPage() {
  return (
    <PlaceholderPage
      title="Archives"
      subtitle="Completed work, sessions, and history."
      icon={<Library className="h-12 w-12" />}
    >
      <p className="font-serif-display text-2xl text-foreground">The archives are still being catalogued.</p>
      <p>
        Completed tasks, session histories, diffs, and results will be stored here — a searchable
        record of everything the city's houses have achieved. This arrives in a later phase.
      </p>
    </PlaceholderPage>
  );
}

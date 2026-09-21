import { Crown } from "lucide-react";
import { PlaceholderPage } from "@/components/layout/placeholder-page";

export default function HighLordsCourtPage() {
  return (
    <PlaceholderPage
      title="High Lord's Court"
      subtitle="The orchestrator house that plans, delegates, and consolidates."
      icon={<Crown className="h-12 w-12" />}
    >
      <p className="font-serif-display text-2xl text-foreground">This throne sits empty.</p>
      <p>
        The High Lord — Velaris' orchestrator house — arrives in Phase 4, where it will plan work,
        delegate quests to the houses, and consolidate results. Until then, assign quests directly
        to your houses from the Quest Board.
      </p>
    </PlaceholderPage>
  );
}

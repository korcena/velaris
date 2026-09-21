import { Bird } from "lucide-react";
import { PlaceholderPage } from "@/components/layout/placeholder-page";

export default function MessengerRoostPage() {
  return (
    <PlaceholderPage
      title="Messenger Roost"
      subtitle="Approvals and clarifications, delivered by bird."
      icon={<Bird className="h-12 w-12" />}
    >
      <p className="font-serif-display text-2xl text-foreground">The roost is quiet.</p>
      <p>
        No birds have been sent. When your houses need an approval — a permission, a command, or a
        clarification — a messenger bird will land here. That arrives with real execution in Phase 2.
      </p>
    </PlaceholderPage>
  );
}

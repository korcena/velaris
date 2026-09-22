"use client";

/**
 * Shared approval card (Job B/C/E) — renders a single approval request with the
 * response controls wired to POST /api/approvals/{id}/respond:
 *   - permission requests → Approve / Reject buttons (plus an optional reply
 *     textarea for "deny-with-guidance").
 *   - question requests → its options as buttons (action=select) plus a free
 *     text reply (action=reply).
 *
 * On a successful action the parent is told via `onResponded` (usually a
 * refetch of the pending list) and a sonner toast confirms; failures surface
 * as error toasts. Used by the house-card bird dialog, the Roost hub, and the
 * house detail page.
 */

import { useRef, useState } from "react";
import { Check, X, Send, Bird } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { apiFetch } from "@/lib/api-client";
import type { ApprovalRequestDto } from "@/shared/types";

interface Props {
  approval: ApprovalRequestDto;
  /** Invoked after a successful response so the caller can refetch. */
  onResponded?: () => void | Promise<void>;
  /** Renders a compact variant suitable for inline lists. */
  compact?: boolean;
}

export function ApprovalCard({ approval, onResponded, compact }: Props) {
  const [busy, setBusy] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [showReply, setShowReply] = useState(false);
  const replyRef = useRef(replyText);
  replyRef.current = replyText;

  async function respond(action: "approve" | "reject" | "select" | "reply", optionId?: string) {
    if (action === "reply" && !replyRef.current.trim()) {
      toast.error("Write a reply before sending it");
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/api/approvals/${approval.id}/respond`, {
        method: "POST",
        body: JSON.stringify({
          action,
          response: action === "reply" ? replyRef.current.trim() : null,
          optionId: action === "select" ? optionId : null,
        }),
      });
      toast.success(verbFor(action));
      setReplyText("");
      setShowReply(false);
      await onResponded?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to respond");
    } finally {
      setBusy(false);
    }
  }

  const isQuestion = approval.kind === "question";

  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Bird className="h-3.5 w-3.5 shrink-0 text-velaris-teal" />
            <span className="truncate text-sm font-medium text-foreground">{approval.title}</span>
          </div>
          <Badge variant="outline" className="mt-1">
            {isQuestion ? "question" : "permission"}
          </Badge>
        </div>
      </div>

      {approval.message ? (
        <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{approval.message}</p>
      ) : null}

      {isQuestion && approval.options.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {approval.options.map((opt) => (
            <Button
              key={opt.id}
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => respond("select", opt.id)}
            >
              <Send className="h-3.5 w-3.5" /> {opt.label}
            </Button>
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!isQuestion && (
          <>
            <Button size="sm" disabled={busy} onClick={() => respond("approve")}>
              <Check className="h-3.5 w-3.5" /> Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => respond("reject")}
            >
              <X className="h-3.5 w-3.5" /> Reject
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => setShowReply((s) => !s)}
          aria-expanded={showReply}
        >
          {isQuestion ? "Reply with text" : "Reply"}
        </Button>
      </div>

      {showReply ? (
        <div className="mt-2 space-y-2">
          <Textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder={isQuestion ? "Type a free-text answer…" : "Reason / guidance (deny-with-guidance)…"}
            rows={compact ? 2 : 3}
            className="text-sm"
          />
          <Button
            size="sm"
            disabled={busy || !replyText.trim()}
            onClick={() => respond("reply")}
          >
            <Send className="h-3.5 w-3.5" /> Send reply
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function verbFor(action: string): string {
  switch (action) {
    case "approve":
      return "Approval granted";
    case "reject":
      return "Approval rejected";
    case "select":
      return "Option selected — reply sent";
    case "reply":
      return "Reply sent";
    default:
      return "Response sent";
  }
}

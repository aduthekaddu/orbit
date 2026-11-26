"use client";

import { useAuiState } from "@assistant-ui/react";
import { replyLabel } from "@/lib/model-picker";

// The record arrives on the stream's metadata and on the saved message; assistant-ui keeps both under `custom`.
export function ReplyLabel() {
  const label = useAuiState((s) => replyLabel(s.message.metadata.custom?.reply));
  if (!label) return null;
  return (
    <p data-reply-label className="ml-auto min-w-0 truncate pl-3 font-mono text-meta text-muted-foreground">
      {label}
    </p>
  );
}

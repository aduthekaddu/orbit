import type { DataMessagePartComponent } from "@assistant-ui/react";

export const ReplyEnd: DataMessagePartComponent<unknown> = ({ data }) => {
  if (!data || typeof data !== "object" || !("reason" in data)) return null;
  const { reason } = data;
  if (reason !== "stopped" && reason !== "failed") return null;
  return (
    <p data-reply-end={reason} className="mt-2 text-xs text-muted-foreground">
      {reason === "stopped" ? "Stopped" : "Interrupted"}
    </p>
  );
};

import { CheckIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { SubmitState } from "@/lib/submit-state";

export function SaveNotice({ state }: { state: SubmitState }) {
  if (state.status === "failed") {
    return (
      <p role="alert" className="flex min-w-0 items-center gap-2 text-meta text-destructive">
        <WarningCircleIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 wrap-anywhere">{state.error}</span>
      </p>
    );
  }

  return (
    <span role="status" className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
      {state.status === "succeeded" ? <><CheckIcon className="size-3.5 text-positive" /> Saved</> : null}
    </span>
  );
}

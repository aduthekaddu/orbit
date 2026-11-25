"use client";

import { WarningCircleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

export function EditorFooter({
  error,
  saving,
  onCancel,
  onSave,
  saveDisabled,
}: {
  error?: string;
  saving?: boolean;
  onCancel: () => void;
  onSave: () => void;
  saveDisabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-end gap-1 border-t px-2 py-1.5">
      {error ? (
        <p role="alert" className="mr-auto flex min-w-0 items-center gap-1.5 px-1 text-xs text-destructive">
          <WarningCircleIcon weight="regular" className="size-3.5 shrink-0" />
          <span className="truncate">{error}</span>
        </p>
      ) : null}
      <Button type="button" variant="ghost" size="xs" onClick={onCancel} disabled={saving}>
        Cancel
      </Button>
      <Button type="button" size="xs" onClick={onSave} disabled={saving || saveDisabled}>
        Save
      </Button>
    </div>
  );
}

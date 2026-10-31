"use client";

import { useState } from "react";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useSaveMessageText } from "./use-save-message";

export function MessageTextEditor({
  messageId,
  initialText,
  onClose,
  label = "Edit message",
}: {
  messageId: string;
  initialText: string;
  onClose: () => void;
  label?: string;
}) {
  const { save, saving, error } = useSaveMessageText();
  const [text, setText] = useState(initialText);
  const rows = Math.min(18, Math.max(4, initialText.split("\n").length + 1));

  async function commit() {
    if (text === initialText) {
      onClose();
      return;
    }
    if (await save(messageId, text)) onClose();
  }

  return (
    <div className="my-2 rounded-xl border bg-surface-sunken p-2 shadow-card focus-within:border-border-strong">
      <textarea
        autoFocus
        rows={rows}
        value={text}
        aria-label={label}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void commit();
          }
        }}
        className="block max-h-96 w-full resize-y bg-transparent px-2 py-1 font-mono text-xs leading-5 outline-none scrollbar-thin"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        {error ? (
          <p role="alert" className="mr-auto flex items-center gap-1.5 text-xs text-destructive">
            <WarningCircleIcon weight="regular" className="size-3.5" />
            {error}
          </p>
        ) : null}
        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={() => void commit()} disabled={saving}>
          Save
        </Button>
      </div>
    </div>
  );
}

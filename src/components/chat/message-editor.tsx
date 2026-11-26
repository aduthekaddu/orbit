"use client";

import { useState } from "react";
import { EditorFooter } from "./editor-footer";
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

  async function commit() {
    if (saving || text.trim() === "") return;
    if (text === initialText) {
      onClose();
      return;
    }
    if (await save(messageId, text)) onClose();
  }

  return (
    <div className="overflow-hidden rounded-xl border border-primary/40 bg-card shadow-card">
      <textarea
        autoFocus
        readOnly={saving}
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
            if (!saving) void commit();
          }
        }}
        className="block max-h-[60vh] min-h-24 w-full resize-none bg-transparent px-4 py-3 text-input outline-none field-sizing-content scrollbar-thin"
      />
      <EditorFooter error={error} saving={saving} saveDisabled={text.trim() === ""} onCancel={onClose} onSave={() => void commit()} />
    </div>
  );
}

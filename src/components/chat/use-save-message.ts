"use client";

import { useState } from "react";
import { useAISDKChat } from "@assistant-ui/react-ai-sdk";
import { z } from "zod";
import { replaceTextPart, replaceTextParts, type MessageParts } from "@/lib/chat-parts";
import { requestJson } from "@/lib/request-json";
import { saveLockFor } from "@/lib/save-lock";
import { useArtifact } from "@/components/artifacts/use-artifact";
import { useChatId } from "./chat-id";

const savedMessage = z.object({ ok: z.literal(true) });

export function useSaveMessageText() {
  const chatId = useChatId();
  const chat = useAISDKChat();
  const artifacts = useArtifact();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function save(messageId: string, text: string, partIndex?: number) {
    return saveLockFor(messageId)(async () => {
      if (!chatId || !messageId) {
        setError("Could not save");
        return false;
      }
      setSaving(true);
      setError("");
      let saved = false;
      await requestJson(
        `/api/chats/${chatId}/messages/${messageId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(partIndex == null ? { text } : { text, partIndex }),
        },
        {
          parse: savedMessage,
          onOk: () => {
            chat?.setMessages((messages) =>
              messages.map((message) => {
                if (message.id !== messageId) return message;
                if (partIndex == null) return { ...message, parts: replaceTextParts(message.parts as MessageParts, text) };
                const parts = replaceTextPart(message.parts as MessageParts, partIndex, text);
                return parts ? { ...message, parts } : message;
              }),
            );
            // The edit may have changed an artifact's code or title. The saved rows reload without moving the branch.
            artifacts?.refresh();
            saved = true;
          },
          onFailed: () => setError("Could not save"),
        },
      );
      setSaving(false);
      return saved;
    });
  }

  return { save, saving, error };
}

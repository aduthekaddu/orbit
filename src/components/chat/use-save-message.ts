"use client";

import { useState } from "react";
import { useAISDKChat } from "@assistant-ui/react-ai-sdk";
import { z } from "zod";
import { replaceTextPart, replaceTextParts, type MessageParts } from "@/lib/chat-parts";
import { requestJson } from "@/lib/request-json";
import { createSaveLock } from "@/lib/save-lock";
import { useChatId } from "./chat-id";

const savedMessage = z.object({ ok: z.literal(true) });

export function useSaveMessageText() {
  const chatId = useChatId();
  const chat = useAISDKChat();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [lock] = useState(createSaveLock);

  function save(messageId: string, text: string, partIndex?: number) {
    return lock(async () => {
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

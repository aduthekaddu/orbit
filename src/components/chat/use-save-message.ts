"use client";

import { useState } from "react";
import { useAISDKChat } from "@assistant-ui/react-ai-sdk";
import { replaceTextParts, type MessageParts } from "@/lib/chat-parts";
import { useChatId } from "./chat-id";

export function useSaveMessageText() {
  const chatId = useChatId();
  const chat = useAISDKChat();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save(messageId: string, text: string) {
    if (!chatId || !messageId) {
      setError("Could not save");
      return false;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/chats/${chatId}/messages/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        setError("Could not save");
        return false;
      }
      chat?.setMessages((messages) =>
        messages.map((message) =>
          message.id === messageId ? { ...message, parts: replaceTextParts(message.parts as MessageParts, text) } : message,
        ),
      );
      return true;
    } catch {
      setError("Could not save");
      return false;
    } finally {
      setSaving(false);
    }
  }

  return { save, saving, error };
}

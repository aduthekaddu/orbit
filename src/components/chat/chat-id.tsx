"use client";

import { createContext, useContext } from "react";

const ChatIdContext = createContext("");

export function ChatIdProvider({ chatId, children }: { chatId: string; children: React.ReactNode }) {
  return <ChatIdContext.Provider value={chatId}>{children}</ChatIdContext.Provider>;
}

export function useChatId() {
  return useContext(ChatIdContext);
}

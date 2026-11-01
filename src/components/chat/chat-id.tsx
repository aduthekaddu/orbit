"use client";

import { createContext, useContext } from "react";

const EditTargetContext = createContext<(id: string | null) => void>(() => {});

export function useEditTarget() { return useContext(EditTargetContext); }

const ChatIdContext = createContext("");

export function ChatIdProvider({ chatId, onEdit, children }: { chatId: string; onEdit: (id: string | null) => void; children: React.ReactNode }) {
  return <ChatIdContext.Provider value={chatId}><EditTargetContext.Provider value={onEdit}>{children}</EditTargetContext.Provider></ChatIdContext.Provider>;
}

export function useChatId() {
  return useContext(ChatIdContext);
}

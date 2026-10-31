"use client";

import { createContext, useContext } from "react";

export type CodeEditContextValue = {
  enabled: boolean;
  text: string;
  active: number | null;
  setActive: (start: number | null) => void;
  save: (messageId: string, text: string) => Promise<boolean>;
  messageId: string;
  saving: boolean;
  error: string;
};

export const CodeEditContext = createContext<CodeEditContextValue | null>(null);

export function useCodeEdit() {
  return useContext(CodeEditContext);
}

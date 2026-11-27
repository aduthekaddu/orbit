"use client";

import { createContext, useContext } from "react";

export type CodeEditContextValue = {
  enabled: boolean;
  text: string;
  textOrdinal: number | undefined;
  active: number | null;
  setActive: (start: number | null) => void;
  save: (messageId: string, text: string) => Promise<boolean>;
  messageId: string;
  saving: boolean;
  error: string;
  /** The message is still streaming, so an artifact in it is not finished yet. */
  streaming: boolean;
  /** Code blocks, by `data-code-index`, whose lines wrap. */
  wrapped: ReadonlySet<number>;
  toggleWrap: (index: number) => void;
};

export const CodeEditContext = createContext<CodeEditContextValue | null>(null);

export function useCodeEdit() {
  return useContext(CodeEditContext);
}

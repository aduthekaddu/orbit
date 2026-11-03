import { generateText, type LanguageModel } from "ai";
import { chatTitle, replaceFallbackTitle } from "./messages";

export const TITLE_ASK = "Write a title of at most six words.";

const wrappingQuotes = /^["'`“”‘’]+|["'`“”‘’]+$/g;

export function titlePrompt(firstMessage: string): string {
  return `${TITLE_ASK}\nReply with the title only.\n\n${firstMessage}`;
}

export function cleanTitle(raw: string): string {
  let text = raw.trim().replace(wrappingQuotes, "");
  if (text.endsWith(".") && !text.endsWith("..")) text = text.slice(0, -1);
  return chatTitle(text.trim());
}

export function startChatTitle(input: {
  messagesBeforeTurn: number;
  chatId: string;
  firstMessage: string;
  fallbackTitle: string;
  model: LanguageModel;
  onError: (message: string) => void;
}): void {
  const firstMessage = input.firstMessage.trim();
  if (input.messagesBeforeTurn !== 0 || !firstMessage || !input.fallbackTitle) return;
  void saveTitle(input, firstMessage);
}

async function saveTitle(
  input: {
    chatId: string;
    fallbackTitle: string;
    model: LanguageModel;
    onError: (message: string) => void;
  },
  firstMessage: string,
) {
  try {
    const result = await generateText({
      model: input.model,
      prompt: titlePrompt(firstMessage),
      maxOutputTokens: 24,
      timeout: 10_000,
      maxRetries: 0,
    });
    const next = cleanTitle(result.text);
    if (!next) return;
    replaceFallbackTitle(input.chatId, input.fallbackTitle, next);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The title request failed";
    input.onError(message);
  }
}

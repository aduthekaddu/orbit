import { generateText, type LanguageModel } from "ai";
import { after } from "next/server";
import type { Redactor } from "./chat-errors";
import type { EffortCallOptions } from "./effort";
import { chatTitle, replaceFallbackTitle } from "./messages";

export const TITLE_ASK = "Write a title of at most six words.";

const TITLE_SOURCE_CHARACTERS = 2_000;

const wrappingQuotes = /^["'`“”‘’]+|["'`“”‘’]+$/g;

export function titlePrompt(firstMessage: string): string {
  const start = Array.from(firstMessage).slice(0, TITLE_SOURCE_CHARACTERS).join("");
  return `${TITLE_ASK}\nReply with the title only.\n\n${start}`;
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
  call: { options: EffortCallOptions; maxOutputTokens: number };
  inputRedact: Redactor;
  redact: Redactor;
  onError: (message: string) => void;
}): void {
  const firstMessage = input.inputRedact.text(input.firstMessage.trim());
  if (input.messagesBeforeTurn !== 0 || !firstMessage || !input.fallbackTitle) return;
  const pending = saveTitle(input, firstMessage);
  after(() => pending);
}

async function saveTitle(
  input: {
    chatId: string;
    fallbackTitle: string;
    model: LanguageModel;
    call: { options: EffortCallOptions; maxOutputTokens: number };
    redact: Redactor;
    onError: (message: string) => void;
  },
  firstMessage: string,
) {
  try {
    const result = await generateText({
      model: input.model,
      prompt: titlePrompt(firstMessage),
      ...input.call.options,
      maxOutputTokens: input.call.maxOutputTokens,
      timeout: 10_000,
      maxRetries: 0,
    });
    const next = input.redact.text(cleanTitle(input.redact.text(result.text)));
    if (!next) {
      input.onError("The title response was empty");
      return;
    }
    replaceFallbackTitle(input.chatId, input.fallbackTitle, next);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The title request failed";
    input.onError(message);
  }
}

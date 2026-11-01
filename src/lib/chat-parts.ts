import type { UIMessage } from "ai";

export type MessageParts = UIMessage["parts"];

/** Put the edited text in the first text part and drop the rest. Other parts keep their place. */
export function replaceTextParts(parts: MessageParts, text: string): MessageParts {
  const next: MessageParts = [];
  let placed = false;
  for (const part of parts) {
    if (part.type !== "text") {
      next.push(part);
      continue;
    }
    if (placed) continue;
    next.push({ ...part, text });
    placed = true;
  }
  if (!placed) next.push({ type: "text", text });
  return next;
}

export function messageText(parts: MessageParts): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}

/** The offset where a fenced block's body starts, found from its opening fence. */
export function codeBodyStart(text: string, fenceOffset: number | undefined, code: string): number {
  if (fenceOffset == null) return text.indexOf(code);
  const newline = text.indexOf("\n", fenceOffset);
  const bodyStart = newline === -1 ? text.length : newline + 1;
  if (code === "") return bodyStart;
  const index = text.indexOf(code, bodyStart);
  return index === -1 ? bodyStart : index;
}

/** Replace one fenced block's code inside a message, using the code block's markdown offsets. */
export function replaceCode(text: string, code: string, next: string, start?: number, end?: number): string {
  const closingFenceGlued = code === "" ? next !== "" : code.endsWith("\n");
  const keepNewline = closingFenceGlued && !next.endsWith("\n") ? "\n" : "";
  if (start != null && end != null && start >= 0 && end <= text.length && text.slice(start, end) === code) {
    return text.slice(0, start) + next + keepNewline + text.slice(end);
  }
  const index = text.indexOf(code);
  if (index === -1) return text;
  return text.slice(0, index) + next + keepNewline + text.slice(index + code.length);
}

export function editedMessageText(parts: readonly { type: string; text?: string }[], index: number, text: string): string {
  return parts.flatMap((part, current) => part.type === "text" ? [current === index ? text : part.text ?? ""] : []).join("\n\n");
}

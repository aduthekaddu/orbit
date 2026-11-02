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

/** Replace the text of one part in place. Null when the index is missing or is not a text part. */
export function replaceTextPart(parts: MessageParts, index: number, text: string): MessageParts | null {
  const part = parts[index];
  if (!part || part.type !== "text") return null;
  const next = parts.slice();
  next[index] = { ...part, text };
  return next;
}

export function messageText(parts: MessageParts): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}

/** The offset where a code block's body starts, using the old offset to choose among identical blocks. */
export function codeStart(text: string, code: string, near: number | undefined): number {
  if (code === "") return nearestFenceBody(text, near);
  let best = text.indexOf(code);
  if (best === -1 || near === undefined) return best;
  let distance = Math.abs(best - near);
  for (let at = text.indexOf(code, best + code.length); at !== -1; at = text.indexOf(code, at + code.length)) {
    const next = Math.abs(at - near);
    if (next < distance) {
      best = at;
      distance = next;
    }
  }
  return best;
}

function nearestFenceBody(text: string, near: number | undefined): number {
  if (near === undefined) return -1;
  let best = -1;
  let distance = Infinity;
  let open = false;
  for (let lineStart = 0; lineStart <= text.length;) {
    const lineEnd = text.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? text.length : lineEnd;
    if (/^ {0,3}(`{3,}|~{3,})/.test(text.slice(lineStart, end))) {
      if (open) open = false;
      else {
        open = true;
        const body = Math.min(end + 1, text.length);
        const gap = Math.abs(body - near);
        if (gap < distance) {
          best = body;
          distance = gap;
        }
      }
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  return best;
}

/** Replace one fenced block's code inside a message, using the code block's markdown offsets. */
export function replaceCode(text: string, code: string, next: string, start?: number, end?: number): string {
  const closingFenceGlued = code === "" ? next !== "" : code.endsWith("\n");
  const keepNewline = closingFenceGlued && !next.endsWith("\n") ? "\n" : "";
  if (start != null && end != null) {
    if (start < 0 || end > text.length || text.slice(start, end) !== code) return text;
    return text.slice(0, start) + next + keepNewline + text.slice(end);
  }
  const index = text.indexOf(code);
  if (index === -1) return text;
  return text.slice(0, index) + next + keepNewline + text.slice(index + code.length);
}

export function textPartIndex(parts: MessageParts, ordinal: number): number | undefined {
  let textOrdinal = 0;
  for (const [index, part] of parts.entries()) {
    if (part.type !== "text") continue;
    if (textOrdinal === ordinal) return index;
    textOrdinal += 1;
  }
  return undefined;
}

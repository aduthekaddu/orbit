import { z } from "zod";

// The only way a route schema builds a string or a list. A route file imports `r`
// from here, never `z` from "zod", so a field with no size limit does not compile.
// route-schema.test.ts fails any route that imports zod directly.
export const r = {
  text: (max: number) => z.string().max(max),
  requiredText: (max: number) => z.string().trim().min(1).max(max),
  list: <T extends z.ZodType>(item: T, max: number) => z.array(item).max(max),
  object: z.object,
  looseObject: z.looseObject,
  enum: z.enum,
  literal: z.literal,
  union: z.union,
  discriminatedUnion: z.discriminatedUnion,
  number: z.number,
  boolean: z.boolean,
  // For content a chat already stores. The whole request is capped at LIMITS.requestBytes before
  // it is parsed, and no string or list inside it can be longer than that.
  history: {
    text: () => z.string().max(LIMITS.requestBytes),
    list: <T extends z.ZodType>(item: T) => z.array(item).max(LIMITS.requestBytes),
  },
  url: (max: number, params?: Parameters<typeof z.url>[0]) => z.string().max(max).pipe(z.url(params)),
};

export const LIMITS = {
  id: 100,
  url: 2048,
  secret: 4096,
  modelName: 200,
  label: 100,
  chatTitle: 120,
  memoryText: 2000,
  query: 500,
  userMessageText: 50_000,
  assistantText: 200_000,
  partType: 100,
  partsPerMessage: 500,
  requestBytes: 33_554_432,
} as const;

export type JsonBody = { ok: true; json: unknown } | { ok: false; reason: "too-large" | "invalid" };

// Reads a request body as JSON and stops reading at `maxBytes`, so a large body is refused before it is parsed.
export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBody> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > maxBytes) return { ok: false, reason: "too-large" };
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, reason: "invalid" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { ok: false, reason: "too-large" };
    }
    chunks.push(chunk.value);
  }
  try {
    return { ok: true, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

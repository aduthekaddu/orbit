import { z } from "zod";

// The only way a route schema builds a string or a list. A route file imports `r`
// from here, never `z` from "zod", so a field with no size limit does not compile.
// route-schema.test.ts fails any route that imports zod directly.
export const r = {
  text: (max: number) => z.string().max(max),
  list: <T extends z.ZodType>(item: T, max: number) => z.array(item).max(max),
  object: z.object,
  looseObject: z.looseObject,
  enum: z.enum,
  literal: z.literal,
  union: z.union,
  discriminatedUnion: z.discriminatedUnion,
  number: z.number,
  url: (max: number, params?: Parameters<typeof z.url>[0]) => z.string().max(max).pipe(z.url(params)),
};

export const LIMITS = {
  id: 100,
  url: 2048,
  secret: 4096,
  modelName: 200,
  memoryText: 2000,
  query: 500,
  userMessageText: 50_000,
  assistantText: 200_000,
  partType: 100,
  partsPerMessage: 500,
  messagesPerRequest: 2000,
} as const;

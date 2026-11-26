import { z } from "zod";

/** What `web_search` returns. The tool line and the result list parse the same shape. */
export const searchOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), query: z.string(), results: z.array(z.object({
    title: z.string(), url: z.url({ protocol: /^https?$/ }), snippet: z.string().max(300), engine: z.enum(["searxng", "tavily"]),
  })).max(8) }),
  z.object({ ok: z.literal(false), query: z.string(), error: z.string() }),
]);

export type SearchOutput = z.infer<typeof searchOutputSchema>;

export function searchSources(output: unknown) {
  const parsed = searchOutputSchema.safeParse(output);
  return parsed.success && parsed.data.ok ? parsed.data.results : [];
}

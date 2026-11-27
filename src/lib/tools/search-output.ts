import { z } from "zod";

/** What `web_search` returns. The tool line and the result list parse the same shape. */
export const searchOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), query: z.string(), results: z.array(z.object({
    title: z.string(), url: z.url({ protocol: /^https?$/ }), snippet: z.string().max(300), engine: z.enum(["searxng", "tavily"]),
  })).max(8) }),
  z.object({ ok: z.literal(false), query: z.string(), error: z.string() }),
]);

export type SearchOutput = z.infer<typeof searchOutputSchema>;
export type SearchResult = Extract<SearchOutput, { ok: true }>["results"][number];

/** A search tool part's result: its hits, the error it returned, or a payload that does not parse. An empty hit list is `found`, not `invalid`. */
export type SearchRun = { state: "found"; results: SearchResult[] } | { state: "failed"; error: string } | { state: "invalid" };

export function parseSearchRun(output: unknown): SearchRun {
  const parsed = searchOutputSchema.safeParse(output);
  if (!parsed.success) return { state: "invalid" };
  return parsed.data.ok ? { state: "found", results: parsed.data.results } : { state: "failed", error: parsed.data.error };
}

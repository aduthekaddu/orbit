import { z } from "zod";

const searchOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), query: z.string(), results: z.array(z.object({
    title: z.string(), url: z.url({ protocol: /^https?$/ }), snippet: z.string().max(300), engine: z.enum(["searxng", "tavily"]),
  })).max(8) }),
  z.object({ ok: z.literal(false), query: z.string(), error: z.string() }),
]);

export function SearchResults({ output }: { output: unknown }) {
  const parsed = searchOutputSchema.safeParse(output);
  if (!parsed.success) return <p className="text-sm text-destructive">Search returned an invalid result</p>;
  const search = parsed.data;
  if (!search.ok) return <p className="text-sm text-destructive">{search.error}</p>;
  return (
    <ul className="space-y-3">
      {search.results.map((result) => {
        const domain = new URL(result.url).hostname;
        return (
          <li key={result.url} className="flex min-w-0 gap-3">
            <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded border text-meta text-muted-foreground uppercase">{domain[0]}</span>
            <div className="min-w-0 text-sm">
              <a href={result.url} target="_blank" rel="noopener noreferrer nofollow" className="break-words text-foreground underline decoration-sun/50 underline-offset-4 hover:decoration-sun">{result.title || domain}</a>
              {result.snippet && <p className="mt-1 break-words text-meta text-muted-foreground">{result.snippet}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

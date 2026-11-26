import { domainTile } from "@/lib/tools/domain-tile";
import { searchOutputSchema } from "@/lib/tools/search-output";
import { cn } from "@/lib/utils";

/** A domain's letter on its own chart color. Computed locally, so nothing is fetched from the site. */
export function DomainTile({ url, className }: { url: string; className?: string }) {
  const { letter, tone } = domainTile(url);
  return (
    <span
      data-tile
      aria-hidden
      style={{ "--tile": `var(--chart-${tone})` } as React.CSSProperties}
      className={cn(
        "flex shrink-0 items-center justify-center bg-[color-mix(in_oklab,var(--tile)_20%,var(--background))] font-semibold text-(color:--tile)",
        className,
      )}
    >
      {letter}
    </span>
  );
}

export function SearchResults({ output }: { output: unknown }) {
  const parsed = searchOutputSchema.safeParse(output);
  if (!parsed.success) return <p className="text-sm text-destructive">Search returned an invalid result</p>;
  const search = parsed.data;
  if (!search.ok) return <p className="text-sm text-destructive">{search.error}</p>;
  return (
    <ul className="space-y-3">
      {search.results.map((result) => {
        const domain = new URL(result.url).hostname.replace(/^www\./, "");
        return (
          <li key={result.url} className="flex min-w-0 gap-3">
            <DomainTile url={result.url} className="size-7 rounded-md text-meta" />
            <div className="min-w-0 text-sm">
              <a href={result.url} target="_blank" rel="noopener noreferrer nofollow" className="break-words text-foreground underline decoration-sun/50 underline-offset-4 hover:decoration-sun">{result.title || domain}</a>
              <p className="mt-0.5 truncate text-meta text-muted-foreground">{domain}</p>
              {result.snippet && <p className="mt-1 break-words text-meta text-muted-foreground">{result.snippet}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

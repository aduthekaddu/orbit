import { githubLinks } from "@/lib/tools/github-links";
import { GenericOutput } from "./generic-output";

export function GithubOutput({ output }: { output: unknown }) {
  const links = githubLinks(output);
  if (links.length === 0) return <GenericOutput output={output} />;
  return (
    <ul className="space-y-2">
      {links.map((link) => (
        <li key={link.href} className="min-w-0 text-sm">
          <a href={link.href} target="_blank" rel="noopener noreferrer nofollow" className="break-words text-foreground underline decoration-sun/50 underline-offset-4 hover:decoration-sun">{link.title}</a>
        </li>
      ))}
    </ul>
  );
}

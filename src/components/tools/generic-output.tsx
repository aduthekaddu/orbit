import { ScrollFade } from "@/components/ui/scroll-fade";

export function GenericOutput({ output }: { output: unknown }) {
  return (
    <ScrollFade axis="y" fade="var(--surface-sunken)" className="rounded-md bg-surface-sunken" scrollerClassName="max-h-tool-content" scrollerLabel="Output">
      <pre className="p-3 whitespace-pre-wrap break-words font-mono text-code text-foreground">{JSON.stringify(output, null, 2)}</pre>
    </ScrollFade>
  );
}

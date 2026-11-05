export function GenericOutput({ output }: { output: unknown }) {
  return (
    <details>
      <summary className="cursor-pointer text-sm text-muted-foreground">Output</summary>
      <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(output, null, 2)}</pre>
    </details>
  );
}

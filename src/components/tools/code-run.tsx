import { z } from "zod";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { runCodeInputSchema, runCodeOutputSchema } from "@/lib/sandbox/spec";

const errorSchema = z.union([z.object({ ok: z.literal(false).optional(), error: z.string() }), z.string().min(1)]);

function CodeText({ text, kind }: { text: string; kind: "source" | "stdout" | "stderr" }) {
  return (
    <ScrollFade axis="x" fade="var(--surface-sunken)" className="min-w-0 rounded-md border bg-surface-sunken">
      <pre data-code-stdout={kind === "stdout" ? "" : undefined} data-code-stderr={kind === "stderr" ? "" : undefined} className="w-max min-w-full p-3 font-mono text-xs leading-5">
        <code>{text}</code>
      </pre>
    </ScrollFade>
  );
}

export function CodeRun({ input, output }: { input: unknown; output: unknown }) {
  const parsedInput = runCodeInputSchema.safeParse(input);
  const parsedOutput = runCodeOutputSchema.safeParse(output);
  const error = errorSchema.safeParse(output);
  return (
    <div className="min-w-0 space-y-3">
      {parsedInput.success && <CodeText text={parsedInput.data.code} kind="source" />}
      {error.success ? <p className="text-sm text-destructive">{typeof error.data === "string" ? error.data : error.data.error}</p> : parsedOutput.success ? (
        <>
          <div className="min-w-0 space-y-1">
            <p className="text-xs text-muted-foreground">stdout</p>
            <CodeText text={parsedOutput.data.stdout} kind="stdout" />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="text-xs text-muted-foreground">stderr</p>
            <CodeText text={parsedOutput.data.stderr} kind="stderr" />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground num">
            <span>Exit {parsedOutput.data.exitCode ?? "killed"}</span>
            <span>{Math.round(parsedOutput.data.durationMs)} ms</span>
            {parsedOutput.data.timedOut && <span className="text-destructive">Timed out</span>}
            {parsedOutput.data.truncated && <span>Output truncated</span>}
          </div>
        </>
      ) : output !== undefined ? <p className="text-sm text-destructive">Code returned an invalid result</p> : null}
    </div>
  );
}

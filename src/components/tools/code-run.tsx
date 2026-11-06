import { CheckIcon, CopyIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { z } from "zod";
import { useCopy } from "@/components/chat/use-copy";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { runCodeInputSchema, runCodeOutputSchema } from "@/lib/sandbox/spec";

const errorSchema = z.union([z.object({ ok: z.literal(false).optional(), error: z.string() }), z.string().min(1)]);
const codeLabels = { source: "Source code", stdout: "Standard output", stderr: "Standard error" };
const copyLabels = { source: "Copy source", stdout: "Copy standard output", stderr: "Copy standard error" };
const copiedLabels = { source: "Source copied", stdout: "Standard output copied", stderr: "Standard error copied" };

function CopyCode({ text, kind }: { text: string; kind: keyof typeof codeLabels }) {
  const { copied, failed, copy } = useCopy();
  return (
    <>
      <span aria-live="polite" className="sr-only">{copied ? copiedLabels[kind] : failed ? "Copy failed" : ""}</span>
      <button
        type="button"
        onClick={() => copy(text)}
        aria-label={copyLabels[kind]}
        className="absolute top-1.5 right-1.5 z-10 flex size-6 items-center justify-center rounded-md bg-surface-sunken text-muted-foreground transition-colors duration-150 ease-orbit outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {copied ? <CheckIcon weight="regular" className="size-3.5" /> : failed ? <WarningCircleIcon weight="regular" className="size-3.5 text-destructive" /> : <CopyIcon weight="regular" className="size-3.5" />}
      </button>
    </>
  );
}

function CodeText({ text, kind }: { text: string; kind: keyof typeof codeLabels }) {
  return (
    <div className="relative min-w-0">
      <ScrollFade axis="y" fade="var(--surface-sunken)" className="min-w-0 rounded-md border bg-surface-sunken" scrollerClassName="max-h-tool-content" scrollerLabel={codeLabels[kind]}>
        <ScrollFade axis="x" fade="var(--surface-sunken)" className="min-w-0" scrollerLabel={`${codeLabels[kind]} horizontal scroll`}>
          <pre data-code-stdout={kind === "stdout" ? "" : undefined} data-code-stderr={kind === "stderr" ? "" : undefined} className="w-max min-w-full p-3 pr-10 font-mono text-xs leading-5">
            <code>{text}</code>
          </pre>
        </ScrollFade>
      </ScrollFade>
      {text ? <CopyCode text={text} kind={kind} /> : null}
    </div>
  );
}

export function CodeRun({ input, output }: { input: unknown; output: unknown }) {
  const parsedInput = runCodeInputSchema.safeParse(input);
  const parsedOutput = runCodeOutputSchema.safeParse(output);
  const error = errorSchema.safeParse(output);
  return (
    <div className="min-w-0 space-y-3">
      {parsedInput.success && <CodeText text={parsedInput.data.code} kind="source" />}
      {error.success ? (
        <ScrollFade axis="y" fade="var(--card)" className="min-w-0" scrollerClassName="max-h-tool-content" scrollerLabel="Code error">
          <p className="whitespace-pre-wrap break-words text-sm text-destructive">{typeof error.data === "string" ? error.data : error.data.error}</p>
        </ScrollFade>
      ) : parsedOutput.success ? (
        <>
          {parsedOutput.data.stdout && (
            <div className="min-w-0 space-y-1">
              <p className="text-xs text-muted-foreground">stdout</p>
              <CodeText text={parsedOutput.data.stdout} kind="stdout" />
            </div>
          )}
          {parsedOutput.data.stderr && (
            <div className="min-w-0 space-y-1">
              <p className="text-xs text-muted-foreground">stderr</p>
              <CodeText text={parsedOutput.data.stderr} kind="stderr" />
            </div>
          )}
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

import { CheckIcon, CopyIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { z } from "zod";
import { useCopy } from "@/components/chat/use-copy";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { runCodeInputSchema, runCodeOutputSchema, type RunCodeOutput } from "@/lib/sandbox/spec";

const errorSchema = z.union([z.object({ ok: z.literal(false).optional(), error: z.string() }), z.string().min(1)]);
const codeLabels = { source: "Source code", stdout: "Standard output", stderr: "Standard error" };
const copyLabels = { source: "Copy source", stdout: "Copy standard output", stderr: "Copy standard error" };
const copiedLabels = { source: "Source copied", stdout: "Standard output copied", stderr: "Standard error copied" };
const surfaces = {
  source: { well: "bg-surface-sunken", fade: "var(--surface-sunken)" },
  stdout: { well: "bg-canvas", fade: "var(--canvas)" },
  stderr: { well: "bg-canvas", fade: "var(--canvas)" },
};

function CopyCode({ text, kind }: { text: string; kind: keyof typeof codeLabels }) {
  const { copied, failed, copy } = useCopy();
  return (
    <>
      <span aria-live="polite" className="sr-only">{copied ? copiedLabels[kind] : failed ? "Copy failed" : ""}</span>
      <button
        type="button"
        onClick={() => copy(text)}
        aria-label={copyLabels[kind]}
        className={`absolute top-1.5 right-1.5 z-10 flex size-6 items-center justify-center rounded-md ${surfaces[kind].well} text-muted-foreground transition-colors duration-150 ease-orbit outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50`}
      >
        {copied ? <CheckIcon weight="regular" className="size-3.5" /> : failed ? <WarningCircleIcon weight="regular" className="size-3.5 text-destructive" /> : <CopyIcon weight="regular" className="size-3.5" />}
      </button>
    </>
  );
}

function CodeText({ text, kind }: { text: string; kind: keyof typeof codeLabels }) {
  return (
    <div className="relative min-w-0">
      <ScrollFade axis="y" fade={surfaces[kind].fade} className={`min-w-0 rounded-md border ${surfaces[kind].well}`} scrollerClassName="max-h-tool-content" scrollerLabel={codeLabels[kind]}>
        <ScrollFade axis="x" fade={surfaces[kind].fade} className="min-w-0" scrollerLabel={`${codeLabels[kind]} horizontal scroll`}>
          <pre data-code-stdout={kind === "stdout" ? "" : undefined} data-code-stderr={kind === "stderr" ? "" : undefined} className="w-max min-w-full p-3 pr-10 font-mono text-xs leading-5">
            <code>{text}</code>
          </pre>
        </ScrollFade>
      </ScrollFade>
      {text ? <CopyCode text={text} kind={kind} /> : null}
    </div>
  );
}

function formatDuration(durationMs: number) {
  const ms = Math.round(durationMs);
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function describeRun(output: RunCodeOutput) {
  const duration = formatDuration(output.durationMs);
  if (output.cancelled) return { primary: "Stopped", duration, failed: false };
  if (output.timedOut) return { primary: "Timed out", duration, failed: true };
  if (output.oomKilled) return { primary: `Out of memory (exit ${output.exitCode})`, duration, failed: true };
  if (output.exitCode === null) return { primary: "Killed", duration, failed: true };
  return { primary: `Exit ${output.exitCode}`, duration, failed: output.exitCode !== 0 };
}

export function CodeRun({ input, output }: { input: unknown; output: unknown }) {
  const parsedInput = runCodeInputSchema.safeParse(input);
  const parsedOutput = runCodeOutputSchema.safeParse(output);
  const error = errorSchema.safeParse(output);
  const run = parsedOutput.success ? describeRun(parsedOutput.data) : null;
  return (
    <div className="min-w-0 space-y-3">
      {parsedInput.success && <CodeText text={parsedInput.data.code} kind="source" />}
      {error.success ? (
        <ScrollFade axis="y" fade="var(--card)" className="min-w-0" scrollerClassName="max-h-tool-content" scrollerLabel="Code error">
          <p className="whitespace-pre-wrap break-words text-sm text-destructive">{typeof error.data === "string" ? error.data : error.data.error}</p>
        </ScrollFade>
      ) : parsedOutput.success && run ? (
        <>
          {parsedOutput.data.stdout.trim() && (
            <div className="min-w-0 space-y-1">
              <p className="text-xs text-muted-foreground">stdout</p>
              <CodeText text={parsedOutput.data.stdout} kind="stdout" />
            </div>
          )}
          {parsedOutput.data.stderr.trim() && (
            <div className="min-w-0 space-y-1">
              <p className="text-xs text-muted-foreground">stderr</p>
              <CodeText text={parsedOutput.data.stderr} kind="stderr" />
            </div>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground num">
            <span className={run.failed ? "text-destructive" : undefined}>{run.primary}</span>
            <span>{run.duration}</span>
            {parsedOutput.data.truncated && <span>Output truncated</span>}
          </div>
        </>
      ) : output !== undefined ? <p className="text-sm text-destructive">Code returned an invalid result</p> : null}
    </div>
  );
}

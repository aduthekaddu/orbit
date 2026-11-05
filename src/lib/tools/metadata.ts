import { hasFailedCodeOutput } from "../sandbox/spec";

export type ToolCardKind = "genui" | "search" | "code" | "generic";

type ToolCardDefinition = {
  card: ToolCardKind;
  failedOutput?: (output: unknown) => boolean;
};

export const toolCards = {
  render_ui: { card: "genui" },
  web_search: { card: "search" },
  run_code: {
    card: "code",
    failedOutput: hasFailedCodeOutput,
  },
} satisfies Record<string, ToolCardDefinition>;

export type ToolName = keyof typeof toolCards;

const definitions = new Map<string, ToolCardDefinition>(Object.entries(toolCards));

function definitionFor(name: string): ToolCardDefinition | undefined {
  return definitions.get(name);
}

export function cardFor(name: string): ToolCardKind {
  return definitionFor(name)?.card ?? "generic";
}

export function hasFailedOutput(name: string | undefined, output: unknown): boolean {
  return definitionFor(name ?? "")?.failedOutput?.(output) ?? false;
}

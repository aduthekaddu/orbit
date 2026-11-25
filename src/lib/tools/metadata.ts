export type ToolCardKind = "genui" | "search" | "code" | "github" | "generic";

type ToolCardDefinition = { card: ToolCardKind };

export const toolCards = {
  render_ui: { card: "genui" },
  web_search: { card: "search" },
  run_code: { card: "code" },
  remember: { card: "generic" },
  forget: { card: "generic" },
} satisfies Record<string, ToolCardDefinition>;

export type ToolName = keyof typeof toolCards;

const definitions = new Map<string, ToolCardDefinition>(Object.entries(toolCards));

function definitionFor(name: string): ToolCardDefinition | undefined {
  return definitions.get(name);
}

export function cardFor(name: string): ToolCardKind {
  if (name.startsWith("github_")) return "github";
  return definitionFor(name)?.card ?? "generic";
}

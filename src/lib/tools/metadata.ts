export type ToolCardKind = "genui" | "search" | "generic";

export const toolCards = {
  render_ui: "genui",
  web_search: "search",
} satisfies Record<string, ToolCardKind>;

export type ToolName = keyof typeof toolCards;

export function cardFor(name: string): ToolCardKind {
  return Object.entries(toolCards).find(([key]) => key === name)?.[1] ?? "generic";
}

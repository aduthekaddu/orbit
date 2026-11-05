import type { Tool, ToolSet } from "ai";
import type { SettingsRecord } from "../settings";
import { renderUiTool } from "../genui/tool";
import { cardFor, type ToolCardKind, type ToolName } from "./metadata";
import { createSearchTool } from "./search";

export type ToolEntry = {
  name: string;
  enabled: (settings: SettingsRecord) => boolean;
  create: (settings: SettingsRecord) => Tool;
  card: ToolCardKind;
};

const implementations = {
  render_ui: { enabled: () => true, create: () => renderUiTool },
  web_search: { enabled: (settings) => Boolean(settings.searxngUrl || settings.tavilyApiKey), create: createSearchTool },
} satisfies Record<ToolName, Pick<ToolEntry, "enabled" | "create">>;

const entries: ToolEntry[] = Object.entries(implementations).map(([name, implementation]) => ({
  name,
  ...implementation,
  card: cardFor(name),
}));

export function toolsFor(settings: SettingsRecord): ToolSet {
  return Object.fromEntries(entries.filter((entry) => entry.enabled(settings)).map((entry) => [entry.name, entry.create(settings)]));
}

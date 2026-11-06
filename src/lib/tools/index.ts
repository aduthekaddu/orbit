import type { Tool, ToolSet } from "ai";
import type { SettingsRecord } from "../settings";
import { renderUiTool } from "../genui/tool";
import { cardFor, type ToolCardKind, type ToolName } from "./metadata";
import { createSearchTool } from "./search";
import { createRunCodeTool } from "./run-code";
import { createStoppedRuns, type StoppedRuns } from "./stopped-runs";

export type ToolEntry = {
  name: string;
  enabled: (settings: SettingsRecord) => boolean;
  create: (settings: SettingsRecord, stopped: StoppedRuns) => Tool;
  card: ToolCardKind;
};

const implementations = {
  render_ui: { enabled: () => true, create: () => renderUiTool },
  web_search: { enabled: (settings) => Boolean(settings.searxngUrl || settings.tavilyApiKey), create: createSearchTool },
  run_code: { enabled: () => process.env.ORBIT_SANDBOX === "on", create: (_settings, stopped) => createRunCodeTool(stopped) },
} satisfies Record<ToolName, Pick<ToolEntry, "enabled" | "create">>;

const entries: ToolEntry[] = Object.entries(implementations).map(([name, implementation]) => ({
  name,
  ...implementation,
  card: cardFor(name),
}));

export function toolsFor(settings: SettingsRecord, stopped: StoppedRuns = createStoppedRuns()): ToolSet {
  return Object.fromEntries(entries.filter((entry) => entry.enabled(settings)).map((entry) => [entry.name, entry.create(settings, stopped)]));
}

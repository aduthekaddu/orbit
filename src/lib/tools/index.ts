import type { Tool, ToolSet } from "ai";
import { Redactor } from "../chat-errors";
import type { SettingsRecord } from "../settings";
import { renderUiTool } from "../genui/tool";
import { cardFor, type ToolCardKind, type ToolName } from "./metadata";
import { createSearchTool } from "./search";
import { openGithubTurn } from "./github";
import { sandboxEnabled } from "../sandbox/enabled";
import { createForgetTool, createRememberTool, type MemorySource } from "./memory";
import { createRunCodeTool } from "./run-code";
import { createStoppedRuns, type StoppedRuns } from "./stopped-runs";
import { sandboxDocker } from "../sandbox/run";

export type { MemorySource };

export type ToolEntry = {
  name: string;
  enabled: (settings: SettingsRecord) => boolean;
  create: (settings: SettingsRecord, stopped: StoppedRuns, source: MemorySource, redact: Redactor) => Tool;
  card: ToolCardKind;
};

function maskToolOutput(tool: Tool, redact: Redactor): Tool {
  const execute = tool.execute?.bind(tool);
  if (!execute) return tool;
  return {
    ...tool,
    execute: async (input, options) => redact.value(await execute(input, options)),
  };
}

const implementations = {
  render_ui: { enabled: () => true, create: (_settings, _stopped, _source, redact) => maskToolOutput(renderUiTool, redact) },
  web_search: { enabled: (settings) => Boolean(settings.searxngUrl || settings.tavilyApiKey), create: (settings, _stopped, _source, redact) => createSearchTool(settings, redact) },
  run_code: { enabled: sandboxEnabled, create: (_settings, stopped, _source, redact) => createRunCodeTool(stopped, sandboxDocker, redact) },
  remember: { enabled: () => true, create: (_settings, _stopped, source, redact) => createRememberTool(source, redact) },
  forget: { enabled: () => true, create: (_settings, _stopped, _source, redact) => maskToolOutput(createForgetTool(), redact) },
} satisfies Record<ToolName, Pick<ToolEntry, "enabled" | "create">>;

const entries: ToolEntry[] = Object.entries(implementations).map(([name, implementation]) => ({
  name,
  ...implementation,
  card: cardFor(name),
}));

export function toolsFor(
  settings: SettingsRecord,
  stopped: StoppedRuns = createStoppedRuns(),
  source: MemorySource = { chatId: null, messageId: null },
  redact: Redactor = new Redactor(settings),
): ToolSet {
  return Object.fromEntries(entries.filter((entry) => entry.enabled(settings)).map((entry) => [entry.name, entry.create(settings, stopped, source, redact)]));
}

export async function toolsForTurn(
  settings: SettingsRecord,
  stopped: StoppedRuns = createStoppedRuns(),
  source: MemorySource = { chatId: null, messageId: null },
  signal?: AbortSignal,
  redact: Redactor = new Redactor(settings),
): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
  const github = await openGithubTurn(settings, signal, { redact });
  return { tools: { ...toolsFor(settings, stopped, source, redact), ...github.tools }, close: github.close };
}

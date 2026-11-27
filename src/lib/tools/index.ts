import type { Tool, ToolSet } from "ai";
import { Redactor } from "../chat-errors";
import { sandboxActive, type InstanceSettingsRecord } from "../instance-settings";
import type { UserId } from "../policy";
import type { UserGithubRecord } from "../user-github";
import { renderUiTool } from "../genui/tool";
import { cardFor, type ToolCardKind, type ToolName } from "./metadata";
import { createSearchTool } from "./search";
import { openGithubTurn } from "./github";
import { createForgetTool, createRememberTool, type MemorySource } from "./memory";
import { createRunCodeTool } from "./run-code";
import { createStoppedRuns, type StoppedRuns } from "./stopped-runs";
import { sandboxDocker } from "../sandbox/run";

export type { MemorySource };

export type ToolContext = {
  instance: Pick<InstanceSettingsRecord, "searxngUrl" | "tavilyApiKey" | "sandbox">;
  user: { id: UserId; memory: boolean; github: Pick<UserGithubRecord, "githubToken" | "githubMcpUrl"> };
};

type ToolEntry = {
  name: string;
  enabled: (context: ToolContext) => boolean;
  create: (context: ToolContext, stopped: StoppedRuns, source: MemorySource, redact: Redactor) => Tool;
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
  web_search: { enabled: ({ instance }) => Boolean(instance.searxngUrl || instance.tavilyApiKey), create: ({ instance }, _stopped, _source, redact) => createSearchTool(instance, redact) },
  run_code: { enabled: ({ instance }) => sandboxActive(instance), create: (_settings, stopped, _source, redact) => createRunCodeTool(stopped, sandboxDocker, redact) },
  remember: { enabled: ({ user }) => user.memory, create: ({ user }, _stopped, source, redact) => createRememberTool(user.id, source, redact) },
  forget: { enabled: ({ user }) => user.memory, create: ({ user }, _stopped, _source, redact) => maskToolOutput(createForgetTool(user.id), redact) },
} satisfies Record<ToolName, Pick<ToolEntry, "enabled" | "create">>;

const entries: ToolEntry[] = Object.entries(implementations).map(([name, implementation]) => ({
  name,
  ...implementation,
  card: cardFor(name),
}));

export function toolsFor(
  context: ToolContext,
  stopped: StoppedRuns = createStoppedRuns(),
  source: MemorySource = { chatId: null, messageId: null },
  redact: Redactor = new Redactor(context.instance, context.user.github),
): ToolSet {
  return Object.fromEntries(entries.filter((entry) => entry.enabled(context)).map((entry) => [entry.name, entry.create(context, stopped, source, redact)]));
}

export async function toolsForTurn(
  context: ToolContext,
  stopped: StoppedRuns = createStoppedRuns(),
  source: MemorySource = { chatId: null, messageId: null },
  signal?: AbortSignal,
  redact: Redactor = new Redactor(context.instance, context.user.github),
): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
  const github = await openGithubTurn(context.user.id, context.user.github, signal, { redact });
  return { tools: { ...toolsFor(context, stopped, source, redact), ...github.tools }, close: github.close };
}

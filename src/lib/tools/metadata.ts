import { githubLinks } from "./github-links";
import type { ToolRunStatus } from "./run-status";
import { parseSearchRun } from "./search-output";

export type ToolCardKind = "genui" | "search" | "code" | "github" | "memory" | "generic";

/** The kinds that render as a line: one pill that opens on tap. `genui` renders inline with no frame and `code` as a full card. */
export type LineKind = Exclude<ToolCardKind, "genui" | "code">;

export type ToolRun = { status: ToolRunStatus; input: unknown; output: unknown };

type Phrase = string | ((run: ToolRun) => string);
type ToolCardDefinition = { card: ToolCardKind; title: string; said?: Record<ToolRunStatus, Phrase> };

function counted(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

export const toolCards = {
  render_ui: { card: "genui", title: "View" },
  web_search: {
    card: "search",
    title: "Web search",
    said: {
      running: "Searching the web",
      succeeded: (run) => {
        const search = parseSearchRun(run.output);
        return search.state === "found" ? `Searched the web, ${counted(search.results.length, "source", "sources")}` : "Searched the web";
      },
      failed: "Search failed",
      cancelled: "Search stopped",
    },
  },
  run_code: { card: "code", title: "Run code" },
  remember: {
    card: "memory",
    title: "Memory",
    said: { running: "Saving to memory", succeeded: "Saved to memory", failed: "Could not save to memory", cancelled: "Stopped" },
  },
  forget: {
    card: "memory",
    title: "Memory",
    said: { running: "Removing a memory", succeeded: "Removed a memory", failed: "Could not remove the memory", cancelled: "Stopped" },
  },
} satisfies Record<string, ToolCardDefinition>;

export type ToolName = keyof typeof toolCards;

const definitions = new Map<string, ToolCardDefinition>(Object.entries(toolCards));

function sentence(name: string) {
  const words = name.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function githubDefinition(name: string): ToolCardDefinition {
  const title = `${sentence(name.slice("github_".length))} on GitHub`;
  return {
    card: "github",
    title,
    said: {
      running: title,
      succeeded: (run) => {
        const count = githubLinks(run.output, run.input).length;
        return count > 0 ? `${title}, ${counted(count, "result", "results")}` : title;
      },
      failed: `${title} failed`,
      cancelled: `${title} stopped`,
    },
  };
}

function definitionFor(name: string): ToolCardDefinition {
  if (name.startsWith("github_")) return githubDefinition(name);
  const known = definitions.get(name);
  if (known) return known;
  const title = sentence(name);
  return { card: "generic", title, said: { running: title, succeeded: title, failed: `${title} failed`, cancelled: `${title} stopped` } };
}

export function cardFor(name: string): ToolCardKind {
  return definitionFor(name).card;
}

export function titleFor(name: string): string {
  return definitionFor(name).title;
}

/** The one line a tool call shows: what it is doing, or what happened. */
export function summaryFor(name: string, run: ToolRun): string {
  const definition = definitionFor(name);
  const phrase = definition.said?.[run.status] ?? definition.title;
  return typeof phrase === "function" ? phrase(run) : phrase;
}

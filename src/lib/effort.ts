import type { AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import type { JSONValue } from "ai";
import type { ConnectionKind } from "./connections";
import type { ModelCaps } from "./model-list";

export const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
/** The effort when nothing saved names one. */
export const DEFAULT_EFFORT: Effort = "medium";
export type EffortOutcome = "applied" | "adjusted" | "ignored";
export const EFFORT_OUTCOMES = ["applied", "adjusted", "ignored"] as const satisfies readonly EffortOutcome[];

export const EFFORT_LABELS: Record<Effort, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value);
}

type JsonOptions = { [key: string]: JSONValue };

export type EffortCallOptions = {
  reasoning?: Effort;
  providerOptions?: { anthropic: JsonOptions };
};

/** The levels a model takes, or null when its list entry does not say. */
export function effortLevels(kind: ConnectionKind, caps: ModelCaps | null): Effort[] | null {
  if (!caps) return null;
  if (kind === "openai-compatible") {
    if (caps.reasoning === false) return [];
    return caps.efforts ?? [...EFFORTS];
  }
  return caps.efforts;
}

function nearest(requested: Effort, levels: readonly Effort[]): Effort {
  const at = EFFORTS.indexOf(requested);
  let best = levels[0];
  for (const level of levels) {
    const distance = Math.abs(EFFORTS.indexOf(level) - at);
    const bestDistance = Math.abs(EFFORTS.indexOf(best) - at);
    if (distance < bestDistance || (distance === bestDistance && EFFORTS.indexOf(level) < EFFORTS.indexOf(best))) best = level;
  }
  return best;
}

/** The level a request sends: the chosen one, its nearest enabled level, or null when the model takes none. The picker moves to it too. */
export function sentEffort(requested: Effort, levels: readonly Effort[] | null): Effort | null {
  if (levels === null) return requested;
  if (levels.length === 0) return null;
  return levels.includes(requested) ? requested : nearest(requested, levels);
}

function anthropicOptions(sent: Effort | null): JsonOptions {
  const cacheControl = { type: "ephemeral" } as const;
  if (sent === null) return { cacheControl } satisfies AnthropicLanguageModelOptions;
  if (sent === "none") return { cacheControl, thinking: { type: "disabled" } } satisfies AnthropicLanguageModelOptions;
  // Current Claude models omit thinking text unless asked, which reads as a long pause. Edit reply rewrites an earlier
  // assistant turn, so a replayed thinking block can stop matching its prefix, and drop_block keeps that from failing.
  return { cacheControl, effort: sent, thinking: { type: "adaptive", display: "summarized", blockBinding: { prefixMismatchBehavior: "drop_block" } } } satisfies AnthropicLanguageModelOptions;
}

export function effortCallOptions(kind: ConnectionKind, requested: Effort, levels: Effort[] | null): { sent: Effort | null; options: EffortCallOptions } {
  const sent = sentEffort(requested, levels);
  if (kind === "anthropic") return { sent, options: { providerOptions: { anthropic: anthropicOptions(sent) } } };
  return { sent, options: sent === null ? {} : { reasoning: sent } };
}

// The AI SDK warns under "reasoning". @ai-sdk/anthropic 4.0.106 warns under these names when it lowers the effort or
// replaces the thinking setting for a model.
const EFFORT_WARNING_FEATURES = new Set(["reasoning", "providerOptions.anthropic.effort", "providerOptions.anthropic.thinking"]);

export function effortOutcome(input: {
  sent: Effort | null;
  requested: Effort;
  dropped: boolean;
  warnings: readonly { type: string; feature?: string }[];
}): EffortOutcome | null {
  if (input.sent === null) return null;
  if (input.dropped) return "ignored";
  if (input.sent !== input.requested) return "adjusted";
  if (input.warnings.some((warning) => warning.feature !== undefined && EFFORT_WARNING_FEATURES.has(warning.feature))) return "adjusted";
  return "applied";
}

const TITLE_TOKENS = 24;
const TITLE_TOKENS_WITH_THINKING = 2048;

/** A title needs no thinking. A Claude model that cannot turn it off gets its lowest level, and room for it in the cap. */
export function titleCallOptions(kind: ConnectionKind, levels: Effort[] | null): { options: EffortCallOptions; maxOutputTokens: number } {
  if (kind === "openai-compatible") return { options: {}, maxOutputTokens: TITLE_TOKENS };
  const lowest: Effort | null = levels === null ? "low" : levels.includes("none") ? "none" : (levels[0] ?? null);
  return { options: { providerOptions: { anthropic: anthropicOptions(lowest) } }, maxOutputTokens: lowest === "none" ? TITLE_TOKENS : TITLE_TOKENS_WITH_THINKING };
}

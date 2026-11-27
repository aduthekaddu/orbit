import { z } from "zod";
import type { ConnectionKind, ModelDefaults, PublicConnection } from "./connections";
import { EFFORT_LABELS, EFFORT_OUTCOMES, EFFORTS, effortLevels, sentEffort, type Effort, type EffortOutcome } from "./effort";
import type { ListedModel, ModelCaps } from "./model-list";
import type { ModelChoice } from "./model-choice";

type ModelOption = Pick<ListedModel, "id">;

export const CUSTOM_OPTION = -1;
export const NO_OPTION = -2;

export function modelOptionIndex(options: ModelOption[], model: string) {
  return options.findIndex((option) => option.id === model);
}

export function selectedOptionIndex(options: ModelOption[], model: string, customMode: boolean) {
  if (customMode) return CUSTOM_OPTION;
  if (model === "") return NO_OPTION;
  return modelOptionIndex(options, model);
}

export function showsModelInput(options: ModelOption[], model: string, customMode: boolean) {
  return options.length === 0 || selectedOptionIndex(options, model, customMode) === CUSTOM_OPTION;
}

/** What `GET /api/connections/[id]/models` answers. */
export type ModelList = { models: ListedModel[]; hidden: string[] };

const caps: z.ZodType<ModelCaps> = z.object({
  images: z.boolean().nullable(),
  tools: z.boolean().nullable(),
  reasoning: z.boolean().nullable(),
  contextTokens: z.number().nullable(),
  efforts: z.array(z.enum(EFFORTS)).nullable(),
  anthropic: z.object({ adaptiveThinking: z.boolean().nullable(), canDisableThinking: z.boolean().nullable() }).optional(),
});

export const modelListBody: z.ZodType<ModelList> = z.object({
  models: z.array(z.object({ id: z.string(), label: z.string(), caps })),
  hidden: z.array(z.string()),
});

export const publicConnectionBody: z.ZodType<PublicConnection> = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("openai-compatible"), label: z.string(), baseUrl: z.string(), createdAt: z.coerce.date(), keySet: z.literal(true), keyReadable: z.boolean() }),
  z.object({ id: z.string(), kind: z.literal("anthropic"), label: z.string(), createdAt: z.coerce.date(), keySet: z.literal(true), keyReadable: z.boolean() }),
]);

export const modelDefaultsBody: z.ZodType<ModelDefaults> = z.object({
  connectionId: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.enum(EFFORTS).nullable(),
});

/** A list longer than this gets a search field. */
export const SEARCH_AFTER_ROWS = 8;

/** The models whose id or name contains the search text. */
export function searchModels(models: ListedModel[], query: string): ListedModel[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return models;
  return models.filter((model) => model.id.toLowerCase().includes(needle) || model.label.toLowerCase().includes(needle));
}

/** The models a picker shows: every one the user has not hidden that matches the search. */
export function shownModels(list: ModelList, query = ""): ListedModel[] {
  const hidden = new Set(list.hidden);
  return searchModels(list.models.filter((model) => !hidden.has(model.id)), query);
}

/** Context size in tokens the way providers say it: 200K, 1M. */
export function contextLabel(tokens: number) {
  const thousands = Math.round(tokens / 1000);
  if (thousands < 1000) return `${Math.max(thousands, 1)}K`;
  return `${Number((tokens / 1_000_000).toFixed(1))}M`;
}

/** The effort levels a listed model takes, or null when the list has not said. */
export function modelLevels(kind: ConnectionKind, list: ModelList | null, modelId: string): Effort[] | null {
  const model = list?.models.find((item) => item.id === modelId);
  return effortLevels(kind, model?.caps ?? null);
}

/** Switching models keeps the effort when the new model takes it, else moves to the nearest level it takes. */
export function switchModel(effort: Effort, connectionId: string, model: string, levels: Effort[] | null): ModelChoice {
  return { connectionId, model, effort: sentEffort(effort, levels) ?? effort };
}

/** `model · Effort`, with the outcome when the provider adjusted or ignored it, or the model alone with no effort. */
export function choiceLabel(model: string, effort: Effort | null, outcome: EffortOutcome | null = null) {
  if (effort === null) return model;
  const marked = outcome === "adjusted" || outcome === "ignored" ? ` (${outcome})` : "";
  return `${model} · ${EFFORT_LABELS[effort]}${marked}`;
}

const replyRecord = z.object({
  model: z.string().min(1),
  effort: z.enum(EFFORTS).nullable(),
  effortOutcome: z.enum(EFFORT_OUTCOMES).nullable(),
});

/** The label for a reply's record, from the live stream or the saved message, or null when there is none. */
export function replyLabel(record: unknown): string | null {
  const parsed = replyRecord.safeParse(record);
  return parsed.success ? choiceLabel(parsed.data.model, parsed.data.effort, parsed.data.effortOutcome) : null;
}

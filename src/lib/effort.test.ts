import assert from "node:assert/strict";
import test from "node:test";
import { EFFORT_LABELS, EFFORTS, effortCallOptions, effortLevels, effortOutcome, type Effort } from "./effort";
import type { ModelCaps } from "./model-list";

const ALL: Effort[] = ["none", "low", "medium", "high", "xhigh", "max"];
// The levels the Models API lists for claude-opus-5-5, which cannot turn thinking off.
const OPUS_LEVELS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const ADAPTIVE = { type: "adaptive", display: "summarized", blockBinding: { prefixMismatchBehavior: "drop_block" } };

function caps(over: Partial<ModelCaps>): ModelCaps {
  return { images: null, tools: null, reasoning: null, contextTokens: null, efforts: null, ...over };
}

function anthropicOptions(result: ReturnType<typeof effortCallOptions>) {
  const options = result.options as { providerOptions?: { anthropic?: Record<string, unknown> } };
  return options.providerOptions?.anthropic ?? {};
}

test("the six efforts keep their order and their labels", () => {
  assert.deepEqual([...EFFORTS], ALL);
  assert.deepEqual(EFFORT_LABELS, { none: "None", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" });
});

test("an OpenAI-compatible model that says it cannot reason takes no effort", () => {
  assert.deepEqual(effortLevels("openai-compatible", caps({ reasoning: false })), []);
});

test("an OpenAI-compatible model takes the levels its list names, or all six when the list does not say", () => {
  assert.deepEqual(effortLevels("openai-compatible", caps({ reasoning: true, efforts: ["low", "high"] })), ["low", "high"]);
  assert.deepEqual(effortLevels("openai-compatible", caps({ reasoning: null })), ALL);
  assert.deepEqual(effortLevels("openai-compatible", caps({ reasoning: true })), ALL);
});

test("with no caps the levels are unknown", () => {
  assert.equal(effortLevels("openai-compatible", null), null);
  assert.equal(effortLevels("anthropic", null), null);
});

test("None is disabled for an Anthropic model whose caps say thinking cannot be turned off", () => {
  const levels = effortLevels("anthropic", caps({ reasoning: true, efforts: OPUS_LEVELS }));
  assert.ok(levels, "known caps give known levels");
  assert.equal(levels.includes("none"), false);
  assert.deepEqual(levels, OPUS_LEVELS);
});

test("an OpenAI-compatible call sends an enabled level as reasoning", () => {
  assert.deepEqual(effortCallOptions("openai-compatible", "high", ALL), { sent: "high", options: { reasoning: "high" } });
});

test("a model that takes no effort gets none sent", () => {
  const openai = effortCallOptions("openai-compatible", "high", []);
  assert.equal(openai.sent, null);
  assert.equal("reasoning" in openai.options, false, JSON.stringify(openai.options));
  const anthropic = effortCallOptions("anthropic", "high", []);
  assert.equal(anthropic.sent, null);
  assert.equal("effort" in anthropicOptions(anthropic), false, JSON.stringify(anthropic.options));
});

test("unknown levels send the requested effort and let the provider decide", () => {
  assert.deepEqual(effortCallOptions("openai-compatible", "xhigh", null), { sent: "xhigh", options: { reasoning: "xhigh" } });
  const anthropic = effortCallOptions("anthropic", "max", null);
  assert.equal(anthropic.sent, "max");
  assert.equal(anthropicOptions(anthropic).effort, "max");
});

test("a level the model does not take sends the nearest one it does, and a tie goes to the lower level", () => {
  const cases: [Effort, Effort[], Effort][] = [
    ["medium", ["low", "high"], "low"],
    ["max", ["low", "medium", "high"], "high"],
    ["none", ["medium", "xhigh"], "medium"],
    ["xhigh", ["none", "max"], "max"],
    ["none", OPUS_LEVELS, "low"],
  ];
  for (const [requested, levels, nearest] of cases) {
    assert.deepEqual(effortCallOptions("openai-compatible", requested, levels), { sent: nearest, options: { reasoning: nearest } }, `${requested} in ${levels}`);
  }
  const anthropic = effortCallOptions("anthropic", "none", OPUS_LEVELS);
  assert.equal(anthropic.sent, "low");
  assert.equal(anthropicOptions(anthropic).effort, "low");
  assert.deepEqual(anthropicOptions(anthropic).thinking, ADAPTIVE);
});

test("an Anthropic call at High sends the effort, adaptive summarized thinking that drops a mismatched block, and prompt caching", () => {
  const result = effortCallOptions("anthropic", "high", OPUS_LEVELS);
  assert.equal(result.sent, "high");
  const anthropic = anthropicOptions(result);
  assert.equal(anthropic.effort, "high");
  assert.deepEqual(anthropic.thinking, ADAPTIVE);
  assert.deepEqual(anthropic.cacheControl, { type: "ephemeral" });
});

test("an Anthropic call at None turns thinking off and still caches the prompt", () => {
  const result = effortCallOptions("anthropic", "none", ALL);
  assert.equal(result.sent, "none");
  const anthropic = anthropicOptions(result);
  assert.deepEqual(anthropic.thinking, { type: "disabled" });
  assert.equal("effort" in anthropic, false, JSON.stringify(anthropic));
  assert.deepEqual(anthropic.cacheControl, { type: "ephemeral" });
});

test("an Anthropic call that sends no effort still caches the prompt", () => {
  assert.deepEqual(anthropicOptions(effortCallOptions("anthropic", "high", [])).cacheControl, { type: "ephemeral" });
});

test("no effort sent gives no outcome", () => {
  assert.equal(effortOutcome({ sent: null, requested: "high", dropped: false, warnings: [] }), null);
  assert.equal(effortOutcome({ sent: null, requested: "high", dropped: false, warnings: [{ type: "unsupported", feature: "reasoning" }] }), null);
});

test("an effort the fallback removed is ignored", () => {
  assert.equal(effortOutcome({ sent: "high", requested: "high", dropped: true, warnings: [] }), "ignored");
  assert.equal(effortOutcome({ sent: "high", requested: "high", dropped: true, warnings: [{ type: "unsupported", feature: "reasoning" }] }), "ignored");
});

test("a reasoning warning from the provider marks the effort adjusted", () => {
  assert.equal(effortOutcome({ sent: "xhigh", requested: "xhigh", dropped: false, warnings: [{ type: "unsupported", feature: "reasoning" }] }), "adjusted");
});

// @ai-sdk/anthropic 4.0.106 lowers or removes these itself and warns under these feature names, not "reasoning".
test("an Anthropic warning that it changed the effort or the thinking marks the effort adjusted", () => {
  for (const feature of ["providerOptions.anthropic.effort", "providerOptions.anthropic.thinking"]) {
    assert.equal(effortOutcome({ sent: "max", requested: "max", dropped: false, warnings: [{ type: "unsupported", feature }] }), "adjusted", feature);
  }
});

test("an effort Orbit moved to the nearest level the model takes is adjusted", () => {
  assert.equal(effortOutcome({ sent: "high", requested: "max", dropped: false, warnings: [] }), "adjusted");
});

test("an effort sent as requested, with no warning about it, is applied", () => {
  assert.equal(effortOutcome({ sent: "high", requested: "high", dropped: false, warnings: [] }), "applied");
  assert.equal(effortOutcome({ sent: "high", requested: "high", dropped: false, warnings: [{ type: "unsupported", feature: "topK" }] }), "applied");
});

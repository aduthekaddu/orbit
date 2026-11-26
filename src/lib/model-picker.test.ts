import assert from "node:assert/strict";
import test from "node:test";
import type { ListedModel } from "./model-list";
import { CUSTOM_OPTION, NO_OPTION, choiceLabel, contextLabel, modelLevels, modelOptionIndex, replyLabel, selectedOptionIndex, shownModels, showsModelInput, switchModel } from "./model-picker";

const models = [{ id: "__custom__" }, { id: "gpt-4" }];

test("a listed model id is addressed by its position", () => {
  assert.equal(modelOptionIndex(models, "__custom__"), 0);
  assert.equal(selectedOptionIndex(models, "__custom__", false), 0);
});

test("the custom field stays while its text matches a listed model", () => {
  assert.equal(showsModelInput(models, "gpt-4", true), true);
});

test("a listed model hides the custom field", () => {
  assert.equal(showsModelInput(models, "gpt-4", false), false);
});

test("an id outside the list uses the custom field", () => {
  assert.equal(selectedOptionIndex(models, "gpt-4-custom", false), CUSTOM_OPTION);
  assert.equal(showsModelInput(models, "gpt-4-custom", false), true);
});

test("an empty list always uses the custom field", () => {
  assert.equal(showsModelInput([], "gpt-4", false), true);
});

test("a loaded list with no saved model selects nothing and hides the custom field", () => {
  assert.equal(selectedOptionIndex(models, "", false), NO_OPTION);
  assert.equal(showsModelInput(models, "", false), false);
});

test("choosing Custom with no model shows the empty custom field", () => {
  assert.equal(selectedOptionIndex(models, "", true), CUSTOM_OPTION);
  assert.equal(showsModelInput(models, "", true), true);
});

const caps = (overrides: Partial<ListedModel["caps"]> = {}): ListedModel["caps"] => ({ images: null, tools: null, reasoning: null, contextTokens: null, efforts: null, ...overrides });
const opus: ListedModel = { id: "claude-opus-5-5", label: "Claude Opus 5.5", caps: caps({ efforts: ["low", "medium", "high", "xhigh", "max"] }) };
const haiku: ListedModel = { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", caps: caps({ efforts: [] }) };
const reasoner: ListedModel = { id: "mock-reasoner", label: "Mock Reasoner", caps: caps({ reasoning: true }) };

test("a list shows every model the user has not hidden, and search matches the id or the name", () => {
  const list = { models: [opus, haiku, reasoner], hidden: ["claude-haiku-4-5"] };
  assert.deepEqual(shownModels(list).map((model) => model.id), ["claude-opus-5-5", "mock-reasoner"]);
  assert.deepEqual(shownModels(list, " OPUS ").map((model) => model.id), ["claude-opus-5-5"]);
  assert.deepEqual(shownModels(list, "mock reasoner").map((model) => model.id), ["mock-reasoner"]);
  assert.deepEqual(shownModels(list, "haiku"), []);
});

test("context sizes read the way providers write them", () => {
  assert.equal(contextLabel(200_000), "200K");
  assert.equal(contextLabel(131_072), "131K");
  assert.equal(contextLabel(1_000_000), "1M");
  assert.equal(contextLabel(1_048_576), "1M");
  assert.equal(contextLabel(1_500_000), "1.5M");
  assert.equal(contextLabel(999_800), "1M");
  assert.equal(contextLabel(300), "1K");
});

test("switching to a model that does not take the effort moves to the nearest level it takes", () => {
  assert.deepEqual(switchModel("none", "c1", opus.id, opus.caps.efforts), { connectionId: "c1", model: opus.id, effort: "low" });
  assert.deepEqual(switchModel("high", "c1", opus.id, opus.caps.efforts), { connectionId: "c1", model: opus.id, effort: "high" });
  assert.equal(switchModel("max", "c1", "m", ["low", "medium"]).effort, "medium");
});

test("switching to a model with no levels or unknown levels keeps the effort", () => {
  assert.equal(switchModel("max", "c1", haiku.id, []).effort, "max");
  assert.equal(switchModel("xhigh", "c1", "typed-model", null).effort, "xhigh");
});

test("a model's levels come from its list entry, and a model the list lacks has unknown levels", () => {
  const list = { models: [opus, haiku, reasoner], hidden: [] };
  assert.deepEqual(modelLevels("anthropic", list, opus.id), opus.caps.efforts);
  assert.deepEqual(modelLevels("anthropic", list, haiku.id), []);
  assert.equal(modelLevels("anthropic", list, "claude-next"), null);
  assert.equal(modelLevels("anthropic", null, opus.id), null);
});

test("a choice reads model and effort, and the model alone without an effort", () => {
  assert.equal(choiceLabel("claude-opus-5-5", "high"), "claude-opus-5-5 · High");
  assert.equal(choiceLabel("gpt-5", "xhigh"), "gpt-5 · Extra high");
  assert.equal(choiceLabel("claude-haiku-4-5", null), "claude-haiku-4-5");
});

test("a reply label marks an adjusted or ignored effort and reads a stored or streamed record", () => {
  assert.equal(replyLabel({ connectionId: "c1", model: "claude-opus-5-5", effort: "high", effortOutcome: "applied" }), "claude-opus-5-5 · High");
  assert.equal(replyLabel({ connectionId: null, model: "m", effort: "high", effortOutcome: "adjusted" }), "m · High (adjusted)");
  assert.equal(replyLabel({ connectionId: "c1", model: "m", effort: "xhigh", effortOutcome: "ignored" }), "m · Extra high (ignored)");
  assert.equal(replyLabel({ connectionId: "c1", model: "mock-genui", effort: null, effortOutcome: null }), "mock-genui");
  assert.equal(replyLabel({ connectionId: "c1", model: "m", effort: "high", effortOutcome: null }), "m · High");
});

test("a message without a usable record has no reply label", () => {
  assert.equal(replyLabel(undefined), null);
  assert.equal(replyLabel({ model: "", effort: null, effortOutcome: null }), null);
  assert.equal(replyLabel({ model: "m", effort: "turbo", effortOutcome: null }), null);
});

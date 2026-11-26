import assert from "node:assert/strict";
import test from "node:test";
import { CUSTOM_OPTION, NO_OPTION, modelOptionIndex, selectedOptionIndex, showsModelInput } from "./model-picker";

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

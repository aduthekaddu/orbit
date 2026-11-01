import assert from "node:assert/strict";
import test from "node:test";
import { appliedSave, type SettingsSnapshot } from "./settings-form";

const submitted: SettingsSnapshot = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-old",
  model: "gpt-4",
  effort: "medium",
};

test("unchanged values clear the key and report saved", () => {
  assert.deepEqual(appliedSave(submitted, { ...submitted }), {
    clearKey: true,
    applyKeySet: true,
    saved: true,
  });
});

test("a key typed during the save stays in the field", () => {
  assert.deepEqual(appliedSave(submitted, { ...submitted, apiKey: "sk-new" }), {
    clearKey: false,
    applyKeySet: true,
    saved: false,
  });
});

test("a base URL changed during the save keeps the previous keySet", () => {
  assert.deepEqual(appliedSave(submitted, { ...submitted, baseUrl: "https://other.example.com/v1" }), {
    clearKey: true,
    applyKeySet: false,
    saved: false,
  });
});

test("a model changed during the save is not reported as saved", () => {
  assert.deepEqual(appliedSave(submitted, { ...submitted, model: "gpt-5" }), {
    clearKey: true,
    applyKeySet: true,
    saved: false,
  });
});

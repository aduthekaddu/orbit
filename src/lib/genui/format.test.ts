import assert from "node:assert/strict";
import test from "node:test";
import { TABLE_ROW_CAP, changeToneOf, formatChange, formatValue, numericColumns } from "./format";

test("numbers group from five digits, so years and short ids keep no comma", () => {
  assert.equal(formatValue(42000), "42,000");
  assert.equal(formatValue(1234567.891), "1,234,567.89");
  assert.equal(formatValue(2026), "2026");
  assert.equal(formatValue(1234), "1234");
  assert.equal(formatValue(-0.5), "-0.5");
});

test("a string prints as the model wrote it", () => {
  assert.equal(formatValue("42000"), "42000");
  assert.equal(formatValue("EU"), "EU");
});

test("a change carries its sign", () => {
  assert.equal(formatChange(12, "percent"), "+12%");
  assert.equal(formatChange(-3.5, "number"), "-3.5");
  assert.equal(formatChange(-8, "percent"), "-8%");
  assert.equal(formatChange(0, "percent"), "0%");
  assert.equal(formatChange(25000, "number"), "+25,000");
});

test("a change's tone follows its sign unless the model names one", () => {
  assert.equal(changeToneOf(12), "positive");
  assert.equal(changeToneOf(-3.5), "negative");
  assert.equal(changeToneOf(0), "neutral");
  assert.equal(changeToneOf(-8, "positive"), "positive");
  assert.equal(changeToneOf(5, "negative"), "negative");
  assert.equal(changeToneOf(5, null), "positive");
});

test("a column is numeric when every filled cell is a number or reads as one", () => {
  const rows = [
    ["Ada", "Engineer", 98],
    ["Grace", "Admiral", 91],
    ["Linus", "Maintainer", 87],
  ];
  assert.deepEqual(numericColumns(rows), [false, false, true]);
  assert.deepEqual(numericColumns([["$1,200", "12%", "", "2026-10-01"], ["-3.5", "", "", "2026-10-02"]]), [true, true, false, false]);
  assert.deepEqual(numericColumns([]), []);
});

test("tables open at twelve rows", () => {
  assert.equal(TABLE_ROW_CAP, 12);
});

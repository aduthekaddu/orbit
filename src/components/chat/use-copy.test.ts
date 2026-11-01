import assert from "node:assert/strict";
import test from "node:test";
import { copyText } from "./use-copy";

test("copyText reports true when the clipboard accepts the text", async () => {
  const written: string[] = [];
  const clipboard = {
    writeText: async (text: string) => {
      written.push(text);
    },
  };

  assert.equal(await copyText(clipboard, "npm test"), true);
  assert.deepEqual(written, ["npm test"]);
});

test("copyText reports false when the clipboard rejects and does not reject itself", async () => {
  const clipboard = {
    writeText: () => Promise.reject(new Error("clipboard-write denied")),
  };

  await assert.doesNotReject(copyText(clipboard, "npm test"));
  assert.equal(await copyText(clipboard, "npm test"), false);
});

test("copyText reports false when the clipboard is missing", async () => {
  assert.equal(await copyText(undefined, "npm test"), false);
});

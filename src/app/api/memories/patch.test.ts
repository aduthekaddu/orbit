import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";
import { LOCAL_AUTH_URL } from "@/lib/auth-origins";
import { getDb, type OrbitDb } from "@/lib/db";
import * as store from "@/lib/memory/store";
import { dataDirectory } from "@/lib/paths";

let db: OrbitDb | undefined;
let patch: typeof import("./[id]/route").PATCH;
let hooks: ReturnType<typeof registerHooks> | undefined;

before(async () => {
  const sessionStub = path.join(dataDirectory(), "memory-session.cjs");
  fs.writeFileSync(sessionStub, 'exports.getSession = async () => ({ user: { id: "memory-editor" } });\n');
  const url = pathToFileURL(sessionStub).href;
  hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@/lib/session") return { url, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  db = getDb();
  ({ PATCH: patch } = await import("./[id]/route"));
});

after(() => {
  hooks?.deregister();
  db?.$client.close();
});

for (const { name, text, source, kind } of [
  { name: "change the kind", text: "I ride a blue bike", source: "tool", kind: "preference" },
  { name: "save identical text", text: "I ride a red bike", source: "dream", kind: "fact" },
] as const) {
  test(`memory attribution survives a PATCH to ${name}`, async () => {
    const { id } = store.saveMemory({ text, kind: "fact", source });
    const request = new Request(new URL(`/api/memories/${id}`, LOCAL_AUTH_URL), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, kind }),
    });
    const response = await patch(request, { params: Promise.resolve({ id }) });
    assert.equal(response.status, 200);
    assert.partialDeepStrictEqual(await response.json(), { memory: { id, kind, text } });
    assert.equal(store.getMemory(id)?.source, source);
  });
}

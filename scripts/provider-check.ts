import {
  credentialsForModelList,
  listModels,
  MODEL_META_TTL_MS,
  modelAllowsReasoning,
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_MODELS_URL,
} from "../src/lib/provider";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function main() {
  const savedKey = "saved-secret";
  const savedBase = "https://opencode.ai/inference/go/openai/v1";

  const mismatched = credentialsForModelList({
    requestedBaseUrl: "https://evil.example/v1",
    requestedApiKey: "  ",
    savedBaseUrl: savedBase,
    savedApiKey: savedKey,
  });
  if (mismatched) fail("saved key reused for a different base URL");

  const slashed = credentialsForModelList({
    requestedBaseUrl: `${savedBase}/`,
    savedBaseUrl: savedBase,
    savedApiKey: savedKey,
  });
  if (slashed?.apiKey !== savedKey || slashed.baseUrl !== `${savedBase}/`) fail("same base URL did not reuse the saved key");

  const typed = credentialsForModelList({
    requestedBaseUrl: "https://evil.example/v1",
    requestedApiKey: "typed-key",
    savedBaseUrl: savedBase,
    savedApiKey: savedKey,
  });
  if (typed?.apiKey !== "typed-key" || typed.baseUrl !== "https://evil.example/v1") fail("typed key was not kept for the edited base URL");

  const stored = credentialsForModelList({
    savedBaseUrl: savedBase,
    savedApiKey: savedKey,
  });
  if (stored?.apiKey !== savedKey || stored.baseUrl !== savedBase) fail("omitted base URL did not use the saved provider");
  console.log("credentials: saved key stays on its base URL");

  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const url = String(input);
    if (url === "https://cache.example/v1/models") {
      return json([
        { id: "plain", capabilities: { reasoning: false } },
        { id: "thinker", capabilities: { reasoning: true } },
      ]);
    }
    return json({ error: "unexpected" }, 500);
  };

  const coldStarted = Date.now();
  const cold = modelAllowsReasoning("https://cache.example/v1", "plain");
  const coldWaited = Date.now() - coldStarted;
  if (calls !== 0 || cold !== true || coldWaited > 50) {
    fail(`cold chat discovered models calls=${calls} allowed=${cold} waitedMs=${coldWaited}`);
  }

  const listed = await listModels("https://cache.example/v1/", savedKey);
  if (listed.map((model) => model.id).join(",") !== "plain,thinker") fail("model list did not return the provider models");
  const afterList = calls;
  const warmStarted = Date.now();
  const plain = modelAllowsReasoning("https://cache.example/v1", "plain");
  const thinker = modelAllowsReasoning("https://cache.example/v1", "thinker");
  const missing = modelAllowsReasoning("https://cache.example/v1", "missing");
  const warmWaited = Date.now() - warmStarted;
  if (plain !== false || thinker !== true || missing !== true) {
    fail(`cached reasoning plain=${plain} thinker=${thinker} missing=${missing}`);
  }
  if (calls !== afterList || warmWaited > 50) {
    fail(`warm chat discovered models calls=${calls} waitedMs=${warmWaited}`);
  }
  const expired = modelAllowsReasoning("https://cache.example/v1", "plain", Date.now() + MODEL_META_TTL_MS + 1000);
  if (expired !== true || calls !== afterList) fail("expired metadata refreshed on the chat path");
  console.log("model metadata: chat does not discover");

  const seen: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    seen.push(url);
    const authorization = new Headers(init?.headers).get("authorization");
    if (authorization !== `Bearer ${savedKey}`) fail("model list sent an unexpected authorization header");
    if (url === `${OPENCODE_GO_BASE_URL}/models`) throw new Error("primary down");
    if (url === OPENCODE_GO_MODELS_URL) return json([{ id: "from-fallback", capabilities: { reasoning: false } }]);
    return json({ error: "unexpected" }, 500);
  };

  let fallback: Awaited<ReturnType<typeof listModels>>;
  try {
    fallback = await listModels(OPENCODE_GO_BASE_URL, savedKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : "throw";
    fail(`primary throw skipped fallback: ${message}`);
  }
  if (fallback.map((model) => model.id).join(",") !== "from-fallback") fail("fallback models missing");
  if (!seen.includes(`${OPENCODE_GO_BASE_URL}/models`) || !seen.includes(OPENCODE_GO_MODELS_URL)) {
    fail(`fallback urls missing ${seen.join(" ")}`);
  }
  if (modelAllowsReasoning(OPENCODE_GO_BASE_URL, "from-fallback") !== false) fail("fallback metadata was not cached");
  console.log("primary throw: opencode fallback ran");

  globalThis.fetch = async () => {
    throw new Error("down");
  };
  try {
    const empty = await listModels("https://other.example/v1", savedKey);
    if (empty.length !== 0) fail("non-opencode failure returned models");
  } catch {
    fail("non-opencode primary throw escaped listModels");
  }
  console.log("provider check passed");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "provider check failed";
  fail(message);
});

// Points an Orbit account at an OpenAI-compatible provider: reuses the account's connection with this
// base URL or adds one, then makes it the default model. `send(path, { method, json })` makes a
// signed-in request and resolves to `{ status, text }`.
export async function connectProvider(send, { label = "Provider", baseUrl, apiKey, model, effort = "low" }) {
  const read = async (path, init, expected) => {
    const response = await send(path, init);
    if (apiKey && response.text.includes(apiKey)) throw new Error(`${init.method ?? "GET"} ${path} returned the API key`);
    if (response.status !== expected) throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status} ${errorOf(response.text)}`);
    return JSON.parse(response.text);
  };
  const wanted = trimSlashes(baseUrl);
  const listed = await read("/api/connections", {}, 200);
  const connection =
    listed.find((item) => item.kind === "openai-compatible" && trimSlashes(item.baseUrl) === wanted) ??
    (await read("/api/connections", { method: "POST", json: { kind: "openai-compatible", label, baseUrl, apiKey } }, 201));
  if (connection.keySet !== true || "apiKey" in connection) throw new Error("the connection response is not keySet without a key");
  const defaults = await read("/api/preferences/model", { method: "PUT", json: { connectionId: connection.id, model, effort } }, 200);
  return { connection, defaults };
}

function trimSlashes(url) {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

function errorOf(text) {
  try {
    return JSON.parse(text).error ?? "";
  } catch {
    return "";
  }
}

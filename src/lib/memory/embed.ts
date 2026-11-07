import { z } from "zod";
import { readEnv } from "../env";
import { listUnembedded, writeVectors } from "./store";

export const EMBED_MODEL = "nomic-embed-text";
export const EMBED_DIM = 768;
const TIMEOUT_MS = 5_000;
export const QUERY_EMBED_TIMEOUT_MS = 1_000;
const STATUS_TTL_MS = 15_000;
const BATCH = 32;

export type EmbedKind = "query" | "document";

const TASK_PREFIX: Record<EmbedKind, string> = { query: "", document: "" };

const responseSchema = z.object({
  embeddings: z.array(z.array(z.number())),
});

export type EmbedResult = { ok: true; vectors: number[][] } | { ok: false; error: string };
export type EmbedPendingResult = { ok: true; embedded: number } | { ok: false; error: string; embedded: number };

export function ollamaBaseUrl(): string {
  return (readEnv("ORBIT_OLLAMA_URL") ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
}

function embedError(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "Ollama timed out";
  return "Ollama is unreachable";
}

export async function embed(texts: string[], kind: EmbedKind, timeoutMs = TIMEOUT_MS): Promise<EmbedResult> {
  if (texts.length === 0) return { ok: true, vectors: [] };
  let response: Response;
  try {
    response = await fetch(`${ollamaBaseUrl()}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts.map((text) => TASK_PREFIX[kind] + text) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, error: embedError(error) };
  }
  if (!response.ok) return { ok: false, error: `Ollama returned HTTP ${response.status}` };
  const json: unknown = await response.json().catch(() => null);
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success || parsed.data.embeddings.length !== texts.length) {
    return { ok: false, error: "Ollama returned a vector that is not 768 numbers" };
  }
  for (const vector of parsed.data.embeddings) {
    if (vector.length !== EMBED_DIM || vector.some((value) => !Number.isFinite(value))) {
      return { ok: false, error: "Ollama returned a vector that is not 768 numbers" };
    }
  }
  return { ok: true, vectors: parsed.data.embeddings };
}

async function fillPending(): Promise<EmbedPendingResult> {
  const rows = listUnembedded();
  let embedded = 0;
  for (let index = 0; index < rows.length; index += BATCH) {
    const batch = rows.slice(index, index + BATCH);
    const result = await embed(batch.map((row) => row.text), "document");
    if (!result.ok) return { ok: false, error: result.error, embedded };
    writeVectors(batch.map((row, offset) => ({ rowid: row.rowid, text: row.text, vector: result.vectors[offset] ?? [] })));
    embedded += batch.length;
  }
  return { ok: true, embedded };
}

let chain: Promise<EmbedPendingResult> = Promise.resolve({ ok: true, embedded: 0 });

export function embedPending(): Promise<EmbedPendingResult> {
  const run = chain.then(() => fillPending(), () => fillPending());
  chain = run.then(
    (result) => result,
    () => ({ ok: false, error: "Ollama is unreachable", embedded: 0 }),
  );
  return run;
}

type OllamaStatus = { ok: true } | { ok: false; error: string };

let statusCache: { url: string; at: number; status: OllamaStatus } | null = null;
let statusInflight: { url: string; promise: Promise<OllamaStatus> } | null = null;

function rememberStatus(status: OllamaStatus) {
  if (status.ok) {
    if (statusCache?.url === ollamaBaseUrl()) statusCache = null;
    return;
  }
  statusCache = { url: ollamaBaseUrl(), at: Date.now(), status };
}

function freshStatus(): OllamaStatus | null {
  if (!statusCache || statusCache.url !== ollamaBaseUrl()) return null;
  if (Date.now() - statusCache.at >= STATUS_TTL_MS) return null;
  return statusCache.status;
}

export function ollamaStatus(timeoutMs = QUERY_EMBED_TIMEOUT_MS): Promise<OllamaStatus> {
  const cached = freshStatus();
  if (cached) return Promise.resolve(cached);
  const url = ollamaBaseUrl();
  if (statusInflight?.url === url) return statusInflight.promise;
  const promise = embed(["orbit"], "query", timeoutMs).then((result) => {
    const status: OllamaStatus = result.ok ? { ok: true } : { ok: false, error: result.error };
    rememberStatus(status);
    if (statusInflight?.promise === promise) statusInflight = null;
    return status;
  });
  statusInflight = { url, promise };
  return promise;
}

export async function embedQuery(text: string): Promise<EmbedResult> {
  const cached = freshStatus();
  if (cached && !cached.ok) return cached;
  const result = await embed([text], "query", QUERY_EMBED_TIMEOUT_MS);
  if (!result.ok) rememberStatus({ ok: false, error: result.error });
  else if (result.vectors[0]) rememberStatus({ ok: true });
  return result;
}

export async function memoryEmbeddings(): Promise<OllamaStatus> {
  const status = await ollamaStatus();
  if (!status.ok) return status;
  const filled = await embedPending();
  if (!filled.ok) {
    const failed = { ok: false as const, error: filled.error };
    rememberStatus(failed);
    return failed;
  }
  return { ok: true };
}

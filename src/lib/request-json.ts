import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

// `handler` means the answer arrived but onOk threw on it.
export type RequestFailure =
  | { kind: "network" }
  | { kind: "http"; status: number; error: string | null }
  | { kind: "invalid" }
  | { kind: "handler" };

export type RequestHandlers<T> = {
  parse: z.ZodType<T>;
  onOk: (data: T) => void;
  onFailed: (failure: RequestFailure) => void;
};

type Outcome<T> = { ok: true; data: T } | { ok: false; failure: RequestFailure };

const errorBody = z.object({ error: z.string() });
const NOT_JSON = Symbol("not JSON");

function readBody(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

function parseOk<T>(parse: z.ZodType<T>, body: unknown): Outcome<T> {
  if (body === NOT_JSON) return { ok: false, failure: { kind: "invalid" } };
  try {
    const parsed = parse.safeParse(body);
    if (parsed.success) return { ok: true, data: parsed.data };
  } catch (error) {
    console.error(error);
  }
  return { ok: false, failure: { kind: "invalid" } };
}

async function settle<T>(input: string, init: RequestInit, parse: z.ZodType<T>): Promise<Outcome<T>> {
  let text: string;
  let response: Response;
  try {
    response = await fetch(input, init);
    text = await response.text();
  } catch {
    return { ok: false, failure: { kind: "network" } };
  }
  const body = readBody(text);
  if (!response.ok) return { ok: false, failure: { kind: "http", status: response.status, error: errorBody.safeParse(body).data?.error ?? null } };
  return parseOk(parse, body);
}

// Reports a handler's own bug in the console, because a handler that throws, or an async one that rejects, must not make requestJson reject.
async function reportThrow(run: () => void): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    console.error(error);
    return true;
  }
}

// The only way browser code sends a request. It never rejects. Exactly one handler runs, unless `init.signal` aborted first:
// then a newer request or an unmount replaced this one, and neither runs. An onOk that throws hands over to onFailed.
export async function requestJson<T>(input: string, init: RequestInit, { parse, onOk, onFailed }: RequestHandlers<T>): Promise<void> {
  const outcome = await settle(input, init, parse);
  if (init.signal?.aborted) return;
  if (!outcome.ok) await reportThrow(() => onFailed(outcome.failure));
  else if (await reportThrow(() => onOk(outcome.data))) await reportThrow(() => onFailed({ kind: "handler" }));
}

// Each call aborts the previous signal, so an older response can never overwrite a newer one.
export function useLatestRequest() {
  const current = useRef<AbortController | null>(null);
  useEffect(() => () => current.current?.abort(), []);
  return useCallback(() => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    return controller.signal;
  }, []);
}

// Only `done` and `revalidating` hold data, so a pending or failed load cannot render as "nothing found".
export type Loaded<T> =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "failed"; failure: RequestFailure }
  | { status: "done"; data: T }
  | { status: "revalidating"; data: T };

// The state a reload starts from: an answer it already holds stays visible while it refetches.
export function nextReload<T>(current: Loaded<T>): Loaded<T> {
  return current.status === "done" || current.status === "revalidating" ? { status: "revalidating", data: current.data } : { status: "pending" };
}

export function useLoaded<T>(initial: Loaded<T>) {
  const [state, setState] = useState<Loaded<T>>(initial);
  const latest = useLatestRequest();
  const load = useCallback(
    (input: string, init: RequestInit, parse: z.ZodType<T>) => {
      const signal = latest();
      setState({ status: "pending" });
      void requestJson(input, { ...init, signal }, {
        parse,
        onOk: (data) => setState({ status: "done", data }),
        onFailed: (failure) => setState({ status: "failed", failure }),
      });
    },
    [latest],
  );
  const reload = useCallback(
    (input: string, init: RequestInit, parse: z.ZodType<T>) => {
      const signal = latest();
      setState(nextReload);
      void requestJson(input, { ...init, signal }, {
        parse,
        onOk: (data) => setState({ status: "done", data }),
        onFailed: (failure) => setState({ status: "failed", failure }),
      });
    },
    [latest],
  );
  // Aborts an in-flight load. Pass `{ status: "pending" }` to start a new search before the request is sent, so a debounce cannot show "No results".
  const reset = useCallback((next: Loaded<T> = { status: "idle" }) => {
    latest();
    setState(next);
  }, [latest]);
  return [state, load, reload, reset] as const;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

export type RequestFailure =
  | { kind: "network" }
  | { kind: "http"; status: number; error: string | null }
  | { kind: "invalid" };

export type RequestHandlers<T> = {
  parse: z.ZodType<T>;
  onOk: (data: T) => void;
  onFailed: (failure: RequestFailure) => void;
};

type Outcome<T> = { ok: true; data: T } | { ok: false; failure: RequestFailure };

const errorBody = z.object({ error: z.string() });

async function settle<T>(input: string, init: RequestInit, parse: z.ZodType<T>): Promise<Outcome<T>> {
  let text: string;
  let response: Response;
  try {
    response = await fetch(input, init);
    text = await response.text();
  } catch {
    return { ok: false, failure: { kind: "network" } };
  }
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok) return { ok: false, failure: { kind: "http", status: response.status, error: errorBody.safeParse(body).data?.error ?? null } };
  const parsed = parse.safeParse(body);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, failure: { kind: "invalid" } };
}

// The only way browser code sends a request. Exactly one handler runs, unless `init.signal` aborted first:
// then a newer request or an unmount replaced this one, and neither runs.
export async function requestJson<T>(input: string, init: RequestInit, { parse, onOk, onFailed }: RequestHandlers<T>): Promise<void> {
  const outcome = await settle(input, init, parse);
  if (init.signal?.aborted) return;
  if (outcome.ok) onOk(outcome.data);
  else onFailed(outcome.failure);
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

// Only `done` holds data, so a pending or failed load cannot render as "nothing found".
export type Loaded<T> =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "failed"; failure: RequestFailure }
  | { status: "done"; data: T };

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
  return [state, load] as const;
}

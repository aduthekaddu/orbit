"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { modelListBody, type ModelList } from "@/lib/model-picker";
import { nextReload, requestJson, type Loaded } from "@/lib/request-json";

export type ModelLists = Readonly<Record<string, Loaded<ModelList>>>;

const IDLE: Loaded<ModelList> = { status: "idle" };

export function listOf(lists: ModelLists, connectionId: string): Loaded<ModelList> {
  return lists[connectionId] ?? IDLE;
}

export function loadedList(load: Loaded<ModelList>): ModelList | null {
  return load.status === "done" || load.status === "revalidating" ? load.data : null;
}

// useLoaded holds one answer; the picker and Settings need one per connection, each with its own latest request.
// Loading a list also warms the server's caps cache, which tells the chat route the levels a model takes.
export function useModelLists() {
  const [lists, setLists] = useState<ModelLists>({});
  const requests = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const open = requests.current;
    return () => {
      for (const controller of open.values()) controller.abort();
    };
  }, []);

  const load = useCallback((connectionId: string) => {
    requests.current.get(connectionId)?.abort();
    const controller = new AbortController();
    requests.current.set(connectionId, controller);
    const settle = (next: Loaded<ModelList>) => setLists((current) => ({ ...current, [connectionId]: next }));
    setLists((current) => ({ ...current, [connectionId]: nextReload(listOf(current, connectionId)) }));
    void requestJson(`/api/connections/${encodeURIComponent(connectionId)}/models`, { signal: controller.signal }, {
      parse: modelListBody,
      onOk: (data) => settle({ status: "done", data }),
      onFailed: (failure) => settle({ status: "failed", failure }),
    });
  }, []);

  const setHidden = useCallback((connectionId: string, hidden: string[]) => {
    setLists((current) => {
      const list = listOf(current, connectionId);
      if (list.status !== "done" && list.status !== "revalidating") return current;
      return { ...current, [connectionId]: { ...list, data: { ...list.data, hidden } } };
    });
  }, []);

  return { lists, load, setHidden };
}

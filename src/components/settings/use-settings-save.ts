"use client";

import { useEffect, useReducer, useRef } from "react";
import { useRouter } from "next/navigation";
import type { ZodType } from "zod";
import { requestJson, useLatestRequest } from "@/lib/request-json";
import { idleSubmit, submitTransition } from "@/lib/submit-state";

export function useSettingsSave<Body>(url: string, method: "PUT" | "PATCH", parse: ZodType<Body>) {
  const router = useRouter();
  const latest = useLatestRequest();
  const saving = useRef(false);
  const [state, dispatch] = useReducer(submitTransition, idleSubmit);

  useEffect(() => {
    if (state.status !== "succeeded") return;
    const timer = setTimeout(() => dispatch({ type: "edit" }), 2000);
    return () => clearTimeout(timer);
  }, [state.status]);

  function save(patch: object, apply: (body: Body) => boolean | void) {
    if (saving.current) return;
    saving.current = true;
    dispatch({ type: "submit" });
    void requestJson(url, {
      method,
      signal: latest(),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }, {
      parse,
      onOk: (body) => {
        const applied = apply(body);
        saving.current = false;
        router.refresh();
        dispatch({ type: "succeed" });
        if (applied === false) dispatch({ type: "edit" });
      },
      onFailed: (failure) => {
        saving.current = false;
        dispatch({ type: "fail", error: (failure.kind === "http" && failure.error) || "Could not save" });
      },
    });
  }

  return { state, pending: state.status === "pending", save, edit: () => dispatch({ type: "edit" }) };
}

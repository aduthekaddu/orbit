import { formatSpecIssues, validateSpec, type Spec } from "@json-render/core";
import type { z } from "zod";
import { catalog } from "./catalog";

export type RenderOutcome = { ok: true; spec: Spec } | { ok: false; error: string; raw: unknown };

function issueText(error: z.ZodError, prefix: Array<string | number>) {
  return error.issues.slice(0, 8).map((issue) => {
    const path = [...prefix, ...issue.path];
    const where = path.length > 0 ? path.join(".") : "spec";
    return `${where}: ${issue.message}`;
  });
}

function tightenProps(spec: Spec): { ok: true; spec: Spec } | { ok: false; error: string } {
  const elements: Spec["elements"] = {};
  const lines: string[] = [];
  for (const [key, element] of Object.entries(spec.elements)) {
    const component = catalog.data.components[element.type as keyof typeof catalog.data.components];
    if (!component) {
      lines.push(`${key}.type: unknown component ${element.type}`);
      continue;
    }
    const parsed = component.props.safeParse(element.props);
    if (!parsed.success) {
      lines.push(...issueText(parsed.error, ["elements", key, "props"]));
      continue;
    }
    elements[key] = { ...element, props: parsed.data };
  }
  if (lines.length > 0) return { ok: false, error: lines.slice(0, 8).join("\n") };
  return { ok: true, spec: { ...spec, elements } };
}

export function parseRenderSpec(input: unknown): RenderOutcome {
  try {
    const parsed = catalog.zodSchema().safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: issueText(parsed.error, []).join("\n"), raw: input };
    }
    const tightened = tightenProps(parsed.data);
    if (!tightened.ok) return { ok: false, error: tightened.error, raw: input };
    const tree = validateSpec(tightened.spec);
    if (!tree.valid) {
      return { ok: false, error: formatSpecIssues(tree.issues), raw: input };
    }
    return { ok: true, spec: tightened.spec };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The spec could not be checked";
    return { ok: false, error: message, raw: input };
  }
}

export function assistantHasVisiblePart(parts: unknown) {
  if (!Array.isArray(parts)) return false;
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown; state?: unknown };
    if (record.type === "text" && typeof record.text === "string" && record.text.trim()) return true;
    const type = typeof record.type === "string" ? record.type : "";
    const tool = type === "dynamic-tool" || type.startsWith("tool-");
    if (tool && (record.state === "output-available" || record.state === "output-error")) return true;
  }
  return false;
}

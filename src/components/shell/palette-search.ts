import type { Loaded } from "@/lib/request-json";

// "empty" means Command.Empty may show "No results". A pending or failed search must not.
export function paletteSearchNotice(status: Loaded<unknown>["status"]): "empty" | "failed" | "none" {
  if (status === "failed") return "failed";
  if (status === "idle" || status === "done") return "empty";
  return "none";
}

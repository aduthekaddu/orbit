export function memoryWriteError(body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string" && body.error.trim()) return body.error;
  return "Could not save";
}

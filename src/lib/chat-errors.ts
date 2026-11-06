export function sanitize(message: string, secret: string) {
  if (!secret) return message;
  return message.split(secret).join("[redacted]");
}

function cleanErrorText(text: string) {
  return text.replace(/AI_[A-Za-z]+Error:\s*/g, "").trim();
}

export function streamErrorMessage(error: unknown, secret: string) {
  if (typeof error === "string") return sanitize(cleanErrorText(error), secret);
  const message = error instanceof Error ? error.message : "The model request failed";
  console.error("chat stream error", sanitize(message, secret));
  if (error instanceof Error && error.name === "AI_InvalidToolInputError") {
    return sanitize(cleanErrorText(message), secret);
  }
  return "The model request failed";
}

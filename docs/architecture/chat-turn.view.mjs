export const title = "One chat turn in Orbit";
export function state(v) {
  if (v.phase === "streaming") {
    const verb = v.kind === "send" ? "Sending" : "Regenerating";
    return v.shown ? `${verb}, text on screen` : `${verb}, waiting for text`;
  }
  if (v.phase === "failed") return "Error shown";
  return v.stored === "none" ? "Idle, no reply saved" : "Idle, reply saved";
}
export function group(v) {
  return v.phase === "streaming" ? "streaming" : v.phase === "failed" ? "failed" : "idle";
}
export const colors = { idle: "blue", streaming: "orange", failed: "pink" };
const labels = {
  YouSend: "you send a message",
  YouRegenerate: "you press regenerate",
  YouRetry: "you press retry",
  TextArrives: "text starts to stream",
  Finishes: "the model finishes",
};
export function step(action, from, to) {
  if (action === "Interrupt") return to.phase === "failed" ? "the provider fails" : "you press stop";
  return labels[action] ?? action;
}

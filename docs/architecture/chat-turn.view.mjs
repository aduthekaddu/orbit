export const title = "One chat turn in Orbit";
export function state(v) {
  if (!v.attached) {
    if (v.phase === "streaming") return "Reconnecting, reply running";
    if (v.phase === "failed") return "Reconnecting after provider failure";
    return v.stored === "none" ? "Reconnecting, no reply saved" : "Reconnecting, reply saved";
  }
  if (v.phase === "streaming") {
    const verb = v.kind === "send" ? "Sending" : "Regenerating";
    return v.visible ? `${verb}, visible parts received` : `${verb}, waiting for visible parts`;
  }
  if (v.phase === "failed") return "Error shown";
  return v.stored === "none" ? "Idle, no reply saved" : "Idle, reply saved";
}
export function group(v) {
  return !v.attached || v.phase === "streaming" ? "streaming" : v.phase === "failed" ? "failed" : "idle";
}
export const colors = { idle: "blue", streaming: "orange", failed: "pink" };
const labels = {
  YouSend: "you send a message",
  YouRegenerate: "you press regenerate",
  YouRetry: "you press retry",
  YouStop: "you press stop",
  VisiblePartArrives: "the model streams a visible part",
  Disconnect: "the connection drops",
  Reconnect: "the browser reconnects",
  Finishes: "the model finishes",
};
export function step(action, from, to) {
  if (action === "Interrupt") return to.phase === "failed" ? "the provider fails" : "you press stop";
  return labels[action] ?? action;
}

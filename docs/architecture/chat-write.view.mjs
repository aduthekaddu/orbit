export const title = "Two tabs write one chat";
const tabs = (v) => Object.keys(v.turn).sort();
export function state(v) {
  const prompt = v.prompt === 1 ? "Prompt as sent" : "Prompt edited";
  const reply = v.answer === 0 ? "no reply saved" : v.answer === 1 ? "reply as answered" : "reply edited";
  const busy = tabs(v).filter((t) => v.turn[t] !== 0).map((t) => `tab ${t} regenerating`);
  const saving = tabs(v).filter((t) => v.saving[t] !== 0).map((t) => `tab ${t} waiting for its edit to show`);
  const misfiled = v.answered.some((text) => text !== v.prompt) ? ["a reply to the old prompt saved"] : [];
  return [prompt, reply, ...busy, ...saving, ...misfiled].join(", ");
}
export function group(v) {
  return tabs(v).some((t) => v.turn[t] !== 0) ? "streaming" : "idle";
}
export const colors = { idle: "blue", streaming: "orange" };
const labels = {
  Load: "tab {t} reloads",
  EditReply: "you edit the reply in tab {t}",
  ShowReplyEdit: "tab {t} shows the saved edit",
  Send: "you send a new prompt from tab {t}",
  Plan: "you press regenerate or retry in tab {t}",
  Finish: "tab {t}'s regenerated reply ends",
  EditPromptInPlace: "you edit the prompt in tab {t}",
};
export function step(action, from, to) {
  const changed = (t) => JSON.stringify(from.seen[t]) !== JSON.stringify(to.seen[t]) || from.turn[t] !== to.turn[t] || from.saving[t] !== to.saving[t];
  const tab = tabs(from).find(changed) ?? tabs(from).find((t) => from.seen[t].answer === to.answer) ?? "?";
  return (labels[action] ?? action).replace("{t}", tab);
}

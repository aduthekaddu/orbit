// The text a reply shows, without its controls: the branch picker, the end mark, buttons, and the model label.
export function replyText(reply) {
  return reply.evaluate((element) => {
    const copy = element.cloneNode(true);
    copy.querySelectorAll("[data-branch-picker], [data-reply-end], [data-reply-label], button").forEach((node) => node.remove());
    return copy.textContent.trim();
  });
}

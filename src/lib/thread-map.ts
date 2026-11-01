export type Turn = { id: string; text: string };

/** The turn the reader is in: the last prompt whose top has crossed the anchor line. */
export function currentTurnIndex(tops: number[], anchor: number) {
  let current = 0;
  tops.forEach((top, index) => {
    if (top <= anchor) current = index;
  });
  return current;
}

/** Each turn runs from its prompt to the next prompt; it is visible while that span overlaps the viewport. */
export function visibleTurns(tops: number[], end: number, viewTop: number, viewBottom: number) {
  return tops.map((top, index) => {
    const bottom = tops[index + 1] ?? end;
    return bottom > viewTop && top < viewBottom;
  });
}

export function turnLabel(text: string) {
  return text.trim().split("\n")[0].slice(0, 120);
}

type ShortcutKey = Pick<KeyboardEvent, "altKey" | "shiftKey" | "metaKey" | "ctrlKey" | "key">;

/** The prompt index Alt+Arrow jumps to, or null when the key combination belongs to the page. */
export function shortcutTarget(event: ShortcutKey, current: number, count: number) {
  if (!event.altKey || event.shiftKey || event.metaKey || event.ctrlKey) return null;
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return null;
  return Math.max(0, Math.min(count - 1, current + (event.key === "ArrowUp" ? -1 : 1)));
}

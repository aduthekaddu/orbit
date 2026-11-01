const DAY_MS = 86_400_000;

const buckets = [
  { label: "Today", maxDaysAgo: 0 },
  { label: "Yesterday", maxDaysAgo: 1 },
  { label: "Previous 7 days", maxDaysAgo: 7 },
  { label: "Previous 30 days", maxDaysAgo: 30 },
  { label: "Older", maxDaysAgo: Infinity },
] as const;

export type ChatGroup<T> = { label: (typeof buckets)[number]["label"]; chats: T[] };

export function startOfDay(date: Date) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

export function groupChatsByRecency<T extends { updatedAt: string }>(chats: T[], today: number): ChatGroup<T>[] {
  const groups: ChatGroup<T>[] = buckets.map((bucket) => ({ label: bucket.label, chats: [] }));
  for (const chat of chats) {
    // Round, not floor: a day across a DST change is 23 or 25 hours long.
    const daysAgo = Math.round((today - startOfDay(new Date(chat.updatedAt))) / DAY_MS);
    groups[buckets.findIndex((bucket) => daysAgo <= bucket.maxDaysAgo)].chats.push(chat);
  }
  return groups.filter((group) => group.chats.length > 0);
}

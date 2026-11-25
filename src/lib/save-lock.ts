export function createSaveLock() {
  let pending = false;

  return async function run<T>(task: () => Promise<T>): Promise<T | false> {
    if (pending) return false;
    pending = true;
    try {
      return await task();
    } finally {
      pending = false;
    }
  };
}

const messageLocks = new Map<string, ReturnType<typeof createSaveLock>>();

/** One lock per message, shared by every editor that can save that row. */
export function saveLockFor(messageId: string) {
  const existing = messageLocks.get(messageId);
  if (existing) return existing;
  const created = createSaveLock();
  messageLocks.set(messageId, created);
  return created;
}

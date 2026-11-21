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

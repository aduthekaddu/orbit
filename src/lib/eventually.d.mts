export type EventuallyOptions = {
  /** How long to keep reading before the wait fails. */
  timeoutMs: number;
  /** The state being waited for, in words. It starts the timeout message. */
  what: string;
  /** Pause between reads. Defaults to 25. */
  intervalMs?: number;
};

/**
 * Reads until the predicate accepts the value, then returns that value.
 * On timeout it throws with `what` and the last value read.
 * An error thrown by `read` or `predicate` ends the wait at once.
 */
export function eventually<T, U extends T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => value is U,
  options: EventuallyOptions,
): Promise<U>;
export function eventually<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  options: EventuallyOptions,
): Promise<T>;

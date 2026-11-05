import { AsyncLocalStorage } from "node:async_hooks";
import axios from "axios";

const signals = new AsyncLocalStorage<AbortSignal>();

axios.interceptors.request.use((config) => {
  const signal = signals.getStore();
  if (signal) config.signal = signal;
  return config;
});

export async function withTavilySignal<T>(signal: AbortSignal, request: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  try {
    return await signals.run(signal, request);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  }
}

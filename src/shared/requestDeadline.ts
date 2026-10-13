import { throwIfAborted } from "./helperStream";

interface Waiter {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  detach(): void;
}

const sharedWaiters = new WeakMap<Promise<unknown>, Set<Waiter>>();

function observeSharedPromise(promise: Promise<unknown>): Set<Waiter> {
  const existing = sharedWaiters.get(promise);
  if (existing) return existing;
  const waiters = new Set<Waiter>();
  sharedWaiters.set(promise, waiters);
  const settle = (kind: "resolve" | "reject", value: unknown) => {
    sharedWaiters.delete(promise);
    for (const waiter of waiters) {
      waiter.detach();
      waiter[kind](value);
    }
    waiters.clear();
  };
  // Only this observer is retained by the underlying promise. Aborted callers
  // are removed from the set even if shared initialization never settles.
  promise.then(
    (value) => settle("resolve", value),
    (error) => settle("reject", error),
  );
  return waiters;
}

/** Abort one waiter without cancelling shared initialization work. */
export function waitWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal | null,
): Promise<T> {
  if (!signal) return promise;
  const waiters = observeSharedPromise(promise);
  return new Promise<T>((resolve, reject) => {
    const waiter: Waiter = {
      resolve: (value) => resolve(value as T),
      reject,
      detach: () => {
        waiters.delete(waiter);
        signal.removeEventListener("abort", abort);
      },
    };
    const abort = () => {
      waiter.detach();
      reject(new DOMException("Request cancelled", "AbortError"));
    };
    waiters.add(waiter);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function withRequestDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal | null,
  timeoutMs = 20_000,
): Promise<T> {
  throwIfAborted(signal || undefined);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    return await waitWithSignal(
      operation(controller.signal),
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

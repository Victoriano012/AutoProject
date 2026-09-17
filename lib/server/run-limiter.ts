import type { ModelProvider } from "../models";

const positiveInt = (value: string | undefined, fallback: number) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
};

/** FIFO within each provider, with a shared process-wide ceiling. Aborted
 * waiters never consume a slot; releases are idempotent. */
export class RunLimiter {
  private active = new Map<ModelProvider, number>();
  private waiting: Array<{
    provider: ModelProvider;
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (reason: unknown) => void;
    abort: () => void;
  }> = [];

  private totalLimit: () => number;
  private providerLimit: (provider: ModelProvider) => number;
  constructor(totalLimit: () => number, providerLimit: (provider: ModelProvider) => number) {
    this.totalLimit = totalLimit;
    this.providerLimit = providerLimit;
  }

  acquire(provider: ModelProvider, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const waiter = { provider, signal, resolve, reject, abort: () => {} };
      waiter.abort = () => {
        this.waiting = this.waiting.filter((item) => item !== waiter);
        reject(signal.reason);
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }

  private drain() {
    for (let i = 0; i < this.waiting.length;) {
      const count = [...this.active.values()].reduce((sum, value) => sum + value, 0);
      if (count >= this.totalLimit()) return;
      const waiter = this.waiting[i];
      const active = this.active.get(waiter.provider) ?? 0;
      if (active >= this.providerLimit(waiter.provider)) { i++; continue; }
      this.waiting.splice(i, 1);
      waiter.signal.removeEventListener("abort", waiter.abort);
      this.active.set(waiter.provider, active + 1);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active.set(waiter.provider, (this.active.get(waiter.provider) ?? 1) - 1);
        this.drain();
      });
    }
  }
}

const globals = globalThis as unknown as { __autoprojectRunLimiter?: RunLimiter };
export const runLimiter = globals.__autoprojectRunLimiter ??= new RunLimiter(
  () => positiveInt(process.env.AUTOPROJECT_MAX_RUNS, 4),
  (provider) => positiveInt(process.env[`AUTOPROJECT_MAX_${provider.toUpperCase()}_RUNS`], 2),
);

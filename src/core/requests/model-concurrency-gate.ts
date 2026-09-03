import { PublicError } from "./public-error";

interface Waiter {
  signal: AbortSignal;
  resolve(release: () => void): void;
  reject(error: PublicError): void;
  onAbort(): void;
}

/** A provider-neutral single-slot gate shared by every model generation surface. */
export class ModelConcurrencyGate {
  private locked = false;
  private readonly waiters: Waiter[] = [];

  async runExclusive<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(this.cancelled());
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.releaseOnce());
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(this.cancelled());
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) continue;
      waiter.resolve(this.releaseOnce());
      return;
    }
    this.locked = false;
  }

  private cancelled(): PublicError {
    return new PublicError("REQUEST_CANCELLED", "The request was cancelled.", true);
  }
}

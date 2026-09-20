/**
 * The worker timer port (RL-107).
 *
 * The same discipline as the reconciliation scheduler's injectable timer:
 * every loop delay is scheduled through this port, so the worker's ticks are
 * deterministic under the testkit clock in tests and wall-clock paced in
 * production (the default timer wraps setTimeout).
 */
export interface WorkerTimer {
  schedule(callback: () => void, delayMs: number): () => void;
}

/** The production timer (setTimeout-based). */
export class SystemWorkerTimer implements WorkerTimer {
  schedule(callback: () => void, delayMs: number): () => void {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  }
}

/** A timer that never fires by itself: tests drive ticks explicitly. */
export class ManualWorkerTimer implements WorkerTimer {
  readonly #pending: { callback: () => void; cancel: () => void }[] = [];

  schedule(callback: () => void, _delayMs: number): () => void {
    const entry = { callback, cancel: () => void 0 };
    entry.cancel = () => {
      const index = this.#pending.indexOf(entry);
      if (index >= 0) this.#pending.splice(index, 1);
    };
    this.#pending.push(entry);
    return entry.cancel;
  }

  /** The number of pending scheduled callbacks. */
  get pendingCount(): number {
    return this.#pending.length;
  }

  /** Fires the oldest pending callback (tests drive the loop). */
  tick(): void {
    const entry = this.#pending.shift();
    entry?.callback();
  }

  /** Cancels everything pending (tests). */
  clear(): void {
    this.#pending.length = 0;
  }
}

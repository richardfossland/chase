// Coalescing refetch scheduler — PURE (no React), so the two rules the hooks
// rely on are unit-tested:
//
//   1. Never two fetches in flight at once.
//   2. A request that arrives WHILE one is in flight is not dropped: exactly
//      one more fetch runs after the current one settles. (The old hook simply
//      returned when `inFlight` was set, so two results entered 200 ms apart
//      left the board showing only the first until the 15 s poll.)
//
// `jitterMs` spreads requests over a random 0..jitter window before they run —
// a broadcast fans out to every spectator at the same instant, and 100 phones
// refetching in the same 50 ms is exactly the spike a Workers-Free isolate
// cannot absorb. Zero for referees/board (they want it now).

export class Refetcher {
  private inFlight = false;
  private queued = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly run: () => Promise<void>,
    private readonly opts: { jitterMs?: number; random?: () => number } = {},
  ) {}

  /** Ask for a refetch. Immediate (or jittered) when idle; otherwise queued
   * (at most one). */
  request(): void {
    if (this.disposed) return;
    const jitter = this.opts.jitterMs ?? 0;
    if (jitter > 0 && !this.inFlight && this.timer === null) {
      const delay = Math.floor((this.opts.random ?? Math.random)() * jitter);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.kick();
      }, delay);
      return;
    }
    this.kick();
  }

  /** Bypass the jitter (mount, manual retry, explicit user action). */
  now(): void {
    if (this.disposed) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.kick();
  }

  private kick(): void {
    if (this.inFlight) {
      this.queued = true;
      return;
    }
    this.inFlight = true;
    // `run` is expected to handle its own errors; swallow anyway so a throw
    // can never leave the in-flight slot taken (or surface as an unhandled
    // rejection) — the next hint must always be able to fetch again.
    void this.run()
      .catch(() => {})
      .then(() => {
        this.inFlight = false;
        if (this.queued && !this.disposed) {
          this.queued = false;
          this.kick();
        }
      });
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.queued = false;
  }

  get busy(): boolean {
    return this.inFlight;
  }
}

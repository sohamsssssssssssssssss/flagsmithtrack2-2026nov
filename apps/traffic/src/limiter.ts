/**
 * Poisson-ish request pacer: each acquirer reserves a slot after the previous
 * one, with exponential gaps around 1/rps (clamped so one unlucky draw cannot
 * stall the generator). Concurrent sessions queue up on reserved slots, which
 * keeps the observed rate close to the target.
 */
export type RateLimiterOptions = {
  rps: number;
  random?: () => number;
};

const MIN_GAP_FACTOR = 0.25;
const MAX_GAP_FACTOR = 3;

export class RateLimiter {
  private rps: number;
  private nextAt = 0;
  private closed = false;
  private readonly random: () => number;
  private readonly waiters = new Map<ReturnType<typeof setTimeout>, () => void>();

  constructor(options: RateLimiterOptions) {
    if (!Number.isFinite(options.rps) || options.rps <= 0) {
      throw new Error("rps must be a positive number");
    }
    this.rps = options.rps;
    this.random = options.random ?? Math.random;
  }

  /** Used by --burst to double the target, then restore it 60s later. */
  setRps(rps: number): void {
    if (!Number.isFinite(rps) || rps <= 0) return;
    this.rps = rps;
  }

  get targetRps(): number {
    return this.rps;
  }

  /** Shutdown: release everyone waiting for a slot so workers can exit now. */
  cancel(): void {
    this.closed = true;
    for (const [timer, resolve] of this.waiters) {
      clearTimeout(timer);
      resolve();
    }
    this.waiters.clear();
  }

  acquire(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.gapMs();
    const waitMs = at - now;
    if (waitMs <= 0) return Promise.resolve();

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(timer);
        resolve();
      }, waitMs);
      this.waiters.set(timer, resolve);
    });
  }

  private gapMs(): number {
    const u = Math.max(this.random(), 1e-9);
    const exponential = (-Math.log(u) / this.rps) * 1000;
    const min = (MIN_GAP_FACTOR / this.rps) * 1000;
    const max = (MAX_GAP_FACTOR / this.rps) * 1000;
    return Math.min(max, Math.max(min, exponential));
  }
}

/** Small deterministic PRNG so the limiter tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

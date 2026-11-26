import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimiter, mulberry32 } from "./limiter.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("RateLimiter", () => {
  it("stays within 20% of the target rps", async () => {
    vi.useFakeTimers();
    const targetRps = 100;
    const limiter = new RateLimiter({ rps: targetRps, random: mulberry32(7) });
    const startedAt = Date.now();
    let completed = 0;

    // Reserve more slots than one second can hold; only count those due within 1s.
    const pending = Array.from({ length: 250 }, () =>
      limiter.acquire().then(() => {
        if (Date.now() - startedAt <= 1_000) completed += 1;
      }),
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect(completed).toBeGreaterThanOrEqual(targetRps * 0.8);
    expect(completed).toBeLessThanOrEqual(targetRps * 1.2);

    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all(pending);
  });

  it("changes pace when the target is doubled for a burst", async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter({ rps: 50, random: mulberry32(11) });
    let completed = 0;
    let running = true;

    // Like the generator: a fixed worker pool re-acquires after each request,
    // so slots are reserved progressively rather than all at once.
    async function worker(): Promise<void> {
      while (running) {
        await limiter.acquire();
        completed += 1;
      }
    }

    const workers = Array.from({ length: 10 }, () => worker());

    await vi.advanceTimersByTimeAsync(1_000);
    expect(completed).toBeGreaterThanOrEqual(40);
    expect(completed).toBeLessThanOrEqual(60);

    limiter.setRps(100);
    completed = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(completed).toBeGreaterThanOrEqual(80);
    expect(completed).toBeLessThanOrEqual(120);

    running = false;
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all(workers);
  });

  it("releases waiters immediately when cancelled", async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter({ rps: 1, random: mulberry32(3) });

    let released = false;
    const pending = limiter.acquire().then(() => {
      released = true;
    });

    expect(released).toBe(false);
    limiter.cancel();
    await pending;
    expect(released).toBe(true);
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });
});

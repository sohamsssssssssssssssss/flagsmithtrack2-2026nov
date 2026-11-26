import { BUCKET_MS, type Bucket } from "./metrics.js";

export const RECOVERY_MS = 120_000;

export function totals(buckets: Pick<Bucket, "requests" | "errors">[]) {
  const requests = buckets.reduce((sum, row) => sum + row.requests, 0);
  const errors = buckets.reduce((sum, row) => sum + row.errors, 0);
  return { requests, errors, rate: requests ? errors / requests : null };
}

export function detectSpike(buckets: Bucket[], end: number) {
  const start = end - 2 * BUCKET_MS;
  const baseline = totals(buckets.filter((b) => b.ts >= start - 600_000 && b.ts < start));
  const window = buckets.filter((b) => b.ts >= start && b.ts < end);
  const recent = totals(window);
  return baseline.rate !== null && recent.rate !== null && recent.errors >= 5
    && (baseline.rate < 0.01 || recent.rate >= 3 * baseline.rate)
    && window.length === 2 && window.every((b) => b.rate !== null && b.rate >= 0.05)
    ? { start, end, baseline, recent } : null;
}

export function recovered(buckets: Bucket[], end: number, baseline: number): boolean {
  for (let ts = end - RECOVERY_MS; ts < end; ts += BUCKET_MS) {
    const bucket = buckets.find((b) => b.ts === ts);
    if (!bucket || bucket.rate === null || !bucket.requests) return false;
    // A clean baseline can only recover to zero.
    if (baseline === 0 ? bucket.errors !== 0 : bucket.rate >= 1.5 * baseline) return false;
  }
  return true;
}

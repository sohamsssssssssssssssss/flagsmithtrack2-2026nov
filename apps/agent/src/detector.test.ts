import { expect, it } from "vitest";
import { detectSpike, recovered, RECOVERY_MS } from "./detector.js";
import { BUCKET_MS } from "./metrics.js";

const end = 900_000;
const bucket = (ts: number, requests: number, errors: number) =>
  ({ ts, requests, errors, rate: requests ? errors / requests : null });

it("requires at least five errors and at least 5% in each of two consecutive buckets", () => {
  const baseline = bucket(end - 30_000, 150, 0);
  const detect = (a: number, b: number) =>
    detectSpike([baseline, bucket(end - 20_000, 40, a), bucket(end - 10_000, 40, b)], end);
  expect(detect(2, 3)?.recent).toEqual({ requests: 80, errors: 5, rate: 0.0625 });
  expect(detect(2, 2)).toBeNull();
  expect(detect(0, 5)).toBeNull();
  expect(detectSpike([baseline, bucket(end - 10_000, 40, 5)], end)).toBeNull();
  expect(detectSpike([bucket(end - 20_000, 40, 3), bucket(end - 10_000, 40, 3)], end)).toBeNull();
});

it("requires triple the baseline when the route already fails at 1% or higher", () => {
  const recent = [bucket(end - 20_000, 50, 3), bucket(end - 10_000, 50, 3)];
  expect(detectSpike([bucket(end - 30_000, 100, 2), ...recent], end)).not.toBeNull();
  expect(detectSpike([bucket(end - 30_000, 100, 3), ...recent], end)).toBeNull();
});

it("keeps the two-minute recovery period with ten-second buckets", () => {
  const clean = Array.from({ length: RECOVERY_MS / BUCKET_MS },
    (_, index) => bucket(end - RECOVERY_MS + index * BUCKET_MS, 100, 0));
  expect(recovered(clean, end, 0)).toBe(true);
  expect(recovered(clean.slice(1), end, 0)).toBe(false);
  expect(recovered([...clean.slice(0, -1), bucket(end - BUCKET_MS, 100, 1)], end, 0)).toBe(false);
});

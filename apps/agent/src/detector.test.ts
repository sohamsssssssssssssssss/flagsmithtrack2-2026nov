import { expect, it } from "vitest";
import { detectSpike, recovered } from "./detector.js";

const end = 900_000;
const bucket = (ts: number, requests: number, errors: number) =>
  ({ ts, requests, errors, rate: requests ? errors / requests : null });

it("requires twenty errors, strictly above 2%, and at least triple the preceding baseline", () => {
  const baseline = bucket(end - 90_000, 150, 2);
  const detect = (requests: number, errors: number) =>
    detectSpike([baseline, bucket(end - 60_000, requests / 2, 10),
      bucket(end - 30_000, requests / 2, errors - 10)], end);
  expect(detect(500, 20)?.recent).toEqual({ requests: 500, errors: 20, rate: 0.04 });
  expect(detect(500, 19)).toBeNull();
  expect(detect(510, 20)).toBeNull();
  expect(detectSpike([bucket(end - 90_000, 5_000, 0), bucket(end - 30_000, 1_000, 20)], end)).toBeNull();
  expect(detectSpike([bucket(end - 30_000, 100, 24)], end)).toBeNull();
});

it("requires four healthy buckets with traffic and handles a clean baseline", () => {
  const clean = [4, 3, 2, 1].map((n) => bucket(end - n * 30_000, 100, 0));
  expect(recovered(clean, end, 0)).toBe(true);
  expect(recovered(clean.slice(1), end, 0)).toBe(false);
  expect(recovered([...clean.slice(0, 3), bucket(end - 30_000, 100, 1)], end, 0)).toBe(false);
});

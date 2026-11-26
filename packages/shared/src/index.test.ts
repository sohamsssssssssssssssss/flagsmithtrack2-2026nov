import { describe, expect, it } from "vitest";
import { ErrorIngest, FlagChange, RequestBatch } from "./index.js";

const ev = {
  ts: 1, identity: "u1", route: "/checkout", message: "boom", stack: "Error: boom",
  flags: { new_checkout: { enabled: true, value: null }, free_shipping_threshold: { enabled: true, value: 50 } },
  source: "server", simulated: true,
};

describe("shared contract", () => {
  it("accepts one error or a batch", () => {
    expect(ErrorIngest.safeParse(ev).success).toBe(true);
    expect(ErrorIngest.safeParse([ev, ev]).success).toBe(true);
  });
  it("rejects bad source and missing flags", () => {
    expect(ErrorIngest.safeParse({ ...ev, source: "edge" }).success).toBe(false);
    const { flags: _, ...noFlags } = ev;
    expect(ErrorIngest.safeParse(noFlags).success).toBe(false);
  });
  it("validates request batches and flag changes", () => {
    expect(RequestBatch.safeParse({ ts_bucket: 0, route: "/", rows: [{ flag_key: "x", flag_on: true, count: 3, errors: 1 }] }).success).toBe(true);
    expect(RequestBatch.safeParse({ ts_bucket: 0, route: "/", rows: [{ flag_key: "x", flag_on: true, count: -1, errors: 0 }] }).success).toBe(false);
    expect(FlagChange.safeParse({ ts: 0, env: "Development", flag_key: "x", feature_id: 1, before: null, after: { enabled: false, value: null, overrides: [{ segment_id: 1, enabled: true, value: null }] }, source: "poll" }).success).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { aggregate } from "./metrics.js";

describe("aggregate", () => {
  it("splits error rate by flag on/off and does not double count requests across flags", () => {
    // 100 checkout requests in bucket 0 (two 5 s batches), each reported once per flag.
    const m = aggregate([
      { ts_bucket: 0, route: "/checkout", flag_key: "new_checkout", flag_on: 1, count: 40, errors: 20 },
      { ts_bucket: 5_000, route: "/checkout", flag_key: "new_checkout", flag_on: 0, count: 60, errors: 1 },
      { ts_bucket: 0, route: "/checkout", flag_key: "promo_banner", flag_on: 1, count: 50, errors: 10 },
      { ts_bucket: 5_000, route: "/checkout", flag_key: "promo_banner", flag_on: 0, count: 50, errors: 11 },
      { ts_bucket: 31_000, route: "/search", flag_key: "smart_search", flag_on: 1, count: 10, errors: 0 },
    ]);
    expect(m.overall).toEqual([
      { ts: 0, requests: 100, errors: 21, rate: 0.21 },
      { ts: 30_000, requests: 10, errors: 0, rate: 0 },
    ]);
    expect(m.by_route["/checkout"]).toEqual([{ ts: 0, requests: 100, errors: 21, rate: 0.21 }]);
    expect(m.by_flag.new_checkout!.on).toEqual([{ ts: 0, requests: 40, errors: 20, rate: 0.5 }]);
    expect(m.by_route["/checkout"]).toEqual([{ ts: 0, requests: 100, errors: 21, rate: 0.21 }]);
    expect(m.by_flag.new_checkout!.off[0]!.rate).toBeCloseTo(1 / 60);
    expect(m.by_flag.smart_search!.off).toEqual([]);
  });

  it("keeps adjacent ten-second windows when aligned to a two-second batch", () => {
    const rows = [0, 2_000, 10_000, 12_000].map((ts_bucket) =>
      ({ ts_bucket, route: "/checkout", flag_key: "x", flag_on: 1, count: 3, errors: 1 }));
    expect(aggregate(rows, 2_000).by_route["/checkout"]).toEqual([
      { ts: -8_000, requests: 3, errors: 1, rate: 1 / 3 },
      { ts: 2_000, requests: 6, errors: 2, rate: 1 / 3 },
      { ts: 12_000, requests: 3, errors: 1, rate: 1 / 3 },
    ]);
  });

  it("returns null rate for empty buckets and handles no rows", () => {
    expect(aggregate([{ ts_bucket: 0, route: "/", flag_key: "x", flag_on: 1, count: 0, errors: 0 }]).overall[0]!.rate).toBeNull();
    expect(aggregate([])).toEqual({ bucket_ms: 10_000, overall: [], by_route: {}, by_flag: {} });
  });
});

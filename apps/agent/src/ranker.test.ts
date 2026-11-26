import { expect, it } from "vitest";
import { fisherGreater } from "./fisher.js";
import { rankFlags } from "./ranker.js";

const changes = ["culprit", "innocent"].map((flag_key) => ({ flag_key, ts: 0 }));
const failures = [{
  route: "/checkout",
  stack: "TypeError\n    at checkout (apps/demo-shop/api/src/checkout/applyDiscount.ts:6:1)\n    at next (node_modules/router/index.js:1:1)",
  flags_json: JSON.stringify({ culprit: { enabled: true }, innocent: { enabled: true } }),
}];
const rows = [
  { flag_key: "culprit", flag_on: true, count: 100, errors: 40 },
  { flag_key: "culprit", flag_on: false, count: 100, errors: 0 },
  { flag_key: "innocent", flag_on: true, count: 100, errors: 20 },
  { flag_key: "innocent", flag_on: false, count: 100, errors: 20 },
].map((row) => ({ ...row, route: "/checkout", ts_bucket: 30_000 }));

it("distinguishes the culprit from an innocent flag changed at the same time", () => {
  const result = rankFlags(rows, failures, changes, 60_000, {
    culprit: ["apps/demo-shop/api/src/checkout/applyDiscount.ts"],
  });
  expect(result.confidence).toBe("confident");
  expect(result.ranking[0]).toMatchObject({ flag: "culprit", overlap: 1, on: { requests: 100, errors: 40 } });
  expect(result.ranking[1]).toMatchObject({ flag: "innocent", p: expect.any(Number), split: 0, map: "no map" });
});

it("reports ambiguity with no map, tied candidates, or tied cohorts", () => {
  expect(rankFlags(rows, failures, changes, 60_000, {}).confidence).toBe("ambiguous");
  const tied = rows.map((row) => ({ ...row, errors: row.flag_on ? 40 : 0 }));
  const mapped = { culprit: ["apps/demo-shop/api/src/checkout/applyDiscount.ts"],
    innocent: ["apps/demo-shop/api/src/checkout/applyDiscount.ts"] };
  expect(rankFlags(tied, failures, changes, 60_000, mapped).confidence).toBe("ambiguous");

});

it("uses Fisher for a small cell and requires one-sided p < 0.001", () => {
  expect(fisherGreater(10, 10, 10, 0)).toBeCloseTo(1 / 184756, 12);
  const small = (errors: number) => rows.slice(0, 2).map((row) =>
    ({ ...row, count: 10, errors: row.flag_on ? errors : 0 }));
  const map = { culprit: ["apps/demo-shop/api/src/checkout/applyDiscount.ts"] };
  expect(rankFlags(small(5), failures, changes, 60_000, map).confidence).toBe("ambiguous");
  const ranked = rankFlags(small(9), failures, changes, 60_000, map);
  expect(ranked.confidence).toBe("confident");
  expect(ranked.ranking[0]).toMatchObject({ test: "fisher", z: null });
  expect(ranked.ranking[0]!.p).toBeLessThan(0.001);
});

it("uses the z test when all four cells have at least 30 observations", () => {
  const large = rows.slice(0, 2).map((row) => ({ ...row, count: 200, errors: row.flag_on ? 90 : 30 }));
  const result = rankFlags(large, failures, changes, 60_000, { culprit: ["apps/demo-shop/api/src/checkout/applyDiscount.ts"] });
  expect(result.ranking[0]).toMatchObject({ test: "z", split: 1, p: null });
});

import { expect, it } from "vitest";
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
  expect(result.ranking[1]).toMatchObject({ flag: "innocent", z: 0, map: "no map" });
});

it("reports ambiguity with no map, tied candidates, or insufficient cohort samples", () => {
  expect(rankFlags(rows, failures, changes, 60_000, {}).confidence).toBe("ambiguous");
  const tied = rows.map((row) => ({ ...row, errors: row.flag_on ? 40 : 0 }));
  const mapped = { culprit: ["apps/demo-shop/api/src/checkout/applyDiscount.ts"],
    innocent: ["apps/demo-shop/api/src/checkout/applyDiscount.ts"] };
  expect(rankFlags(tied, failures, changes, 60_000, mapped).confidence).toBe("ambiguous");
  const small = rows.map((row) => ({ ...row, count: 25, errors: row.errors ? 10 : 0 }));
  expect(rankFlags(small, failures, changes, 60_000, mapped).ranking.every((r) => r.z === null)).toBe(true);
});

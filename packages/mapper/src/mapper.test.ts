import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { mapFlags } from "./index.js";

const fixtures = fileURLToPath(new URL("../fixtures", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));

it("maps SDK calls, computed properties, guards, routes, helper arguments and imported calls", async () => {
  const map = await mapFlags(fixtures, ["checkout", "search", "unused"]);
  expect(map.flags.checkout?.hits).toEqual(expect.arrayContaining([
    expect.objectContaining({ function: "handleCheckout", confidence: "high", guard: { kind: "if", start_line: 4, end_line: 4 }, routes: ["/checkout"] }),
    expect.objectContaining({ file: "linked.ts", via: "handlers.tsx:4", confidence: "low", routes: ["/checkout"] }),
    expect.objectContaining({ line: 15, confidence: "low" }),
  ]));
  expect(map.flags.search?.hits.map((hit) => hit.guard?.kind)).toEqual(expect.arrayContaining(["&&", "ternary"]));
  expect(map.flags.search?.routes).toEqual(["/search"]);
  expect(map.flags.unused?.files).toEqual([]);
  expect(map.edges).toContainEqual({ id: "file:linked.ts->route:/checkout", source: "file:linked.ts", target: "route:/checkout" });
});

it("snapshots the real shop's checkout mapping", async () => {
  const map = await mapFlags(repo, ["new_checkout"]);
  expect(map.flags.new_checkout).toMatchSnapshot();
  expect(map.flags.new_checkout?.routes).toContain("/api/checkout");
  expect(map.flags.new_checkout?.files).toContain("apps/demo-shop/api/src/checkout/applyDiscount.ts");
});

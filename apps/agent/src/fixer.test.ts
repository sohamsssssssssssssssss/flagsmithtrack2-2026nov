import { expect, it, vi } from "vitest";
import { createFixModel, findSafePatch, fixContext, patchFiles, projectFrames } from "./fixer.js";

const file = "apps/demo-shop/api/src/checkout/applyDiscount.ts";
const patch = (path: string, lines: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${lines}\n`;
const good = patch(file, "-const { code } = promotion.details;\n+const { code } = promotion;");

async function model(replies: string[]) {
  const request = vi.fn<typeof fetch>(async () => Response.json({
    choices: [{ message: { content: replies.shift() } }],
  }));
  const client = await createFixModel({ base: "https://example.test/v1", key: "test-auth", model: "grok-test" }, request);
  return { request, client };
}

it("accepts a bounded mapped diff from a mocked model and uses no replay inputs in its prompt", async () => {
  const { request, client } = await model([good]);
  const validate = vi.fn(async () => {});
  const result = await findSafePatch([file], (reason) => client.patch("Flag: new_checkout", reason), validate, () => {});
  expect(result).toMatchObject({ attempt: 1, paths: [file] });
  expect(validate).toHaveBeenCalledOnce();
  const sent = String(request.mock.calls[0]?.[1]?.body);
  expect(sent).toContain("keep the old path");
  expect(sent).not.toContain("test-auth");
});

it("rejects an oversized patch before validation", async () => {
  const oversized = patch(file, "-old\n" + "+line\n".repeat(40));
  const { client } = await model([oversized, oversized, oversized]);
  const validate = vi.fn();
  await expect(findSafePatch([file], (reason) => client.patch("Flag", reason), validate, () => {}))
    .rejects.toThrow("40 lines");
  expect(validate).not.toHaveBeenCalled();
});

it("rejects an unmapped file and non-content Git changes", async () => {
  const other = patch("package.json", "-old\n+new");
  const { client } = await model([other, other, other]);
  const validate = vi.fn();
  await expect(findSafePatch([file], (reason) => client.patch("Flag", reason), validate, () => {}))
    .rejects.toThrow("unmapped file");
  expect(validate).not.toHaveBeenCalled();
  expect(() => patchFiles(good.replace("--- a/", "new file mode 120000\n--- a/"), [file])).toThrow();
});

it("feeds replay failures back to the model and stops after two retries", async () => {
  const { request, client } = await model([good, good, good]);
  const validate = vi.fn(async () => { throw new Error("Saved checkout replay returned HTTP 500"); });
  await expect(findSafePatch([file], (reason) => client.patch("Flag", reason), validate, () => {}))
    .rejects.toThrow("Attempt 3: Saved checkout replay returned HTTP 500");
  expect(validate).toHaveBeenCalledTimes(3);
  expect(String(request.mock.calls[1]?.[1]?.body)).toContain("Validation failure");
  expect(String(request.mock.calls[2]?.[1]?.body)).toContain("HTTP 500");
});

it("caps mapped context and keeps only project stack frames", async () => {
  const lines = Array.from({ length: 250 }, (_, i) => "source " + (i + 1));
  const frames = projectFrames(`Error\n    at discount (/workspace/${file}:6:11)\n    at caller (/workspace/node_modules/pkg/index.js:1:2)`, "/workspace");
  expect(frames).toEqual([`discount ${file}:6:11`]);
  const text = await fixContext("new_checkout", { files: [file], routes: ["/api/checkout"], hits: [{
    flag: "new_checkout", file, line: 27, function: "applyDiscount", guard: null,
    function_range: { start_line: 1, end_line: 250 }, routes: ["/api/checkout"], confidence: "high",
  }] }, "TypeError", frames, async () => lines.join("\n"));
  expect(text.split("\n").filter((line) => line.startsWith("source "))).toHaveLength(200);
});

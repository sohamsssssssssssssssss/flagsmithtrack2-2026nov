import { createServer } from "node:http";
import { ErrorEvent, INGEST, RequestBatch, type FlagSnapshot } from "@blast/shared";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createTelemetry, REQUEST_BUCKET_MS } from "./telemetry.js";

vi.mock("./checkout/applyDiscount.js", () => ({
  applyDiscount: vi.fn((subtotal: number, code?: string) => {
    if (code) throw new TypeError("Simulated discount failure");
    return subtotal;
  }),
}));

it("checks out on the old path and sends valid error events and per-flag request batches", async () => {
  const received: Array<{ path?: string; body: unknown }> = [];
  const agent = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(204).end();
  });
  await new Promise<void>((resolve) => { agent.listen(0, "127.0.0.1", resolve); });
  try {
    const address = agent.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
    const telemetry = createTelemetry(`http://127.0.0.1:${address.port}`);
    const evaluate = vi.fn(async (identity: string, _cohort: string | undefined): Promise<FlagSnapshot> => ({
      new_checkout: { enabled: identity === "on", value: null },
      unrelated_flag: { enabled: false, value: "test" },
    }));
    const shop = request(buildApp(evaluate, telemetry));
    const body = { items: [{ id: "glow", quantity: 1 }], discountCode: "LUMEN10" };

    await shop.post("/api/checkout").set("x-identity", "off").send(body).expect(200, { total: 4320 });
    await shop.post("/api/checkout").set({
      "x-identity": "on", "x-cohort": "demo", "x-simulated": "1",
    }).send(body).expect(500);
    await shop.post("/api/checkout").set("x-identity", "on").send({ items: body.items })
      .expect(200, { total: 4800 });
    expect(evaluate.mock.calls).toEqual([["off", undefined], ["on", "demo"], ["on", undefined]]);

    telemetry.flush(Date.now() + REQUEST_BUCKET_MS);
    await vi.waitFor(() => {
      const requestCount = received.filter(({ path }) => path === INGEST.requests)
        .flatMap(({ body: payload }) => RequestBatch.parse(payload).rows)
        .filter(({ flag_key }) => flag_key === "new_checkout")
        .reduce((count, row) => count + row.count, 0);
      expect(requestCount).toBe(3);
    });
    await vi.waitFor(() => expect(received.some(({ path }) => path === INGEST.error)).toBe(true));
    const error = ErrorEvent.parse(received.find(({ path }) => path === INGEST.error)?.body);
    expect(error).toMatchObject({ identity: "on", route: "/api/checkout", source: "server", simulated: true });
    expect(error.flags).toEqual({
      new_checkout: { enabled: true, value: null },
      unrelated_flag: { enabled: false, value: "test" },
    });
    expect(error.stack).toContain("TypeError: Simulated discount failure");
    expect(error.replay).toEqual({ method: "POST", body });

    const batches = received.filter(({ path }) => path === INGEST.requests)
      .map(({ body: payload }) => RequestBatch.parse(payload));
    const totals = new Map<boolean, number[]>();
    for (const batch of batches) {
      expect(batch.route).toBe("/api/checkout");
      expect(batch.ts_bucket % REQUEST_BUCKET_MS).toBe(0);
      for (const row of batch.rows.filter(({ flag_key }) => flag_key === "new_checkout")) {
        const [count = 0, errors = 0] = totals.get(row.flag_on) ?? [];
        totals.set(row.flag_on, [count + row.count, errors + row.errors]);
      }
    }
    expect(totals).toEqual(new Map([[false, [1, 0]], [true, [2, 1]]]));
  } finally {
    await new Promise<void>((resolve) => { agent.close(() => resolve()); });
  }
});

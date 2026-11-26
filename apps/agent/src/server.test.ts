import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

describe("agent ingest stubs", () => {
  const app = buildServer();
  const ev = { ts: 1, identity: "u", route: "/", message: "m", stack: "s", flags: {}, source: "browser", simulated: true };
  it("accepts valid errors and batches", async () => {
    expect((await app.inject({ method: "POST", url: "/ingest/error", payload: [ev, ev] })).json()).toEqual({ accepted: 2 });
    const r = await app.inject({ method: "POST", url: "/ingest/requests", payload: { ts_bucket: 0, route: "/", rows: [] } });
    expect(r.statusCode).toBe(202);
  });
  it("rejects invalid bodies with 400", async () => {
    expect((await app.inject({ method: "POST", url: "/ingest/error", payload: { ts: 1 } })).statusCode).toBe(400);
  });
});

import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { buildServer } from "./server.js";

const ev = { ts: 1_000, identity: "u", route: "/checkout", message: "m", stack: "s",
  flags: { new_checkout: { enabled: true, value: null } }, source: "browser", simulated: true };

describe("ingest", () => {
  const db = openDb(":memory:");
  const app = buildServer(db);

  it("stores valid errors and batches", async () => {
    expect((await app.inject({ method: "POST", url: "/ingest/error", payload: [ev, ev] })).json()).toEqual({ accepted: 2 });
    expect((await app.inject({ method: "POST", url: "/ingest/error", payload: ev })).statusCode).toBe(202);
    const r = await app.inject({ method: "POST", url: "/ingest/requests",
      payload: { ts_bucket: 0, route: "/checkout", rows: [{ flag_key: "new_checkout", flag_on: true, count: 4, errors: 3 }] } });
    expect(r.statusCode).toBe(202);
    expect(db.prepare("SELECT COUNT(*) n FROM errors").get()).toEqual({ n: 3 });
    expect(JSON.parse((db.prepare("SELECT flags_json f FROM errors").get() as { f: string }).f)).toEqual(ev.flags);
    expect(db.prepare("SELECT flag_on, count, errors FROM requests").get()).toEqual({ flag_on: 1, count: 4, errors: 3 });
  });

  it("rejects invalid bodies with 400 and stores nothing", async () => {
    const before = db.prepare("SELECT COUNT(*) n FROM errors").get();
    expect((await app.inject({ method: "POST", url: "/ingest/error", payload: { ts: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/ingest/error", payload: [ev, { ...ev, source: "edge" }] })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/ingest/requests", payload: { ts_bucket: 0, route: "/", rows: [{ flag_key: "x", flag_on: true, count: 1.5, errors: 0 }] } })).statusCode).toBe(400);
    expect(db.prepare("SELECT COUNT(*) n FROM errors").get()).toEqual(before);
  });

  it("serves metrics and rejects a bad window", async () => {
    expect((await app.inject({ url: "/api/metrics?window=0" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/metrics?window=600" })).json()).toHaveProperty("overall");
  });
});

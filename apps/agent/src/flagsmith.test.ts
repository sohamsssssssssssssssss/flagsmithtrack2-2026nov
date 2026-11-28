import { describe, expect, it, vi } from "vitest";
import { FlagsmithClient } from "./flagsmith.js";

const KEY = "secret-admin-key";
const val = (n: number) => ({ type: "integer", value: String(n) });

// Minimal fake of the __future__ endpoint: PATCH upserts overrides by segment id.
function fakeApi(initial: any, opts: { fail5xx?: number } = {}) {
  let flag = structuredClone(initial);
  let fails = opts.fail5xx ?? 0;
  const calls: { method: string; url: string; body?: any }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method: init.method!, url, body });
    if (fails-- > 0) return new Response("boom", { status: 502 });
    if (url.includes("/environments/") && url.includes("/projects/"))
      return Response.json({ results: [{ name: "Development", api_key: "envkey" }] });
    if (init.method === "DELETE") {
      const id = Number(/segment-overrides\/(\d+)\//.exec(url)![1]);
      flag.segment_overrides = flag.segment_overrides.filter((o: any) => o.segment.id !== id);
      return new Response(null, { status: 204 });
    }
    if (init.method === "PATCH") {
      if (body.environment_default) flag.environment_default = { ...flag.environment_default, ...body.environment_default };
      for (const o of body.segment_overrides ?? []) {
        const cur = flag.segment_overrides.find((x: any) => x.segment.id === o.segment.id);
        cur ? Object.assign(cur, o) : flag.segment_overrides.push({ priority: 9, value: null, variants: [], ...o });
      }
      return Response.json(flag);
    }
    return Response.json(flag);
  });
  const client = new FlagsmithClient({ apiUrl: "https://x", adminKey: KEY, projectId: 1, envName: "Development" }, fetchImpl as any);
  return { client, calls };
}

const base = {
  environment_default: { enabled: true, value: val(50), variants: [] },
  segment_overrides: [
    { segment: { id: 7 }, priority: 1, enabled: true, value: null, variants: [] },
    { segment: { id: 8 }, priority: 2, enabled: false, value: { type: "boolean", value: "true" }, variants: [] },
  ],
};

describe("FlagsmithClient", () => {
  it("normalizes typed values and sorts overrides", async () => {
    const { client } = fakeApi(base);
    expect(await client.getState(1)).toEqual({ enabled: true, value: 50, overrides: [
      { segment_id: 7, enabled: true, value: null }, { segment_id: 8, enabled: false, value: true }] });
  });

  it("setEnabled re-reads and reports before/after; overrides can keep it on", async () => {
    const { client, calls } = fakeApi(base);
    const r = await client.setEnabled(1, false);
    expect(r.ok).toBe(true);
    expect(r.before.enabled).toBe(true);
    expect(r.after.enabled).toBe(false);
    expect(r.after.overrides.find((o) => o.segment_id === 7)!.enabled).toBe(true); // still on for segment 7
    expect(calls.filter((c) => c.method === "PATCH")[0]!.body).toEqual({ environment_default: { enabled: false } });
    expect(calls.at(-1)!.method).toBe("GET");
  });

  it("setSegmentOverrideEnabled changes only that override and keeps the rest", async () => {
    const { client, calls } = fakeApi(base);
    const r = await client.setSegmentOverrideEnabled(1, 7, false);
    expect(r.ok).toBe(true);
    expect(r.after.overrides).toEqual([{ segment_id: 7, enabled: false, value: null }, { segment_id: 8, enabled: false, value: true }]);
    const sent = calls.find((c) => c.method === "PATCH")!.body.segment_overrides;
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toHaveProperty("variants");
    expect(sent[1]).toMatchObject({ segment: { id: 8 }, priority: 2, value: { type: "boolean", value: "true" } });
  });

  it("disableEverywhere turns off default and all overrides", async () => {
    const { client } = fakeApi(base);
    const r = await client.disableEverywhere(1);
    expect(r.ok).toBe(true);
    expect(r.after.enabled).toBe(false);
    expect(r.after.overrides.every((o) => !o.enabled)).toBe(true);
  });

  it("rejects probing when another override could be removed", async () => {
    const { client, calls } = fakeApi(base);
    await expect(client.probeDisabledOverrideList(1, 8)).rejects.toThrow("exactly one disabled demo override");
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("re-reads after omitting the sole disabled demo override", async () => {
    const { client, calls } = fakeApi({
      environment_default: { ...base.environment_default, enabled: false },
      segment_overrides: [base.segment_overrides[1]],
    });
    const result = await client.probeDisabledOverrideList(1, 8);
    expect(result.ok).toBe(true);
    expect(result.after.overrides).toEqual(result.before.overrides);
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ segment_overrides: [] });
    expect(calls.at(-1)?.method).toBe("GET");
  });

  it("reports ok=false when the re-read does not match", async () => {
    const { client } = fakeApi(base);
    (client as any).fetchImpl = vi.fn(async (_u: string, init: RequestInit) =>
      init.method === "PATCH" ? Response.json({}) : _u.includes("/projects/") ? Response.json([{ name: "Development", api_key: "k" }]) : Response.json(base));
    expect((await client.setEnabled(1, false)).ok).toBe(false);
  });

  it("retries once on 5xx, then fails with the key redacted", async () => {
    const ok = fakeApi(base, { fail5xx: 1 });
    expect((await ok.client.getState(1)).enabled).toBe(true);
    const bad = fakeApi(base, { fail5xx: 99 });
    const err = await bad.client.getState(1).catch((e) => e as Error);
    expect(err.message).toContain("502");
    expect(bad.calls).toHaveLength(2);
    expect(bad.client.redact(`Api-Key ${KEY}`)).toBe("Api-Key [REDACTED]");
  });

  it("does not retry 4xx and never leaks the key in errors", async () => {
    const fetchImpl = vi.fn(async () => new Response(`bad key ${KEY}`, { status: 401 }));
    const c = new FlagsmithClient({ apiUrl: "https://x", adminKey: KEY, projectId: 1, envName: "D", envKey: "e" }, fetchImpl as any);
    const err = await c.getState(1).catch((e) => e as Error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(err.message).not.toContain(KEY);
  });
});

it("kill switch deletes the beta override, audits it, and keeps other overrides", async () => {
  const { client, calls } = fakeApi(base);
  const log = vi.fn();
  const r = await client.disableEverywhere(1, undefined, { removeSegmentIds: [8], log });
  expect(r.ok).toBe(true);
  expect(r.after.overrides.map((o) => o.segment_id)).toEqual([7]);
  expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/segment-overrides/8/"))).toBe(true);
  expect(log).toHaveBeenCalledWith("demo_override_deleted", { feature_id: 1, segment_id: 8 });
});

it("kill switch reports not ok if the beta override survives the delete", async () => {
  const { client } = fakeApi(base);
  (client as any).fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    const { client: fresh } = fakeApi(base);
    return (fresh as any).fetchImpl(url, init);
  });
  const r = await client.disableEverywhere(1, undefined, { removeSegmentIds: [8], log: vi.fn() });
  expect(r.ok).toBe(false);
});

it("demo break recreates the beta override after the kill switch deleted it", async () => {
  const { client } = fakeApi({ ...base, segment_overrides: base.segment_overrides.filter((o) => o.segment.id !== 8) });
  const r = await client.setSegmentOverrideEnabled(1, 8, true);
  expect(r.ok).toBe(true);
  expect(r.after.overrides.find((o) => o.segment_id === 8)?.enabled).toBe(true);
});

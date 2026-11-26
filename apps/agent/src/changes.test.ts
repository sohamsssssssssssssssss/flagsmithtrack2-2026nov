import { describe, expect, it, vi } from "vitest";
import type { FlagLiveState } from "@blast/shared";
import { diffStates, listChanges, loadStates, recordChange, type StateMap } from "./changes.js";
import { openDb } from "./db.js";
import type { FlagsmithClient } from "./flagsmith.js";
import { pollOnce } from "./watcher.js";

const st = (enabled: boolean, value: FlagLiveState["value"] = null, overrides: FlagLiveState["overrides"] = []): FlagLiveState => ({ enabled, value, overrides });
const map = (o: Record<string, FlagLiveState | null>): StateMap => new Map(Object.entries(o).map(([k, s], i) => [k, { feature_id: i + 1, state: s }]));

describe("diffStates", () => {
  it("detects default, value and override changes, additions and removals", () => {
    const prev = map({ a: st(false), b: st(true, 50), c: st(true, null, [{ segment_id: 9, enabled: false, value: null }]), gone: st(true) });
    const next = map({ a: st(true), b: st(true, 60), c: st(true, null, [{ segment_id: 9, enabled: true, value: null }]), gone: null, fresh: st(false) });
    next.delete("gone");
    const d = diffStates(prev, next);
    expect(d.map((x) => x.flag_key).sort()).toEqual(["a", "b", "c", "fresh", "gone"]);
    expect(d.find((x) => x.flag_key === "gone")!.after).toBeNull();
    expect(d.find((x) => x.flag_key === "fresh")!.before).toBeNull();
  });
  it("reports nothing when equal", () => {
    expect(diffStates(map({ a: st(true, 1) }), map({ a: st(true, 1) }))).toEqual([]);
  });
});

describe("pollOnce", () => {
  const client = (states: Record<string, FlagLiveState>) => ({
    listFeatures: vi.fn(async () => Object.keys(states).map((name, i) => ({ id: i + 1, name }))),
    getState: vi.fn(async (id: number) => Object.values(states)[id - 1]!),
  }) as unknown as FlagsmithClient;

  it("baselines silently, then records poll changes", async () => {
    const db = openDb(":memory:");
    expect(await pollOnce(db, client({ a: st(false) }), "Development")).toEqual([]);
    expect(loadStates(db).get("a")!.state).toEqual(st(false));
    const c = await pollOnce(db, client({ a: st(true) }), "Development");
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ flag_key: "a", source: "poll", before: st(false), after: st(true) });
    expect(await pollOnce(db, client({ a: st(true) }), "Development")).toEqual([]);
  });

  it("does not double count an agent change", async () => {
    const db = openDb(":memory:");
    await pollOnce(db, client({ a: st(true) }), "Development");
    recordChange(db, { ts: Date.now(), env: "Development", flag_key: "a", feature_id: 1, before: st(true), after: st(false), source: "agent" });
    expect(await pollOnce(db, client({ a: st(false) }), "Development")).toEqual([]);
    expect(listChanges(db).map((c) => c.source)).toEqual(["agent"]);
  });

  it("skips a flag the agent wrote while the poll was in flight", async () => {
    const db = openDb(":memory:");
    await pollOnce(db, client({ a: st(true) }), "Development");
    const c = client({ a: st(true) }); // stale read: Flagsmith still says true
    let t = 1_000;
    (c.getState as any).mockImplementation(async () => {
      recordChange(db, { ts: 2_000, env: "Development", flag_key: "a", feature_id: 1, before: st(true), after: st(false), source: "agent" });
      return st(true);
    });
    expect(await pollOnce(db, c, "Development", () => t++)).toEqual([]);
  });
});

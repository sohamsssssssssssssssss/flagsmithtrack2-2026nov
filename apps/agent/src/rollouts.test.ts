import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { FlagLiveState } from "@blast/shared";
import { openDb, type DB } from "./db.js";
import { canApplyRollout, UnverifiedWrite, type RolloutSnapshot, type RolloutStage } from "./flagsmith.js";
import { buildProposals } from "./proposals.js";
import { buildRollouts, healthGate } from "./rollouts.js";

const dbs: DB[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function fixture() {
  let time = 100_000;
  const db = openDb(":memory:");
  dbs.push(db);
  const bus = new EventEmitter();
  const log = vi.fn();
  let state: FlagLiveState = { enabled: false, value: null, overrides: [] };
  let segment: RolloutSnapshot["segment"] = null;
  let failVerify = false;
  const client = {
    getState: async () => state,
    getRolloutSnapshot: async () => ({ state, segment }),
    redact: (error: string) => error,
    applyRollout: vi.fn(async (_flag: string, _feature: number, stage: RolloutStage,
      authorize: (snapshot: RolloutSnapshot) => void) => {
      const before = state;
      authorize({ state, segment });
      segment = { id: 19, percentage: stage };
      state = { enabled: stage === 100, value: null,
        overrides: stage === 100 ? [] : [{ segment_id: 19, enabled: true, value: null }] };
      if (failVerify) throw new UnverifiedWrite("Verification unavailable");
      return { ok: true, before, after: state };
    }),
    disableEverywhere: vi.fn(async (_feature: number, authorize?: (snapshot: FlagLiveState) => void) => {
      const before = state;
      authorize?.(before);
      state = { enabled: false, value: null, overrides: [] };
      return { ok: true, before, after: state };
    }),
  };
  const proposals = buildProposals(db, client, "Development", bus, log, () => time);
  const rollouts = buildRollouts(db, proposals, bus, 30_000, log, () => time);
  db.prepare("INSERT INTO incidents(id,opened_ts,status,evidence_json) VALUES (1,0,'closed',?)")
    .run(JSON.stringify({ route: "/checkout", start: 0, end: 20_000 }));
  db.prepare(`INSERT INTO proposals(id,incident_id,kind,payload_json,snapshot_hash,created_ts,expires_ts,status)
    VALUES (1,1,'disable_flag',?,'x',0,10000,'approved')`).run(JSON.stringify({ flag: "checkout", feature_id: 5 }));
  db.prepare("INSERT INTO actions(proposal_id,ts,outcome) VALUES (1,0,'recovered')").run();
  function samples(stage: RolloutStage, errors = 0) {
    const start = Math.ceil((time + 5_000) / 10_000) * 10_000;
    const insert = db.prepare("INSERT INTO requests(ts_bucket,route,flag_key,flag_on,count,errors) VALUES (?,'/checkout','checkout',?,?,?)");
    for (let i = 0; i < 3; i++) {
      insert.run(start + i * 10_000, 1, 12, i ? 0 : errors);
      if (stage !== 100) insert.run(start + i * 10_000, 0, 15, 0);
    }
    time = start + 32_500;
  }
  return { client, proposals, rollouts, samples, failVerification: () => { failVerify = true; } };
}

it("checks the ratio, spike, and telemetry coverage", () => {
  const clean = { requests: 50, errors: 0, rate: 0 };
  const failing = { requests: 20, errors: 1, rate: 0.05 };
  expect(healthGate(clean, clean, false, true)).toMatchObject({ ok: true, test: "fisher", p: 1 });
  expect(healthGate(failing, clean, false, true).ok).toBe(false);
  expect(healthGate(clean, clean, true, true).ok).toBe(false);
  expect(healthGate(clean, clean, false, false).ok).toBe(false);
});

it("requires separate approval at each hold and uses the 50% control at 100%", async () => {
  const { client, proposals, rollouts, samples } = fixture();
  await expect(rollouts.start(1, false)).rejects.toThrow("Confirm the fix");
  await rollouts.start(1, true);
  for (const [index, stage] of ([10, 50, 100] as const).entries()) {
    await rollouts.tick();
    const pending = rollouts.get(1)!.stages.find((item) => item.stage === stage)!;
    expect(pending.status).toBe("pending");
    expect(client.applyRollout).toHaveBeenCalledTimes(index);
    await proposals.approve(pending.proposal_id, "reviewer");
    await rollouts.tick();
    expect(rollouts.get(1)!.stage).toBe(stage);
    samples(stage);
    await rollouts.tick();
  }
  expect(rollouts.get(1)).toMatchObject({ status: "complete", stages: [
    { outcome: "stage_passed" }, { outcome: "stage_passed" }, { outcome: "stage_passed", gate: { control: "stage_50" } },
  ] });
});

it("pauses and proposes a disable after a failed gate", async () => {
  const { client, proposals, rollouts, samples } = fixture();
  const plan = await rollouts.start(1, true);
  await proposals.approve(plan!.stages[0]!.proposal_id, "reviewer");
  samples(10, 1);
  await rollouts.tick();
  await rollouts.tick();
  const paused = rollouts.get(1);
  expect(paused).toMatchObject({ status: "paused", rollback: { status: "pending", kind: "disable_flag" } });
  expect(client.disableEverywhere).not.toHaveBeenCalled();
  await proposals.approve(paused!.rollback.id, "reviewer");
  expect(client.disableEverywhere).toHaveBeenCalledOnce();
});

it("marks a verification failure PARTIAL and prevents promotion", async () => {
  const { client, proposals, rollouts, failVerification } = fixture();
  const plan = await rollouts.start(1, true);
  failVerification();
  await expect(proposals.approve(plan!.stages[0]!.proposal_id, "reviewer")).rejects.toThrow("PARTIAL");
  await rollouts.tick();
  expect(rollouts.get(1)).toMatchObject({ stage: 10, status: "paused", stages: [{ outcome: "PARTIAL" }] });
  expect(client.applyRollout).toHaveBeenCalledOnce();
});


it("refuses to hide unrelated overrides or skip the previous percentage", () => {
  const state = { enabled: false, value: null, overrides: [{ segment_id: 19, enabled: false, value: null }] };
  expect(canApplyRollout({ state, segment: null }, 10)).toBe(false);
  state.overrides[0]!.enabled = true;
  expect(canApplyRollout({ state, segment: { id: 19, percentage: 10 } }, 50)).toBe(true);
  expect(canApplyRollout({ state, segment: { id: 19, percentage: 10 } }, 100)).toBe(false);
});

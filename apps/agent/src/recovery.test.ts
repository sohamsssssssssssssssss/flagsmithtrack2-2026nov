import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { openDb, type DB } from "./db.js";
import { assessRecovery, MAX_RECOVERY_WAIT_MS, recordVerification } from "./recovery.js";
import type { Bucket } from "./metrics.js";

const dbs: DB[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

// Buckets every 10s from `from` up to (excluding) `to`, with `requests` each and `errors` on the last.
function traffic(from: number, to: number, requests: number, errors = 0): Bucket[] {
  const out: Bucket[] = [];
  for (let ts = from; ts < to; ts += 10_000) {
    out.push({ ts, requests, errors: ts === to - 10_000 ? errors : 0, rate: requests ? (ts === to - 10_000 ? errors : 0) / requests : null });
  }
  return out;
}

const since = 100_000;
const clean = traffic(since, since + 600_000, 10);
const at = (ms: number) => since + ms;

it("keeps watching while the recovery window has too little traffic", () => {
  const sparse = traffic(since, since + 600_000, 1);
  expect(assessRecovery(sparse, since, 0, at(150_000))).toMatchObject({ outcome: "watching", reason: null });
});

it("keeps watching before the window is complete after the disable", () => {
  expect(assessRecovery(clean, since, 0, at(60_000))).toMatchObject({ outcome: "watching" });
});

it("reports inconclusive (not not_recovered) once the wait cap passes with no usable traffic", () => {
  const none: Bucket[] = [];
  const result = assessRecovery(none, since, 0, at(MAX_RECOVERY_WAIT_MS + 1));
  expect(result).toMatchObject({ outcome: "inconclusive", reason: "inconclusive: insufficient traffic" });
});

it("recovers on enough clean traffic", () => {
  expect(assessRecovery(clean, since, 0, at(200_000))).toMatchObject({ outcome: "recovered", reason: null });
});

it("marks not_recovered when the failing route still errors on enough traffic", () => {
  const failing = clean.map((bucket) => ({ ...bucket, errors: 3, rate: 0.3 }));
  expect(assessRecovery(failing, since, 0, at(200_000))).toMatchObject({ outcome: "not_recovered", reason: null });
});

it("appends verification records and keeps the earlier ones", () => {
  const db = openDb(":memory:");
  dbs.push(db);
  db.prepare("INSERT INTO incidents(id,opened_ts,status,evidence_json) VALUES (1,0,'closed','{}')").run();
  db.prepare(`INSERT INTO proposals(id,incident_id,kind,payload_json,snapshot_hash,created_ts,expires_ts,status)
    VALUES (1,1,'disable_flag','{}','x',0,0,'approved')`).run();
  db.prepare("INSERT INTO actions(id,proposal_id,ts,outcome,outcome_ts) VALUES (1,1,0,'watching',0)").run();
  const bus = new EventEmitter();
  const log = vi.fn();
  const assess = (outcome: "inconclusive" | "recovered") => ({ outcome, reason: outcome === "inconclusive" ? "inconclusive: insufficient traffic" : null, requests: 5, window_end: 1 });
  recordVerification(db, bus, log, 1, assess("inconclusive"), "auto", null, 1_000);
  recordVerification(db, bus, log, 1, assess("recovered"), "manual", "reviewer", 2_000);
  const rows = db.prepare("SELECT outcome,trigger,actor FROM verifications WHERE action_id=1 ORDER BY id").all();
  expect(rows).toEqual([
    { outcome: "inconclusive", trigger: "auto", actor: null },
    { outcome: "recovered", trigger: "manual", actor: "reviewer" },
  ]);
  expect(db.prepare("SELECT outcome FROM actions WHERE id=1").get()).toEqual({ outcome: "recovered" });
  expect(log).toHaveBeenCalledWith("verification_recorded", expect.objectContaining({ action_id: 1, trigger: "manual", actor: "reviewer" }));
});

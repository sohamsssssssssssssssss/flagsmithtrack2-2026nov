import type { EventEmitter } from "node:events";
import { audit } from "./audit.js";
import type { DB } from "./db.js";
import { recovered, RECOVERY_MS } from "./detector.js";
import { BUCKET_MS, type Bucket } from "./metrics.js";

export const MIN_RECOVERY_REQUESTS = 100;
export const MAX_RECOVERY_WAIT_MS = 5 * 60_000;
export const INSUFFICIENT_TRAFFIC = "inconclusive: insufficient traffic";

export type RecoveryOutcome = "watching" | "recovered" | "not_recovered" | "inconclusive";
export type Assessment = { outcome: RecoveryOutcome; reason: string | null; requests: number; window_end: number };

/**
 * Judge recovery of the failing route after a disable. Missing or thin traffic is never a failure:
 * the check keeps watching until enough requests arrive, then reports inconclusive after MAX_RECOVERY_WAIT_MS.
 * `since` is the time the disable was verified (or the manual re-check's reference point).
 */
export function assessRecovery(buckets: Bucket[], since: number, baseline: number, now: number): Assessment {
  const windowEnd = Math.floor((now - 2_500) / BUCKET_MS) * BUCKET_MS;
  const windowStart = windowEnd - RECOVERY_MS;
  const window = buckets.filter((bucket) => bucket.ts >= windowStart && bucket.ts < windowEnd);
  const requests = window.reduce((sum, bucket) => sum + (bucket.requests ?? 0), 0);
  const complete = windowStart >= Math.ceil(since / BUCKET_MS) * BUCKET_MS && window.length === RECOVERY_MS / BUCKET_MS
    && window.every((bucket) => (bucket.requests ?? 0) > 0);
  const expired = now - since >= MAX_RECOVERY_WAIT_MS;
  if (!complete || requests < MIN_RECOVERY_REQUESTS) {
    return expired
      ? { outcome: "inconclusive", reason: INSUFFICIENT_TRAFFIC, requests, window_end: windowEnd }
      : { outcome: "watching", reason: null, requests, window_end: windowEnd };
  }
  return { outcome: recovered(buckets, windowEnd, baseline) ? "recovered" : "not_recovered",
    reason: null, requests, window_end: windowEnd };
}

/** Appends a verification record and mirrors its outcome onto the action. Old records are never changed. */
export function recordVerification(db: DB, bus: EventEmitter, log: typeof audit, actionId: number,
  assessment: Assessment, trigger: "auto" | "manual", actor: string | null, now: number) {
  const incident = db.prepare(`SELECT p.incident_id FROM actions a JOIN proposals p ON p.id=a.proposal_id WHERE a.id=?`)
    .get(actionId) as { incident_id: number } | undefined;
  db.transaction(() => {
    db.prepare("INSERT INTO verifications(action_id,ts,outcome,reason,requests,trigger,actor) VALUES (?,?,?,?,?,?,?)")
      .run(actionId, now, assessment.outcome, assessment.reason, assessment.requests, trigger, actor);
    db.prepare("UPDATE actions SET outcome=?,outcome_ts=? WHERE id=?").run(assessment.outcome, now, actionId);
  })();
  log("verification_recorded", { action_id: actionId, incident_id: incident?.incident_id, trigger, actor, ...assessment });
  bus.emit("action_done", { incident_id: incident?.incident_id, outcome: assessment.outcome });
}

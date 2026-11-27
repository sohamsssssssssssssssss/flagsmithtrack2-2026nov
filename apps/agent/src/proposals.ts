import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { FlagLiveState } from "@blast/shared";
import { audit } from "./audit.js";
import { loadStates, recordChange } from "./changes.js";
import type { DB } from "./db.js";
import { canApplyRollout, FlagsmithError, UnverifiedWrite, type FlagsmithClient, type RolloutSnapshot, type RolloutStage } from "./flagsmith.js";
import type { rankFlags } from "./ranker.js";

type Evidence = ReturnType<typeof rankFlags>["ranking"][number];
type Client = Pick<FlagsmithClient, "getState" | "disableEverywhere" | "redact"> &
  Partial<Pick<FlagsmithClient, "getRolloutSnapshot" | "applyRollout">>;
type Payload = { flag: string; feature_id: number; evidence?: Evidence; stage?: RolloutStage; rollback?: true };
type Kind = "disable_flag" | "rollout_stage";
type Proposal = {
  id: number; incident_id: number; kind: string; payload_json: string; snapshot_hash: string;
  created_ts: number; expires_ts: number; status: string; approver: string | null; decision_ts: number | null;
};

export class DecisionError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}

export function snapshotHash(incident: number, feature: number, state: FlagLiveState) {
  const overrides = [...state.overrides].sort((a, b) => a.segment_id - b.segment_id)
    .map((o) => [o.segment_id, o.enabled, o.value]);
  return createHash("sha256").update(JSON.stringify([incident, feature, state.enabled, state.value, overrides])).digest("hex");
}

const rolloutHash = (incident: number, feature: number, snapshot: RolloutSnapshot) =>
  createHash("sha256").update(JSON.stringify([snapshotHash(incident, feature, snapshot.state), snapshot.segment])).digest("hex");

// A human clicks each rollout stage, so stage approvals stay open for 30 minutes.
export const STAGE_APPROVAL_MS = 30 * 60_000;
const decodeProposal = ({ payload_json, created_ts, expires_ts, ...row }: Proposal) =>
  ({ ...row, ...JSON.parse(payload_json), created: created_ts, expires: expires_ts });

export function buildProposals(db: DB, client: Client, env: string, bus: EventEmitter, log = audit, now = Date.now) {
  const lookup = (id: number) => db.prepare("SELECT * FROM proposals WHERE id=?").get(id) as Proposal | undefined;
  const isOpen = (id: number) => db.prepare("SELECT 1 FROM incidents WHERE id=? AND status='open'").get(id);
  const get = (id: number) => {
    const proposal = lookup(id);
    if (!proposal) throw new DecisionError("Proposal not found", 404);
    return proposal;
  };
  function expire() {
    db.prepare("UPDATE proposals SET status='expired',decision_ts=? WHERE status='pending' AND expires_ts<=?").run(now(), now());
  }
  async function create(incident: number, evidence: Evidence) {
    expire();
    if (!isOpen(incident)) throw new DecisionError("Incident is closed");
    const feature = loadStates(db).get(evidence.flag);
    if (!feature?.state) throw new DecisionError("Flag has no known live feature");
    const state = await client.getState(feature.feature_id).catch(() => {
      throw new DecisionError("Could not read live flag state", 502);
    });
    if (!state.enabled && !state.overrides.some((o) => o.enabled)) throw new DecisionError("Flag is already disabled");
    if (!isOpen(incident)) throw new DecisionError("Incident is closed");
    return enqueue(incident, "disable_flag", { flag: evidence.flag, feature_id: feature.feature_id, evidence },
      snapshotHash(incident, feature.feature_id, state));
  }

  function enqueue(incident: number, kind: Kind, payload: Payload, hash: string) {
    const created = now();
    const result = db.prepare(`INSERT OR IGNORE INTO proposals(incident_id,kind,payload_json,snapshot_hash,created_ts,expires_ts,status)
      VALUES (?,?,?,?,?,?,'pending')`).run(incident, kind, JSON.stringify(payload), hash, created,
        created + (kind === "rollout_stage" ? STAGE_APPROVAL_MS : 600_000));
    if (!result.changes) throw new DecisionError("Incident already has a pending proposal");
    const proposal = decodeProposal(get(Number(result.lastInsertRowid)));
    log("proposal_created", { proposal });
    bus.emit("proposal_created", proposal);
    return proposal;
  }

  async function queueRollout(incident: number, flag: string, feature: number, stage: RolloutStage) {
    if (!client.getRolloutSnapshot) throw new DecisionError("Rollout is unavailable", 503);
    const snapshot = await client.getRolloutSnapshot(flag, feature);
    if (snapshot.state.overrides.some((override) => override.segment_id !== snapshot.segment?.id)) {
      throw new DecisionError("Resolve other segment overrides before starting rollout");
    }
    if (!canApplyRollout(snapshot, stage)) throw new DecisionError("Flag state is outside this rollout stage");
    return enqueue(incident, "rollout_stage", { flag, feature_id: feature, stage }, rolloutHash(incident, feature, snapshot));
  }

  async function queueRollback(incident: number, flag: string, feature: number) {
    const state = await client.getState(feature);
    if (!state.enabled && !state.overrides.some((override) => override.enabled)) return;
    enqueue(incident, "disable_flag", { flag, feature_id: feature, rollback: true }, snapshotHash(incident, feature, state));
  }

  function eligible(p: Proposal) {
    const payload = JSON.parse(p.payload_json) as Payload;
    if (p.kind === "disable_flag" && !payload.rollback) return Boolean(isOpen(p.incident_id));
    const rollout = db.prepare("SELECT status,stage,flag,feature_id FROM rollouts WHERE incident_id=?").get(p.incident_id) as
      { status: string; stage: number; flag: string; feature_id: number } | undefined;
    if (!rollout || rollout.flag !== payload.flag || rollout.feature_id !== payload.feature_id) return false;
    return p.kind === "rollout_stage" ? rollout.status === "active" && rollout.stage === payload.stage
      && !db.prepare("SELECT 1 FROM incidents WHERE status='open' LIMIT 1").get()
      : p.kind === "disable_flag" && payload.rollback === true && rollout.status === "paused";
  }

  function applyDecision(id: number, approver: string, approve: boolean) {
    expire();
    const p = get(id);
    if (p.status === "expired") throw new DecisionError("Proposal expired");
    if (p.status !== "pending" || !eligible(p)) throw new DecisionError("Proposal is no longer pending");
    if (p.kind !== "disable_flag" && p.kind !== "rollout_stage") throw new DecisionError("Action is outside the allowlist");
    const status = approve ? "executing" : "rejected";
    const result = db.prepare("UPDATE proposals SET status=?,approver=?,decision_ts=? WHERE id=? AND status='pending' AND expires_ts>?")
      .run(status, approver, now(), id, now());
    if (!result.changes) throw new DecisionError("Proposal is no longer pending");
    return p;
  }

  function reject(id: number, approver: string) {
    applyDecision(id, approver, false);
    log("proposal_rejected", { id, approver });
    return decodeProposal(get(id));
  }

  async function approve(id: number, approver: string) {
    const p = applyDecision(id, approver, true);
    const { flag, feature_id, stage, rollback } = JSON.parse(p.payload_json) as Payload;
    let actionId: number | undefined;
    let result: Awaited<ReturnType<Client["disableEverywhere"]>>;
    try {
      function authorize(hash: string) {
        if (!eligible(p)) throw new DecisionError("Proposal is no longer eligible");
        if (hash !== p.snapshot_hash) throw new DecisionError("Flag state changed");
        if (now() >= p.expires_ts) throw new DecisionError("Proposal expired");
        log("proposal_approved", { id, approver, snapshot_hash: p.snapshot_hash });
        actionId = Number(db.prepare(`INSERT INTO actions(proposal_id,ts,request_json,outcome)
          VALUES (?,?,?,'executing')`).run(id, now(), JSON.stringify({ kind: p.kind, flag, feature_id, stage })).lastInsertRowid);
      }
      if (p.kind === "rollout_stage") {
        if (!client.applyRollout || !stage || ![10, 50, 100].includes(stage)) throw new DecisionError("Invalid rollout stage");
        result = await client.applyRollout(flag, feature_id, stage, (snapshot) =>
          authorize(rolloutHash(p.incident_id, feature_id, snapshot)));
      } else {
        result = await client.disableEverywhere(feature_id, (state) => authorize(snapshotHash(p.incident_id, feature_id, state)));
      }
    } catch (error) {
      const message = client.redact(error instanceof Error ? error.message : String(error));
      const outcome = actionId !== undefined && (error instanceof UnverifiedWrite || !(error instanceof FlagsmithError))
        ? "PARTIAL" : "failed";
      if (actionId !== undefined) {
        const responseStatus = error instanceof FlagsmithError ? error.status ?? null : null;
        db.prepare("UPDATE actions SET response_status=?,verify_json=?,outcome=?,outcome_ts=? WHERE id=?")
          .run(responseStatus, JSON.stringify({ ok: false, error: message }), outcome, now(), actionId);
        bus.emit("action_done", { id: actionId, incident_id: p.incident_id, outcome });
      }
      db.prepare("UPDATE proposals SET status=? WHERE id=?").run(
        error instanceof DecisionError ? (message.includes("expired") ? "expired" : "refused") : outcome, id);
      log("proposal_execution_failed", { id, approver, action_id: actionId, outcome, error: message });
      if (error instanceof DecisionError) throw error;
      throw new DecisionError(outcome === "PARTIAL" ? "PARTIAL: write could not be verified" : "Flagsmith action failed", 502);
    }

    const outcome = !result.ok ? "PARTIAL" : p.kind === "rollout_stage" ? "watching_rollout" : rollback ? "disabled" : "watching";
    const ts = now();
    db.transaction(() => {
      db.prepare("UPDATE actions SET verify_json=?,outcome=?,outcome_ts=? WHERE id=?")
        .run(JSON.stringify(result), outcome, ts, actionId);
      db.prepare("UPDATE proposals SET status=? WHERE id=?").run(result.ok ? "approved" : "PARTIAL", id);
      const change = { ts, env, flag_key: flag, feature_id, before: result.before, after: result.after, source: "agent" as const };
      if (snapshotHash(p.incident_id, feature_id, result.before) !== snapshotHash(p.incident_id, feature_id, result.after)) {
        recordChange(db, change);
      }
    })();
    const action = { id: actionId, incident_id: p.incident_id, outcome, verified: result.ok };
    log("action_done", action);
    bus.emit("action_done", action);
    return action;
  }

  function list(incident: number) {
    expire();
    return (db.prepare("SELECT * FROM proposals WHERE incident_id=? ORDER BY id DESC").all(incident) as Proposal[]).map(decodeProposal);
  }

  return { create, approve, reject, list, expire, queueRollout, queueRollback };
}

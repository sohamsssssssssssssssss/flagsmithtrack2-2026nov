import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { FlagLiveState } from "@blast/shared";
import { audit } from "./audit.js";
import { loadStates, recordChange } from "./changes.js";
import type { DB } from "./db.js";
import { FlagsmithError, UnverifiedWrite, type FlagsmithClient } from "./flagsmith.js";
import type { rankFlags } from "./ranker.js";

type Evidence = ReturnType<typeof rankFlags>["ranking"][number];
type Client = Pick<FlagsmithClient, "getState" | "disableEverywhere" | "redact">;
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
    const created = now();
    const payload = { flag: evidence.flag, feature_id: feature.feature_id, evidence };
    const result = db.prepare(`INSERT OR IGNORE INTO proposals(incident_id,kind,payload_json,snapshot_hash,created_ts,expires_ts,status)
      VALUES (?,'disable_flag',?,?,?,?, 'pending')`).run(incident, JSON.stringify(payload),
      snapshotHash(incident, feature.feature_id, state), created, created + 600_000);
    if (!result.changes) throw new DecisionError("Incident already has a pending proposal");
    const proposal = decodeProposal(get(Number(result.lastInsertRowid)));
    log("proposal_created", { proposal });
    bus.emit("proposal_created", proposal);
    return proposal;
  }

  function applyDecision(id: number, approver: string, approve: boolean) {
    expire();
    const p = get(id);
    if (p.status === "expired") throw new DecisionError("Proposal expired");
    if (p.status !== "pending" || !isOpen(p.incident_id)) throw new DecisionError("Proposal is no longer pending");
    if (p.kind !== "disable_flag") throw new DecisionError("Action is outside the disable-only allowlist");
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
    const { flag, feature_id } = JSON.parse(p.payload_json) as { flag: string; feature_id: number };
    let actionId: number | undefined;
    let result: Awaited<ReturnType<Client["disableEverywhere"]>>;
    try {
      result = await client.disableEverywhere(feature_id, (state) => {
        if (!isOpen(p.incident_id)) throw new DecisionError("Incident is closed");
        if (snapshotHash(p.incident_id, feature_id, state) !== p.snapshot_hash) throw new DecisionError("Flag state changed");
        if (now() >= p.expires_ts) throw new DecisionError("Proposal expired");
        log("proposal_approved", { id, approver, snapshot_hash: p.snapshot_hash });
        actionId = Number(db.prepare(`INSERT INTO actions(proposal_id,ts,request_json,outcome)
          VALUES (?,?,?,'executing')`).run(id, now(), JSON.stringify({ kind: "disable_flag", flag, feature_id })).lastInsertRowid);
      });
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

    const outcome = result.ok ? "watching" : "PARTIAL";
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

  return { create, approve, reject, list, expire };
}

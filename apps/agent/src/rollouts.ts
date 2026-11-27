import type { EventEmitter } from "node:events";
import { audit } from "./audit.js";
import type { DB } from "./db.js";
import { detectSpike, totals } from "./detector.js";
import { compareRates, type Sample } from "./fisher.js";
import type { RolloutStage } from "./flagsmith.js";
import { aggregate, BUCKET_MS, type RequestRow } from "./metrics.js";
import { DecisionError, type buildProposals } from "./proposals.js";
import { localSha, shopSha, type Versions } from "./version.js";
import { ROOT } from "./config.js";

const stages = [10, 50, 100] as const;
type Plan = {
  incident_id: number; flag: string; feature_id: number; route: string; stage: RolloutStage;
  status: "active" | "paused" | "complete"; hold_ms: number; reason: string | null; rollback_checked: number;
};
type StageRecord = {
  proposal_id: number; status: string; stage: RolloutStage; action_id: number | null; outcome: string | null;
  outcome_ts: number | null; verify_json: string | null; expires_ts: number;
};

export const INSUFFICIENT_TELEMETRY = "Insufficient cohort telemetry";

export function healthGate(on: Sample, off: Sample, spike: boolean, coverage: boolean) {
  const comparison = compareRates(on, off);
  const reason = spike ? "Error spike detected"
    : !coverage || !comparison.test ? INSUFFICIENT_TELEMETRY
    : on.rate! > 1.5 * off.rate! ? "Flag-on error rate exceeds 1.5× control" : null;
  return { ok: reason === null, reason, on, off, spike, ...comparison };
}

export function buildRollouts(db: DB, proposals: ReturnType<typeof buildProposals>, bus: EventEmitter,
  holdMs = 120_000, log = audit, now = Date.now,
  versions: Versions = { shop: () => shopSha(), local: () => localSha(ROOT) }) {
  const initializing = new Set<number>();
  const plans = db.prepare("SELECT * FROM rollouts WHERE incident_id=?");
  const records = db.prepare(`SELECT p.id AS proposal_id,p.status,p.expires_ts,json_extract(p.payload_json,'$.stage') AS stage,
    a.id AS action_id,a.outcome,a.outcome_ts,a.verify_json FROM proposals p LEFT JOIN actions a ON a.proposal_id=p.id
    WHERE p.incident_id=? AND p.kind='rollout_stage' ORDER BY p.id`);
  function get(id: number) {
    const plan = plans.get(id) as Plan | undefined;
    if (!plan) return null;
    const rows = (records.all(id) as StageRecord[]).map(({ verify_json, ...row }) => ({
      ...row, gate: verify_json ? JSON.parse(verify_json).gate ?? null : null,
    }));
    const rollback = proposals.list(id).find((proposal) => proposal.rollback);
    return { ...plan, stages: rows, rollback: rollback ?? null };
  }

  async function start(id: number) {
    // The shop must run the same commit as the demo checkout, so a rollout never re-enables an unfixed shop.
    const [shop, local] = await Promise.all([versions.shop(), versions.local()]).catch(() => {
      throw new DecisionError("Could not read the shop version; start the shop and try again", 503);
    });
    if (shop !== local) {
      throw new DecisionError(`The shop runs ${shop.slice(0, 7)} but the demo checkout is at ${local.slice(0, 7)}; run demo-restart-shop first`, 409);
    }
    const incident = db.prepare("SELECT evidence_json,status FROM incidents WHERE id=?").get(id) as
      { evidence_json: string; status: string } | undefined;
    if (!incident || incident.status !== "closed") throw new DecisionError("A closed incident is required");
    const source = db.prepare(`SELECT p.payload_json FROM proposals p JOIN actions a ON a.proposal_id=p.id
      WHERE p.incident_id=? AND p.kind='disable_flag' AND p.status='approved'
        AND COALESCE((SELECT v.outcome FROM verifications v WHERE v.action_id=a.id ORDER BY v.id DESC LIMIT 1), a.outcome)='recovered'
      ORDER BY a.id DESC LIMIT 1`).get(id) as { payload_json: string } | undefined;
    if (!source) throw new DecisionError("A verified disable and recovery are required");
    const { flag, feature_id } = JSON.parse(source.payload_json) as { flag: string; feature_id: number };
    const evidence = JSON.parse(incident.evidence_json);
    const sample = db.prepare(`SELECT route FROM errors WHERE ts>=? AND ts<? GROUP BY route ORDER BY count(*) DESC, route LIMIT 1`)
      .get(evidence.start, evidence.end) as { route: string } | undefined;
    const route = evidence.route ?? sample?.route;
    if (!route) throw new DecisionError("The incident has no failing route to monitor");
    const inserted = db.prepare(`INSERT OR IGNORE INTO rollouts(incident_id,flag,feature_id,route,stage,status,hold_ms,started_ts)
      VALUES (?,?,?,?,10,'active',?,?)`).run(id, flag, feature_id, route, holdMs, now());
    if (!inserted.changes) throw new DecisionError("A rollout already exists for this incident or flag");
    initializing.add(id);
    try {
      await proposals.queueRollout(id, flag, feature_id, 10);
    } catch (error) {
      db.prepare("DELETE FROM rollouts WHERE incident_id=?").run(id);
      throw error;
    } finally {
      initializing.delete(id);
    }
    log("rollout_started", { incident_id: id, flag, route, hold_ms: holdMs });
    return get(id);
  }

  /** Re-queues the current stage of a paused rollout whose stage approval expired unanswered. */
  async function requeue(id: number, actor: string) {
    const plan = plans.get(id) as Plan | undefined;
    if (!plan) throw new DecisionError("Rollout not found", 404);
    if (plan.status !== "paused") throw new DecisionError("Only a paused rollout can be re-queued");
    const incident = db.prepare("SELECT status FROM incidents WHERE id=?").get(id) as { status: string } | undefined;
    if (incident?.status !== "closed") throw new DecisionError("A closed incident is required");
    if (db.prepare("SELECT 1 FROM proposals WHERE incident_id=? AND status='pending' LIMIT 1").get(id)) {
      throw new DecisionError("Incident already has a pending proposal");
    }
    const latest = (records.all(id) as StageRecord[]).filter((record) => record.stage === plan.stage).at(-1);
    const insufficient = latest?.status === "approved" && latest.outcome === "stage_failed"
      && JSON.parse(latest.verify_json ?? "{}").gate?.reason === INSUFFICIENT_TELEMETRY;
    if (!latest || (latest.status !== "expired" && !insufficient)) {
      throw new DecisionError("Only an expired stage approval or a stage that lacked telemetry can be re-queued");
    }
    const why = latest.status === "expired" ? "expired" : "insufficient telemetry";
    db.prepare("UPDATE rollouts SET status='active',reason=NULL WHERE incident_id=?").run(id);
    initializing.add(id);
    try {
      await proposals.queueRollout(id, plan.flag, plan.feature_id, plan.stage);
    } catch (error) {
      db.prepare("UPDATE rollouts SET status='paused',reason=? WHERE incident_id=?")
        .run(error instanceof Error ? error.message : "Re-queue failed", id);
      throw error;
    } finally {
      initializing.delete(id);
    }
    log("rollout_requeued", { incident_id: id, stage: plan.stage, actor, reason: why, previous_proposal_id: latest.proposal_id });
    bus.emit("action_done", { incident_id: id, stage: plan.stage, outcome: "requeued" });
    return get(id);
  }

  function pause(plan: Plan, reason: string) {
    db.prepare("UPDATE rollouts SET status='paused',reason=? WHERE incident_id=?").run(reason, plan.incident_id);
    log("rollout_paused", { incident_id: plan.incident_id, stage: plan.stage, reason });
    bus.emit("action_done", { incident_id: plan.incident_id, outcome: "paused" });
  }

  async function evaluate(plan: Plan) {
    const { incident_id: id, flag, feature_id: feature, route, stage } = plan;
    if (plan.status === "paused") {
      if (!plan.rollback_checked) {
        await proposals.queueRollback(id, flag, feature);
        db.prepare("UPDATE rollouts SET rollback_checked=1 WHERE incident_id=?").run(id);
      }
      return;
    }
    if (db.prepare("SELECT 1 FROM incidents WHERE status='open' LIMIT 1").get()) {
      db.prepare("UPDATE proposals SET status='cancelled',decision_ts=? WHERE incident_id=? AND kind='rollout_stage' AND status='pending'")
        .run(now(), id);
      pause(plan, "An incident opened during rollout");
      return;
    }
    const history = records.all(id) as StageRecord[];
    const current = history.filter((record) => record.stage === stage).at(-1);
    if (!current) {
      try { await proposals.queueRollout(id, flag, feature, stage); }
      catch (error) {
        if (!(error instanceof DecisionError) || error.statusCode !== 409) throw error;
        pause(plan, error.message);
      }
      return;
    }
    if (!["pending", "executing", "approved"].includes(current.status)) {
      pause(plan, `Stage approval or verification ended as ${current.status}`);
      return;
    }
    if (current.outcome !== "watching_rollout" || current.outcome_ts === null) return;
    // Start after one SDK refresh and use complete buckets throughout the hold.
    const start = Math.ceil((current.outcome_ts + 5_000) / BUCKET_MS) * BUCKET_MS;

    // Too little telemetry is not evidence of harm: wait for more complete buckets, up to 3x the hold, before failing.
    const cap = start + 3 * plan.hold_ms;
    const gateAt = (windowEnd: number) => {
      const rows = db.prepare("SELECT * FROM requests WHERE ts_bucket>=? AND ts_bucket<?")
        .all(start - 620_000, windowEnd) as RequestRow[];
      const series = aggregate(rows);
      const inHold = rows.filter((row) => row.ts_bucket >= start && row.route === route && row.flag_key === flag);
      const sample = (on: boolean) => totals(inHold.filter((row) => Boolean(row.flag_on) === on)
        .map((row) => ({ requests: row.count, errors: row.errors })));
      const on = sample(true), liveOff = sample(false);
      // At 100% the preceding 50% hold supplies the comparison cohort.
      const control = history.find((record) => record.stage === 50 && record.outcome === "stage_passed");
      const off: Sample = stage === 100 && control?.verify_json ? JSON.parse(control.verify_json).gate.off : liveOff;
      const coverage = new Set(inHold.filter((row) => row.count > 0)
        .map((row) => Math.floor(row.ts_bucket / BUCKET_MS))).size >= plan.hold_ms / BUCKET_MS;
      let spike = false;
      for (let ts = start + BUCKET_MS; ts <= windowEnd && !spike; ts += BUCKET_MS) {
        spike = Boolean(detectSpike(series.overall, ts) || Object.values(series.by_route).some((buckets) => detectSpike(buckets, ts)));
      }
      return { ...healthGate(on, off, spike, coverage && (stage !== 100 || liveOff.requests === 0)),
        control: stage === 100 ? "stage_50" : "concurrent", start, end: windowEnd };
    };
    let end = start + plan.hold_ms;
    if (now() < end + 2_500) return;
    let gate = gateAt(end);
    if (!gate.ok && gate.reason === INSUFFICIENT_TELEMETRY) {
      const latest = Math.min(cap, Math.floor((now() - 2_500) / BUCKET_MS) * BUCKET_MS);
      if (latest > end) gate = gateAt(end = latest);
      if (!gate.ok && gate.reason === INSUFFICIENT_TELEMETRY && latest < cap) return;
    }
    const next = stages[stages.indexOf(stage) + 1];
    const outcome = gate.ok ? "stage_passed" : "stage_failed";
    db.transaction(() => {
      db.prepare("UPDATE actions SET verify_json=?,outcome=?,outcome_ts=? WHERE id=?")
        .run(JSON.stringify({ ...JSON.parse(current.verify_json ?? "{}"), gate }), outcome, now(), current.action_id);
      if (gate.ok && next) db.prepare("UPDATE rollouts SET stage=? WHERE incident_id=?").run(next, id);
      else if (gate.ok) db.prepare("UPDATE rollouts SET status='complete' WHERE incident_id=?").run(id);
      // Insufficient telemetry pauses without proposing a rollback: nothing showed harm.
      else db.prepare("UPDATE rollouts SET status='paused',reason=?,rollback_checked=? WHERE incident_id=?")
        .run(gate.reason, gate.reason === INSUFFICIENT_TELEMETRY ? 1 : 0, id);
    })();
    log("rollout_gate", { incident_id: id, stage, outcome, gate });
    bus.emit("action_done", { incident_id: id, stage, outcome });
  }

  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      proposals.expire();
      for (const plan of db.prepare("SELECT * FROM rollouts WHERE status='active' OR (status='paused' AND rollback_checked=0)").all() as Plan[]) {
        if (initializing.has(plan.incident_id)) continue;
        try { await evaluate(plan); }
        catch { log("rollout_evaluation_retry", { incident_id: plan.incident_id, stage: plan.stage }); }
      }
    } finally { running = false; }
  }
  return { start, requeue, get, tick, status: (id: number) => (plans.get(id) as Plan | undefined)?.status ?? null };
}

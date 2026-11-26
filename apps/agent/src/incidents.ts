import type { EventEmitter } from "node:events";
import { audit } from "./audit.js";
import type { DB } from "./db.js";
import { detectSpike, recovered, RECOVERY_MS } from "./detector.js";
import { aggregate, BUCKET_MS, type RequestRow } from "./metrics.js";
import { DecisionError, type buildProposals } from "./proposals.js";
import { rankFlags, readFlagFiles, type Failure, type RecentChange } from "./ranker.js";

type Spike = NonNullable<ReturnType<typeof detectSpike>> & { route?: string };
type Ranking = ReturnType<typeof rankFlags>;
type IncidentRow = {
  id: number; opened_ts: number; closed_ts: number | null; status: string; top_flag: string | null;
  ranking_json: string; evidence_json: string;
};
const decode = ({ ranking_json, evidence_json, ...row }: IncidentRow) =>
  ({ ...row, ...(JSON.parse(ranking_json) as Ranking), evidence: JSON.parse(evidence_json) as Spike });

export function buildIncidents(db: DB, proposals: ReturnType<typeof buildProposals>, bus: EventEmitter,
  log = audit, now = Date.now) {
  const interval = 250;
  let evaluatedEnd = -1;
  const requests = db.prepare("SELECT * FROM requests WHERE ts_bucket>=? AND ts_bucket<?");
  const failures = db.prepare("SELECT route, stack, flags_json FROM errors WHERE ts>=? AND ts<?");
  const changes = db.prepare("SELECT ts, flag_key FROM flag_changes WHERE ts>=? AND ts<=? ORDER BY ts DESC, id DESC");
  let running = false;

  // A process can stop after dispatch but before storing verification.
  db.prepare("UPDATE actions SET outcome='PARTIAL',outcome_ts=? WHERE outcome='executing'").run(now());
  db.prepare(`UPDATE proposals SET status=CASE WHEN EXISTS(SELECT 1 FROM actions WHERE proposal_id=proposals.id)
    THEN 'PARTIAL' ELSE 'failed' END WHERE status='executing'`).run();

  async function tick() {
    if (running) return;
    running = true;
    try {
      await evaluate();
    } finally {
      running = false;
    }
  }

  async function evaluate() {
    // Allow time for the shop's boundary-aligned flush to arrive before reading the completed batch.
    const end = Math.floor((now() - 500) / 2_000) * 2_000;
    if (end === evaluatedEnd) return;
    evaluatedEnd = end;
    const rows = requests.all(end - 900_000, end) as RequestRow[];
    const rolling = aggregate(rows, end % BUCKET_MS);
    const { overall, by_route } = end % BUCKET_MS ? aggregate(rows) : rolling;
    const completeEnd = Math.floor((now() - 2_500) / BUCKET_MS) * BUCKET_MS;
    const routeSpikes = Object.entries(rolling.by_route).flatMap(([route, buckets]) => {
      const spike = detectSpike(buckets, end);
      return spike ? [{ route, ...spike }] : [];
    }).sort((a, b) => b.recent.rate! - a.recent.rate!);
    const recent = routeSpikes[0] ?? detectSpike(rolling.overall, end);
    let open = db.prepare("SELECT * FROM incidents WHERE status='open'").get() as IncidentRow | undefined;
    const lastClosed = (db.prepare("SELECT MAX(closed_ts) AS ts FROM incidents").get() as { ts: number | null }).ts;
    if (!open && recent && (lastClosed === null || recent.start >= lastClosed)) {
      const result = db.prepare(`INSERT INTO incidents(opened_ts,status,ranking_json,evidence_json)
        VALUES (?,'open',?,?)`).run(now(), JSON.stringify({ confidence: "ambiguous", ranking: [] }), JSON.stringify(recent));
      open = db.prepare("SELECT * FROM incidents WHERE id=?").get(result.lastInsertRowid) as IncidentRow;
      log("incident_opened", { id: open.id, evidence: recent });
      bus.emit("incident_opened", decode(open));
    }

    if (open) {
      const incident = decode(open);
      const baseline = incident.evidence.baseline.rate!;
      const buckets = incident.evidence.route ? by_route[incident.evidence.route] ?? [] : overall;
      if (completeEnd - RECOVERY_MS >= incident.evidence.end && recovered(buckets, completeEnd, baseline)) {
        const ts = now();
        db.prepare("UPDATE incidents SET status='closed',closed_ts=? WHERE id=?").run(ts, open.id);
        db.prepare("UPDATE proposals SET status='cancelled',decision_ts=? WHERE incident_id=? AND status='pending' AND kind!='fix_pr'").run(ts, open.id);
        log("incident_closed", { id: open.id, ts });
        bus.emit("incident_closed", { id: open.id, closed_ts: ts });
      } else {
        const start = incident.evidence.start;
        const errors = (failures.all(start, end) as Failure[])
          .filter((failure) => !incident.evidence.route || failure.route === incident.evidence.route);
        const ranked = rankFlags(rows.filter((row) => row.ts_bucket >= start), errors,
          changes.all(incident.evidence.end - 1_800_000, incident.opened_ts) as RecentChange[],
          incident.opened_ts, readFlagFiles());
        db.prepare("UPDATE incidents SET top_flag=?,ranking_json=? WHERE id=?")
          .run(ranked.ranking[0]?.flag ?? null, JSON.stringify(ranked), open.id);
        if (ranked.confidence === "confident" && !db.prepare("SELECT 1 FROM proposals WHERE incident_id=?").get(open.id)) {
          await proposals.create(open.id, ranked.ranking[0]!).catch((error) => {
            log("proposal_creation_failed", { incident_id: open!.id, error: error instanceof DecisionError ? error.message : "Internal error" });
          });
        }
      }
    }

    const watching = db.prepare(`SELECT a.id, a.outcome_ts AS verified_ts, p.incident_id, i.evidence_json
      FROM actions a JOIN proposals p ON p.id=a.proposal_id JOIN incidents i ON i.id=p.incident_id
      WHERE a.outcome='watching'`).all() as { id: number; verified_ts: number; incident_id: number; evidence_json: string }[];
    for (const action of watching) {
      const recoveryEnd = Math.ceil(action.verified_ts / BUCKET_MS) * BUCKET_MS + RECOVERY_MS;
      if (completeEnd < recoveryEnd) continue;
      const evidence = JSON.parse(action.evidence_json) as Spike;
      const buckets = evidence.route ? by_route[evidence.route] ?? [] : overall;
      const outcome = recovered(buckets, recoveryEnd, evidence.baseline.rate!) ? "recovered" : "not_recovered";
      db.prepare("UPDATE actions SET outcome=?,outcome_ts=? WHERE id=?").run(outcome, now(), action.id);
      const event = { id: action.id, incident_id: action.incident_id, outcome };
      log("action_outcome", event);
      bus.emit("action_done", event);
    }
    proposals.expire();
  }

  function start() {
    const run = () => void tick().catch(() => console.error("Incident evaluation failed"));
    const timer = setInterval(run, interval);
    run();
    return () => clearInterval(timer);
  }

  function list() {
    return (db.prepare("SELECT * FROM incidents ORDER BY id DESC LIMIT 100").all() as IncidentRow[]).map(decode);
  }

  function get(id: number) {
    const row = db.prepare("SELECT * FROM incidents WHERE id=?").get(id) as IncidentRow | undefined;
    if (!row) throw new DecisionError("Incident not found", 404);
    const incident = decode(row);
    const history = proposals.list(id);
    const actions = (db.prepare(`SELECT a.* FROM actions a JOIN proposals p ON p.id=a.proposal_id
      WHERE p.incident_id=? ORDER BY a.id`).all(id) as {
        id: number; ts: number; outcome: string; outcome_ts: number | null; request_json: string; verify_json: string | null;
      }[]).map(({ request_json, verify_json, ...action }) =>
      ({ ...action, request: JSON.parse(request_json), verification: verify_json ? JSON.parse(verify_json) : null }));
    const timeline = [
      { ts: incident.opened_ts, event: "incident_opened" },
      ...history.flatMap((p) => [{ ts: p.created, event: "proposal_created", id: p.id },
        ...(p.decision_ts ? [{ ts: p.decision_ts, event: `proposal_${p.status}`, id: p.id }] : [])]),
      ...actions.flatMap((a) => [{ ts: a.ts, event: "action_started", id: a.id },
        ...(a.outcome_ts ? [{ ts: a.outcome_ts, event: a.outcome, id: a.id }] : [])]),
      ...(incident.closed_ts ? [{ ts: incident.closed_ts, event: "incident_closed" }] : []),
    ].sort((a, b) => a.ts - b.ts);
    return { ...incident, proposal: history[0] ?? null, proposals: history, actions, timeline };
  }

  async function pick(id: number, flag: string) {
    const incident = get(id);
    const evidence = incident.ranking.find((item) => item.flag === flag);
    if (!evidence) throw new DecisionError("Flag was not ranked for this incident", 400);
    return proposals.create(id, evidence);
  }

  return { start, tick, list, get, pick };
}

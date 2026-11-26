import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

// Append-only list: never edit a shipped migration, add a new one.
const MIGRATIONS = [
  `CREATE TABLE errors(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, identity TEXT, route TEXT, message TEXT, stack TEXT,
     flags_json TEXT NOT NULL, source TEXT, simulated INTEGER);
   CREATE INDEX errors_ts ON errors(ts);
   CREATE TABLE requests(ts_bucket INTEGER NOT NULL, route TEXT NOT NULL, flag_key TEXT NOT NULL, flag_on INTEGER NOT NULL,
     count INTEGER NOT NULL, errors INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX requests_ts ON requests(ts_bucket);
   CREATE TABLE flag_changes(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, env TEXT NOT NULL, flag_key TEXT NOT NULL,
     feature_id INTEGER NOT NULL, before_json TEXT, after_json TEXT, source TEXT NOT NULL);
   CREATE INDEX flag_changes_ts ON flag_changes(ts);
   CREATE TABLE flag_state(flag_key TEXT PRIMARY KEY, feature_id INTEGER NOT NULL, state_json TEXT, updated_ts INTEGER NOT NULL);
   CREATE TABLE incidents(id INTEGER PRIMARY KEY, opened_ts INTEGER NOT NULL, closed_ts INTEGER, status TEXT NOT NULL,
     top_flag TEXT, ranking_json TEXT);
   CREATE TABLE proposals(id INTEGER PRIMARY KEY, incident_id INTEGER REFERENCES incidents(id), kind TEXT NOT NULL,
     payload_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL, created_ts INTEGER NOT NULL, expires_ts INTEGER NOT NULL, status TEXT NOT NULL);
   CREATE TABLE actions(id INTEGER PRIMARY KEY, proposal_id INTEGER REFERENCES proposals(id), ts INTEGER NOT NULL,
     request_json TEXT, response_status INTEGER, verify_json TEXT);`,
  `ALTER TABLE incidents ADD COLUMN evidence_json TEXT;
   CREATE UNIQUE INDEX single_open_incident ON incidents(status) WHERE status = 'open';
   ALTER TABLE proposals ADD COLUMN approver TEXT;
   ALTER TABLE proposals ADD COLUMN decision_ts INTEGER;
   CREATE UNIQUE INDEX one_pending_proposal ON proposals(incident_id) WHERE status IN ('pending', 'executing');
   ALTER TABLE actions ADD COLUMN outcome TEXT;
   ALTER TABLE actions ADD COLUMN outcome_ts INTEGER;`,
  `CREATE TABLE rollouts(
      incident_id INTEGER PRIMARY KEY REFERENCES incidents(id), flag TEXT NOT NULL, feature_id INTEGER NOT NULL,
      route TEXT NOT NULL, stage INTEGER NOT NULL CHECK(stage IN (10,50,100)), status TEXT NOT NULL,
      hold_ms INTEGER NOT NULL, started_ts INTEGER NOT NULL, reason TEXT, rollback_checked INTEGER NOT NULL DEFAULT 0
   );
   CREATE UNIQUE INDEX one_running_rollout_per_flag ON rollouts(flag) WHERE status='active';`,
  `ALTER TABLE errors ADD COLUMN replay_json TEXT;
   CREATE TABLE fix_jobs(
     proposal_id INTEGER PRIMARY KEY REFERENCES proposals(id), status TEXT NOT NULL,
     model TEXT, diff TEXT, pr_url TEXT, steps_json TEXT NOT NULL DEFAULT '[]', reason TEXT
   );`,
];

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000"); // the toggle CLI writes from another process
  const version = db.pragma("user_version", { simple: true }) as number;
  db.transaction(() => {
    MIGRATIONS.slice(version).forEach((sql) => db.exec(sql));
    db.pragma(`user_version = ${MIGRATIONS.length}`);
  })();
  return db;
}

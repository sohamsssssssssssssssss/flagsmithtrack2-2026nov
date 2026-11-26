import type { FlagChange, FlagLiveState } from "@blast/shared";
import type { DB } from "./db.js";

export type StateMap = Map<string, { feature_id: number; state: FlagLiveState | null }>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b); // states are normalized (overrides sorted)

/** Pure diff of two snapshots keyed by flag name: additions, removals and any change in default/value/overrides. */
export function diffStates(prev: StateMap, next: StateMap): { flag_key: string; feature_id: number; before: FlagLiveState | null; after: FlagLiveState | null }[] {
  const out = [];
  for (const key of new Set([...prev.keys(), ...next.keys()])) {
    const p = prev.get(key), n = next.get(key);
    const before = p?.state ?? null, after = n?.state ?? null;
    if (!same(before, after)) out.push({ flag_key: key, feature_id: (n ?? p)!.feature_id, before, after });
  }
  return out;
}

export function loadStates(db: DB): StateMap {
  const rows = db.prepare("SELECT flag_key, feature_id, state_json FROM flag_state").all() as { flag_key: string; feature_id: number; state_json: string | null }[];
  return new Map(rows.map((r) => [r.flag_key, { feature_id: r.feature_id, state: r.state_json ? JSON.parse(r.state_json) : null }]));
}

/** Records a change and updates the stored live state in one transaction, so the watcher won't count it again. */
export function recordChange(db: DB, c: FlagChange): void {
  db.transaction(() => {
    db.prepare("INSERT INTO flag_changes(ts, env, flag_key, feature_id, before_json, after_json, source) VALUES (?,?,?,?,?,?,?)")
      .run(c.ts, c.env, c.flag_key, c.feature_id, JSON.stringify(c.before), JSON.stringify(c.after), c.source);
    saveState(db, c.flag_key, c.feature_id, c.after, c.ts);
  })();
}

export function saveState(db: DB, flag_key: string, feature_id: number, state: FlagLiveState | null, ts: number): void {
  db.prepare(`INSERT INTO flag_state(flag_key, feature_id, state_json, updated_ts) VALUES (?,?,?,?)
    ON CONFLICT(flag_key) DO UPDATE SET feature_id=excluded.feature_id, state_json=excluded.state_json, updated_ts=excluded.updated_ts`)
    .run(flag_key, feature_id, JSON.stringify(state), ts);
}

export function listChanges(db: DB, since = 0, limit = 200): FlagChange[] {
  const rows = db.prepare("SELECT * FROM flag_changes WHERE ts >= ? ORDER BY ts DESC, id DESC LIMIT ?").all(since, limit) as Record<string, any>[];
  return rows.map((r) => ({ ts: r.ts, env: r.env, flag_key: r.flag_key, feature_id: r.feature_id,
    before: JSON.parse(r.before_json), after: JSON.parse(r.after_json), source: r.source }));
}

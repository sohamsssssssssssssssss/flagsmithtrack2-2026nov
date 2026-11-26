import type { FlagChange } from "@blast/shared";
import { diffStates, loadStates, recordChange, saveState, type StateMap } from "./changes.js";
import type { DB } from "./db.js";
import type { FlagsmithClient } from "./flagsmith.js";

/** One poll: read every feature's live state, record differences as source "poll". */
export async function pollOnce(db: DB, client: FlagsmithClient, env: string, now = Date.now): Promise<FlagChange[]> {
  const started = now();
  const features = await client.listFeatures();
  const states = await Promise.all(features.map((f) => client.getState(f.id)));
  const next: StateMap = new Map(features.map((f, i) => [f.name, { feature_id: f.id, state: states[i]! }]));

  const prev = loadStates(db);
  if (prev.size === 0) { // first boot: baseline silently, nothing changed yet
    for (const [k, v] of next) saveState(db, k, v.feature_id, v.state, started);
    return [];
  }
  // Skip flags written (e.g. by the toggle CLI) after this poll started: our read may predate that write.
  const fresh = new Set((db.prepare("SELECT flag_key FROM flag_state WHERE updated_ts > ?").all(started) as { flag_key: string }[]).map((r) => r.flag_key));
  const changes: FlagChange[] = diffStates(prev, next)
    .filter((d) => !fresh.has(d.flag_key))
    .map((d) => ({ ts: now(), env, source: "poll", ...d }));
  changes.forEach((c) => recordChange(db, c));
  return changes;
}

export function startWatcher(db: DB, client: FlagsmithClient, env: string, onChange: (c: FlagChange) => void, intervalMs = 5000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { (await pollOnce(db, client, env)).forEach(onChange); }
    catch (e) { console.error("watcher:", client.redact((e as Error).message)); }
    finally { running = false; }
  };
  void tick();
  const t = setInterval(tick, intervalMs);
  return () => clearInterval(t);
}

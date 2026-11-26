// Manual test write: pnpm --filter agent run toggle <flag> on|off
import { createInterface } from "node:readline/promises";
import { audit } from "./audit.js";
import { recordChange } from "./changes.js";
import { BLAST_DIR, loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { FlagsmithClient } from "./flagsmith.js";

const [flag, mode] = process.argv.slice(2);
if (!flag || (mode !== "on" && mode !== "off")) {
  console.error("usage: toggle <flag> on|off");
  process.exit(2);
}
const cfg = loadConfig();
const client = new FlagsmithClient(cfg);
const feature = (await client.listFeatures()).find((f) => f.name === flag);
if (!feature) { console.error(`no feature "${flag}" in project ${cfg.projectId}`); process.exit(1); }

if (process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Set ${flag} (id ${feature.id}) default ${mode.toUpperCase()} in ${cfg.envName}? [y/N] `);
  rl.close();
  if (answer.trim().toLowerCase() !== "y") { console.log("aborted"); process.exit(1); }
}

const enabled = mode === "on";
audit("flagsmith_write_requested", { via: "cli", flag, feature_id: feature.id, env: cfg.envName, enabled });
try {
  const r = await client.setEnabled(feature.id, enabled);
  audit("flagsmith_write_result", { via: "cli", flag, feature_id: feature.id, ok: r.ok, before: r.before, after: r.after });
  recordChange(openDb(`${BLAST_DIR}/db.sqlite`),
    { ts: Date.now(), env: cfg.envName, flag_key: flag, feature_id: feature.id, before: r.before, after: r.after, source: "agent" });
  console.log(`${r.ok ? "OK" : "PARTIAL (re-read does not match)"}: ${flag} enabled ${r.before.enabled} -> ${r.after.enabled}`);
  if (r.after.overrides.some((o) => o.enabled !== enabled)) console.log("note: segment overrides still differ from the default");
  process.exit(r.ok ? 0 : 1);
} catch (e) {
  const error = client.redact((e as Error).message);
  audit("flagsmith_write_result", { via: "cli", flag, feature_id: feature.id, ok: false, error });
  console.error("FAILED:", error);
  process.exit(1);
}

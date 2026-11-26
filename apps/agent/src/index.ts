import { EventEmitter } from "node:events";
import { PORTS } from "@blast/shared";
import { BLAST_DIR, loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { createFlagMap } from "./flagmap.js";
import { FlagsmithClient } from "./flagsmith.js";
import { buildServer } from "./server.js";
import { buildIncidents } from "./incidents.js";
import { buildProposals } from "./proposals.js";
import { buildRollouts } from "./rollouts.js";
import { startWatcher } from "./watcher.js";

const cfg = loadConfig();
const fastHold = process.argv.includes("--fast-hold");
if (fastHold && cfg.envName !== "Development") throw new Error("--fast-hold is Development-only");
const db = openDb(`${BLAST_DIR}/db.sqlite`);
const bus = new EventEmitter();
const client = new FlagsmithClient(cfg);
const proposals = buildProposals(db, client, cfg.envName, bus);
const incidents = buildIncidents(db, proposals, bus);
const flagMap = createFlagMap(client);
const rollouts = buildRollouts(db, proposals, bus, fastHold ? 30_000 : 120_000);
const app = buildServer(db, bus, { incidents, proposals, flagMap, rollouts });
const stopWatcher = startWatcher(db, client, cfg.envName, (c) => {
  console.log(`flag change (${c.source}): ${c.flag_key}`);
  bus.emit("change", c);
});

let stopIncidents: (() => void) | undefined;
const rolloutTimer = setInterval(() => void rollouts.tick().catch(() => console.error("Rollout evaluation failed")), 1_000);
app.addHook("onClose", async () => { stopWatcher(); stopIncidents?.(); clearInterval(rolloutTimer); });
await app.listen({ port: PORTS.agent, host: "127.0.0.1" });
console.log(`agent listening on http://localhost:${PORTS.agent}`);
await flagMap.refresh().catch(() => console.error("Could not generate the flag map"));
stopIncidents = incidents.start();

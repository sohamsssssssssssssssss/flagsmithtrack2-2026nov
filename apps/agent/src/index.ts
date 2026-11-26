import { EventEmitter } from "node:events";
import { PORTS } from "@blast/shared";
import { BLAST_DIR, loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { createFlagMap } from "./flagmap.js";
import { FlagsmithClient } from "./flagsmith.js";
import { buildServer } from "./server.js";
import { buildIncidents } from "./incidents.js";
import { buildProposals } from "./proposals.js";
import { startWatcher } from "./watcher.js";

const cfg = loadConfig();
const db = openDb(`${BLAST_DIR}/db.sqlite`);
const bus = new EventEmitter();
const client = new FlagsmithClient(cfg);
const proposals = buildProposals(db, client, cfg.envName, bus);
const incidents = buildIncidents(db, proposals, bus);
const flagMap = createFlagMap(client);
const app = buildServer(db, bus, { incidents, proposals, flagMap });
const stopWatcher = startWatcher(db, client, cfg.envName, (c) => {
  console.log(`flag change (${c.source}): ${c.flag_key}`);
  bus.emit("change", c);
});

let stopIncidents: (() => void) | undefined;
app.addHook("onClose", async () => { stopWatcher(); stopIncidents?.(); });
await app.listen({ port: PORTS.agent, host: "127.0.0.1" });
console.log(`agent listening on http://localhost:${PORTS.agent}`);
await flagMap.refresh().catch(() => console.error("Could not generate the flag map"));
stopIncidents = incidents.start();

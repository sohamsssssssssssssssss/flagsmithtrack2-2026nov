import { EventEmitter } from "node:events";
import { PORTS } from "@blast/shared";
import { BLAST_DIR, loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { FlagsmithClient } from "./flagsmith.js";
import { buildServer } from "./server.js";
import { startWatcher } from "./watcher.js";

const cfg = loadConfig();
const db = openDb(`${BLAST_DIR}/db.sqlite`);
const bus = new EventEmitter();
const client = new FlagsmithClient(cfg);
const app = buildServer(db, bus);
await app.listen({ port: PORTS.agent, host: "127.0.0.1" });
console.log(`agent listening on http://localhost:${PORTS.agent}`);
startWatcher(db, client, cfg.envName, (c) => {
  console.log(`flag change (${c.source}): ${c.flag_key}`);
  bus.emit("change", c);
});

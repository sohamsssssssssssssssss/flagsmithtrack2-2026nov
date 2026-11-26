import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { PORTS, type FlagSnapshot } from "@blast/shared";
import { DefaultFlag, Flagsmith } from "flagsmith-nodejs";
import { buildApp } from "./app.js";
import { createTelemetry, REQUEST_BUCKET_MS } from "./telemetry.js";

const env = new URL("../../../../.env", import.meta.url);
if (existsSync(env)) loadEnvFile(env);

const key = process.env.FLAGSMITH_SERVER_KEY;
const defaultFlagHandler = () => new DefaultFlag(null, false);
const client = key ? new Flagsmith({
  environmentKey: key,
  enableLocalEvaluation: true,
  environmentRefreshIntervalSeconds: 5,
  defaultFlagHandler,
  requestTimeoutSeconds: 2,
  retries: 0,
}) : undefined;

const knownFlags = ["new_checkout", "smart_search", "recs_v2", "promo_banner", "free_shipping_threshold"];
const telemetry = createTelemetry();
buildApp(async (identity, cohort) => {
  const flags = await client?.getIdentityFlags(identity, cohort === undefined ? {} : { cohort });
  const defaults = knownFlags.map((name) => [name, flags?.getFlag(name) ?? defaultFlagHandler()] as const);
  const evaluated = (flags?.allFlags() ?? []).map((flag) => [flag.featureName, flag] as const);
  const snapshot: FlagSnapshot = Object.fromEntries([...defaults, ...evaluated]
    .map(([name, { enabled, value }]) => [name, { enabled, value: value ?? null }]));
  return snapshot;
}, telemetry).listen(PORTS.shopApi, () => {
  console.log(`Lumen Shop API (DEMO) on http://localhost:${PORTS.shopApi}`);
});

function flushOnBoundary() {
  telemetry.flush();
  setTimeout(flushOnBoundary, REQUEST_BUCKET_MS - (Date.now() % REQUEST_BUCKET_MS)).unref();
}

flushOnBoundary();

// Idempotent: ensures the demo flags and the beta_cohort segment exist in the Flagsmith project.
// Reads .env. Prints ids only, never keys. Writes non-secret ids to config/flags.json.
import { mkdirSync, writeFileSync } from "node:fs";

process.loadEnvFile(new URL("../.env", import.meta.url));
const BASE = process.env.FLAGSMITH_API_URL || "https://api.flagsmith.com";
const KEY = process.env.FLAGSMITH_ADMIN_KEY;
const PROJECT = Number(process.env.FLAGSMITH_PROJECT_ID || 56400);
if (!KEY) throw new Error("FLAGSMITH_ADMIN_KEY missing in .env");

const FEATURES = [
  { name: "new_checkout", default_enabled: false },
  { name: "smart_search", default_enabled: false },
  { name: "promo_banner", default_enabled: false },
  { name: "recs_v2", default_enabled: false },
  { name: "free_shipping_threshold", default_enabled: true, initial_value: "50" },
];
const SEGMENT = {
  name: "beta_cohort",
  project: PROJECT,
  rules: [{ type: "ALL", conditions: [], rules: [{ type: "ANY", rules: [], conditions: [{ property: "cohort", operator: "EQUAL", value: "beta" }] }] }],
};

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Api-Key ${KEY}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.split(KEY).join("[REDACTED]").slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const list = async (path) => {
  const r = await api("GET", path);
  return Array.isArray(r) ? r : r.results; // shortcut: first page only (page_size=999), fine for a demo project
};

const existing = new Map((await list(`/api/v1/projects/${PROJECT}/features/?page_size=999`)).map((f) => [f.name, f.id]));
const features = {};
for (const f of FEATURES) {
  let id = existing.get(f.name);
  const status = id ? "exists " : "created";
  if (!id) id = (await api("POST", `/api/v1/projects/${PROJECT}/features/`, { type: "STANDARD", ...f })).id;
  features[f.name] = id;
  console.log(`feature ${status} ${f.name.padEnd(24)} id=${id}`);
}

let seg = (await list(`/api/v1/projects/${PROJECT}/segments/?page_size=999`)).find((s) => s.name === SEGMENT.name);
const segStatus = seg ? "exists " : "created";
seg ??= await api("POST", `/api/v1/projects/${PROJECT}/segments/`, SEGMENT);
console.log(`segment ${segStatus} ${SEGMENT.name.padEnd(24)} id=${seg.id}`);

const envs = await list(`/api/v1/projects/${PROJECT}/environments/`);
const dev = envs.find((e) => e.name === "Development");

mkdirSync(new URL("../config", import.meta.url), { recursive: true });
const out = {
  project_id: PROJECT,
  environment: dev ? { id: dev.id, name: dev.name } : null,
  features,
  segments: { [SEGMENT.name]: seg.id },
};
writeFileSync(new URL("../config/flags.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log("wrote config/flags.json");

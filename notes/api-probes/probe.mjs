// Day-0 Flagsmith Admin API probes. Node 20+, built-in fetch, no deps.
// Reads FLAGSMITH_ADMIN_KEY from .env. Saves {status, body} per call to NN_name.json.
// The key is never written to output: it is stripped from every saved body.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const OUT = here;
const BASE = "https://api.flagsmith.com";
const PROJECT_NAME = "blast-radius";
const ENV_NAME = "Development";

const env = Object.fromEntries(
  readFileSync(join(root, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const KEY = env.FLAGSMITH_ADMIN_KEY;
if (!KEY) throw new Error("FLAGSMITH_ADMIN_KEY is empty in .env");

let n = 0;
const summary = [];

function redact(text) {
  let t = text.split(KEY).join("[REDACTED]");
  return t.replace(/Api-Key\s+\S+/g, "Api-Key [REDACTED]");
}

async function call(name, method, path, body, { save = true } = {}) {
  const url = path.startsWith("http") ? path : BASE + path;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Api-Key ${KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw.slice(0, 2000);
  }
  const record = { method, path, status: res.status, body: parsed };
  if (save) {
    n += 1;
    const file = join(OUT, `${String(n).padStart(2, "0")}_${name}.json`);
    writeFileSync(file, redact(JSON.stringify(record, null, 2)));
  }
  console.log(`${method} ${path} -> ${res.status}`);
  return { status: res.status, body: parsed };
}

function note(endpoint, methodStr, works, text) {
  summary.push({ endpoint, method: methodStr, works, note: text });
}

const results = (r) => (r.body && r.body.results) || r.body;

// ---- a. projects
const projects = await call("projects", "GET", "/api/v1/projects/");
const project = results(projects).find?.((p) => p.name === PROJECT_NAME);
if (!project) throw new Error(`project "${PROJECT_NAME}" not found; see 01_projects.json`);
const PID = project.id;
note("/api/v1/projects/", "GET", projects.status === 200, `project id ${PID}`);

// ---- b. environments
let envs = await call("environments", "GET", `/api/v1/projects/${PID}/environments/`);
if (envs.status !== 200) {
  envs = await call("environments_alt", "GET", `/api/v1/environments/?project=${PID}`);
}
const devEnv = results(envs).find((e) => e.name === ENV_NAME);
if (!devEnv) throw new Error(`env "${ENV_NAME}" not found`);
const ENV_KEY = devEnv.api_key;
const ENV_ID = devEnv.id;
note("/api/v1/projects/{id}/environments/", "GET", envs.status === 200, `env id ${ENV_ID}`);

// ---- c. create + list features
const created = await call("feature_create", "POST", `/api/v1/projects/${PID}/features/`, {
  name: "probe_flag",
  type: "STANDARD",
  initial_value: null,
  default_enabled: false,
});
const feats = await call("features_list", "GET", `/api/v1/projects/${PID}/features/`);
const probe = results(feats).find?.((f) => f.name === "probe_flag");
const FID = probe?.id ?? created.body?.id;
note("/api/v1/projects/{id}/features/", "POST", created.status < 300, "create probe_flag");
note("/api/v1/projects/{id}/features/", "GET", feats.status === 200, `feature id ${FID}`);

// ---- d. experimental endpoint, env api_key then env id
const futurePath = (ident) => `/api/__future__/environments/${ident}/features/${FID}/`;
let dIdent = ENV_KEY;
let d0 = await call("future_get_apikey", "GET", futurePath(ENV_KEY));
if (d0.status >= 300) {
  dIdent = ENV_ID;
  d0 = await call("future_get_envid", "GET", futurePath(ENV_ID));
}
for (const [label, enabled] of [["on", true], ["off", false]]) {
  await call(`future_patch_${label}`, "PATCH", futurePath(dIdent), {
    environment_default: { enabled },
  });
  await call(`future_reread_${label}`, "GET", futurePath(dIdent));
}
note("/api/__future__/environments/{key}/features/{id}/", "GET", d0.status === 200, `identifier used: ${dIdent === ENV_KEY ? "env api_key" : "env id"}`);
note("/api/__future__/environments/{key}/features/{id}/", "PATCH", true, "see 06/07 files for result");

// ---- e. v1 featurestates
const fs = await call("featurestates_list", "GET", `/api/v1/environments/${ENV_KEY}/featurestates/`);
const fsRow = results(fs).find?.((s) => s.feature?.id === FID) ?? null;
note("/api/v1/environments/{key}/featurestates/", "GET", fs.status === 200, fsRow ? `featurestate id ${fsRow.id}` : "probe_flag state not found");
if (fsRow) {
  const p = await call("featurestate_patch", "PATCH", `/api/v1/environments/${ENV_KEY}/featurestates/${fsRow.id}/`, { enabled: true });
  note("/api/v1/environments/{key}/featurestates/{id}/", "PATCH", p.status < 300, "enabled=true");
  const p2 = await call("featurestate_patch_off", "PATCH", `/api/v1/environments/${ENV_KEY}/featurestates/${fsRow.id}/`, { enabled: false });
  note("/api/v1/environments/{key}/featurestates/{id}/", "PATCH (disable)", p2.status < 300, "enabled=false");
}

// ---- f. audit log candidates
for (const [name, path] of [
  ["audit_root", "/api/v1/audit/"],
  ["audit_project", `/api/v1/projects/${PID}/audit/`],
  ["audit_env", `/api/v1/environments/${ENV_KEY}/audit/`],
]) {
  const r = await call(name, "GET", path);
  note(path, "GET", r.status === 200, r.status === 200 ? "see file for fields" : `HTTP ${r.status}`);
}

// ---- g. webhooks (list only; create is a separate decision)
const wh = await call("webhooks_list", "GET", `/api/v1/environments/${ENV_KEY}/webhooks/`);
note("/api/v1/environments/{key}/webhooks/", "GET", wh.status === 200, `HTTP ${wh.status}`);
const wh2 = await call("webhooks_project_list", "GET", `/api/v1/projects/${PID}/integrations/`);
note("/api/v1/projects/{id}/integrations/", "GET", wh2.status === 200, `HTTP ${wh2.status}`);

// ---- h. percentage rollout
const seg = await call("segment_create", "POST", `/api/v1/projects/${PID}/segments/`, {
  name: "probe_segment",
  rules: [{ type: "ALL", conditions: [], rules: [] }],
  feature_states: [],
});
note("/api/v1/projects/{id}/segments/", "POST", seg.status < 300, `HTTP ${seg.status}`);
// Multivariate: convert probe_flag to MULTIVARIATE with weighted options.
const mv = await call("feature_mv_patch", "PATCH", `/api/v1/projects/${PID}/features/${FID}/`, {
  multivariate_options: [
    { type: "unicode", string_value: "control", default_percentage_allocation: 50 },
    { type: "unicode", string_value: "variant", default_percentage_allocation: 50 },
  ],
});
note("/api/v1/projects/{id}/features/{id}/ (multivariate)", "PATCH", mv.status < 300, `HTTP ${mv.status}`);

writeFileSync(join(OUT, "_summary.json"), redact(JSON.stringify(summary, null, 2)));
console.log("\nDone. Summary rows:", summary.length);

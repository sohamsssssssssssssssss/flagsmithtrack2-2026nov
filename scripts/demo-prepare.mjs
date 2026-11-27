// Resets the whole demo so one take can start from a known state. Asks y/N before anything changes.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { tsImport } from "tsx/esm/api";

const root = new URL("../", import.meta.url);
const rootPath = root.pathname.replace(/%20/g, " ");
const git = (...args) => execFileSync("git", args, { cwd: rootPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const fail = (message) => { console.error(`STOPPED: ${message}`); process.exit(1); };

if (git("status", "--porcelain")) fail("working tree has uncommitted changes; commit or stash them first");
if (await fetch("http://localhost:4000/api/incidents", { signal: AbortSignal.timeout(1_000) }).then(() => true, () => false)) {
  fail("the agent is running on :4000; stop it before resetting the demo");
}
try { git("rev-parse", "-q", "--verify", "refs/tags/demo-start"); } catch { fail("tag demo-start is missing; create it on the buggy demo commit first"); }

const plan = [
  "hard-reset local demo to demo-start and force-push origin/demo",
  "close open blast/fix-* PRs and delete their branches",
  "reset new_checkout OFF everywhere (verified) and ensure the beta_cohort override exists",
  "clear .blast runtime db and sandboxes (keeps flagmap.json and identities.json)",
];
console.log("Demo prepare plan:\n  - " + plan.join("\n  - "));
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question("Apply this plan? [y/N] ").finally(() => rl.close());
if (answer.trim().toLowerCase() !== "y") fail("cancelled");

// 1. Branch and remote.
git("fetch", "origin", "--quiet");
git("checkout", "-q", "-B", "demo", "demo-start");
git("reset", "-q", "--hard", "demo-start");
git("push", "-q", "--force", "origin", "demo");
console.log(`demo at ${git("rev-parse", "--short", "HEAD")} (demo-start), pushed`);

// 2. Fix PRs and their branches from earlier takes.
const prs = JSON.parse(execFileSync("gh", ["pr", "list", "--state", "open", "--json", "number,headRefName"], { encoding: "utf8" }));
for (const pr of prs.filter((pr) => pr.headRefName.startsWith("blast/fix-"))) {
  execFileSync("gh", ["pr", "close", String(pr.number), "--delete-branch", "--comment", "Closed by demo-prepare"], { stdio: "inherit" });
  console.log(`closed PR #${pr.number} (${pr.headRefName})`);
}
for (const line of git("ls-remote", "--heads", "origin", "blast/fix-*").split("\n").filter(Boolean)) {
  const ref = line.split("\t")[1].replace("refs/heads/", "");
  git("push", "-q", "origin", "--delete", ref);
  console.log(`deleted remote branch ${ref}`);
}
for (const branch of git("branch", "--list", "blast/fix-*").split("\n").map((b) => b.trim()).filter(Boolean)) {
  git("branch", "-D", branch);
}

// 3. Flag state: reset runs its own verified confirmation.
const reset = spawnSync(process.execPath, [new URL("./demo-reset.mjs", import.meta.url).pathname], { stdio: "inherit", cwd: rootPath });
if (reset.status !== 0) fail("demo-reset did not complete; flag state is not verified");
const [{ FlagsmithClient }, { loadConfig }] = await Promise.all([
  tsImport("../apps/agent/src/flagsmith.ts", import.meta.url),
  tsImport("../apps/agent/src/config.ts", import.meta.url),
]);
const cfg = loadConfig();
const { features, segments } = JSON.parse(readFileSync(new URL("../config/flags.json", import.meta.url), "utf8"));
const client = new FlagsmithClient(cfg);
let state = await client.getState(features.new_checkout);
if (state.enabled || state.overrides.some((o) => o.enabled)) fail("new_checkout is still on after reset");
if (!state.overrides.some((o) => o.segment_id === segments.beta_cohort)) {
  const after = await client.setSegmentOverrideEnabled(features.new_checkout, segments.beta_cohort, false);
  if (!after.ok) fail("could not recreate the beta_cohort override");
  state = after.after;
  console.log("recreated the disabled beta_cohort override");
}

// 4. Runtime data. Flagmap and identities stay.
const blast = new URL("../.blast/", import.meta.url).pathname;
for (const name of ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"]) rmSync(blast + name, { force: true });
rmSync(blast + "sandboxes", { recursive: true, force: true });
for (const name of existsSync(blast) ? readdirSync(blast) : []) {
  if (name.startsWith("fixer-validation-")) rmSync(blast + name, { recursive: true, force: true });
}

console.log("ready for take");

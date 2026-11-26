import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const runs = args.length === 0 ? 5 : args[0] === "--runs" && args.length === 2 ? Number(args[1]) : NaN;
if (!Number.isInteger(runs) || runs < 1 || runs > 100) {
  console.error("Usage: node scripts/rehearse.mjs [--runs 1..100]");
  process.exit(2);
}
const base = join(root, ".blast", "rehearsals");
mkdirSync(base, { recursive: true });
const suite = mkdtempSync(join(base, "run-"));
const urls = ["http://127.0.0.1:4000/health", "http://127.0.0.1:4100/api/health",
  "http://localhost:5173/", "http://localhost:5174/"];
const controller = new AbortController();
for (const name of ["SIGINT", "SIGTERM"]) process.on(name, () => controller.abort(new Error("Rehearsal interrupted")));
const results = [];
const seconds = (ms) => ms == null ? "—" : (ms / 1000).toFixed(2);

function report() {
  const rows = results.map(({ run, incident, proposal, flag, confidence, evidence, route }) =>
    `| ${run} | ${seconds(incident)} | ${seconds(proposal)} | ${flag ?? "—"} | ${confidence ?? "—"} | ${route ?? "—"} | ${evidence ? `${evidence.on.errors}/${evidence.on.requests}` : "—"} | ${evidence ? `${evidence.off.errors}/${evidence.off.requests}` : "—"} | ${evidence?.p == null ? "—" : evidence.p.toPrecision(3)} |`);
  writeFileSync(join(root, "notes", "rehearsals.md"), [
    "# Simulated demo rehearsals", "",
    "Preset: 600 users, 25 requests/s, 40% discount-code entry, 50% beta. Each trial starts with a fresh agent database and 45 seconds of baseline traffic. Times are seconds from the successful Flagsmith beta-on PATCH response. The runner records proposals and resets the demo flag. It never approves a proposal.", "",
    "| Run | Incident (s) | Proposal (s) | Top flag | Rank | Route | On errors / requests | Off errors / requests | Fisher p |",
    "| ---: | ---: | ---: | --- | --- | --- | ---: | ---: | ---: |", ...rows, "",
    "Targets: incident ≤20s, proposal ≤30s, and a confident new_checkout proposal in every run. A dash means the event was unavailable in the 60-second observation window.", "",
  ].join("\n"));
}

async function fetchJson(path) {
  const response = await fetch(new URL(path, urls[0]), { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}
async function reachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}
async function waitFor(check, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    controller.signal.throwIfAborted();
    const result = await check();
    if (result) return result;
    await delay(250, undefined, { signal: controller.signal });
  }
}
function child(command, args, env, log) {
  const fd = log ? openSync(log, "a") : undefined;
  const proc = spawn(command, args, { cwd: root, env, detached: true,
    stdio: ["ignore", fd ?? "inherit", fd ?? "inherit"] });
  if (fd !== undefined) closeSync(fd);
  const done = new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code, signal) => resolve(code ?? signal));
  });
  void done.catch(() => {});
  return { proc, done };
}
async function stop({ proc, done }) {
  if (!proc.pid) return;
  // tsx watch can put its application child into a separate process group.
  const tree = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n")
    .map((entry) => entry.trim().split(/\s+/).map(Number));
  const descendants = new Set([proc.pid]);
  for (const pid of descendants) {
    for (const [childPid, parentPid] of tree) if (parentPid === pid) descendants.add(childPid);
  }
  const kill = (pid, signal) => {
    try { process.kill(pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  kill(-proc.pid, "SIGTERM");
  for (const pid of descendants) if (pid !== proc.pid) kill(pid, "SIGTERM");
  const timer = new AbortController();
  try {
    const result = await Promise.race([done, delay(3_000, "timeout", { signal: timer.signal })]);
    if (result === "timeout") kill(-proc.pid, "SIGKILL");
  } finally { timer.abort(); }
}
async function toggle(mode, env) {
  const step = child(process.execPath, [`scripts/demo-${mode}.mjs`, "--yes"], env);
  const timer = setTimeout(() => void stop(step).catch(() => {}), 90_000);
  try {
    const result = await step.done;
    if (result !== 0) throw new Error(`demo-${mode} failed (${result})`);
  } finally { clearTimeout(timer); }
}

async function trial(run) {
  if ((await Promise.all(urls.map(reachable))).some(Boolean)) {
    throw new Error("Stop existing demo services before rehearsing so each trial can use isolated telemetry");
  }
  const dir = join(suite, String(run));
  mkdirSync(dir);
  const env = { ...process.env, BLAST_DIR: dir, BLAST_REHEARSAL: "1" };
  const services = child("pnpm", ["demo:up"], env, join(dir, "services.log"));
  let traffic;
  let attemptedBreak = false;
  try {
    const healthy = await waitFor(async () => {
      if (services.proc.exitCode != null) throw new Error(`demo:up exited. See ${join(dir, "services.log")}`);
      if (!(await Promise.all(urls.map(reachable))).every(Boolean)) return false;
      return reachable("http://127.0.0.1:4000/api/map");
    }, 30_000);
    if (!healthy) throw new Error(`Demo health checks timed out. See ${join(dir, "services.log")}`);
    const state = await waitFor(async () => (await fetchJson("/api/flags"))
      .find((flag) => flag.flag_key === "new_checkout")?.state, 15_000);
    if (!state) throw new Error("Timed out waiting for the agent’s live flag snapshot");
    if (state.enabled || state.overrides.some((override) => override.enabled)) {
      throw new Error("Start rehearsal with new_checkout fully off");
    }

    traffic = child("pnpm", ["traffic:demo"], env, join(dir, "traffic.log"));
    console.log(`Trial ${run}/${runs}: collecting 45s of simulated baseline traffic`);
    await Promise.race([delay(45_000, undefined, { signal: controller.signal }),
      traffic.done.then((code) => { throw new Error(`Simulated traffic stopped (${code})`); })]);
    const baseline = await fetchJson("/api/metrics?window=60");
    if (!baseline.overall.some((bucket) => bucket.requests > 0) || baseline.overall.some((bucket) => bucket.errors > 0)) {
      throw new Error("Baseline did not contain clean simulated traffic");
    }

    controller.signal.throwIfAborted();
    attemptedBreak = true;
    await toggle("break", env);
    const events = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const ack = events.find((event) => event.via === "rehearsal" && event.mode === "break"
      && event.event === "flagsmith_patch_response" && event.step === "beta-on" && event.status >= 200 && event.status < 300)?.ts;
    if (typeof ack !== "number") throw new Error("Missing rehearsal break acknowledgement");
    let detail;
    await waitFor(async () => {
      const [incident] = await fetchJson("/api/incidents");
      if (!incident || incident.opened_ts < ack) return false;
      detail = await fetchJson(`/api/incidents/${incident.id}`);
      if (detail.actions.length) throw new Error("A proposal was acted on during rehearsal");
      return detail.proposal?.status === "pending";
    }, Math.max(0, ack + 60_000 - Date.now()));
    const proposal = detail?.proposal;
    const evidence = proposal?.evidence ?? detail?.ranking?.[0];
    const result = { run, incident: detail ? detail.opened_ts - ack : null,
      proposal: proposal ? proposal.created - ack : null, flag: evidence?.flag, confidence: detail?.confidence,
      evidence, route: detail?.evidence?.route };
    results.push(result);
    report();
    console.log(`Trial ${run}: incident ${seconds(result.incident)}s, proposal ${seconds(result.proposal)}s, ${result.flag ?? "no culprit"}`);
  } finally {
    try { if (attemptedBreak) await toggle("reset", env); }
    finally {
      if (traffic) await stop(traffic);
      await stop(services);
      const stopped = await waitFor(async () => (await Promise.all(urls.map(reachable))).every((ready) => !ready), 10_000);
      if (!stopped) throw new Error("Demo ports remained open after rehearsal shutdown");
    }
  }
}

for (let run = 1; run <= runs; run++) await trial(run);
console.log(`Raw rehearsal logs: ${suite}`);
if (results.some((r) => r.incident == null || r.incident > 20_000 || r.proposal == null || r.proposal > 30_000
  || r.flag !== "new_checkout" || r.confidence !== "confident")) process.exitCode = 1;

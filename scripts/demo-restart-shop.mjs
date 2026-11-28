// After merging a fix into demo: pull demo and restart only the shop, then print the commit it runs.
import { execFileSync, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootPath = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: rootPath, encoding: "utf8" }).trim();
const fail = (message) => { console.error(`STOPPED: ${message}`); process.exit(1); };

if (git("branch", "--show-current") !== "demo") fail("check out the demo branch first");
git("pull", "--ff-only", "origin", "demo");
const head = git("rev-parse", "HEAD");

for (const pid of execFileSync("lsof", ["-ti", "tcp:4100"], { encoding: "utf8" }).split("\n").filter(Boolean)) {
  process.kill(Number(pid), "SIGTERM");
}
await new Promise((resolve) => setTimeout(resolve, 1_000));

const log = openSync(fileURLToPath(new URL("../.blast/shop.log", import.meta.url)), "a");
spawn("pnpm", ["--filter", "@blast/shop-api", "dev"], { cwd: rootPath, detached: true, stdio: ["ignore", log, log] }).unref();

let running = null;
for (let i = 0; i < 60 && !running; i++) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  running = await fetch("http://localhost:4100/api/version", { signal: AbortSignal.timeout(1_000) })
    .then((response) => response.json()).then((body) => body.sha).catch(() => null);
}
if (!running) fail("the shop did not come back on :4100");
console.log(`shop runs ${running.slice(0, 7)} (${execFileSync("git", ["log", "-1", "--format=%s", running], { cwd: rootPath, encoding: "utf8" }).trim()})`);
if (running !== head) fail(`shop runs ${running.slice(0, 7)} but demo is at ${head.slice(0, 7)}`);
console.log("shop matches demo");

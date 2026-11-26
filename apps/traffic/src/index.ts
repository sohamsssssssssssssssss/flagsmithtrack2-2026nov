import { IDENTITIES_PATH, cohortFor, loadIdentities, type IdentityRecord } from "./identities.js";
import { RateLimiter } from "./limiter.js";
import { ShopSession, type SimulatedUser } from "./shop.js";
import { TrafficStats, type StatsSnapshot } from "./stats.js";
import { HELP, UsageError, parseArgs, type CliOptions } from "./args.js";

const STATS_EVERY_MS = 2_000;
const BURST_MS = 60_000;
const BURST_FACTOR = 2;

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

function printStats(stats: TrafficStats, elapsedMs: number, sinceLastMs: number, targetRps: number): StatsSnapshot {
  const snapshot = stats.snapshot(sinceLastMs);
  console.log(
    `[SIMULATED TRAFFIC] ${formatDuration(elapsedMs)} | rps ${snapshot.rps.toFixed(1)} (target ${targetRps})` +
      ` | total ${snapshot.total} | 5xx ${snapshot.total5xx} | err ${snapshot.errorRate.toFixed(1)}%`,
  );
  return snapshot;
}

function buildUsers(records: IdentityRecord[], betaRate: number): SimulatedUser[] {
  return records.map((record) => ({
    identity: record.identity,
    cohort: cohortFor(record.identity, betaRate),
  }));
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`[SIMULATED TRAFFIC] ${error.message}\n`);
      console.error(HELP);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  if (options.help) {
    console.log(HELP);
    return;
  }

  const records = loadIdentities(options.users);
  const users = buildUsers(records, options.betaRate);
  const betaCount = users.filter((user) => user.cohort === "beta").length;

  const targetRps = options.rps;
  const limiter = new RateLimiter({ rps: options.burst ? targetRps * BURST_FACTOR : targetRps });
  const stats = new TrafficStats();
  let stopping = false;
  const session = new ShopSession({
    baseUrl: options.baseUrl,
    limiter,
    stats,
    discountRate: options.discountRate,
    isStopped: () => stopping,
  });

  console.log("=".repeat(68));
  console.log("  SIMULATED TRAFFIC — Blast Radius demo");
  console.log(`  target   ${options.baseUrl}`);
  console.log(
    `  users    ${users.length} (beta ${betaCount} / default ${users.length - betaCount})` +
      ` | beta-rate ${percent(options.betaRate)}`,
  );
  console.log(
    `  rps      ${targetRps}${options.burst ? ` (x${BURST_FACTOR} for ${BURST_MS / 1000}s)` : ""}` +
      ` | discount-rate ${percent(options.discountRate)}`,
  );
  console.log(`  duration ${options.durationSec === 0 ? "until Ctrl+C" : `${options.durationSec}s`}`);
  console.log(`  identities ${IDENTITIES_PATH}`);
  console.log("=".repeat(68));
  console.log("All requests are SIMULATED. Stats every 2s; Ctrl+C to stop.\n");

  let currentTarget = limiter.targetRps;
  let shuttingDown = false;
  const startedAt = Date.now();
  let lastTickAt = startedAt;

  // About one worker per rps keeps the pacer's queue full through think time,
  // so the target rate holds and a session still finishes in a few seconds.
  const initialRps = options.burst ? targetRps * BURST_FACTOR : targetRps;
  const workerCount = Math.min(users.length, Math.max(6, Math.ceil(initialRps * 0.9)));
  let nextUser = 0;

  async function worker(): Promise<void> {
    while (!stopping) {
      const user = users[nextUser % users.length] as SimulatedUser;
      nextUser += 1;
      try {
        await session.run(user);
      } catch (error) {
        // Shop errors are counted inside ShopSession; this guard keeps a bug in
        // the generator from taking the demo down mid-session.
        console.error(`[SIMULATED TRAFFIC] session error: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (stopping) break;
      await new Promise((resolve) => setTimeout(resolve, 400 + Math.random() * 800));
    }
  }

  const statsTimer = setInterval(() => {
    if (stopping) return;
    const now = Date.now();
    printStats(stats, now - startedAt, now - lastTickAt, currentTarget);
    lastTickAt = now;
  }, STATS_EVERY_MS);

  let burstTimer: ReturnType<typeof setTimeout> | undefined;
  if (options.burst) {
    burstTimer = setTimeout(() => {
      limiter.setRps(targetRps);
      currentTarget = targetRps;
      console.log(`[SIMULATED TRAFFIC] burst over — back to ${targetRps} rps`);
    }, BURST_MS);
  }

  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  const workers = Array.from({ length: workerCount }, () => worker());
  const workersDone = Promise.all(workers);

  const finish = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopping = true;
    limiter.cancel();
    clearInterval(statsTimer);
    if (burstTimer) clearTimeout(burstTimer);
    if (durationTimer) clearTimeout(durationTimer);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);

    console.log(`\n[SIMULATED TRAFFIC] stopping (${reason})...`);
    await workersDone;

    const now = Date.now();
    const snapshot = printStats(stats, now - startedAt, now - lastTickAt, currentTarget);
    console.log(
      `[SIMULATED TRAFFIC] summary | elapsed ${formatDuration(now - startedAt)} | requests ${snapshot.total}` +
        ` | errors ${snapshot.totalErrors} (${snapshot.errorRate.toFixed(1)}%) | 5xx ${snapshot.total5xx}` +
        ` | users ${users.length} (beta ${betaCount})`,
    );
  };

  const onSignal = (): void => {
    void finish("Ctrl+C");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  if (options.durationSec > 0) {
    durationTimer = setTimeout(() => {
      void finish(`duration ${options.durationSec}s reached`);
    }, options.durationSec * 1000);
  }
}

await main();

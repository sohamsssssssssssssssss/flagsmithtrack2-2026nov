import { SHOP_API_URL } from "@blast/shared";

export type CliOptions = {
  users: number;
  rps: number;
  discountRate: number;
  betaRate: number;
  durationSec: number;
  burst: boolean;
  baseUrl: string;
  help: boolean;
};

export class UsageError extends Error {}

const MAX_USERS = 100_000;
const MAX_RPS = 10_000;
const MAX_DURATION_SEC = 24 * 60 * 60;

const DEFAULTS: Omit<CliOptions, "help"> = {
  users: 100,
  rps: 5,
  discountRate: 0.2,
  betaRate: 0.5,
  durationSec: 0,
  burst: false,
  baseUrl: SHOP_API_URL,
};

function readNumber(name: string, raw: string, min: number, max: number, integer: boolean): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new UsageError(
      `${name} must be ${integer ? "an integer" : "a number"} between ${min} and ${max} (got "${raw}")`,
    );
  }
  return value;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { ...DEFAULTS, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--burst") {
      options.burst = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new UsageError(`unknown argument "${arg}"`);

    const equals = arg.indexOf("=");
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    let raw: string | undefined;
    if (equals >= 0) {
      raw = arg.slice(equals + 1);
    } else {
      raw = argv[i + 1];
      if (raw === undefined || raw.startsWith("--")) raw = undefined;
      else i += 1;
    }
    if (raw === undefined) throw new UsageError(`missing value for ${name}`);

    switch (name) {
      case "--users":
        options.users = readNumber(name, raw, 1, MAX_USERS, true);
        break;
      case "--rps":
        options.rps = readNumber(name, raw, 0.1, MAX_RPS, false);
        break;
      case "--discount-rate":
        options.discountRate = readNumber(name, raw, 0, 1, false);
        break;
      case "--beta-rate":
        options.betaRate = readNumber(name, raw, 0, 1, false);
        break;
      case "--duration":
        options.durationSec = readNumber(name, raw, 0, MAX_DURATION_SEC, true);
        break;
      case "--base-url": {
        let url: URL;
        try {
          url = new URL(raw);
        } catch {
          throw new UsageError(`--base-url is not a valid URL (got "${raw}")`);
        }
        options.baseUrl = url.toString().replace(/\/$/, "");
        break;
      }
      default:
        throw new UsageError(`unknown option "${name}"`);
    }
  }

  return options;
}

export const HELP = `
SIMULATED TRAFFIC — Blast Radius demo traffic generator

Usage:
  pnpm --filter traffic start [options]

Options:
  --users <n>            stable identities to simulate (default ${DEFAULTS.users})
  --rps <n>              target requests per second (default ${DEFAULTS.rps})
  --discount-rate <0-1>  share of checkouts with a discount code (default ${DEFAULTS.discountRate})
  --beta-rate <0-1>      share of users in the "beta" cohort (default ${DEFAULTS.betaRate})
  --duration <seconds>   0 = run until Ctrl+C (default 0)
  --burst                double rps for the first 60 seconds
  --base-url <url>       shop API (default ${DEFAULTS.baseUrl})
  -h, --help             show this help

Every request sends x-identity, x-cohort and x-simulated: 1.
Identity is SIMULATED: no real users are involved.
`.trimStart();

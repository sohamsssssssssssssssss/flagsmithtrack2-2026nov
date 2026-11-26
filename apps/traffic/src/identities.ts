import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type IdentityRecord = { identity: string; index: number };

type IdentityFile = {
  version: 1;
  createdAt: string;
  identities: IdentityRecord[];
};

export type Cohort = "beta" | "default";

const MAX_USERS = 100_000;

/**
 * Everything shared by the demo (identities, sqlite, audit lines) lives in the
 * repo-root .blast/. Walk up from this module so it works from src (tsx) and
 * from dist (node), and from any app cwd.
 */
function defaultIdentitiesPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return join(dir, ".blast", "identities.json");
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(process.cwd(), ".blast", "identities.json");
    dir = parent;
  }
}

export const IDENTITIES_PATH = defaultIdentitiesPath();

function newIdentity(index: number): string {
  return `sim-${String(index).padStart(5, "0")}-${randomBytes(4).toString("hex")}`;
}

function parseIdentityFile(raw: unknown): IdentityFile | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Partial<IdentityFile>;
  if (obj.version !== 1 || !Array.isArray(obj.identities)) return null;

  const seen = new Set<string>();
  const identities: IdentityRecord[] = [];
  for (const entry of obj.identities) {
    if (!entry || typeof entry !== "object") return null;
    const identity = (entry as Partial<IdentityRecord>).identity;
    if (typeof identity !== "string" || identity.length === 0 || seen.has(identity)) return null;
    seen.add(identity);
    identities.push({ identity, index: identities.length });
  }

  return {
    version: 1,
    createdAt: typeof obj.createdAt === "string" ? obj.createdAt : new Date(0).toISOString(),
    identities,
  };
}

function saveIdentityFile(filePath: string, file: IdentityFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
}

/**
 * Load the first `count` stable identities, generating only the missing ones.
 * The file is never rewritten when it already has enough identities, so
 * repeated runs keep byte-identical users (same identity every run).
 */
export function loadIdentities(count: number, filePath: string = IDENTITIES_PATH): IdentityRecord[] {
  if (!Number.isInteger(count) || count < 0 || count > MAX_USERS) {
    throw new Error(`users must be an integer between 0 and ${MAX_USERS}`);
  }

  let file: IdentityFile | null = null;
  if (existsSync(filePath)) {
    try {
      file = parseIdentityFile(JSON.parse(readFileSync(filePath, "utf8")));
    } catch {
      file = null;
    }
    if (!file) {
      const backup = `${filePath}.corrupt-${Date.now()}`;
      renameSync(filePath, backup);
      console.warn(`[SIMULATED TRAFFIC] unreadable identity file moved to ${backup}; regenerating`);
    }
  }

  if (!file) {
    file = { version: 1, createdAt: new Date().toISOString(), identities: [] };
  }

  if (file.identities.length < count) {
    while (file.identities.length < count) {
      const index = file.identities.length;
      file.identities.push({ identity: newIdentity(index), index });
    }
    saveIdentityFile(filePath, file);
  }

  return file.identities.slice(0, count);
}

function hashFraction(value: string): number {
  const digest = createHash("sha256").update(value).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Deterministic so a user keeps their cohort across runs, but derived from the
 * current --beta-rate so changing the share re-splits the population.
 */
export function cohortFor(identity: string, betaRate: number): Cohort {
  return hashFraction(identity) < betaRate ? "beta" : "default";
}

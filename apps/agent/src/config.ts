import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// src/ and dist/ are both one level under apps/agent, so this resolves to the repo root from either.
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const BLAST_DIR = process.env.BLAST_DIR ?? `${ROOT}.blast`;

export function loadConfig() {
  if (existsSync(`${ROOT}.env`)) process.loadEnvFile(`${ROOT}.env`);
  const flags = JSON.parse(readFileSync(`${ROOT}config/flags.json`, "utf8")) as {
    project_id: number;
    environment: { id: number; name: string } | null;
  };
  const adminKey = process.env.FLAGSMITH_ADMIN_KEY;
  if (!adminKey) throw new Error("FLAGSMITH_ADMIN_KEY missing in .env");
  return {
    apiUrl: process.env.FLAGSMITH_API_URL ?? "https://api.flagsmith.com",
    adminKey,
    projectId: Number(process.env.FLAGSMITH_PROJECT_ID ?? flags.project_id),
    envName: flags.environment?.name ?? "Development",
    envKey: process.env.FLAGSMITH_ENV_KEY || undefined, // resolved via the admin API when unset
  };
}

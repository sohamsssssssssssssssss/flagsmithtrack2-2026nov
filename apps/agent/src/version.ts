import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PORTS } from "@blast/shared";

const exec = promisify(execFile);

export type Versions = { shop: () => Promise<string>; local: () => Promise<string> };

/** The commit the agent's checkout (the demo branch) is at. */
export async function localSha(root: string) {
  return (await exec("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 5_000 })).stdout.trim();
}

/** The commit the running shop reports from GET /api/version. */
export async function shopSha(url = `http://localhost:${PORTS.shopApi}`) {
  const response = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Shop version HTTP ${response.status}`);
  return ((await response.json()) as { sha?: string }).sha ?? "";
}

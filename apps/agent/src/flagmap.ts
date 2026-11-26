import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFlagMap, type FlagMap } from "@blast/mapper";
import { BLAST_DIR, ROOT } from "./config.js";
import type { FlagsmithClient } from "./flagsmith.js";

export function createFlagMap(client: Pick<FlagsmithClient, "listFeatures">) {
  let current: FlagMap | null = null;
  let pending: Promise<FlagMap> | undefined;
  async function generate() {
    const config = JSON.parse(await readFile(join(ROOT, "config/flags.json"), "utf8")) as {
      features: Record<string, number>;
    };
    const live = await client.listFeatures().catch(() => []);
    const keys = [...Object.keys(config.features), ...live.map((feature) => feature.name)];
    current = await writeFlagMap(ROOT, keys, BLAST_DIR);
    return current;
  }
  return {
    get: () => current,
    refresh: () => pending ??= generate().finally(() => { pending = undefined; }),
  };
}

import { appendFileSync, mkdirSync } from "node:fs";
import { BLAST_DIR } from "./config.js";

/** Append one JSON line to .blast/audit.jsonl. Callers must pass already-redacted data. */
export function audit(event: string, data: Record<string, unknown>, dir = BLAST_DIR): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(`${dir}/audit.jsonl`, JSON.stringify({ ts: Date.now(), event, ...data }) + "\n");
}

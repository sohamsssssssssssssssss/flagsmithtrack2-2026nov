import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { FlagSnapshot } from "@blast/shared";
import { BLAST_DIR, ROOT } from "./config.js";
import type { RequestRow } from "./metrics.js";
import { compareRates } from "./fisher.js";
import { totals } from "./detector.js";

export type Failure = { route: string; stack: string; flags_json: string };
export type RecentChange = { ts: number; flag_key: string };
export type FlagFiles = Record<string, string[]>;

export function readFlagFiles(): FlagFiles {
  try {
    const data = JSON.parse(readFileSync(`${BLAST_DIR}/flagmap.json`, "utf8"));
    const files = Object.create(null) as FlagFiles;
    for (const [key, value] of Object.entries(data.flags ?? {})) {
      const paths = (value as { files?: unknown } | null)?.files;
      if (Array.isArray(paths) && paths.every((file) => typeof file === "string")) files[key] = paths;
    }
    return files;
  } catch {
    return {};
  }
}

function projectFile(file: string): string | undefined {
  const path = relative(ROOT, isAbsolute(file) ? file : resolve(ROOT, file));
  return path.startsWith("../") || path.startsWith("node:") || path.split("/").includes("node_modules")
    ? undefined : path;
}

export function rankFlags(rows: RequestRow[], failures: Failure[], changes: RecentChange[], spike: number, files: FlagFiles) {
  const candidates = new Set(changes.map((change) => change.flag_key));
  for (const failure of failures) {
    for (const key of Object.keys(JSON.parse(failure.flags_json) as FlagSnapshot)) candidates.add(key);
  }
  const routes = new Set(failures.map((failure) => failure.route));
  const frames = failures.flatMap(({ stack }) => stack.split("\n").flatMap((line) => {
    const match = line.match(/^\s+at (?:.* \()?((?:file:\/\/)?[^()]+):\d+:\d+\)?$/);
    const path = match?.[1] && projectFile(match[1].replace(/^file:\/\//, "").replaceAll("%20", " "));
    return path ? [path] : [];
  }));
  const ranking = [...candidates].map((flag) => {
    const requests = rows.filter((row) => row.flag_key === flag && routes.has(row.route));
    const cohort = (on: boolean) => totals(requests.filter((row) => Boolean(row.flag_on) === on)
      .map((row) => ({ requests: row.count, errors: row.errors })));
    const on = cohort(true), off = cohort(false);
    const { test, p, z } = compareRates(on, off);
    const higher = on.rate !== null && off.rate !== null && on.rate > off.rate;
    const split = Number(higher && (p !== null ? p < 0.001 : z !== null && z > 3.090232306));
    const paths = new Set((Object.hasOwn(files, flag) ? files[flag]! : []).map(projectFile));
    const matched = frames.filter((frame) => paths.has(frame)).length;
    const overlap = frames.length ? matched / frames.length : 0;
    const changed = changes.filter((change) => change.flag_key === flag && change.ts <= spike)
      .reduce<RecentChange | undefined>((latest, change) => !latest || change.ts > latest.ts ? change : latest, undefined);
    const minutes = changed ? (spike - changed.ts) / 60_000 : null;
    const recency = minutes === null ? 0 : Math.exp(-minutes / 10);
    const pct = (rate: number | null) => rate === null ? "unavailable" : `${(rate * 100).toFixed(1)}%`;
    return {
      flag, score: 0.6 * split + 0.3 * overlap + 0.1 * recency, on, off, z, p, test,
      split, overlap, matched_frames: matched, failing_frames: frames.length,
      map: paths.size ? "mapped" : "no map", recency, minutes_since_change: minutes,
      reason: `${flag} was on for ${on.requests} of ${on.requests + off.requests} requests on failing routes, with ${pct(on.rate)} errors on versus ${pct(off.rate)} off${minutes === null ? "" : `, ${minutes.toFixed(1)} minutes after its last change`}${paths.size ? "" : " (no map)"}.`,
    };
  }).sort((a, b) => b.score - a.score || a.flag.localeCompare(b.flag));
  const first = ranking[0];
  const confidence = first && first.score >= 0.7 && first.score - (ranking[1]?.score ?? 0) >= 0.25
    ? "confident" as const : "ambiguous" as const;
  return { confidence, ranking };
}

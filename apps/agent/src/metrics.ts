import type { DB } from "./db.js";

export const BUCKET_MS = 10_000;

export interface RequestRow { ts_bucket: number; route: string; flag_key: string; flag_on: number | boolean; count: number; errors: number }
export interface Bucket { ts: number; requests: number; errors: number; rate: number | null }
export interface Metrics {
  bucket_ms: number;
  overall: Bucket[];
  by_route: Record<string, Bucket[]>;
  by_flag: Record<string, { on: Bucket[]; off: Bucket[] }>;
}

const rate = (b: Omit<Bucket, "rate">): Bucket => ({ ...b, rate: b.requests ? b.errors / b.requests : null });

/** Pure aggregation into 10 s buckets: overall error rate and error rate per flag_key x flag_on. */
export function aggregate(rows: RequestRow[], alignment = 0): Metrics {
  // Each request is reported once per flag, so the overall count per (bucket, route) is the max over flags, not the sum.
  const perFlag = new Map<string, { requests: number; errors: number }>(); // bucket|route|flag
  const byFlag = new Map<string, Map<number, { requests: number; errors: number }>>(); // flag|on -> bucket
  for (const r of rows) {
    const ts = Math.floor((r.ts_bucket - alignment) / BUCKET_MS) * BUCKET_MS + alignment;
    const k = `${ts}|${r.route}|${r.flag_key}`;
    const a = perFlag.get(k) ?? { requests: 0, errors: 0 };
    a.requests += r.count; a.errors += r.errors; perFlag.set(k, a);
    const fk = `${r.flag_key}|${r.flag_on ? "on" : "off"}`;
    const m = byFlag.get(fk) ?? new Map(); byFlag.set(fk, m);
    const b = m.get(ts) ?? { requests: 0, errors: 0 };
    b.requests += r.count; b.errors += r.errors; m.set(ts, b);
  }
  const route = new Map<string, { requests: number; errors: number }>(); // bucket|route
  for (const [k, v] of perFlag) {
    const rk = k.slice(0, k.lastIndexOf("|"));
    const cur = route.get(rk);
    if (!cur || v.requests > cur.requests) route.set(rk, v);
  }
  const overall = new Map<number, { requests: number; errors: number }>();
  const routeBuckets = new Map<string, Bucket[]>();
  for (const [k, v] of route) {
    const ts = Number(k.slice(0, k.indexOf("|")));
    const name = k.slice(k.indexOf("|") + 1);
    const buckets = routeBuckets.get(name) ?? [];
    buckets.push(rate({ ts, ...v }));
    routeBuckets.set(name, buckets);
    const o = overall.get(ts) ?? { requests: 0, errors: 0 };
    o.requests += v.requests; o.errors += v.errors; overall.set(ts, o);
  }
  const series = (m: Map<number, { requests: number; errors: number }>) =>
    [...m].sort((a, b) => a[0] - b[0]).map(([ts, v]) => rate({ ts, ...v }));
  const by_flag: Metrics["by_flag"] = Object.create(null);
  for (const [fk, m] of byFlag) {
    const [flag, side] = fk.split("|") as [string, "on" | "off"];
    (by_flag[flag] ??= { on: [], off: [] })[side] = series(m);
  }
  const by_route = Object.fromEntries([...routeBuckets].map(([name, buckets]) =>
    [name, buckets.sort((a, b) => a.ts - b.ts)]));
  return { bucket_ms: BUCKET_MS, overall: series(overall), by_route, by_flag };
}

export function metrics(db: DB, windowSec: number, now = Date.now()): Metrics & { error_events: { ts: number; count: number }[] } {
  const since = Math.floor((now - windowSec * 1000) / BUCKET_MS) * BUCKET_MS;
  const rows = db.prepare("SELECT * FROM requests WHERE ts_bucket >= ?").all(since) as RequestRow[];
  const error_events = db.prepare(`SELECT (ts / ${BUCKET_MS}) * ${BUCKET_MS} AS ts, COUNT(*) AS count FROM errors WHERE ts >= ? GROUP BY 1 ORDER BY 1`)
    .all(since) as { ts: number; count: number }[];
  return { ...aggregate(rows), error_events };
}

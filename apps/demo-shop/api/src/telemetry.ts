import { AGENT_URL, INGEST, type ErrorEvent, type FlagSnapshot, type RequestBatch } from "@blast/shared";

export const REQUEST_BUCKET_MS = 2_000;

export function createTelemetry(agentUrl = AGENT_URL) {
  const buckets = new Map<number, Map<string, Map<string, RequestBatch["rows"][number]>>>();

  function post(path: string, body: ErrorEvent | RequestBatch) {
    void fetch(agentUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2_000),
    }).catch(() => {});
  }

  return {
    error: (event: ErrorEvent) => post(INGEST.error, event),
    record(ts: number, route: string, flags: FlagSnapshot, failed: boolean) {
      const bucket = Math.floor(ts / REQUEST_BUCKET_MS) * REQUEST_BUCKET_MS;
      const routes = buckets.get(bucket) ?? new Map();
      buckets.set(bucket, routes);
      const rows = routes.get(route) ?? new Map();
      routes.set(route, rows);
      for (const [flag_key, { enabled: flag_on }] of Object.entries(flags)) {
        const key = JSON.stringify([flag_key, flag_on]);
        const row = rows.get(key) ?? { flag_key, flag_on, count: 0, errors: 0 };
        row.count++;
        row.errors += Number(failed);
        rows.set(key, row);
      }
    },
    flush(now = Date.now()) {
      for (const [ts_bucket, routes] of buckets) {
        if (ts_bucket + REQUEST_BUCKET_MS > now) continue;
        buckets.delete(ts_bucket);
        for (const [route, rows] of routes) {
          if (rows.size) post(INGEST.requests, { ts_bucket, route, rows: [...rows.values()] });
        }
      }
    },
  };
}

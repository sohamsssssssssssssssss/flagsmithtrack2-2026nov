import { z } from "zod";

export const PORTS = { agent: 4000, dashboard: 5173, shopWeb: 5174, shopApi: 4100 } as const;
// Plain constants (no process.env) so the browser apps can import them too.
export const AGENT_URL = `http://localhost:${PORTS.agent}`;
export const SHOP_API_URL = `http://localhost:${PORTS.shopApi}`;
export const INGEST = { error: "/ingest/error", requests: "/ingest/requests" } as const;

export const FlagValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const FlagState = z.object({ enabled: z.boolean(), value: FlagValue });
export type FlagState = z.infer<typeof FlagState>;

/** The flags the SDK served to one identity, keyed by flag name. */
export const FlagSnapshot = z.record(z.string(), FlagState);
export type FlagSnapshot = z.infer<typeof FlagSnapshot>;

export const ErrorEvent = z.object({
  ts: z.number(),
  identity: z.string(),
  route: z.string(),
  message: z.string(),
  stack: z.string(),
  flags: FlagSnapshot,
  source: z.enum(["server", "browser"]),
  simulated: z.boolean(),
});
export type ErrorEvent = z.infer<typeof ErrorEvent>;

/** Body of POST /ingest/error: one event or a batch. */
export const ErrorIngest = z.union([ErrorEvent, z.array(ErrorEvent)]);
export type ErrorIngest = z.infer<typeof ErrorIngest>;

/** Body of POST /ingest/requests: per-route counts split by flag state (the denominator). */
export const RequestBatch = z.object({
  ts_bucket: z.number(),
  route: z.string(),
  rows: z.array(
    z.object({
      flag_key: z.string(),
      flag_on: z.boolean(),
      count: z.number().int().nonnegative(),
      errors: z.number().int().nonnegative(),
    }),
  ),
});
export type RequestBatch = z.infer<typeof RequestBatch>;

export const FlagChange = z.object({
  ts: z.number(),
  env: z.string(),
  flag_key: z.string(),
  feature_id: z.number().int(),
  before: FlagState.nullable(), // null when the flag first appears
  after: FlagState.nullable(), // null when the flag disappears
  source: z.enum(["poll", "agent"]),
});
export type FlagChange = z.infer<typeof FlagChange>;

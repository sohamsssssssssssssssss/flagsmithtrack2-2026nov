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

export const CheckoutReplay = z.object({
  method: z.literal("POST"),
  body: z.object({
    items: z.array(z.object({
      id: z.string().regex(/^[a-z0-9_-]{1,64}$/),
      quantity: z.number().int().min(1).max(99),
    })).min(1).max(100),
    discountCode: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
  }),
});
export type CheckoutReplay = z.infer<typeof CheckoutReplay>;

export const ErrorEvent = z.object({
  /** Epoch milliseconds. */
  ts: z.number(),
  identity: z.string(),
  route: z.string(),
  message: z.string(),
  stack: z.string(),
  flags: FlagSnapshot,
  source: z.enum(["server", "browser"]),
  simulated: z.boolean(),
  replay: CheckoutReplay.optional(),
});
export type ErrorEvent = z.infer<typeof ErrorEvent>;

/** Body of POST /ingest/error: one event or a batch. */
export const ErrorIngest = z.union([ErrorEvent, z.array(ErrorEvent)]);
export type ErrorIngest = z.infer<typeof ErrorIngest>;

/** Body of POST /ingest/requests: per-route counts split by flag state (the denominator). */
export const RequestBatch = z.object({
  /** Bucket start, epoch milliseconds. The agent re-buckets to 30 s. */
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

/** Live state of a flag in one environment, as the agent reads it from the Flagsmith Admin API. */
export const SegmentOverrideState = z.object({ segment_id: z.number().int(), enabled: z.boolean(), value: FlagValue });
export const FlagLiveState = FlagState.extend({ overrides: z.array(SegmentOverrideState) });
export type FlagLiveState = z.infer<typeof FlagLiveState>;

export const FlagChange = z.object({
  ts: z.number(),
  env: z.string(),
  flag_key: z.string(),
  feature_id: z.number().int(),
  before: FlagLiveState.nullable(), // null when the flag first appears
  after: FlagLiveState.nullable(), // null when the flag disappears
  source: z.enum(["poll", "agent"]),
});
export type FlagChange = z.infer<typeof FlagChange>;

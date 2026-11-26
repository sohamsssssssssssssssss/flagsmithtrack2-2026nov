import type { createFlagMap } from "./flagmap.js";
import type { buildIncidents } from "./incidents.js";
import type { buildProposals } from "./proposals.js";
import Fastify from "fastify";
import { EventEmitter } from "node:events";
import { ErrorIngest, INGEST, RequestBatch } from "@blast/shared";
import { listChanges } from "./changes.js";
import type { DB } from "./db.js";
import { metrics } from "./metrics.js";

/** Bus events: "change" (FlagChange) from the watcher, "bucket" (latest metrics) after ingest. */
export function buildServer(db: DB, bus = new EventEmitter(), workflow?: {
  incidents: ReturnType<typeof buildIncidents>; proposals: ReturnType<typeof buildProposals>;
  flagMap?: ReturnType<typeof createFlagMap>;
}) {
  const app = Fastify({ logger: false });
  bus.setMaxListeners(0);

  const insertError = db.prepare(`INSERT INTO errors(ts, identity, route, message, stack, flags_json, source, simulated)
    VALUES (@ts, @identity, @route, @message, @stack, @flags_json, @source, @simulated)`);
  const insertReq = db.prepare(`INSERT INTO requests(ts_bucket, route, flag_key, flag_on, count, errors)
    VALUES (?, ?, ?, ?, ?, ?)`);

  // Coalesce ingest into at most one SSE "bucket" push per second.
  let dirty = false;
  const pusher = setInterval(() => {
    if (!dirty || bus.listenerCount("bucket") === 0) return;
    dirty = false;
    const m = metrics(db, 60);
    bus.emit("bucket", { overall: m.overall.at(-1) ?? null, error_events: m.error_events.at(-1) ?? null });
  }, 1000);
  app.addHook("onClose", async () => clearInterval(pusher));

  app.get("/health", async () => ({ ok: true }));

  app.post(INGEST.error, async (req, reply) => {
    const r = ErrorIngest.safeParse(req.body);
    if (!r.success) return reply.code(400).send({ error: r.error.issues });
    const events = Array.isArray(r.data) ? r.data : [r.data];
    db.transaction(() => events.forEach((e) =>
      insertError.run({ ...e, flags_json: JSON.stringify(e.flags), simulated: e.simulated ? 1 : 0 })))();
    dirty = true;
    return reply.code(202).send({ accepted: events.length });
  });

  app.post(INGEST.requests, async (req, reply) => {
    const r = RequestBatch.safeParse(req.body);
    if (!r.success) return reply.code(400).send({ error: r.error.issues });
    const b = r.data;
    db.transaction(() => b.rows.forEach((row) =>
      insertReq.run(b.ts_bucket, b.route, row.flag_key, row.flag_on ? 1 : 0, row.count, row.errors)))();
    dirty = true;
    return reply.code(202).send({ accepted: b.rows.length });
  });

  app.get("/api/flags", async () => {
    const rows = db.prepare(`SELECT s.flag_key, s.feature_id, s.state_json, s.updated_ts,
        (SELECT MAX(ts) FROM flag_changes c WHERE c.flag_key = s.flag_key) AS last_change_ts
      FROM flag_state s ORDER BY s.flag_key`).all() as Record<string, any>[];
    return rows.map((r) => ({ flag_key: r.flag_key, feature_id: r.feature_id, state: JSON.parse(r.state_json),
      state_ts: r.updated_ts, last_change_ts: r.last_change_ts ?? null }));
  });

  app.get<{ Querystring: { since?: string; limit?: string } }>("/api/changes", async (req) =>
    listChanges(db, Number(req.query.since ?? 0) || 0, Math.min(Number(req.query.limit ?? 200) || 200, 1000)));

  app.get<{ Querystring: { window?: string } }>("/api/metrics", async (req, reply) => {
    const w = Number(req.query.window ?? 600);
    if (!Number.isFinite(w) || w <= 0 || w > 86_400) return reply.code(400).send({ error: "window must be 1..86400 seconds" });
    return metrics(db, w);
  });

  if (workflow) {
    const { incidents, proposals } = workflow;
    if (workflow.flagMap) {
      const flagMap = workflow.flagMap;
      app.get("/api/map", (_req, reply) => flagMap.get() ?? reply.code(503).send({ message: "Flag map is being generated" }));
      app.post("/api/map/refresh", () => flagMap.refresh());
    }
    app.get("/api/incidents", () => incidents.list());
    app.get<{ Params: { id: string } }>("/api/incidents/:id", (req) => incidents.get(Number(req.params.id)));
    app.post<{ Params: { id: string }; Body: { flag: string } }>("/api/incidents/:id/propose", {
      schema: { body: { type: "object", required: ["flag"], properties: { flag: { type: "string", minLength: 1, maxLength: 200 } } } },
    }, (req) => incidents.pick(Number(req.params.id), req.body.flag));
    for (const decision of ["approve", "reject"] as const) {
      app.post<{ Params: { id: string }; Body: { approver: string } }>(`/api/proposals/:id/${decision}`, {
        schema: { body: { type: "object", required: ["approver"], properties: {
          approver: { type: "string", pattern: "\\S", maxLength: 200 },
        } } },
      }, (req) => proposals[decision](Number(req.params.id), req.body.approver.trim()));
    }
  }

  app.get("/api/stream", (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    const send = (event: string) => (data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const events = ["change", "bucket", "incident_opened", "proposal_created", "action_done", "incident_closed"];
    const listeners = events.map((event) => ({ event, listener: send(event) }));
    listeners.forEach(({ event, listener }) => bus.on(event, listener));
    const ping = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
    reply.raw.write(": connected\n\n");
    reply.raw.on("close", () => {
      clearInterval(ping);
      listeners.forEach(({ event, listener }) => bus.off(event, listener));
    });
  });

  // Dashboard runs on another port in dev.
  app.addHook("onSend", async (_req, reply) => { reply.header("Access-Control-Allow-Origin", "*"); });

  return app;
}

import Fastify from "fastify";
import { ErrorIngest, INGEST, RequestBatch } from "@blast/shared";

// Stub: validates and acknowledges ingest; storage comes in B6.
export function buildServer() {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ ok: true }));
  app.post(INGEST.error, async (req, reply) => {
    const r = ErrorIngest.safeParse(req.body);
    if (!r.success) return reply.code(400).send({ error: r.error.issues });
    return reply.code(202).send({ accepted: Array.isArray(r.data) ? r.data.length : 1 });
  });
  app.post(INGEST.requests, async (req, reply) => {
    const r = RequestBatch.safeParse(req.body);
    if (!r.success) return reply.code(400).send({ error: r.error.issues });
    return reply.code(202).send({ accepted: r.data.rows.length });
  });
  return app;
}

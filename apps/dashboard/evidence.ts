import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";

const database = join(process.env.BLAST_DIR || fileURLToPath(new URL("../../.blast", import.meta.url)), "db.sqlite");

export function dashboardEvidence(): Plugin {
  const setup = (middlewares: Connect.Server) => {
    middlewares.use("/dashboard-evidence", (req, res) => {
      if (req.method !== "GET") { res.writeHead(405).end(); return; }
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      const start = Number(params.get("start")), end = Number(params.get("end"));
      if (![start, end].every((ts) => Number.isSafeInteger(ts) && ts >= 0) || end < start) {
        res.writeHead(400).end(); return;
      }
      const sql = `SELECT EXISTS(SELECT 1 FROM errors WHERE simulated=1) AS simulated,
        (SELECT json_object('route',route,'stack',substr(stack,1,8192)) FROM errors
         WHERE ts >= ${start} AND ts < ${end} ORDER BY source='server' DESC, ts LIMIT 1) AS sample`;
      execFile("/usr/bin/sqlite3", ["-readonly", "-json", "-cmd", ".timeout 1000", database, sql],
        { timeout: 2_000, maxBuffer: 32_768 }, (error, stdout) => {
          if (error) { res.writeHead(503).end(); return; }
          const hit = JSON.parse(stdout)[0];
          const sample = hit.sample ? JSON.parse(hit.sample) as { route: string; stack: string } : null;
          const frame = sample?.stack.match(/(?:\/|\()(apps\/[^\n()]+?:\d+):\d+\)?(?:\n|$)/)?.[1];
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ simulated: Boolean(hit.simulated), route: sample?.route, frame }));
        });
    });
  };
  return { name: "dashboard-evidence", configureServer: (server) => setup(server.middlewares),
    configurePreviewServer: (server) => setup(server.middlewares) };
}

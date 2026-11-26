# Blast Radius dashboard

Start the agent and dashboard with `pnpm demo:up`. Open `http://localhost:5173` for live errors, incident evidence, and approval history. The dashboard uses the Vite proxy for the agent's HTTP API and SSE so decisions work on the same origin.

The Vite evidence endpoint reads the agent's SQLite database in read-only mode through the macOS `sqlite3` command. It returns the failing route, a repository-relative stack frame, and whether simulated events have been seen. If you use `BLAST_DIR`, set the same absolute path for both services. The chart and approval controls continue working if the evidence database is unavailable.

`vendor/` contains the MIT-licensed Recharts 3.11.1 browser distribution and react-is 19.3.1. The Recharts UMD wrapper calls the same factory with ES module imports for React, React DOM, and react-is. The react-is production CommonJS bundle exports its existing object as ESM. These adapters keep the dashboard independent of changes to the root workspace lockfile. The upstream license files are included.

The Map tab uses the agent-generated flag graph. Select a flag to inspect live state and file references. The agent generates the map on boot and Refresh map rescans the current source tree. Static route attribution is best effort.

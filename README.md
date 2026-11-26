# Blast Radius (working name)

It maps every Flagsmith flag in your code. When your app breaks, it finds the flag that did it, turns it off, and writes the fix. You approve every step.

Built for Toggle Wars (WeMakeDevs × Flagsmith), Track 02: AI Agents and Feature Flags.

Docs:
- [01 PRD](docs/01_PRD.md)
- [02 Tech Spec](docs/02_TECH_SPEC.md)
- [03 Build Plan and Tracker](docs/03_BUILD_PLAN.md)

## Run the demo

Use Node 20.19+ on the Node 20 line, or Node 22.12+.

```sh
pnpm i
cp .env.example .env   # for a new checkout
```

Fill in the Development admin key, public environment key, and server-side SDK key in `.env`. For a new Flagsmith project, run `pnpm seed` to create the flags and beta segment.

Run `pnpm demo:up` to start the agent, shop API, storefront, and dashboard. In another terminal, run `pnpm traffic` for 300 simulated identities at 8 requests per second.

After 60 seconds of baseline traffic, run `node scripts/demo-break.mjs` and approve the beta-only checkout change. Wait 90 seconds and inspect `/api/metrics` on port 4000. Run `node scripts/demo-reset.mjs` and approve the reset. The scripts re-read each write and append the before/after state to `.blast/audit.jsonl`. Use `node scripts/rehearse.mjs --runs 5` for audited non-interactive rehearsals. Stop existing demo services first. The runner uses `pnpm traffic:demo` with 600 simulated users at 25 requests per second, saves results in `notes/rehearsals.md`, and resets the demo flag after each trial without approving proposals.

| app | package | port |
|---|---|---|
| agent (Fastify; `POST /ingest/error`, `POST /ingest/requests`) | `@blast/agent` | 4000 |
| dashboard (Vite React) | `@blast/dashboard` | 5173 |
| demo shop web (Vite React, DEMO) | `@blast/shop-web` | 5174 |
| demo shop api (Express, DEMO) | `@blast/shop-api` | 4100 |
| traffic generator (SIMULATED) | `@blast/traffic` | - |

Shared types, zod schemas, ports and ingest paths: `packages/shared/src/index.ts`.

# Blast Radius (working name)

It maps every Flagsmith flag in your code. When your app breaks, it finds the flag that did it, turns it off, and writes the fix. You approve every step.

Built for Toggle Wars (WeMakeDevs × Flagsmith), Track 02: AI Agents and Feature Flags.

Docs:
- [01 PRD](docs/01_PRD.md)
- [02 Tech Spec](docs/02_TECH_SPEC.md)
- [03 Build Plan and Tracker](docs/03_BUILD_PLAN.md)

Status: P1 scaffold. Apps are hello-world stubs; the shared contract lives in `packages/shared`.

## Dev

Needs Node 20+ and corepack (`corepack enable`).

```sh
pnpm i
cp .env.example .env               # fill in the keys
pnpm seed                          # idempotent: creates the 5 demo flags + beta_cohort segment, writes config/flags.json
pnpm llm-check                     # lists models at LLM_BASE_URL and tries one chat call
pnpm dev                           # everything, in parallel
pnpm build && pnpm test && pnpm lint
```

| app | package | port |
|---|---|---|
| agent (Fastify; `POST /ingest/error`, `POST /ingest/requests`) | `@blast/agent` | 4000 |
| dashboard (Vite React) | `@blast/dashboard` | 5173 |
| demo shop web (Vite React, DEMO) | `@blast/shop-web` | 5174 |
| demo shop api (Express, DEMO) | `@blast/shop-api` | 4100 |
| traffic generator (SIMULATED) | `@blast/traffic` | - |

Shared types, zod schemas, ports and ingest paths: `packages/shared/src/index.ts`.

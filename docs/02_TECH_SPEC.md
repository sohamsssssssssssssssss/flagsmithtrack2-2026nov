# 02 — Tech Spec: Blast Radius

## 1. Stack

- Node 20+, TypeScript, pnpm workspaces.
- Agent server: Fastify (HTTP and Server-Sent Events), better-sqlite3 for storage, zod for validation.
- Mapper: `@babel/parser` and `@babel/traverse` (or ts-morph) for the JS/TS syntax tree.
- Dashboard: Vite, React, React Flow (map) and Recharts (error line).
- Demo shop: Vite and React frontend, Express backend, Flagsmith JS SDK (client) and Node SDK (server).
- LLM: any OpenAI-compatible endpoint (Gemini's OpenAI-compatible endpoint, Groq, OpenRouter free models), set by `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY`.
- GitHub: `gh` CLI or Octokit for the PR.

## 2. Repo layout

```
apps/
  agent/       # server: watcher, detector, ranker, responder, fixer, rollout, API
  dashboard/   # React UI: map, incidents, approvals
  demo-shop/   # target app with flags and a planted bug
  traffic/     # simulated user generator (labelled SIMULATED)
packages/
  mapper/      # static scan: flag -> code regions
  shared/      # types, zod schemas
docs/
.blast/        # gitignored runtime data: db.sqlite, audit.jsonl, sandboxes/
```

## 3. Components

### 3.1 Mapper (`packages/mapper`)
- Input: repo path, plus the flag names from the Flagsmith API.
- Detects calls: `hasFeature('x')`, `getValue('x')`, `isFeatureEnabled('x')`, `getFeatureValue('x')`, `useFlags(['x', ...])` and `flags.x` access, `getExperimentFlag('x')`, and string literals matching a known flag name (marked as low confidence).
- For each hit it records: flag, file, line, the enclosing function, the region guarded by the if/ternary, and the route if it can be resolved (Express `app.get/post`, React Router paths).
- Output: `FlagMap { flags[], nodes[], edges[] }` as JSON, cached by git SHA.
- Merges in live state: enabled, value, segment overrides, last change time.

### 3.2 Error collector (agent `POST /ingest/error`)
- Demo shop sends: `{ ts, identity, route, message, stack, flags: { [key]: { enabled, value } } }`.
- Browser: `window.onerror`, `unhandledrejection` and React error boundary. Server: Express error middleware.
- The flags field is the snapshot the SDK served to that identity. This is what makes the on/off split possible.
- Also `POST /ingest/request` with a count per route, per flag state, for the denominator. Batched every 5 seconds.

### 3.3 Flag watcher
- Polls the Flagsmith Admin API every 10 seconds for feature states per environment, diffs them against the last snapshot, and stores the changes in `flag_changes`.
- If webhooks prove workable (Day-0 check), use them as well and keep polling as the fallback.

### 3.4 Spike detector (deterministic)
- 30-second buckets. A spike is when error rate is at least 3 times the rolling 10-minute baseline, at least 20 errors in the window, and above a 2% absolute floor.
- Opens an `incident` and stays open until the rate is below 1.5 times baseline for 2 minutes.

### 3.5 Culprit ranker (deterministic)
Each candidate flag (changed in the last 30 minutes, or on in the failing requests) gets three scores:

| Signal | Computation | Weight |
|---|---|---|
| On/off split | error rate with flag on vs off; two-proportion z-test; needs n ≥ 30 in each group | 0.6 |
| Code overlap | share of failing stack frames that fall inside the flag's mapped regions | 0.3 |
| Recency | `exp(-minutes_between_change_and_spike / 10)` | 0.1 |

- Output: ranked list with the raw numbers shown, not only a score.
- **Confident** if the top score is at least 0.7 and at least 0.25 ahead of the second. Otherwise it reports "ambiguous" and shows the top 2. No kill is proposed for an ambiguous result unless the human picks one.

### 3.6 Responder (kill switch)
- Proposal: `{ incident_id, flag, env, action: "disable", evidence, snapshot_hash }`.
- Approval in the dashboard. Each approval binds `snapshot_hash` (flag state plus incident window). It expires after 10 minutes. On approval, re-read live state; if it has changed, the approval is refused.
- Execute: `PATCH /api/__future__/environments/{env_key}/features/{feature_id}/` with `{"environment_default":{"enabled":false}}` (experimental endpoint, see section 5). Re-read to confirm, then watch errors for 2 minutes and mark the result as `recovered` or `not_recovered`.

### 3.7 Fixer (LLM, stretch S1)
- Context: the stack trace, the mapped region of the guilty flag (at most 200 lines), and the error message. No secrets and no `.env` content.
- Output: a unified diff, maximum 40 changed lines, only in files from the mapped region.
- Validation: create a git worktree under `.blast/sandboxes/`, apply the patch, run `pnpm build` and `pnpm test`, then replay the failing request (a saved fixture) with the flag forced on. All must pass.
- Pass: push a branch and open a PR with the evidence card in the body. Fail: up to 2 retries with the error output, then show "no safe fix found".

### 3.8 Rollout (stretch S2)
- After the PR is merged and the shop restarted: stages of 10%, 50% and 100%.
- Mechanism (Day-0 check): a segment with a percentage-split rule plus a segment override, or multivariate weights through the same experimental endpoint.
- Each stage needs approval, holds for at least 2 minutes, and passes a health gate (no spike, and the flag-on error rate is within 1.5 times the flag-off rate). Failure means auto-pause and a proposal to turn the flag off.

### 3.9 Dashboard
- Map view (React Flow): flag nodes linked to file and route nodes. Colours: on (green), off (grey), suspect (amber), guilty (red).
- Error line chart with flag-change markers.
- Incident card: ranked flags with evidence, and Approve/Reject.
- Audit page: approvals.
- Live updates over Server-Sent Events.

## 4. Data (SQLite, `.blast/db.sqlite`)

```
errors(id, ts, identity, route, message, stack, flags_json)
requests(ts_bucket, route, flag_key, flag_on, count)
flag_changes(id, ts, env, flag_key, before_json, after_json, source)   -- source: poll|webhook|agent
incidents(id, opened_ts, closed_ts, status, top_flag, ranking_json)
proposals(id, incident_id, kind, payload_json, snapshot_hash, created_ts, expires_ts, status)
actions(id, proposal_id, ts, request_json, response_status, verify_json)
```
Audit: `.blast/audit.jsonl`. One line per proposal, approval, action and outcome. Append only.

## 5. Flagsmith API

| Need | Endpoint | Status |
|---|---|---|
| List features | `GET /api/v1/projects/{project_id}/features/` | To verify on Day 0 |
| Read flag state | `GET /api/__future__/environments/{env_key}/features/{feature_id}/` | Documented, **experimental** |
| Toggle flag | `PATCH` same URL, body `{"environment_default":{"enabled":false}}` | Documented, **experimental** |
| Segment override | `PATCH` same URL with `segment_overrides[]` | Documented, **experimental** |
| Variant weights | `PATCH` with `environment_default.variants[{id, weight}]` | Documented, **experimental** |
| Change history | Audit log in the dashboard; webhook payload documented; REST read endpoint not documented | To verify on Day 0 |
| Code References | GitHub CI action uploads file and line to Flagsmith; no documented read API | Optional, display only |

Limits: the experimental endpoints may change; flags can't be updated through them when change requests are on (so keep change requests off in the demo environment).

Auth: `Authorization: Api-Key {ADMIN_KEY}` held in `.env`; never logged, never sent to the LLM, never shown in the UI.

## 6. Guardrails

1. No write to Flagsmith or GitHub without a matching, unexpired approval.
2. Approval is tied to a snapshot. Re-read before acting; refuse if the state changed.
3. Actions on an allowlist only: disable flag, set stage weight or override, open PR. No deletes.
4. The LLM never decides the culprit and never sees secrets.
5. Patches: maximum 40 lines, only in mapped files, must pass build, test and replay.
6. Never auto-merge.
7. Demo traffic and the planted bug are labelled SIMULATED and DEMO in the UI, README and video.
8. Every external call has a timeout (10 s) and the result is recorded, success or failure.
9. A partial failure (for example, the flag turned off but the verify failed) is shown as PARTIAL, never as success.
10. Admin key and LLM key come only from `.env`, which is gitignored.

## 7. Config (`.env.example`)

```
FLAGSMITH_API_URL=https://api.flagsmith.com
FLAGSMITH_ADMIN_KEY=
FLAGSMITH_PROJECT_ID=
FLAGSMITH_ENV_KEY=            # server-side environment key for the demo env
FLAGSMITH_CLIENT_ENV_KEY=     # client-side key for the shop
LLM_BASE_URL=
LLM_MODEL=
LLM_API_KEY=
GITHUB_REPO=sohamsssssssssssssssss/flagsmithtrack2-2026nov
```

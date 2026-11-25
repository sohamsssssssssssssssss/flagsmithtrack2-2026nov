# 03 — Build Plan and Tracker: Blast Radius

Times are IST. Hackathon: 26 Nov 08:00 to 29 Nov 20:00. Internal freeze: 29 Nov 10:00. Internal submit target: 29 Nov 16:00.

Workers: Claude Code, Codex, Freebuff. Prompts are delivered as .txt files, one block at a time.

## Day 0: now to 26 Nov 08:00 (checks only)

| ID | Check | Done |
|---|---|---|
| C1 | Flagsmith Cloud account, project `blast-radius`, environment `demo`, change requests **off** | [ ] |
| C2 | Admin API key: `GET features` works; save the raw JSON to `notes/api-probes/` | [ ] |
| C3 | Experimental endpoint: GET and PATCH toggle one flag, then re-read | [ ] |
| C4 | Change history: is there a REST read for the audit log? Do environment webhooks exist on the free plan? | [ ] |
| C5 | Percentage stages: segment percentage-split plus override through the API, **or** variant weights | [ ] |
| C6 | Free LLM: pick a provider and model; one test call through the OpenAI-compatible endpoint | [ ] |
| C7 | Ask on Discord: is a pre-event head start fine, and can one project enter more than one track? | [ ] |

If C3 fails: fall back to the stable v1 feature-state endpoint (look it up), or to the Flagsmith CLI.

## Day 1: 26 Nov, foundation

| ID | Task | Done |
|---|---|---|
| B1 | pnpm monorepo scaffold, TS config, lint, `.env.example`, `.gitignore` (`.blast/`, `.env`) | [ ] |
| B2 | Demo shop: products, cart, checkout; 5 flags (`new_checkout`, `smart_search`, `promo_banner`, `recs_v2`, `free_shipping_threshold`) | [ ] |
| B3 | Planted bug: `new_checkout` path crashes on carts with a discount code | [ ] |
| B4 | Shop sends errors and request counts with flag snapshots to the agent | [ ] |
| B5 | Traffic generator: N identities, realistic paths, about 20% use discount codes; banner says SIMULATED | [ ] |
| B6 | Agent: Flagsmith client (read, toggle, re-read), watcher with polling and diff, SQLite schema | [ ] |

**End of Day 1:** traffic flows, errors land in the database, flag flips are recorded.

## Day 2: 27 Nov, the core loop (MVP complete)

| ID | Task | Done |
|---|---|---|
| B7 | Mapper: Babel scan, regions, routes, JSON output, unit tests on fixtures | [ ] |
| B8 | Spike detector, with unit tests | [ ] |
| B9 | Culprit ranker: on/off z-test, overlap, recency; evidence object; unit tests including two flags changed together | [ ] |
| B10 | Proposals and approvals: snapshot hash, expiry, re-read before acting | [ ] |
| B11 | Kill action, verification, recovery watch, audit JSON lines | [ ] |
| B12 | Minimal dashboard: incident card and Approve button (map comes Day 3) | [ ] |

**End of Day 2:** break, detect, rank, approve, kill, recover, all working. This is the minimum entry. Commit and push.

## Day 3: 28 Nov, the wow

| ID | Task | Done |
|---|---|---|
| B13 | Dashboard map (React Flow) with live colours; error chart with change markers | [ ] |
| B14 | Fixer: LLM patch, worktree, build, test, replay, PR (S1) | [ ] |
| B15 | Staged re-rollout with gates (S2) | [ ] |
| B16 | Rehearse 5 runs; record results in the log below | [ ] |

## Day 4: 29 Nov, ship

| Time | Task | Done |
|---|---|---|
| until 10:00 | Bug fixes only; then freeze | [ ] |
| 10:00–13:00 | README: pitch, GIF, setup, architecture, guardrails, SIMULATED note | [ ] |
| 13:00–15:30 | Record the demo video (story in PRD §8) | [ ] |
| 16:00 | Submit | [ ] |

## Cut order (cut from the top when behind)

1. S3 map warnings
2. S2 staged re-rollout: replace with a single approved re-enable
3. Map polish: a simple list instead of a graph
4. S1 fixer: show the evidence and the kill only, and say the fix PR is future work

Never cut: on/off evidence, approval, kill, verify, audit log.

## Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Experimental API changes or fails | C3 on Day 0; fall back to the v1 endpoint or the CLI |
| R2 | Free LLM writes bad patches | Small scope, sandbox validation, retries; the kill works without it |
| R3 | Free LLM rate limits during the video | Record the fix step once it succeeds; keep a second provider configured |
| R4 | Judges see "Sentry already does this" | Show the on/off proof, the action, the fix and the re-rollout; say it plainly in the video |
| R5 | Solo time crunch | MVP done by the end of Day 2; cut order above |
| R6 | Flag served to the identity differs from the snapshot | Read flags from the same SDK call the code uses; log both |

## Log

| Date | Note |
|---|---|
| 26 Nov | Idea locked: Blast Radius (map, detect, kill, fix, re-roll). Experiment Doctor dropped. |

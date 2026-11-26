# Day 2 end-to-end run

Run on 26 November 2026 against Flagsmith Development, project 56400. The dashboard, agent, shop API, and storefront started with `pnpm demo:up` and responded on ports 5173, 4000, 4100, and 5174. The dashboard served its scaffold. A clean checkout installed all nine workspace projects with one `pnpm i` and built successfully. The existing tracked lockfile already covered the shop dependencies.

`pnpm traffic` used 300 simulated identities, 8 requests per second, a 50% beta assignment, and the default 20% discount-code rate. The 60-second baseline produced zero ingested errors. A pre-break discounted checkout returned HTTP 200 for both cohorts. The shop also served the configured $50 shipping threshold, confirming it had loaded Flagsmith configuration.

## Break and timing

The Admin API kept the environment default off and added an enabled override for `beta_cohort` (1204777). The verification read confirmed that state.

Times below are relative to the successful PATCH response at 08:11:42.481 UTC. The request left the CLI 469 ms earlier. The shop probe and agent ingestion observation sampled roughly every 250 ms.

| Event | UTC | Since PATCH response |
| --- | --- | ---: |
| Admin verification read returned | 08:11:43.556 | 1.075 s |
| First beta checkout returned HTTP 500, with default control HTTP 200 | 08:11:44.088 | 1.607 s |
| First error was visible in the agent database (checkout probe) | 08:11:44.092 | 1.611 s |
| Agent watcher recorded the override with source `poll` | 08:11:46.974 | 4.493 s |
| First traffic-generator error was visible in the agent database | 08:11:48.449 | 5.968 s |

## Metrics after 90 seconds

`GET /api/metrics?window=300` showed 14 ingested error events in the break window. All 14 were simulated and on `/api/checkout`, including one timing-probe event. The request series and the event series are delivered independently. Four events in the trailing bucket were visible before their request batches flushed.

| Scope | Checkout flag ON | Checkout flag OFF |
| --- | ---: | ---: |
| All routes, API buckets intersecting the break window | 10 errors / 336 requests (2.98%) | 0 / 448 (0%) |
| Checkout only, agent request rows from the first full 5-second bucket after the break | 9 errors / 74 requests (12.16%) | 0 / 73 (0%) |

The 30-second API buckets include the pre-break portion of the first bucket. The checkout-only row excludes the first partial bucket and the trailing unflushed requests.

## Reset and issues

The first reset PATCH returned HTTP 400 because the API rejects a `variants` field, even an empty array, for this standard flag. The client now omits empty variant lists and preserves populated ones. The retried reset returned HTTP 200. Its verification read showed the default and beta override both off. A subsequent PATCH with an empty override list preserved the disabled beta override. The agent watcher recorded recovery at 08:13:43.789 UTC. Discounted checkout then returned HTTP 200 and 4320 cents for both cohorts.

The Development environment initially had no server-side SDK key. A Development key was created for the local demo and configured in the ignored `.env`. The four demo services were left running and the traffic generator was stopped. The scripts recorded approval, outbound PATCH, response status, and verified before/after state in `.blast/audit.jsonl`. A declined TTY prompt exited before making a PATCH.

## D2-B detection, approval, and recovery

The four services ran via `pnpm demo:up` with an isolated runtime directory and a manually supplied `flagmap.json` mapping `new_checkout` to the checkout route handler and `applyDiscount.ts`. The mapper remains a scaffold. The run used the default 300 users and 8 requests per second, with `--discount-rate 0.8` to exercise the 20-errors-in-60-seconds threshold reliably. It collected a 60-second clean baseline before running `demo-break`.

| Event | UTC | Time after the break PATCH response |
| --- | --- | ---: |
| Flagsmith acknowledged the beta-only break | 08:31:56.295 | 0 s |
| Incident opened with 24 errors in 489 requests (4.91%), against a 0/285 baseline | 08:32:43.778 | 47.483 s |
| Agent proposed disabling `new_checkout` | 08:33:14.463 | 78.168 s |
| Curl approval completed and the flag disable was verified | 08:33:16.520 | 80.225 s |
| Last ingested checkout error was emitted | 08:33:18.787 | 82.492 s |
| Incident closed and the action was marked recovered | 08:35:43.815 | 227.520 s |

At incident opening, the flag-on side had 26 requests, so ranking stayed ambiguous. The next completed bucket brought the split to 47 errors in 57 flag-on checkouts (82.46%) versus 0 in 112 flag-off checkouts. The two-proportion z statistic was 11.31. All 94 project stack frames matched the mapped files, giving `new_checkout` a score of 0.995. The 66 ingested events were all on `/api/checkout`.

The agent ranks on/off requests on the failing routes. It bounds positive z evidence at (z=3) and excludes library frames from code overlap. Without a map the code-overlap component is zero. For ambiguous incidents, `POST /api/incidents/:id/propose` with `{"flag":"new_checkout"}` lets a reviewer select a ranked flag for a separately approved proposal.

The four completed recovery buckets contained 949 requests and zero errors. Recovery was confirmed 147.295 seconds after the verified disable, including bucket alignment and telemetry delivery. The follow-up `demo-reset` verified both the default and beta override were still off. Simulated traffic was stopped.

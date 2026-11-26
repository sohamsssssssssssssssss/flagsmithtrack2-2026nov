# Simulated demo rehearsals

Preset: 600 users, 25 requests/s, 40% discount-code entry, 50% beta. Each trial starts with a fresh agent database and 45 seconds of baseline traffic. Times are seconds from the successful Flagsmith beta-on PATCH response. The runner records proposals and resets the demo flag. It never approves a proposal.

| Run | Incident (s) | Proposal (s) | Top flag | Rank | Route | On errors / requests | Off errors / requests | Fisher p |
| ---: | ---: | ---: | --- | --- | --- | ---: | ---: | ---: |
| 1 | 27.62 | 28.17 | new_checkout | confident | /api/checkout | 22/56 | 0/60 | 7.72e-9 |
| 2 | 13.89 | 14.21 | new_checkout | confident | /api/checkout | 19/35 | 0/80 | 1.67e-12 |
| 3 | 18.55 | 19.98 | new_checkout | confident | /api/checkout | 12/33 | 0/78 | 9.00e-8 |
| 4 | 15.23 | 15.57 | new_checkout | confident | /api/checkout | 18/38 | 0/79 | 5.05e-11 |
| 5 | 20.01 | 21.23 | new_checkout | confident | /api/checkout | 15/41 | 0/82 | 9.05e-9 |

Targets: incident ≤20s, proposal ≤30s, and a confident new_checkout proposal in every run. A dash means the event was unavailable in the 60-second observation window.

The preliminary timed run opened at 20.109s and proposed at 20.717s. The five-run suite above used epoch-aligned two-second shop flushes and evaluated two consecutive ten-second windows at each completed shop batch. The detector thresholds and significance cutoff were carried into the final suite.

All five trials proposed the correct culprit within 30 seconds. Three met the 20-second incident target. In run 1, the first checkout error arrived at 9.339s and the qualifying window used by the detector closed at 27.060s. Run 5 opened at 20.006s. Each trial recorded one pending proposal, zero agent actions, and a verified rehearsal reset.

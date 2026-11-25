# 01 — PRD: Blast Radius (working name)

Toggle Wars (WeMakeDevs × Flagsmith), **Track 02: AI Agents and Feature Flags**. Solo. Hacking window 26 Nov 08:00 IST to 29 Nov 20:00 IST.

## 1. One-line pitch

**"It maps every flag in your code. When your app breaks, it finds the flag that did it, turns it off, and writes the fix. You just approve."**

## 2. The problem

- Teams ship features behind flags so they can switch them off fast. In practice, when production breaks, someone still has to work out **which** flag caused it.
- Without help, that means: open the error tracker, open Flagsmith, scroll the change history, guess, read code, then toggle. That takes minutes to hours while users see errors.
- Sentry's Flagsmith integration can mark flags as "suspect" on an error. It stops there. It doesn't prove the cause, act on it, fix the code, or bring the feature back safely.

## 3. What it does (the loop)

1. **Map:** scans the repo and links every Flagsmith flag to the files, functions and routes it controls. It also merges in live Flagsmith state: on/off, value, segment overrides and last change.
2. **Watch:** collects errors from the app, each carrying the flags that user was served, and watches Flagsmith for flag changes.
3. **Find:** when errors spike, it ranks the flags by evidence:
   - error rate for users with the flag **on vs off**, which is the strongest signal;
   - stack-trace overlap with the code that flag controls, from the map;
   - how recently the flag changed before the spike.
4. **Stop the bleeding:** proposes turning the guilty flag off. **A human approves.** It acts through the Flagsmith API, then checks that errors drop.
5. **Fix:** an LLM reads the stack trace and the mapped code and writes a small patch. The patch is applied in a sandbox copy, built, and tested against the failing case. If it passes, it opens a **pull request**. A human reviews it.
6. **Bring it back:** once the fix is deployed, it re-enables the flag in stages (for example 10%, 50%, 100%) and pauses if errors return. **Each stage needs approval.**

The verdict ("this flag is guilty") always comes from deterministic code. The LLM only writes the patch.

## 4. Users

- **Primary:** the on-call developer at a small team using Flagsmith.
- **Secondary:** a team lead who wants a clean record of what was changed, why, and who approved it.

## 5. MVP (must ship)

| ID | Feature |
|---|---|
| M1 | Demo shop app with 5+ Flagsmith flags, one of which has a real planted bug |
| M2 | Error collector: app errors arrive with stack trace, identity, and the flags served |
| M3 | Flag-change watcher: polls Flagsmith and records every change with a timestamp |
| M4 | Mapper: static scan of JS/TS, flag key to file, line, function and route |
| M5 | Spike detector: deterministic, needs a minimum error count and a rise over baseline |
| M6 | Culprit ranker: on/off error split, stack overlap and change recency, with the evidence shown |
| M7 | Kill switch with approval: Flagsmith API write, then a re-read, then a recovery check |
| M8 | Dashboard: flag map graph, incident timeline, and Approve/Reject buttons |
| M9 | Audit log: every proposal, approval, action and result in a JSON lines file |
| M10 | Traffic generator for the demo (clearly labelled SIMULATED) |

## 6. Stretch (in this order)

| ID | Feature |
|---|---|
| S1 | LLM fix: patch, sandbox build and test, then a GitHub PR |
| S2 | Staged re-rollout with health gates and approval per stage |
| S3 | Map warnings: dead flags, nested flags, untested on/off combinations |
| S4 | Run the mapper on a public open-source repo that uses the Flagsmith JS SDK |
| S5 | Sentry as an optional error source |

S1 is the most visible stretch item. Aim to have it working by Day 3.

## 7. Non-goals

- No auto-merge and no flag change without approval, ever.
- No ML model training. Ranking is plain statistics.
- No languages other than JS/TS in the mapper.
- No paid services. Free-tier LLM only, and the tool works without an LLM (minus S1).

## 8. Demo story (about 3 minutes)

1. **The map (20 s):** open the dashboard; the flag graph shows each flag and the code it touches.
2. **Normal traffic (10 s):** simulated users browse the shop, with a flat error line.
3. **The break (20 s):** someone turns on `new_checkout` at 50%. Errors spike.
4. **Detection (30 s):** the incident card appears. `new_checkout` turns red on the map. Evidence: "Users with the flag on: 31% errors. Off: 0.4%. The stack trace is inside `checkout/applyDiscount.ts`, which this flag controls. Changed 2 minutes before the spike."
5. **Approve the kill (15 s):** click Approve. The flag is turned off in Flagsmith (shown in the Flagsmith dashboard), and the error line drops.
6. **The fix (40 s):** the agent shows a 3-line patch, passing build and test, and the PR opens on GitHub.
7. **Back safely (30 s):** after merge, the flag goes back on at 10%, then 50%, then 100%, with no errors.
8. **Close (15 s):** the audit log shows who approved what, and when.

## 9. How it maps to judging

| Criterion | Our answer |
|---|---|
| Use of Flagsmith | Flags are the whole mechanism: read state, watch changes, kill, staged rollout, all through the Flagsmith API |
| Impact | Cuts time-to-recovery from minutes or hours to under a minute, and every write is human-approved |
| Creativity | Flag-aware incident response, with proof (on/off split) instead of a guess, plus a map |
| Demo video | Break, detect, kill, fix, return, all live in one take |
| Track 02 extras | Real time saved, a human approves every change, clear output (evidence card) |

## 10. Competition (public Track 02 repos seen on 26 Nov)

- FlagPilot, FlagAgent, PulsePilot: all "prompt to experiment" with approval. None handle incidents.
- Sentry + Flagsmith integration: marks suspect flags. No proof, no action, no fix, no re-rollout.

## 11. Success criteria

- The full loop runs end to end in a single take on the demo app.
- The culprit is correct in 5 out of 5 rehearsal runs, including one with two flags changed together.
- Every write is preceded by a logged approval.
- Someone who hasn't seen it understands the pitch in one sentence.

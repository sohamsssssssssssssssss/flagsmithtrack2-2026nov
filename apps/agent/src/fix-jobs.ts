import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import { join } from "node:path";
import { CheckoutReplay, type FlagLiveState, type FlagSnapshot } from "@blast/shared";
import { audit } from "./audit.js";
import { BLAST_DIR, ROOT } from "./config.js";
import type { DB } from "./db.js";
import { committedSource, fixBase, fixWorktree } from "./fix-worktree.js";
import { createFixModel, findSafePatch, fixContext, measure, projectFrames, redactFixText,
  type FixStep, type Progress } from "./fixer.js";
import type { createFlagMap } from "./flagmap.js";
import type { FlagsmithClient } from "./flagsmith.js";
import { DecisionError, snapshotHash } from "./proposals.js";
import type { rankFlags } from "./ranker.js";

type Evidence = ReturnType<typeof rankFlags>["ranking"][number];
type Payload = { flag: string; feature_id: number; evidence: Evidence; base: string; error_id: number };
type StoredProposal = { id: number; incident_id: number; payload_json: string; snapshot_hash: string; status: string;
  expires_ts: number; created_ts: number; approver: string | null };
type SavedError = { id: number; message: string; stack: string; replay_json: string; flags_json: string };

const flagOff = (state: FlagLiveState) => !state.enabled && state.overrides.every((override) => !override.enabled);
const fixHash = (id: number, payload: Payload, state: FlagLiveState) => createHash("sha256")
  .update(JSON.stringify([snapshotHash(id, payload.feature_id, state), payload.base, payload.error_id])).digest("hex");

export function buildFixJobs(db: DB, client: Pick<FlagsmithClient, "getState">,
  map: ReturnType<typeof createFlagMap>, bus: EventEmitter, log = audit) {
  db.prepare("UPDATE fix_jobs SET status='PARTIAL',reason='Agent restarted before the fix job finished' WHERE status='running'").run();
  db.prepare("UPDATE proposals SET status='PARTIAL' WHERE kind='fix_pr' AND id IN (SELECT proposal_id FROM fix_jobs WHERE status='PARTIAL')").run();
  db.prepare("UPDATE actions SET outcome='PARTIAL' WHERE outcome='fix_running'").run();

  const load = (id: number) => db.prepare("SELECT * FROM proposals WHERE kind='fix_pr' AND id=?").get(id) as StoredProposal | undefined;
  const isFix = (id: number) => Boolean(load(id));
  function get(incident: number) {
    const row = db.prepare(`SELECT p.id,p.status AS proposal_status,p.expires_ts,p.approver,j.* FROM proposals p
      JOIN fix_jobs j ON j.proposal_id=p.id WHERE p.incident_id=? ORDER BY p.id DESC LIMIT 1`).get(incident) as
      ({ steps_json: string } & Record<string, unknown>) | undefined;
    if (!row) return null;
    const { steps_json, ...result } = row;
    return { ...result, steps: JSON.parse(steps_json) as FixStep[] };
  }

  const candidates = db.prepare(`SELECT p.incident_id,p.payload_json,a.verify_json,i.evidence_json,a.ts AS disabled_at
    FROM proposals p JOIN actions a ON a.proposal_id=p.id JOIN incidents i ON i.id=p.incident_id
    WHERE p.kind='disable_flag' AND p.status='approved' AND json_extract(a.verify_json,'$.ok')=1
      AND json_extract(p.payload_json,'$.rollback') IS NULL
      AND NOT EXISTS (SELECT 1 FROM proposals f WHERE f.incident_id=p.incident_id AND f.kind='fix_pr')`);
  let scanning = false;
  async function tick() {
    if (scanning || !map.get()) return;
    scanning = true;
    try {
      for (const row of candidates.all() as { incident_id: number; payload_json: string; verify_json: string;
        evidence_json: string; disabled_at: number }[]) {
        const { flag, feature_id, evidence } = JSON.parse(row.payload_json) as Payload;
        const mapping = map.get()?.flags[flag];
        if (!mapping?.files.length) continue;
        const state = (JSON.parse(row.verify_json) as { after: FlagLiveState }).after;
        if (!flagOff(state)) continue;
        const incidentEvidence = JSON.parse(row.evidence_json) as { start: number };
        const errors = db.prepare(`SELECT id,message,stack,replay_json,flags_json FROM errors WHERE ts>=? AND ts<=?
          AND route='/api/checkout' AND simulated=1 AND replay_json IS NOT NULL ORDER BY ts DESC LIMIT 200`)
          .all(incidentEvidence.start, row.disabled_at) as SavedError[];
        const sample = errors.find((error) => (JSON.parse(error.flags_json) as FlagSnapshot)[flag]?.enabled &&
          CheckoutReplay.safeParse(JSON.parse(error.replay_json)).success);
        if (!sample) continue;
        const base = await fixBase(ROOT, mapping.files).catch(() => null);
        if (!base || base !== map.get()?.sha) continue;
        const payload = { flag, feature_id, evidence, base, error_id: sample.id };
        const now = Date.now();
        const proposal = db.transaction(() => {
          const inserted = db.prepare(`INSERT OR IGNORE INTO proposals(incident_id,kind,payload_json,snapshot_hash,created_ts,expires_ts,status)
            VALUES (?,'fix_pr',?,?,?,?,'pending')`).run(row.incident_id, JSON.stringify(payload), fixHash(row.incident_id, payload, state),
            now, now + 600_000);
          if (!inserted.changes) return null;
          const id = Number(inserted.lastInsertRowid);
          db.prepare("INSERT INTO fix_jobs(proposal_id,status) VALUES (?,'pending')").run(id);
          return { id, incident_id: row.incident_id, kind: "fix_pr", flag };
        })();
        if (proposal) {
          log("proposal_created", { proposal });
          bus.emit("proposal_created", proposal);
        }
      }
    } finally { scanning = false; }
  }

  function pending(id: number) {
    const p = load(id);
    if (!p) throw new DecisionError("Fix proposal not found", 404);
    if (Date.now() >= p.expires_ts) throw new DecisionError("Fix proposal expired");
    if (p.status !== "pending") throw new DecisionError("Fix proposal is no longer pending");
    return p;
  }

  async function execute(p: StoredProposal, payload: Payload, mapping: NonNullable<ReturnType<typeof map.get>>["flags"][string],
    sample: SavedError, authorize: () => Promise<void>, action: number) {
    const steps: FixStep[] = [];
    let publishing = false;
    const progress: Progress = ({ step, diff, attempt }) => {
      const patchStep = steps.find((entry) => entry.name === "LLM patch" && entry.attempt === attempt);
      if (diff && patchStep) patchStep.diff = diff;
      if (step) {
        if (step.status === "running") steps.push(step);
        else {
          const index = steps.findIndex((entry) => entry.name === step.name && entry.attempt === step.attempt);
          steps[index] = { ...step, diff: steps[index]?.diff };
        }
      }
      if (step || patchStep) {
        db.prepare("UPDATE fix_jobs SET steps_json=? WHERE proposal_id=?").run(JSON.stringify(steps), p.id);
        if (step) log("fix_step", { proposal_id: p.id, ...step });
      }
      if (diff) db.prepare("UPDATE fix_jobs SET diff=? WHERE proposal_id=?").run(diff, p.id);
      bus.emit("action_done", { incident_id: p.incident_id, outcome: "fix_progress" });
    };
    let status: string, reason = null, pr = null;
    try {
      const frames = projectFrames(sample.stack, ROOT);
      const context = await fixContext(payload.flag, mapping, sample.message, frames,
        (file) => committedSource(ROOT, payload.base, file));
      const model = await measure(progress, "Model selection", 0, () => createFixModel({
        base: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL,
      }));
      db.prepare("UPDATE fix_jobs SET model=? WHERE proposal_id=?").run(model.model, p.id);
      const repo = process.env.GITHUB_REPO?.trim() || "sohamsssssssssssssssss/flagsmithtrack2-2026nov";
      const replay = CheckoutReplay.parse(JSON.parse(sample.replay_json));
      const work = fixWorktree({ root: ROOT, directory: join(BLAST_DIR, "sandboxes", String(p.incident_id)),
        base: payload.base, flag: payload.flag, incident: p.incident_id, replay, progress, repo });
      const allowed = mapping.files.filter((file) => /^apps\/demo-shop\/api\/src\/[\w./-]+\.ts$/.test(file));
      const result = await findSafePatch(allowed, async (feedback) => {
        await authorize();
        return model.patch(context, feedback);
      }, work.validate, progress);
      publishing = true;
      const e = payload.evidence;
      const rate = (value: number | null) => value === null ? "unavailable" : (100 * value).toFixed(2) + "%";
      const fn = frames[0]?.split(" ")[0] ?? "checkout";
      const title = redactFixText(`Fix: ${fn} crash on the ${payload.flag} path`).slice(0, 120);
      const counts = (prefix: string) => result.diff.split("\n").filter((l) => l.startsWith(prefix) && !l.startsWith(prefix.repeat(3))).length;
      const timing = steps.filter((s) => s.attempt === result.attempt || s.attempt === 0)
        .map((s) => `- ${s.name}: ${s.status} in ${((s.ms ?? 0) / 1_000).toFixed(2)}s`);
      const body = redactFixText([
        "## Incident evidence", "",
        `- Flag: \`${payload.flag}\``,
        `- Flag on: ${e.on.errors}/${e.on.requests} errors (${rate(e.on.rate)})`,
        `- Flag off: ${e.off.errors}/${e.off.requests} errors (${rate(e.off.rate)})`,
        `- Error: ${sample.message.slice(0, 500)}`, "",
        "Project stack:", ...frames.map((line) => "    " + line), "",
        "## Diff summary", "",
        `${result.paths.length} file(s), +${counts("+")} / -${counts("-")} lines (LLM ${model.model}, attempt ${result.attempt} of 3):`,
        ...result.paths.map((file) => "- " + file), "",
        "```diff", result.diff.trimEnd(), "```", "",
        "## Validation (isolated git worktree)", "",
        ...timing,
        `- Replay: saved failing checkout (error #${sample.id}) returned 2xx with \`${payload.flag}\` forced ON locally.`, "",
        `Found by Blast Radius; flag \`${payload.flag}\` currently OFF in Flagsmith. Not merged automatically: review before merging.`,
      ].join("\n"));
      pr = await work.publish(result.paths, title, body, result.attempt, authorize);
      status = "pr_open";
    } catch (error) {
      status = publishing ? "publish_failed" : "no_safe_fix";
      // Command arguments and provider response bodies stay out of the UI and audit log.
      const problem = error as { message?: string; cmd?: string };
      reason = problem.cmd ? "A required local or GitHub command failed" : redactFixText(problem.message ?? "Fix failed").slice(0, 2_000);
    }
    db.transaction(() => {
      db.prepare("UPDATE fix_jobs SET status=?,reason=?,pr_url=? WHERE proposal_id=?").run(status, reason, pr, p.id);
      db.prepare("UPDATE proposals SET status=? WHERE id=?").run(pr ? "approved" : "failed", p.id);
      db.prepare("UPDATE actions SET outcome=?,outcome_ts=?,verify_json=? WHERE id=?")
        .run(status, Date.now(), JSON.stringify({ reason, pr_url: pr }), action);
    })();
    log("fix_finished", { incident_id: p.incident_id, proposal_id: p.id, status, pr_url: pr, reason });
    bus.emit("action_done", { incident_id: p.incident_id, outcome: status });
  }

  async function approve(id: number, approver: string) {
    const p = pending(id);
    const payload = JSON.parse(p.payload_json) as Payload;
    const mapping = map.get()?.flags[payload.flag];
    if (!mapping || payload.base !== map.get()?.sha || await fixBase(ROOT, mapping.files) !== payload.base) {
      throw new DecisionError("Mapped source changed since fix proposal");
    }
    const sample = db.prepare("SELECT id,message,stack,replay_json,flags_json FROM errors WHERE id=?").get(payload.error_id) as SavedError | undefined;
    if (!sample) throw new DecisionError("Missing saved checkout replay");
    const authorize = async () => {
      if (Date.now() >= p.expires_ts) throw new DecisionError("Fix proposal expired");
      const state = await client.getState(payload.feature_id);
      if (!flagOff(state) || fixHash(p.incident_id, payload, state) !== p.snapshot_hash) {
        throw new DecisionError("Flag state changed since fix proposal");
      }
      if (Date.now() >= p.expires_ts) throw new DecisionError("Fix proposal expired");
    };
    await authorize();
    const action = db.transaction(() => {
      const claimed = db.prepare("UPDATE proposals SET status='executing',approver=?,decision_ts=? WHERE id=? AND status='pending' AND expires_ts>?")
        .run(approver, Date.now(), id, Date.now());
      if (!claimed.changes) throw new DecisionError("Fix proposal is no longer pending");
      db.prepare("UPDATE fix_jobs SET status='running' WHERE proposal_id=?").run(id);
      return Number(db.prepare("INSERT INTO actions(proposal_id,ts,request_json,outcome) VALUES (?,?,?,'fix_running')")
        .run(id, Date.now(), JSON.stringify({ kind: "fix_pr", flag: payload.flag })).lastInsertRowid);
    })();
    log("proposal_approved", { id, approver, kind: "fix_pr" });
    void execute(p, payload, mapping, sample, authorize, action).catch(() => {
      console.error("Could not persist the fix job outcome");
    });
    return { id, outcome: "fix_running" };
  }

  function reject(id: number, approver: string) {
    pending(id);
    db.transaction(() => {
      db.prepare("UPDATE proposals SET status='rejected',approver=?,decision_ts=? WHERE id=?").run(approver, Date.now(), id);
      db.prepare("UPDATE fix_jobs SET status='rejected' WHERE proposal_id=?").run(id);
    })();
    log("proposal_rejected", { id, approver, kind: "fix_pr" });
    return { id, outcome: "rejected" };
  }

  return { get, isFix, approve, reject, tick };
}

import { useState, type FormEvent } from "react";
import { duration, percent, type IncidentDetail } from "./model";

type Props = {
  incident: IncidentDetail;
  now: number;
  start: (id: number) => Promise<void>;
  requeue?: (id: number, requestedBy: string) => Promise<void>;
  decide: (id: number, decision: "approve" | "reject", approver: string) => Promise<void>;
};

/** Minutes:seconds left on a stage approval window, e.g. "29:58". */
export function countdown(expiresTs: number, now: number) {
  const left = Math.max(0, Math.ceil((expiresTs - now) / 1_000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

export function RolloutStrip({ incident, now, start, requeue, decide }: Props) {
  const [confirmed, setConfirmed] = useState(false);
  const [approver, setApprover] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rollout = incident.rollout;
  const canStart = !rollout && incident.status === "closed" && incident.actions.some((action) => action.outcome === "recovered");
  if (!rollout && !canStart) return null;

  async function perform(event: FormEvent, action: () => Promise<void>) {
    event.preventDefault();
    setError(""); setBusy(true);
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : "Rollout action failed"); }
    finally { setBusy(false); }
  }

  // The latest record per stage is the live one; earlier records are history.
  const latestFor = (stage: number) => rollout?.stages.filter((item) => item.stage === stage).at(-1);
  const current = latestFor(rollout?.stage ?? 0);
  const last = rollout?.stages.at(-1);
  const requeueable = rollout?.status === "paused" && last?.stage === rollout.stage
    && (last.status === "expired" || (last.outcome === "stage_failed" && last.gate?.reason === "Insufficient cohort telemetry"));
  const pending = rollout?.status === "paused" && rollout.rollback?.status === "pending" && rollout.rollback.expires > now
    ? { id: rollout.rollback.id, label: "Approve disable" }
    : rollout?.status === "active" && current?.status === "pending" && current.expires_ts > now
      ? { id: current.proposal_id, label: `Approve ${current.stage}%` } : null;

  return <section className="rollout-strip" aria-labelledby="rollout-heading">
    <div className="rollout-heading"><h3 id="rollout-heading">Staged rollout</h3>
      {rollout && <span className={`badge ${rollout.status === "complete" ? "green" : rollout.status === "paused" ? "red" : "amber"}`}>
        {rollout.status === "complete" ? "Complete" : rollout.status === "paused" ? "Paused" : `Hold ${duration(rollout.hold_ms)}`}
      </span>}
    </div>
    <ol className="rollout-stages">{([10, 50, 100] as const).map((stage) => {
      const record = latestFor(stage);
      const label = record?.outcome === "stage_passed" ? "Passed" : record?.outcome === "stage_failed" ? (record.gate?.reason === "Insufficient cohort telemetry" ? "Not enough telemetry" : "Gate failed")
        : record?.outcome === "PARTIAL" ? "PARTIAL" : record?.outcome === "watching_rollout" ? "Holding"
        : record?.status === "pending" ? record.expires_ts > now ? `Approval needed · ${countdown(record.expires_ts, now)} left` : "Expired"
        : record?.status === "executing" ? "Applying" : (record?.status ?? "Queued");
      return <li key={stage} className={record?.outcome === "stage_passed" ? "stage-passed" : ""}>
        <strong>{stage}%</strong><span>{label}</span>
        {record?.gate && <small title={record.gate.control === "stage_50" ? "Off cohort from the 50% hold" : "Concurrent cohorts"}>
          On {percent(record.gate.on.rate)} ({record.gate.on.errors}/{record.gate.on.requests})<br />
          Off {percent(record.gate.off.rate)} ({record.gate.off.errors}/{record.gate.off.requests})
        </small>}
      </li>;
    })}</ol>
    {canStart && <form className="approval" onSubmit={(event) => perform(event, () => start(incident.id))}>
      <label className="rollout-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        Fix merged and shop restarted</label>
      <button disabled={!confirmed || busy}>Propose 10%</button>
    </form>}
    {rollout?.reason && <p className="failure" role="status">{rollout.reason}</p>}
    {requeue && requeueable && <form className="approval" onSubmit={(event) => perform(event, () => requeue(incident.id, approver.trim()))}>
      <label htmlFor="rollout-requeue-name">Re-queue {rollout?.stage}% as</label>
      <input id="rollout-requeue-name" required maxLength={200} value={approver} onChange={(event) => setApprover(event.target.value)} />
      <button disabled={busy || !approver.trim()}>Re-queue {rollout?.stage}% (30 min)</button>
    </form>}
    {rollout?.rollback?.status === "approved" && <p className="muted">Rollback approved.</p>}
    {pending && <form className="approval" onSubmit={(event) => perform(event, () => {
      const reject = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "reject";
      return decide(pending.id, reject ? "reject" : "approve", approver.trim());
    })}>
      <label htmlFor="rollout-approver">Rollout approver name</label>
      <input id="rollout-approver" required maxLength={200} value={approver} onChange={(event) => setApprover(event.target.value)} />
      <div><button className="primary" value="approve" disabled={busy || !approver.trim()}>{pending.label}</button>
        <button value="reject" disabled={busy || !approver.trim()}>Reject</button></div>
    </form>}
    {error && <p className="failure" role="alert">{error}</p>}
  </section>;
}

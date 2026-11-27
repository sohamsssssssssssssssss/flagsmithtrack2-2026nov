import { useState } from "react";
import type { FixJob } from "./model";

type Props = {
  job: FixJob;
  now: number;
  decide: (id: number, decision: "approve" | "reject", approver: string) => Promise<void>;
};

export function FixPanel({ job, now, decide }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const expired = job.proposal_status === "expired" || (job.status === "pending" && job.expires_ts <= now);
  const label = expired ? "Expired" : ({
    pending: "Approval needed", running: "Validating", pr_open: "PR open",
    no_safe_fix: "No safe fix found", publish_failed: "Publishing failed", rejected: "Rejected",
  } as Record<string, string>)[job.status] ?? job.status;

  return <section className="rollout-strip fix-panel" aria-labelledby="fix-heading">
    <div className="rollout-heading"><h3 id="fix-heading">Fix</h3>
      <span className={`badge ${job.status === "pr_open" ? "green" : job.status === "pending" && !expired ? "amber" : ""}`} role="status">
        {label}
      </span>
    </div>
    {job.status === "pending" && !expired && <form className="approval" onSubmit={async (event) => {
      event.preventDefault();
      if (!name.trim() || busy) return;
      const reject = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "reject";
      setBusy(true); setError("");
      try { await decide(job.id, reject ? "reject" : "approve", name.trim()); }
      catch (failure) { setError(failure instanceof Error ? failure.message : "Fix decision failed"); }
      finally { setBusy(false); }
    }}>
      <p className="muted">Approval asks the LLM to propose a patch and can open a GitHub PR if validation passes.</p>
      <label htmlFor="fix-approver">Fix approver name</label>
      <input id="fix-approver" value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} />
      <div><button className="primary" value="approve" disabled={busy || !name.trim()}>Approve fix attempt</button>
        <button value="reject" disabled={busy || !name.trim()}>Reject</button></div>
    </form>}
    {job.model && <small className="muted">Model <code>{job.model}</code></small>}
    {job.steps.length > 0 && <ol className="steps" aria-label="Fix validation progress">
      {job.steps.map((step) => <li key={`${step.attempt}-${step.name}`} className={step.status === "passed" ? "done" : step.status === "failed" ? "failed" : ""}>
        {step.name}{step.attempt > 1 ? ` · attempt ${step.attempt}` : ""}{step.ms == null ? "…" : ` · ${(step.ms / 1_000).toFixed(2)}s`}
      </li>)}
    </ol>}
    {job.pr_url && <a className="fix-link" href={job.pr_url} target="_blank" rel="noreferrer">View open pull request ↗</a>}
    {job.diff && <details className="fix-diff" open={job.status === "pr_open"}><summary>Candidate diff</summary><pre>{job.diff}</pre></details>}
    {(error || job.reason) && <p className="failure" role="alert">{error || job.reason}</p>}
  </section>;
}

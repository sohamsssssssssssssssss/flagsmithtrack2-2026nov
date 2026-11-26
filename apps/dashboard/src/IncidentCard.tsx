import { useState, type FormEvent } from "react";
import { RolloutStrip } from "./RolloutStrip";
import { duration, percent, type Evidence, type IncidentDetail } from "./model";

type Props = {
  incident: IncidentDetail | null; evidence: Evidence | null; now: number;
  onDecision: (id: number, decision: "approve" | "reject", approver: string) => Promise<void>;
  onStartRollout?: (id: number) => Promise<void>;
  onPropose?: (incidentId: number, flag: string) => Promise<void>;
};

export function IncidentCard({ incident, evidence, now, onDecision, onPropose, onStartRollout }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!incident) return <aside className="panel incident quiet">
    <div className="panel-heading"><span className="eyebrow">Incident response</span></div>
    <div className="quiet-body"><span className="quiet-icon" aria-hidden="true">✓</span><h2>All quiet</h2>
      <p>Incidents will appear here when the agent detects an error spike.</p></div>
  </aside>;

  const latest = incident.proposal;
  const proposal = latest?.kind === "rollout_stage" || latest?.rollback
    ? incident.proposals.find((item) => item.kind !== "rollout_stage" && !item.rollback) ?? null
    : latest;
  const lead = proposal?.evidence ?? incident.ranking[0];
  const action = [...incident.actions].reverse().find((item) => item.proposal_id === proposal?.id);
  const expired = proposal?.status === "expired" || (proposal?.status === "pending" && now >= proposal.expires);
  const pending = proposal?.status === "pending" && !expired;
  const recovered = action?.outcome === "recovered";
  const partial = action?.outcome === "PARTIAL" || proposal?.status === "PARTIAL";
  const failed = action?.outcome === "failed";
  const approved = proposal?.status === "approved" || proposal?.status === "executing" || !!action;
  const status = partial ? "PARTIAL" : recovered ? "Recovered" : expired ? "Expired" : pending ? "Approval needed"
    : action?.outcome === "watching" ? "Watching" : action?.outcome === "not_recovered" ? "Not recovered"
    : failed || proposal?.status === "failed" ? "Update failed" : proposal?.status === "refused" ? "Approval refused"
    : proposal?.status === "rejected" ? "Rejected" : approved ? "Approved" : incident.status === "closed" ? "Closed" : "Investigating";
  const remaining = proposal
    ? Math.max(0, Math.ceil((proposal.expires - Math.max(now, proposal.created)) / 1000)) : 0;
  async function decide(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const decision = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "reject" ? "reject" : "approve";
    if (!proposal || !pending || !name.trim() || busy) return;
    setError(""); setBusy(true);
    try { await onDecision(proposal.id, decision, name.trim()); }
    catch (error) { setError(error instanceof Error ? error.message : "Decision failed"); }
    finally { setBusy(false); }
  }

  return <aside className={`panel incident ${recovered ? "resolved" : ""}`}>
    <div className="panel-heading incident-heading"><span className="eyebrow">Incident response</span>
      <span className={`badge ${recovered ? "green" : partial ? "red" : "amber"}`}>{status}</span></div>
    <div className="incident-body">
      <h2>{lead?.reason ?? "The agent detected an error spike and is collecting evidence."}</h2>
      <div className="timings">
        {proposal && <span title="Incident detection to proposal">Found in <strong>{duration(proposal.created - incident.opened_ts)}</strong></span>}
        {recovered && action.outcome_ts !== null && <span>Recovered in <strong>{duration(action.outcome_ts - action.ts)}</strong></span>}
      </div>
      {lead && <div className="cohorts" aria-label="Error rates by flag state">
        <div className="cohort-on"><span>FLAG ON</span><strong>{percent(lead.on.rate)}</strong>
          <small>{lead.on.errors} errors / {lead.on.requests} requests</small></div>
        <span className="versus">vs</span>
        <div className="cohort-off"><span>FLAG OFF</span><strong>{percent(lead.off.rate)}</strong>
          <small>{lead.off.errors} errors / {lead.off.requests} requests</small></div>
      </div>}
      <div className="incident-section">
        <span className="eyebrow">Ranked candidates</span>
        {incident.ranking.length > 0 ? <ol className="candidates">{incident.ranking.map((candidate, index) =>
          <li key={candidate.flag}><span>{String(index + 1).padStart(2, "0")}</span><code>{candidate.flag}</code>
            <strong>{candidate.score.toFixed(3)}</strong></li>)}</ol> : <p className="muted">Collecting cohort samples.</p>}
      </div>
      <div className="incident-section evidence">
        <span className="eyebrow">Failing request</span>
        <code>{evidence?.route ?? "Route unavailable"}</code>
        <code title={evidence?.frame}>{evidence?.frame?.split("/").slice(-2).join("/") ?? "Stack frame unavailable"}</code>
      </div>
      {proposal && <div className="incident-section">
        <p className="proposal-title">Proposed: turn off <code>{proposal.flag}</code> in Development</p>
        {pending && <form onSubmit={decide} className="approval">
          <label htmlFor="approver">Approver name <span className="expiry">Expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}</span></label>
          <input id="approver" maxLength={200} required placeholder="Your name" value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
          <div><button type="submit" value="approve" className="primary" disabled={busy || !name.trim()}>{busy ? "Submitting…" : "Approve"}</button>
            <button type="submit" value="reject" disabled={busy || !name.trim()}>Reject</button></div>
        </form>}
        {expired && <p className="muted">The approval window ended.</p>}
        {proposal.status === "rejected" && <p className="muted">Rejected by {proposal.approver}.</p>}
      </div>}
      {!pending && !approved && incident.status === "open" && incident.ranking.length > 0 && onPropose &&
        (!proposal || expired || ["rejected", "refused", "failed"].includes(proposal.status)) &&
        <form className="approval" onSubmit={async (event) => {
          event.preventDefault();
          const flag = String(new FormData(event.currentTarget).get("flag"));
          setBusy(true); setError("");
          try { await onPropose(incident.id, flag); }
          catch (error) { setError(error instanceof Error ? error.message : "Proposal failed"); }
          finally { setBusy(false); }
        }}>
          <label htmlFor="candidate">Select a flag to propose</label>
          <select id="candidate" name="flag">{incident.ranking.map(({ flag }) => <option key={flag}>{flag}</option>)}</select>
          <button disabled={busy}>Create proposal</button>
        </form>}
      {approved && <ol className="steps" aria-label="Action progress">
        <li className="done">Approved{proposal?.approver ? ` by ${proposal.approver}` : ""}</li>
        <li className={action?.verification?.ok ? "done" : partial || failed ? "failed" : ""}>
          {failed ? "Flagsmith update failed" : partial ? "Flagsmith update could not be verified" : action?.verification?.ok ? "Flagsmith updated (verified)" : "Verifying Flagsmith update"}</li>
        <li className={recovered || action?.outcome === "watching" ? "done" : ""}>Watching error rate</li>
        <li className={recovered ? "done" : action?.outcome === "not_recovered" ? "failed" : ""}>
          {action?.outcome === "not_recovered" ? "Not recovered" : "Recovered"}</li>
      </ol>}
      {onStartRollout && <RolloutStrip incident={incident} now={now} start={onStartRollout} decide={onDecision} />}
      {error && <p role="alert" className="failure">{error}</p>}
    </div>
  </aside>;
}

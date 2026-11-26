import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { IncidentCard } from "./IncidentCard";
import { changeLabel, TrafficChart } from "./TrafficChart";
import { api, duration, time, type Evidence, type Flag, type FlagChange, type Incident, type IncidentDetail, type Metrics } from "./model";
import "./dashboard.css";

function Dashboard() {
  const [tab, setTab] = useState<"overview" | "audit">("overview");
  const [flags, setFlags] = useState<Flag[]>([]);
  const [changes, setChanges] = useState<FlagChange[]>([]);
  const [metrics, setMetrics] = useState<Metrics>({ overall: [] });
  const [details, setDetails] = useState<IncidentDetail[]>([]);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [simulated, setSimulated] = useState(false);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const current = ++generation.current;
    try {
      const [newFlags, newChanges, newMetrics, incidents] = await Promise.all([
        api<Flag[]>("/api/flags", undefined, signal),
        api<FlagChange[]>("/api/changes?since=" + (Date.now() - 600_000), undefined, signal),
        api<Metrics>("/api/metrics?window=600", undefined, signal),
        api<Incident[]>("/api/incidents", undefined, signal),
      ]);
      const active = incidents.find((i) => i.status === "open") ?? incidents[0];
      const selected = tab === "audit" ? incidents : active ? [active] : [];
      const query = active ? `?start=${active.evidence.start}&end=${active.evidence.end}` : "";
      const [incidentDetails, sample] = await Promise.all([
        Promise.all(selected.map((item) => api<IncidentDetail>(`/api/incidents/${item.id}`, undefined, signal))),
        api<Evidence>("/dashboard-evidence" + query, undefined, signal).catch(() => null),
      ]);
      if (current !== generation.current || signal?.aborted) return;
      setFlags(newFlags); setChanges(newChanges); setMetrics(newMetrics); setDetails(incidentDetails);
      setEvidence(sample); if (sample?.simulated) setSimulated(true);
      setFailed(false); setLoading(false);
    } catch {
      if (current === generation.current && !signal?.aborted) { setFailed(true); setLoading(false); }
    }
  }, [tab]);

  useEffect(() => {
    const stream = new EventSource("/api/stream");
    const controller = new AbortController();
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (scheduled) return;
      scheduled = setTimeout(() => { scheduled = undefined; void refresh(controller.signal); }, 750);
    };
    stream.onopen = () => { setConnected(true); update(); };
    stream.onerror = () => { setConnected(false); };
    for (const event of ["change", "bucket", "incident_opened", "proposal_created", "action_done", "incident_closed"]) {
      stream.addEventListener(event, update);
    }
    void refresh(controller.signal);
    const poll = setInterval(update, 5_000);
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => { stream.close(); clearInterval(poll); clearInterval(clock); clearTimeout(scheduled); controller.abort(); };
  }, [refresh]);

  const incident = details.find((item) => item.status === "open") ?? details[0] ?? null;
  async function decide(id: number, decision: "approve" | "reject", approver: string) {
    try { await api(`/api/proposals/${id}/${decision}`, { approver }); }
    finally { await refresh(); }
  }
  async function propose(id: number, flag: string) {
    try { await api(`/api/incidents/${id}/propose`, { flag }); }
    finally { await refresh(); }
  }

  return <>
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">◈</span><span>Blast Radius</span></div>
      <nav aria-label="Dashboard">
        <button aria-current={tab === "overview" ? "page" : undefined} onClick={() => setTab("overview")}>Overview</button>
        <button aria-current={tab === "audit" ? "page" : undefined} onClick={() => setTab("audit")}>Audit log</button>
      </nav>
      <div className="top-status">{simulated && <span className="badge simulated">SIMULATED TRAFFIC</span>}
        <span className="environment"><i /> Development</span></div>
    </header>
    <main>
      <div className="page-heading">
        <div><h1>{tab === "overview" ? "Rollout monitor" : "Audit log"}</h1>
          <p>{tab === "overview" ? "Flag changes, live errors and incident response." : "Review proposals, approvals and verified outcomes."}</p></div>
        <div className={`connection ${connected && !failed ? "online" : ""}`} role="status"><i />
          {connected && !failed ? "Live connection" : loading ? "Connecting" : "Reconnecting"}</div>
      </div>
      {failed && <p className="banner" role="status">Agent data is unavailable. Retrying automatically.</p>}
      {tab === "overview" ? <div className="layout">
        <section className="panel flags" aria-labelledby="flags-title">
          <div className="panel-heading"><h2 id="flags-title">Feature flags</h2><span className="count">{flags.length}</span></div>
          {flags.length ? <ul>{flags.map((flag) => {
            const hasOverride = flag.state?.overrides.some((override) => override.enabled !== flag.state?.enabled);
            const tag = hasOverride ? "Override" : flag.state?.enabled ? "On" : flag.state ? "Off" : "Removed";
            return <li key={flag.flag_key}><code>{flag.flag_key}</code>
              <div><span className={`badge ${hasOverride ? "amber" : flag.state?.enabled ? "green" : ""}`}>{tag}</span>
                <small>{flag.last_change_ts == null ? "No recent change" : `${duration(now - flag.last_change_ts)} ago`}</small></div></li>;
          })}</ul> : <p className="empty-line">{loading ? "Loading flags…" : "No flags reported."}</p>}
        </section>
        <div className="center">
          <TrafficChart buckets={metrics.overall} changes={changes} now={now} />
          <section className="panel changes" aria-labelledby="changes-title">
            <div className="panel-heading"><h2 id="changes-title">Recent changes</h2></div>
            {changes.length ? <ol>{changes.slice(0, 3).map((change, index) =>
              <li key={`${change.ts}-${change.flag_key}-${index}`}><span><i /><code>{changeLabel(change)}</code></span>
                <time dateTime={new Date(change.ts).toISOString()}>{time(change.ts)}</time></li>)}</ol>
              : <p className="empty-line">No flag changes in the last 10 minutes.</p>}
          </section>
        </div>
        <IncidentCard key={incident?.id ?? "quiet"} incident={incident} evidence={evidence} now={now} onDecision={decide} onPropose={propose} />
      </div> : <section className="panel audit">
        <table><thead><tr><th>Proposal</th><th>Flag</th><th>Created</th><th>Approver</th><th>Decision</th><th>Action</th><th>Outcome</th></tr></thead>
          <tbody>{details.flatMap((item) => item.proposals.map((proposal) => {
            const action = item.actions.find((entry) => entry.proposal_id === proposal.id);
            return <tr key={proposal.id}><td>#{proposal.id}</td><td><code>{proposal.flag}</code></td>
              <td>{new Date(proposal.created).toLocaleString()}</td><td>{proposal.approver ?? "—"}</td>
              <td>{proposal.status}</td><td>{action ? `#${action.id} · Disable flag` : "—"}</td>
              <td><span className={`badge ${action?.outcome === "recovered" ? "green" : action?.outcome === "PARTIAL" ? "red" : ""}`}>{action?.outcome.replaceAll("_", " ") ?? "—"}</span></td></tr>;
          }))}
          {details.every((item) => item.proposals.length === 0) && <tr><td colSpan={7} className="empty-line">No proposals recorded.</td></tr>}</tbody></table>
      </section>}
    </main>
  </>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Dashboard /></StrictMode>);

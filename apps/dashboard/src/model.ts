import type { FlagChange, FlagLiveState } from "../../../packages/shared/src/index";
export type { FlagChange };

export type Flag = { flag_key: string; state: FlagLiveState | null; last_change_ts: number | null };
export type Bucket = { ts: number; requests: number; errors: number; rate: number | null };
export type Metrics = { overall: Bucket[]; bucket_ms: number };
type Cohort = { requests: number; errors: number; rate: number | null };
export type Candidate = {
  flag: string; score: number; reason: string; on: Cohort; off: Cohort;
  z: number | null; map: string; failing_frames: number; matched_frames: number;
};
export type Incident = {
  id: number; opened_ts: number; closed_ts: number | null; status: string; top_flag: string | null;
  rollout_status?: "active" | "paused" | "complete" | null;
  confidence: "confident" | "ambiguous"; ranking: Candidate[];
  evidence: { start: number; end: number; baseline: Cohort; recent: Cohort };
};
export type Proposal = {
  id: number; incident_id: number; flag: string; kind?: string; stage?: number; rollback?: boolean; evidence?: Candidate; created: number; expires: number;
  decision_ts: number | null; approver: string | null; status: string;
};
export type Action = {
  id: number; proposal_id: number; ts: number; outcome: string; outcome_ts: number | null;
  verification: { ok: boolean; error?: string } | null;
};
export type Rollout = {
  stage: 10 | 50 | 100; status: "active" | "paused" | "complete"; hold_ms: number; reason: string | null;
  stages: { stage: number; proposal_id: number; expires_ts: number; status: string; outcome: string | null;
    gate: { on: Cohort; off: Cohort; control: string } | null }[];
  rollback: Proposal | null;
};
export type IncidentDetail = Incident & { rollout?: Rollout | null; proposal: Proposal | null; proposals: Proposal[]; actions: Action[] };
export type Evidence = { simulated: boolean; route?: string; frame?: string };

export const percent = (rate: number | null | undefined) => rate == null ? "—" : `${(rate * 100).toFixed(1)}%`;
export function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
export const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, ...(body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : {}) });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.message || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

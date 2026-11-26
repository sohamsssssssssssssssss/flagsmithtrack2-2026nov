import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IncidentCard } from "./IncidentCard";
import type { Action, Candidate, IncidentDetail, Proposal } from "./model";

const now = 6_000;
const candidate: Candidate = {
  flag: "new_checkout", score: 0.995, reason: "Discounted checkouts fail for the flag-on cohort.",
  on: { errors: 31, requests: 100, rate: 0.31 }, off: { errors: 1, requests: 250, rate: 0.004 },
  z: 8, map: "mapped", failing_frames: 31, matched_frames: 31,
};
const proposal: Proposal = {
  id: 1, incident_id: 2, flag: candidate.flag, created: 2_000, expires: 602_000,
  status: "pending", decision_ts: null, approver: null, evidence: candidate,
};
const incident: IncidentDetail = {
  id: 2, opened_ts: 1_000, closed_ts: null, status: "open", top_flag: candidate.flag,
  confidence: "confident", ranking: [candidate], proposal, proposals: [proposal], actions: [],
  evidence: { start: 0, end: 800, baseline: candidate.off, recent: candidate.on },
};
const action: Action = {
  id: 5, proposal_id: proposal.id, ts: 3_000, outcome: "watching", outcome_ts: 4_000,
  verification: { ok: true },
};
const render = (item: IncidentDetail | null = incident, time = now) => renderToStaticMarkup(
  createElement(IncidentCard, {
    incident: item, evidence: { simulated: true, route: "/api/checkout", frame: "checkout/applyDiscount.ts:6" },
    now: time, onDecision: async () => {},
  }),
);

describe("incident card", () => {
  it("shows an actionable proposal with cohorts, evidence and expiry", () => {
    const html = render();
    for (const text of ["Approval needed", "31.0%", "0.4%", "Expires in 9:56", "Approve", "Reject",
      "/api/checkout", "applyDiscount.ts:6", "Found in"]) expect(html).toContain(text);
  });

  it("shows the approver, verified write and watch in progress", () => {
    const html = render({ ...incident, proposal: { ...proposal, status: "approved", approver: "Demo operator" }, actions: [action] });
    for (const text of ["Watching", "Approved by Demo operator", "Flagsmith updated (verified)", "Watching error rate"])
      expect(html).toContain(text);
    expect(html).not.toContain('value="approve"');
  });

  it("reports recovery only when the action outcome is recovered", () => {
    const html = render({ ...incident, status: "closed", proposal: { ...proposal, status: "approved" },
      actions: [{ ...action, outcome: "recovered", outcome_ts: 123_000 }] });
    expect(html).toContain("Recovered in");
    expect(html).toContain("2m 0s");
  });

  it("keeps an unverified write visibly PARTIAL", () => {
    const html = render({ ...incident, proposal: { ...proposal, status: "PARTIAL" },
      actions: [{ ...action, outcome: "PARTIAL", verification: { ok: false } }] });
    expect(html).toContain("PARTIAL");
    expect(html).toContain("Flagsmith update could not be verified");
    expect(html).not.toContain("Flagsmith updated (verified)");
  });

  it("hides approval when the local countdown expires before the next refresh", () => {
    const html = render(incident, proposal.expires);
    expect(html).toContain("Expired");
    expect(html).toContain("The approval window ended");
    expect(html).not.toContain('value="approve"');
  });

  it("shows cohort counts while gathering evidence for an ambiguous incident", () => {
    const html = render({ ...incident, confidence: "ambiguous", proposal: null, proposals: [] });
    expect(html).toContain("Gathering evidence… need more data");
    expect(html).toContain("Evidence: 100 flag-on checkouts, 250 flag-off");
    expect(html).not.toContain('value="approve"');
  });

  it("shows all quiet with no incidents", () => {
    expect(render(null)).toContain("All quiet");
  });
});

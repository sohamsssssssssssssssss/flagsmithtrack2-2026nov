import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { saveState } from "./changes.js";
import { openDb } from "./db.js";
import { FlagsmithClient } from "./flagsmith.js";
import { buildIncidents } from "./incidents.js";
import { buildProposals } from "./proposals.js";
import { rankFlags } from "./ranker.js";
import { buildServer } from "./server.js";

function fixture() {
  let now = 1_000_000;
  const db = openDb(":memory:");
  db.prepare(`INSERT INTO incidents(id,status,opened_ts,ranking_json,evidence_json)
    VALUES (1,'open',0,'{"ranking":[]}', '{"end":990000,"baseline":{"rate":0}}')`).run();
  let enabled = true;
  let verificationFails = false;
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      enabled = false;
    } else if (!enabled && verificationFails) {
      return new Response(null, { status: 503 });
    }
    return Response.json({ environment_default: { enabled, value: null, variants: [] }, segment_overrides: [] });
  });
  const client = new FlagsmithClient({ apiUrl: "https://example.test", adminKey: "mock",
    projectId: 1, envName: "demo", envKey: "mock-env" }, fetcher);
  saveState(db, "checkout", 1, { enabled: true, value: null, overrides: [] }, now);
  const log = vi.fn();
  const bus = new EventEmitter();
  const proposals = buildProposals(db, client, "demo", bus, log, () => now);
  const incidents = buildIncidents(db, proposals, bus, log, () => now);
  const app = buildServer(db, bus, { incidents, proposals });
  const evidence = rankFlags([], [], [{ flag_key: "checkout", ts: 0 }], now, {}).ranking[0]!;
  const approve = (id: number) => app.inject({ method: "POST", url: `/api/proposals/${id}/approve`, payload: { approver: "Tester" } });
  return {
    db, app, bus, proposals, incidents, evidence, approve, log,
    advance: (ms: number) => { now += ms; },
    change: () => { enabled = false; },
    failVerification: () => { verificationFails = true; },
    writes: () => fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH").length,
  };
}

it("refuses expired proposals without writing", async () => {
  const f = fixture();
  try {
    const proposal = await f.proposals.create(1, f.evidence);
    f.advance(600_000);
    const response = await f.approve(proposal.id);
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toMatch(/expired/);
    expect(f.writes()).toBe(0);
  } finally { await f.app.close(); f.db.close(); }
});

it("re-reads the snapshot and refuses a changed flag without writing", async () => {
  const f = fixture();
  try {
    const proposal = await f.proposals.create(1, f.evidence);
    f.change();
    const response = await f.approve(proposal.id);
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toMatch(/state changed/i);
    expect(f.writes()).toBe(0);
  } finally { await f.app.close(); f.db.close(); }
});

it("marks a write with a failed verification read PARTIAL and refuses duplicate approvals", async () => {
  const f = fixture();
  try {
    const proposal = await f.proposals.create(1, f.evidence);
    f.failVerification();
    const results = await Promise.all([f.approve(proposal.id), f.approve(proposal.id)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([409, 502]);
    expect(f.writes()).toBe(1);
    expect(f.incidents.get(1).actions[0]?.outcome).toBe("PARTIAL");
    expect(f.log).toHaveBeenCalledWith("proposal_execution_failed", expect.objectContaining({ outcome: "PARTIAL" }));
  } finally { await f.app.close(); f.db.close(); }
});

it("rejects an approval after a human rejects the proposal", async () => {
  const f = fixture();
  try {
    const proposal = await f.proposals.create(1, f.evidence);
    const response = await f.app.inject({ method: "POST", url: `/api/proposals/${proposal.id}/reject`,
      payload: { approver: "Reviewer" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "rejected", approver: "Reviewer" });
    expect((await f.approve(proposal.id)).statusCode).toBe(409);
    expect(f.writes()).toBe(0);
  } finally { await f.app.close(); f.db.close(); }
});

it.each([0, 1])("tracks the action through twelve full buckets with %i post-write errors", async (errors) => {
  const f = fixture();
  try {
    const proposal = await f.proposals.create(1, f.evidence);
    const response = await f.approve(proposal.id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: "watching", verified: true });
    expect(f.writes()).toBe(1);
    const insert = f.db.prepare(`INSERT INTO requests(ts_bucket,route,flag_key,flag_on,count,errors)
      VALUES (?,'/checkout','checkout',0,50,?)`);
    for (let ts = 1_000_000; ts < 1_120_000; ts += 10_000) insert.run(ts, ts === 1_110_000 ? errors : 0);
    f.advance(122_499);
    await f.incidents.tick();
    expect(f.incidents.get(1).actions[0]?.outcome).toBe("watching");
    f.advance(1);
    await f.incidents.tick();
    const incident = f.incidents.get(1);
    expect(incident.actions[0]?.outcome).toBe(errors ? "not_recovered" : "recovered");
    expect(incident.status).toBe(errors ? "open" : "closed");
  } finally { await f.app.close(); f.db.close(); }
});

it("streams workflow events over the SSE endpoint", async () => {
  const f = fixture();
  const controller = new AbortController();
  try {
    const url = await f.app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${url}/api/stream`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const events = ["incident_opened", "proposal_created", "action_done", "incident_closed"];
    for (const event of events) f.bus.emit(event, { id: 1 });
    let received = "";
    while (!received.includes("event: incident_closed")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value);
    }
    expect(received.match(/^event: .+$/gm)).toEqual(events.map((event) => `event: ${event}`));
  } finally {
    controller.abort();
    await f.app.close();
    f.db.close();
  }
});

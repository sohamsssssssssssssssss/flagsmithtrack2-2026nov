import type { FlagLiveState } from "@blast/shared";

type Fetch = typeof fetch;
type ApiValue = { type: "string" | "integer" | "boolean"; value: string } | null;
interface ApiOverride { segment: { id: number }; priority: number; enabled: boolean; value: ApiValue; variants: unknown[] }
interface ApiFlag { environment_default: { enabled: boolean; value: ApiValue; variants: unknown[] }; segment_overrides: ApiOverride[] }
export type RolloutStage = 10 | 50 | 100;
export type RolloutSnapshot = { state: FlagLiveState; segment: { id: number; percentage: number } | null };
interface ApiSegment {
  id: number; name: string;
  rules: { type: string; rules: unknown[]; conditions: { operator: string; property: string; value: string }[] }[];
}
const rulesFor = (stage: RolloutStage) => [{ type: "ALL", rules: [],
  conditions: [{ operator: "PERCENTAGE_SPLIT", property: "$.identity.identifier", description: null, value: String(stage) }] }];

export function canApplyRollout({ state, segment }: RolloutSnapshot, stage: RolloutStage) {
  if (state.enabled || state.overrides.some((override) => override.segment_id !== segment?.id)) return false;
  const enabled = state.overrides.some((override) => override.enabled);
  // Re-queuing 10% after an inconclusive hold finds the 10% rollout already live: re-applying it changes no exposure.
  return stage === 10 ? !enabled || segment?.percentage === 10 : enabled && segment?.percentage === (stage === 50 ? 10 : 50);
}

export interface Feature { id: number; name: string }
export class UnverifiedWrite extends Error {}
export interface WriteResult { ok: boolean; before: FlagLiveState; after: FlagLiveState }

export class FlagsmithError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

const toScalar = (v: ApiValue) =>
  v === null ? null : v.type === "integer" ? Number(v.value) : v.type === "boolean" ? v.value === "true" : v.value;

export function normalize(f: ApiFlag): FlagLiveState {
  return {
    enabled: f.environment_default.enabled,
    value: toScalar(f.environment_default.value),
    overrides: f.segment_overrides
      .map((o) => ({ segment_id: o.segment.id, enabled: o.enabled, value: toScalar(o.value) }))
      .sort((a, b) => a.segment_id - b.segment_id),
  };
}

export class FlagsmithClient {
  private envKey?: string;

  constructor(
    private opts: { apiUrl: string; adminKey: string; projectId: number; envName: string; envKey?: string },
    private fetchImpl: Fetch = fetch,
  ) {
    this.envKey = opts.envKey;
  }

  redact(s: string): string {
    for (const key of [this.opts.adminKey, this.envKey, process.env.FLAGSMITH_SERVER_KEY]) {
      if (key) s = s.split(key).join("[REDACTED]");
    }
    return s;
  }

  private async req<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(this.opts.apiUrl + path, {
          method,
          headers: { Authorization: `Api-Key ${this.opts.adminKey}`, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (e) {
        if (retry && attempt === 0) continue; // one retry on network error / timeout
        throw new FlagsmithError(this.redact(`${method} ${path}: ${(e as Error).message}`));
      }
      if (retry && res.status >= 500 && attempt === 0) continue; // one retry on 5xx
      const text = await res.text();
      if (!res.ok) throw new FlagsmithError(this.redact(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`), res.status);
      return (text ? JSON.parse(text) : null) as T;
    }
  }

  async resolveEnvKey(): Promise<string> {
    if (this.envKey) return this.envKey;
    const r = await this.req<{ results: { name: string; api_key: string }[] } | { name: string; api_key: string }[]>(
      "GET", `/api/v1/projects/${this.opts.projectId}/environments/`);
    const env = (Array.isArray(r) ? r : r.results).find((e) => e.name === this.opts.envName);
    if (!env) throw new FlagsmithError(`environment "${this.opts.envName}" not found`);
    return (this.envKey = env.api_key);
  }

  async listFeatures(projectId = this.opts.projectId): Promise<Feature[]> {
    // shortcut: first page only (page_size=999), fine for a demo project
    const r = await this.req<{ results: Feature[] }>("GET", `/api/v1/projects/${projectId}/features/?page_size=999`);
    return r.results.map(({ id, name }) => ({ id, name }));
  }

  private async raw(featureId: number): Promise<ApiFlag> {
    return this.req<ApiFlag>("GET", `/api/__future__/environments/${await this.resolveEnvKey()}/features/${featureId}/`);
  }

  async getState(featureId: number): Promise<FlagLiveState> {
    return normalize(await this.raw(featureId));
  }

  private async patch(featureId: number, body: unknown, check: (s: FlagLiveState) => boolean,
    allow?: (s: FlagLiveState) => boolean): Promise<WriteResult> {
    const before = await this.getState(featureId);
    if (allow && !allow(before)) throw new FlagsmithError("Override probe requires exactly one disabled demo override");
    await this.req("PATCH", `/api/__future__/environments/${await this.resolveEnvKey()}/features/${featureId}/`, body);
    const after = await this.getState(featureId); // always re-read: the PATCH response is not trusted
    return { ok: check(after), before, after };
  }

  setEnabled(featureId: number, enabled: boolean): Promise<WriteResult> {
    return this.patch(featureId, { environment_default: { enabled } }, (s) => s.enabled === enabled);
  }

  async setSegmentOverrideEnabled(featureId: number, segmentId: number, enabled: boolean): Promise<WriteResult> {
    const current = await this.raw(featureId);
    return this.patch(featureId, { segment_overrides: overridesBody(current, (id) => id === segmentId, enabled, segmentId) },
      (s) => s.overrides.find((o) => o.segment_id === segmentId)?.enabled === enabled);
  }

  /** Probe omission semantics only when the sole override is the disabled demo segment. */
  async probeDisabledOverrideList(featureId: number, segmentId: number): Promise<WriteResult> {
    return this.patch(featureId, { segment_overrides: [] }, (state) =>
      !state.enabled && state.overrides.every((o) => o.segment_id === segmentId && !o.enabled),
    (state) => !state.enabled && state.overrides.length === 1
      && state.overrides[0]?.segment_id === segmentId && !state.overrides[0].enabled);
  }

  private segmentPath() { return `/api/v1/projects/${this.opts.projectId}/segments/`; }

  private async getRolloutSegment(flag: string): Promise<RolloutSnapshot["segment"]> {
    const path = this.segmentPath();
    const response = await this.req<{ results: ApiSegment[] } | ApiSegment[]>("GET", path + "?page_size=999");
    const matches = (Array.isArray(response) ? response : response.results).filter((segment) => segment.name === `br_rollout_${flag}`);
    if (matches.length > 1) throw new FlagsmithError("Several rollout segments have the same name");
    const match = matches[0];
    if (!match) return null;
    const { rules } = await this.req<ApiSegment>("GET", path + match.id + "/");
    const rule = rules[0], condition = rule?.conditions[0];
    if (rules.length !== 1 || rule?.type !== "ALL" || rule.rules.length ||
      rule.conditions.length !== 1 || condition?.operator !== "PERCENTAGE_SPLIT" || condition.property !== "$.identity.identifier" ||
      !["10", "50", "100"].includes(condition.value)) {
      throw new FlagsmithError("Unexpected rollout segment rules");
    }
    return { id: match.id, percentage: Number(condition.value) };
  }

  async getRolloutSnapshot(flag: string, featureId: number): Promise<RolloutSnapshot> {
    const [state, segment] = await Promise.all([this.getState(featureId), this.getRolloutSegment(flag)]);
    return { state, segment };
  }

  async applyRollout(flag: string, featureId: number, stage: RolloutStage,
    authorize: (snapshot: RolloutSnapshot) => void): Promise<WriteResult> {
    const featurePath = `/api/__future__/environments/${await this.resolveEnvKey()}/features/${featureId}/`;
    const snapshot = await this.getRolloutSnapshot(flag, featureId);
    let segment = snapshot.segment;
    const before = snapshot.state;
    if (!canApplyRollout(snapshot, stage)) {
      throw new FlagsmithError("Flag has an unexpected default, segment override, or rollout percentage");
    }
    authorize(snapshot);
    try {
      if (stage === 100) {
        await this.req("PATCH", featurePath, { environment_default: { enabled: true } }, false);
        if (!(await this.getState(featureId)).enabled) throw new UnverifiedWrite("Environment default was not enabled");
        await this.req("DELETE", featurePath + `segment-overrides/${segment!.id}/`, undefined, false);
      } else {
        const path = this.segmentPath();
        if (!segment) {
          await this.req("POST", path, { name: `br_rollout_${flag}`, project: this.opts.projectId, rules: rulesFor(stage) }, false);
        } else if (segment.percentage !== stage) {
          await this.req("PATCH", path + segment.id + "/", { rules: rulesFor(stage) }, false);
        }
        segment = await this.getRolloutSegment(flag);
        if (segment?.percentage !== stage) throw new UnverifiedWrite("Rollout segment percentage did not verify");
        if (stage === 10) {
          await this.req("PATCH", featurePath, { environment_default: { enabled: false },
            segment_overrides: [{ segment: { id: segment.id }, enabled: true }] }, false);
        }
      }
      const after = await this.getState(featureId);
      const ok = stage === 100 ? after.enabled && !after.overrides.length
        : !after.enabled && after.overrides.length === 1 && after.overrides[0]?.segment_id === segment?.id
          && after.overrides[0]?.enabled === true;
      return { ok, before, after };
    } catch (error) {
      throw new UnverifiedWrite(this.redact(error instanceof Error ? error.message : "Rollout write could not be verified"));
    }
  }

  /** Turns off the environment default AND every segment override; ok only if nothing still serves the flag on. */
  async disableEverywhere(featureId: number, authorize?: (state: FlagLiveState) => void): Promise<WriteResult> {
    const path = `/api/__future__/environments/${await this.resolveEnvKey()}/features/${featureId}/`;
    const current = await this.req<ApiFlag>("GET", path);
    const before = normalize(current);
    const body = { environment_default: { enabled: false }, segment_overrides: overridesBody(current, () => true, false) };
    authorize?.(before);
    try {
      await this.req("PATCH", path, body, !authorize);
    } catch (error) {
      if (error instanceof FlagsmithError && error.status && error.status < 500) throw error;
      throw new UnverifiedWrite("Flagsmith write could not be confirmed");
    }
    try {
      const after = await this.getState(featureId);
      return { ok: !after.enabled && after.overrides.every((o) => !o.enabled), before, after };
    } catch {
      throw new UnverifiedWrite("Flagsmith accepted the write but its state could not be verified");
    }
  }
}

// Sends the full override list (with priority/value/variants) so it is safe whether PATCH replaces or upserts the array.
function overridesBody(current: ApiFlag, match: (segmentId: number) => boolean, enabled: boolean, addSegmentId?: number) {
  const list = current.segment_overrides.map((o) => ({
    segment: o.segment, priority: o.priority, value: o.value,
    ...(o.variants.length ? { variants: o.variants } : {}),
    enabled: match(o.segment.id) ? enabled : o.enabled,
  }));
  if (addSegmentId !== undefined && !list.some((o) => o.segment.id === addSegmentId))
    list.push({ segment: { id: addSegmentId }, enabled } as (typeof list)[number]);
  return list;
}

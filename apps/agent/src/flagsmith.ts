import type { FlagLiveState } from "@blast/shared";

type Fetch = typeof fetch;
type ApiValue = { type: "string" | "integer" | "boolean"; value: string } | null;
interface ApiOverride { segment: { id: number }; priority: number; enabled: boolean; value: ApiValue; variants: unknown[] }
interface ApiFlag { environment_default: { enabled: boolean; value: ApiValue; variants: unknown[] }; segment_overrides: ApiOverride[] }
export interface Feature { id: number; name: string }
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

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
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
        if (attempt === 0) continue; // one retry on network error / timeout
        throw new FlagsmithError(this.redact(`${method} ${path}: ${(e as Error).message}`));
      }
      if (res.status >= 500 && attempt === 0) continue; // one retry on 5xx
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

  /** Turns off the environment default AND every segment override; ok only if nothing still serves the flag on. */
  async disableEverywhere(featureId: number): Promise<WriteResult> {
    const current = await this.raw(featureId);
    return this.patch(featureId,
      { environment_default: { enabled: false }, segment_overrides: overridesBody(current, () => true, false) },
      (s) => !s.enabled && s.overrides.every((o) => !o.enabled));
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

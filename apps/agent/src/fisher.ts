function logChoose(n: number, k: number) {
  k = Math.min(k, n - k);
  let value = 0;
  for (let i = 1; i <= k; i++) value += Math.log((n - k + i) / i);
  return value;
}

/** One-sided Fisher exact test for excess failures in the flag-on cohort. */
export function fisherGreater(on: number, onErrors: number, off: number, offErrors: number): number {
  const errors = onErrors + offErrors;
  const upper = Math.min(on, errors);
  let logMass = logChoose(on, onErrors) + logChoose(off, offErrors) - logChoose(on + off, errors);
  let sum = Math.exp(logMass);
  for (let x = onErrors; x < upper; x++) {
    logMass += Math.log((on - x) / (x + 1)) + Math.log((errors - x) / (off - errors + x + 1));
    sum += Math.exp(logMass);
  }
  return Math.min(1, sum);
}

export interface Sample { requests: number; errors: number; rate: number | null }

export function compareRates(on: Sample, off: Sample) {
  if (on.rate === null || off.rate === null || on.errors > on.requests || off.errors > off.requests) {
    return { test: null, p: null, z: null };
  }
  if (Math.min(on.errors, off.errors, on.requests - on.errors, off.requests - off.errors) < 30) {
    return { test: "fisher" as const, p: fisherGreater(on.requests, on.errors, off.requests, off.errors), z: null };
  }
  const pooled = (on.errors + off.errors) / (on.requests + off.requests);
  const error = Math.sqrt(pooled * (1 - pooled) * (1 / on.requests + 1 / off.requests));
  return { test: "z" as const, p: null, z: error > 0 ? (on.rate - off.rate) / error : null };
}

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

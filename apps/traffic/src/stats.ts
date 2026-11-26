export type StatsSnapshot = {
  intervalMs: number;
  requests: number;
  errors: number;
  serverErrors: number;
  rps: number;
  total: number;
  totalErrors: number;
  total5xx: number;
  errorRate: number;
};

export class TrafficStats {
  total = 0;
  totalErrors = 0;
  total5xx = 0;

  private windowRequests = 0;
  private windowErrors = 0;
  private window5xx = 0;

  recordStatus(status: number): void {
    this.total += 1;
    this.windowRequests += 1;
    if (status >= 500) {
      this.total5xx += 1;
      this.totalErrors += 1;
      this.window5xx += 1;
      this.windowErrors += 1;
    } else if (status >= 400) {
      this.totalErrors += 1;
      this.windowErrors += 1;
    }
  }

  recordFailure(): void {
    this.total += 1;
    this.windowRequests += 1;
    this.totalErrors += 1;
    this.windowErrors += 1;
  }

  snapshot(intervalMs: number): StatsSnapshot {
    const requests = this.windowRequests;
    const errors = this.windowErrors;
    const serverErrors = this.window5xx;
    this.windowRequests = 0;
    this.windowErrors = 0;
    this.window5xx = 0;

    return {
      intervalMs,
      requests,
      errors,
      serverErrors,
      rps: intervalMs > 0 ? (requests / intervalMs) * 1000 : 0,
      total: this.total,
      totalErrors: this.totalErrors,
      total5xx: this.total5xx,
      errorRate: this.total > 0 ? (this.totalErrors / this.total) * 100 : 0,
    };
  }
}

import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "../vendor/recharts.js";
import { percent, time, type Bucket, type FlagChange } from "./model";

export function changeLabel(change: FlagChange) {
  const enabled = change.after?.enabled || change.after?.overrides.some((override) => override.enabled);
  return `${change.flag_key} ${enabled ? "ON" : "OFF"}`;
}

export function TrafficChart({ buckets, changes, now, bucketMs }: { buckets: Bucket[]; changes: FlagChange[]; now: number; bucketMs: number }) {
  const end = Math.ceil(now / bucketMs) * bucketMs;
  const start = end - 600_000;
  const series = new Map(buckets.map((b) => [b.ts, b.rate]));
  const points = Array.from({ length: 600_000 / bucketMs + 1 }, (_, index) => {
    const ts = start + index * bucketMs;
    return { ts, rate: series.get(ts) ?? null };
  });
  const inWindow = buckets.filter((b) => b.ts >= start);
  const latest = inWindow.at(-1);
  const events = changes.filter((c) => c.ts >= start && c.ts <= now);
  const max = Math.max(0.04, Math.ceil(Math.max(0, ...inWindow.map((b) => b.rate ?? 0)) * 25) / 25);
  return <section className="panel traffic" aria-labelledby="traffic-title">
    <div className="panel-heading"><h2 id="traffic-title">Error rate</h2><span className="legend"><i /> Flag change</span></div>
    <div className="chart-summary">
      <div><strong>{percent(latest?.rate)}</strong><span>Latest {bucketMs / 1000}-second bucket</span></div>
      <div className="chart-totals"><span><b>{inWindow.reduce((n, b) => n + b.requests, 0).toLocaleString()}</b> requests</span>
        <span><b>{inWindow.reduce((n, b) => n + b.errors, 0).toLocaleString()}</b> errors</span></div>
    </div>
    <div className="plot" role="img" aria-label="Error rate over the last ten minutes, with markers at flag changes">
      {!inWindow.length && <span className="waiting">Waiting for request traffic</span>}
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 27, right: 15, bottom: 4, left: 0 }}>
          <defs><linearGradient id="error-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ff765e" stopOpacity={0.30} />
            <stop offset="100%" stopColor="#ff765e" stopOpacity={0.035} /></linearGradient></defs>
          <CartesianGrid vertical={false} stroke="#2a3037" strokeDasharray="3 5" />
          <XAxis dataKey="ts" type="number" domain={[start, end]} ticks={[start, start + 120_000, start + 240_000, start + 360_000, start + 480_000, end]}
            tickFormatter={time} tick={{ fill: "#a0a8b4", fontSize: 11 }} axisLine={false} tickLine={false} tickMargin={10} />
          <YAxis domain={[0, max]} width={40} tickCount={5} tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            tick={{ fill: "#a0a8b4", fontSize: 11 }} axisLine={false} tickLine={false} />
          <Tooltip labelFormatter={(ts: number) => time(ts)} formatter={(v: number) => [percent(v), "Error rate"]}
            contentStyle={{ background: "#181e26", border: "1px solid #373e48", borderRadius: 8, color: "#f2f4f7" }} />
          {events.map((event, index) => <ReferenceLine key={`${event.ts}-${event.flag_key}-${index}`} x={event.ts}
            stroke="#e6a55b" strokeDasharray="4 4" label={{ value: changeLabel(event), position: "insideTop", fill: "#fac980", fontSize: 10, offset: index % 2 ? 25 : 7 }} />)}
          <Area type="linear" dataKey="rate" stroke="#ff765e" strokeWidth={2} fill="url(#error-fill)" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
    <div className="chart-footer"><span>LAST 10 MINUTES</span><span>{bucketMs / 1000}S BUCKETS</span></div>
  </section>;
}

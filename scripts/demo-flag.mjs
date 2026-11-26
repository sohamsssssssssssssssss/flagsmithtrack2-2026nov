import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { tsImport } from "tsx/esm/api";

export async function runDemoFlag(mode) {
  const args = process.argv.slice(2);
  const probe = mode === "reset" && args.includes("--probe-override-list");
  if (args.some((arg) => arg !== "--yes" && !(probe && arg === "--probe-override-list"))) {
    console.error(`Usage: node scripts/demo-${mode}.mjs [--yes]${mode === "reset" ? " [--probe-override-list]" : ""}`);
    process.exitCode = 2;
    return;
  }

  const [{ FlagsmithClient }, { loadConfig }, { audit }] = await Promise.all([
    tsImport("../apps/agent/src/flagsmith.ts", import.meta.url),
    tsImport("../apps/agent/src/config.ts", import.meta.url),
    tsImport("../apps/agent/src/audit.ts", import.meta.url),
  ]);
  const cfg = loadConfig();
  const { project_id, environment, features, segments } = JSON.parse(
    readFileSync(new URL("../config/flags.json", import.meta.url), "utf8"),
  );
  const featureId = features.new_checkout;
  const segmentId = segments.beta_cohort;
  const action = { via: `demo-${mode}`, flag: "new_checkout", feature_id: featureId, env: cfg.envName };
  let step = "preflight";
  let writes = 0;
  const client = new FlagsmithClient(cfg, async (url, init) => {
    if (init.method !== "PATCH") return fetch(url, init);
    audit("flagsmith_patch_sent", { ...action, step });
    writes++;
    const response = await fetch(url, init);
    audit("flagsmith_patch_response", { ...action, step, status: response.status });
    return response;
  });

  try {
    if (cfg.projectId !== project_id || cfg.envName !== environment.name) {
      throw new Error("Configured project and environment must match config/flags.json");
    }
    const scopedClient = new FlagsmithClient({ ...cfg, envKey: undefined });
    if (await client.resolveEnvKey() !== await scopedClient.resolveEnvKey()) {
      throw new Error("Configured environment key is outside the demo environment");
    }
    const before = await client.getState(featureId);
    if (mode === "break" && before.overrides.some((o) => o.segment_id !== segmentId && o.enabled)) {
      throw new Error("Another segment override is enabled. Reset the demo before enabling beta only.");
    }
    if (probe && (before.overrides.length !== 1 || before.overrides[0].segment_id !== segmentId)) {
      throw new Error("Override probe requires beta to be the sole override");
    }
    const plan = mode === "break" ? "Set default OFF and beta_cohort ON"
      : `Disable the default and every override${probe ? " and probe an empty override list" : ""}`;
    console.log(`${plan} for new_checkout in ${cfg.envName}. Current state: ${JSON.stringify(before)}`);
    if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question("Apply this plan? [y/N] ").finally(() => rl.close());
      if (answer.trim().toLowerCase() !== "y") throw new Error("Cancelled");
    } else if (!args.includes("--yes")) {
      throw new Error("Pass --yes to approve in a non-interactive shell");
    }
    audit("flagsmith_demo_approved", { ...action, before, probe });
    if (JSON.stringify(await client.getState(featureId)) !== JSON.stringify(before)) {
      throw new Error("State changed since approval. Review the new state and retry.");
    }

    async function write(label, run) {
      step = label;
      audit("flagsmith_write_requested", { ...action, step });
      const result = await run();
      audit("flagsmith_write_result", { ...action, step, ...result });
      console.log(`${label} ${result.ok ? "verified" : "PARTIAL"}: ${JSON.stringify(result.before)} -> ${JSON.stringify(result.after)}`);
      if (!result.ok) throw new Error("The verification read did not match the requested state");
      return result.after;
    }

    if (mode === "break") {
      if (before.enabled) await write("default-off", () => client.setEnabled(featureId, false));
      const after = await write("beta-on", () => client.setSegmentOverrideEnabled(featureId, segmentId, true));
      if (after.enabled || after.overrides.some((o) => o.segment_id !== segmentId && o.enabled)) {
        throw new Error("The flag is also enabled outside the beta override");
      }
    } else {
      await write("disable-everywhere", () => client.disableEverywhere(featureId));
      if (probe) {
        const after = await write("omit-beta", () => client.probeDisabledOverrideList(featureId, segmentId));
        console.log(after.overrides.length === 0
          ? "The empty list removed the existing beta override."
          : "The empty list preserved the existing beta override.");
      }
    }
  } catch (error) {
    const message = client.redact(error instanceof Error ? error.message : String(error));
    audit("flagsmith_demo_failed", { ...action, step, partial: writes > 0, error: message });
    console.error(`${writes > 0 ? "PARTIAL" : "STOPPED"}: ${message}`);
    process.exitCode = 1;
  }
}

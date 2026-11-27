import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { PORTS, type CheckoutReplay } from "@blast/shared";
import { measure, redactFixText, type Progress } from "./fixer.js";

const exec = promisify(execFile);
const sandbox = "/usr/bin/sandbox-exec";

async function command(cwd: string, file: string, args: string[], timeout = 10_000, env = process.env) {
  const result = await exec(file, args, { cwd, env, timeout, maxBuffer: 2 << 20 });
  return result.stdout;
}

export async function fixBase(root: string, files: string[]) {
  if (await command(root, "git", ["status", "--porcelain", "--", ...files])) {
    throw new Error("Commit mapped source files before requesting a fix");
  }
  return (await command(root, "git", ["rev-parse", "HEAD"])).trim();
}

export function committedSource(root: string, base: string, file: string) {
  return command(root, "git", ["show", `${base}:${file}`]);
}

function sandboxProfile(root: string, worktree: string) {
  const protectedPaths = [join(root, ".env"), join(root, ".git", "config"),
    ...[".git-credentials", ".config/gh", ".ssh", ".aws", "Library/Keychains"].map((path) => join(homedir(), path))];
  const sources = protectedPaths.map((path) => `(subpath ${JSON.stringify(path)})`).join(" ");
  return `(version 1)
    (allow default)
    (deny file-read* ${sources})
    (deny file-write* (subpath ${JSON.stringify(root)}) (subpath ${JSON.stringify(homedir())}))
    (allow file-write* (subpath ${JSON.stringify(worktree)}))
    (deny network-outbound)
    (allow network-outbound (remote ip "localhost:*"))
    (deny network-outbound ${Object.values(PORTS).map((port) => `(remote ip "localhost:${port}")`).join(" ")})`;
}

const replayLauncher = `
const { buildApp } = await import("./src/app.ts");
const app = buildApp(async () => ({ [process.argv[1]]: { enabled: true, value: null } }),
  { error() {}, record() {}, flush() {} });
const server = app.listen(0, "127.0.0.1", () => process.send(server.address().port));
`;

async function replayCheckout(worktree: string, profile: string, env: NodeJS.ProcessEnv, flag: string, replay: CheckoutReplay) {
  const child = spawn(sandbox, ["-p", profile, process.execPath, "--import", "tsx", "--input-type=module",
    "-e", replayLauncher, flag], { cwd: join(worktree, "apps/demo-shop/api"), env,
    stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const port = await new Promise<number>((accept, reject) => {
      timer = setTimeout(() => reject(new Error("Replay shop startup timed out")), 10_000);
      child.once("error", () => reject(new Error("Could not start the sandbox shop")));
      child.once("exit", () => reject(new Error("Sandbox shop stopped before replay")));
      child.once("message", (value) => {
        if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535) accept(value);
        else reject(new Error("Invalid sandbox shop port"));
      });
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/checkout`, {
      method: replay.method, headers: { "Content-Type": "application/json", "x-identity": "fix-replay", "x-simulated": "1" },
      body: JSON.stringify(replay.body), signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Saved checkout replay returned HTTP ${response.status}; expected 2xx with the flag forced on`);
  } finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
  }
}

export function fixWorktree(options: {
  root: string; directory: string; base: string; flag: string; incident: number; replay: CheckoutReplay;
  progress: Progress; repo: string;
}) {
  const { base, flag, incident, replay, progress, repo } = options;
  const root = resolve(options.root), directory = resolve(options.directory);
  const patch = join(directory, ".blast", "candidate.patch");
  const runtime = join(directory, ".blast", "tmp");
  const branch = `blast/fix-${incident}`;
  const env = { PATH: process.env.PATH, TMPDIR: runtime, CI: "true", npm_config_offline: "true" };
  const profile = sandboxProfile(root, directory);
  let prepared = false;

  async function prepare() {
    if (prepared) return;
    await mkdir(dirname(directory), { recursive: true });
    await command(root, "git", ["worktree", "add", "--detach", directory, base]);
    await mkdir(runtime, { recursive: true });
    // Dependencies come from the lockfile and cached store before any candidate is applied.
    await command(directory, "pnpm", ["install", "--offline", "--frozen-lockfile"], 120_000, env);
    prepared = true;
  }

  async function validate(diff: string, files: string[], attempt: number) {
    await measure(progress, "Worktree / apply", attempt, async () => {
      await prepare();
      await command(directory, "git", ["reset", "--hard", base]);
      await command(directory, "git", ["clean", "-fd"]);
      await writeFile(patch, diff, { mode: 0o600 });
      const stats = (await command(directory, "git", ["apply", "--recount", "--numstat", "-z", patch])).split("\0").filter(Boolean);
      const parsed = stats.map((line) => line.split("\t"));
      if (parsed.length !== files.length || parsed.some(([adds, removes, name]) =>
        !/^\d+$/.test(adds ?? "") || !/^\d+$/.test(removes ?? "") || !files.includes(name ?? ""))
        || parsed.reduce((n, [a, b]) => n + Number(a) + Number(b), 0) > 40) throw new Error("Git reported a patch outside the mapped source limit");
      try {
        await command(directory, "git", ["apply", "--recount", "--check", patch]);
        await command(directory, "git", ["apply", "--recount", patch]);
      } catch { throw new Error("The unified diff did not apply to the committed source"); }
    });
    for (const name of ["build", "test"]) {
      await measure(progress, name === "build" ? "Build" : "Tests", attempt, async () => {
        try { await command(directory, sandbox, ["-p", profile, "pnpm", name], 120_000, env); }
        catch (error) {
          const output = error as { stdout?: string; stderr?: string };
          const relevant = (output.stdout ?? "").concat("\n", output.stderr ?? "").split("\n")
            .filter((line) => /error TS\d+|AssertionError|Test Files.*failed|Tests.*failed/.test(line)).slice(0, 6);
          throw new Error(redactFixText(`pnpm ${name} failed${relevant.length ? `: ${relevant.join(" ")}` : ""}`).slice(0, 600));
        }
      });
    }
    await measure(progress, "Replay", attempt, () => replayCheckout(directory, profile, env, flag, replay));
    const changes = (await command(directory, "git", ["status", "--porcelain", "-z"])).split("\0").filter(Boolean);
    if (changes.length !== files.length || changes.some((change) => !/^ M /.test(change) || !files.includes(change.slice(3)))) {
      throw new Error("Validation changed unexpected worktree files");
    }
  }

  async function publish(files: string[], title: string, body: string, attempt: number, authorize: () => Promise<void>) {
    // Fix PRs target the demo branch; main is never a PR base for this agent.
    const base = process.env.FIX_PR_BASE?.trim() || "demo";
    if (base === "main") throw new Error("FIX_PR_BASE must not be main");
    // Accept only the repository configured for this workspace and keep publishing credentials out of validation.
    const remote = (await command(root, "git", ["remote", "get-url", "origin"])).trim();
    if (![ `https://github.com/${repo}`, `https://github.com/${repo}.git`,
      `git@github.com:${repo}`, `git@github.com:${repo}.git` ].includes(remote)) {
      throw new Error("Git origin does not match GITHUB_REPO");
    }
    const publishEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" };
    await authorize();
    await measure(progress, "Push branch", attempt, async () => {
      if (await command(directory, "git", ["ls-remote", "--heads", "origin", branch], 30_000, publishEnv)) {
        throw new Error("The fix branch already exists on GitHub");
      }
      await command(directory, "git", ["switch", "-c", branch]);
      await command(directory, "git", ["add", "--", ...files]);
      await command(directory, "git", ["commit", "-m", title]);
      await authorize();
      await command(directory, "git", ["push", "origin", `HEAD:refs/heads/${branch}`], 60_000, publishEnv);
    });
    return measure(progress, "Open PR", attempt, async () => {
      await authorize();
      const path = join(directory, ".blast", "pr.md");
      await writeFile(path, body, { mode: 0o600 });
      const url = (await command(directory, "gh", ["pr", "create", "--repo", repo, "--base", base, "--head", branch,
        "--title", title, "--body-file", path], 60_000, publishEnv)).trim();
      if (!url.startsWith(`https://github.com/${repo}/pull/`) || !/\/pull\/\d+$/.test(url)) {
        throw new Error("GitHub did not return a pull request URL");
      }
      return url;
    });
  }

  return { validate, publish };
}

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cohortFor, loadIdentities } from "./identities.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blast-identities-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("stable simulated identities", () => {
  it("generates once and reuses the same identities across runs", () => {
    const file = join(dir, ".blast", "identities.json");

    const first = loadIdentities(10, file);
    expect(first).toHaveLength(10);
    expect(new Set(first.map((record) => record.identity)).size).toBe(10);
    expect(first.map((record) => record.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const rawAfterFirstRun = readFileSync(file, "utf8");

    // A later run with the same user count must not regenerate or rewrite.
    const second = loadIdentities(10, file);
    expect(second).toEqual(first);
    expect(readFileSync(file, "utf8")).toBe(rawAfterFirstRun);

    // Growing the population keeps existing users and only appends new ones.
    const grown = loadIdentities(14, file);
    expect(grown).toHaveLength(14);
    expect(grown.slice(0, 10)).toEqual(first);
    expect(new Set(grown.map((record) => record.identity)).size).toBe(14);
  });

  it("assigns cohorts deterministically at about the requested share", () => {
    const file = join(dir, ".blast", "identities.json");
    const identities = loadIdentities(2_000, file);

    const beta = identities.filter((record) => cohortFor(record.identity, 0.3) === "beta").length;
    const share = beta / identities.length;
    expect(share).toBeGreaterThan(0.25);
    expect(share).toBeLessThan(0.35);

    const first = identities[0] as { identity: string };
    expect(cohortFor(first.identity, 0.3)).toBe(cohortFor(first.identity, 0.3));
    expect(cohortFor(first.identity, 1)).toBe("beta");
    expect(cohortFor(first.identity, 0)).toBe("default");
  });
});

import { describe, expect, it } from "vitest";

import {
  bandOf,
  difficultyRecord,
  difficultySection,
  nextSolve,
  withDifficultySection,
  type SolveRecord,
} from "./taskDifficulty.js";

const solve = (
  outcome: SolveRecord["outcome"],
  fields: Partial<SolveRecord> = {},
): SolveRecord => ({
  outcome,
  turns: 20,
  usd: 1,
  seconds: 60,
  failed_checks: outcome === "scored below 1" ? ["year"] : [],
  instance_id: null,
  ...fields,
});
const pass = solve("passed");
const miss = solve("scored below 1");
const unfinished = solve("failed", { turns: null, usd: 0.2 });

describe("the adaptive band", () => {
  it.each([
    ["0 of 3", "too_hard", [miss, miss, miss]],
    ["3 of 3", "too_easy", [pass, pass, pass]],
    ["1 of 3", "undecided", [pass, miss, miss]],
    ["2 of 3", "undecided", [pass, pass, miss]],
    ["1 of 5", "in_band", [pass, miss, miss, miss, miss]],
    ["3 of 5", "in_band", [pass, pass, miss, pass, miss]],
    ["4 of 5", "too_easy", [pass, pass, miss, pass, pass]],
    [
      "2 of 3 beside an unfinished run",
      "undecided",
      [pass, unfinished, pass, miss],
    ],
  ] as const)("places %s as %s", (_label, band, solves) => {
    expect(bandOf(solves)).toBe(band);
  });

  it("asks for 3 solves, stops at 0 or 3 of 3, asks for 2 more otherwise and stops at 5", () => {
    expect(nextSolve([], 10)).toEqual({ next: true });
    expect(nextSolve([pass, miss], 10)).toEqual({ next: true });
    expect(nextSolve([pass, pass, pass], 10)).toEqual({
      next: false,
      stopped: "decided",
    });
    expect(nextSolve([pass, miss, miss], 10)).toEqual({ next: true });
    expect(nextSolve([pass, miss, miss, pass], 10)).toEqual({ next: true });
    expect(nextSolve([pass, miss, miss, pass, miss], 10)).toEqual({
      next: false,
      stopped: "decided",
    });
  });

  it("runs an unfinished solve again, at most twice, and does not count it", () => {
    expect(nextSolve([pass, unfinished, pass], 10)).toEqual({ next: true });
    expect(nextSolve([unfinished, unfinished, pass], 10)).toEqual({
      next: true,
    });
    expect(nextSolve([unfinished, unfinished, unfinished], 10)).toEqual({
      next: false,
      stopped: "unfinished",
    });
  });

  it("stops before a solve that the largest cost so far would take past the budget", () => {
    const costly = solve("passed", { usd: 1.5 });
    expect(nextSolve([costly, miss], 4)).toEqual({ next: true });
    expect(nextSolve([costly, miss], 3.9)).toEqual({
      next: false,
      stopped: "budget",
    });
    expect(nextSolve([solve("passed", { usd: null })], 10)).toEqual({
      next: false,
      stopped: "cost_unknown",
    });
  });
});

describe("the difficulty record", () => {
  it("counts passes, failures per check and cost over finished solves, and turns each", () => {
    const record = difficultyRecord({
      model: "anthropic/claude-sonnet-5-5",
      agent: "claude-code",
      solves: [
        pass,
        solve("scored below 1", { failed_checks: ["year", "kept"] }),
        unfinished,
        solve("scored below 1", { failed_checks: ["year"], turns: 31 }),
        pass,
        miss,
      ],
      budgetUsd: 8,
      stopped: "decided",
      taskSha256: "ab".repeat(32),
      versions: { rea: "6.8.0", agentenv: "0.9.1431" },
      measuredAt: "2026-11-07T01:00:00.000Z",
    });

    expect(record).toMatchObject({
      band: "in_band",
      k: 5,
      passes: 2,
      unfinished: 1,
      usd: 5.2,
      turns: [20, 20, 31, 20, 20],
      failures_per_check: { year: 3, kept: 1 },
      stopped: "decided",
      task_sha256: "ab".repeat(32),
      versions: { rea: "6.8.0", agentenv: "0.9.1431" },
    });
    expect(record.solves).toHaveLength(6);
  });

  it("renders one README line per task and replaces the section it wrote before", () => {
    const base = {
      agent: "claude-code",
      budgetUsd: 8,
      stopped: "decided" as const,
      taskSha256: "cd".repeat(32),
      versions: { rea: "6.8.0", agentenv: "0.9.1431" },
      measuredAt: "2026-11-07T01:00:00.000Z",
    };
    const section = difficultySection({
      "add-eggs": difficultyRecord({
        ...base,
        model: "m",
        solves: [pass, pass, pass],
      }),
      "add-bread": difficultyRecord({
        ...base,
        model: "m",
        solves: [pass, miss, miss, miss, pass],
      }),
    });
    expect(section).toContain("## Measured difficulty");
    expect(section).toContain("`add-eggs`: m passed 3 of 3, too easy");
    expect(section).toContain("`add-bread`: m passed 2 of 5, in the band");

    const readme = "# App\n\n## Task `add-eggs`\n\nText.\n";
    const once = withDifficultySection(readme, section);
    expect(withDifficultySection(once, section)).toBe(once);
    expect(once.startsWith(readme)).toBe(true);
    const later = withDifficultySection(
      `${once}\n## After\n\nMore.\n`,
      "## Measured difficulty\n\nNew.\n",
    );
    expect(later).toContain("New.");
    expect(later).not.toContain("too easy");
    expect(later).toContain("## After\n\nMore.\n");
  });
});

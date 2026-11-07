import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import * as hostFiles from "../../desktop/HostFileRead.js";
import {
  SolveCancelledError,
  SolveCleanupError,
} from "../../desktop/AgentEnvSolveHelper.js";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import type { SolveReport } from "../../desktop/AgentEnvSolveHelper.js";
import { measureBuildTask, type Solver } from "./DesktopBuildSolves.js";

/** A bundle holding stand-in steps and verifiers for these tasks, and a README. */
const bundleWith = async (...tasks: string[]) => {
  const bundle = await createTestTempDirectory("measured-");
  for (const task of tasks) {
    await mkdir(join(bundle, "tasks"), { recursive: true });
    await mkdir(join(bundle, "artifacts", `${task}-check`), {
      recursive: true,
    });
    await writeFile(join(bundle, "tasks", `${task}.json`), `["${task}"]\n`);
    await writeFile(
      join(bundle, "artifacts", `${task}-check`, "verify.py"),
      `# ${task}\n`,
    );
  }
  await writeFile(join(bundle, "README.md"), "# App\n");
  return bundle;
};

const passed: SolveReport = {
  outcome: "passed",
  instance_id: null,
  seconds: 1,
  checks: [{ id: "year", passed: true, description: "year" }],
  turns: 10,
  usd: 0.5,
  agentenv: "0.9.1431",
  error: null,
};

/** A solver that passes every solve, counting its calls. */
const counting = () => {
  const calls: string[] = [];
  const solver: Solver = async (request) => {
    calls.push(request.task);
    await new Promise((resolve) => setTimeout(resolve, 1));
    return passed;
  };
  return { calls, solver };
};

const request = (bundle: string, task: string) => ({
  bundle,
  task,
  model: "m",
  agent: "claude-code",
  budget_usd: 10,
});

describe("measureBuildTask's record of a bundle", () => {
  it("keeps both records when two tasks of one bundle are measured at once", async () => {
    const bundle = await bundleWith("add-eggs", "add-bread");
    const { solver } = counting();
    const signal = new AbortController().signal;

    const results = await Promise.all([
      measureBuildTask(request(bundle, "add-eggs"), solver, signal),
      measureBuildTask(request(bundle, "add-bread"), solver, signal),
    ]);

    for (const result of results) expect(result.ok).toBe(true);
    const recorded = JSON.parse(
      await readFile(join(bundle, "difficulty.json"), "utf8"),
    ) as { tasks: Record<string, unknown> };
    expect(Object.keys(recorded.tasks).sort()).toEqual([
      "add-bread",
      "add-eggs",
    ]);
    const readme = await readFile(join(bundle, "README.md"), "utf8");
    expect(readme).toContain("`add-eggs`");
    expect(readme).toContain("`add-bread`");
  });

  it.each([
    ["not JSON", "{not json"],
    ["records it cannot read", '{"tasks": {"add-bread": {"model": 1}}}'],
  ])(
    "refuses a difficulty file holding %s before any solve, and leaves it as it was",
    async (_label, content) => {
      const bundle = await bundleWith("add-eggs");
      await writeFile(join(bundle, "difficulty.json"), content);
      const { calls, solver } = counting();

      const result = await measureBuildTask(
        request(bundle, "add-eggs"),
        solver,
        new AbortController().signal,
      );

      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error.userMessage).toContain("difficulty.json");
      expect(calls).toEqual([]);
      expect(await readFile(join(bundle, "difficulty.json"), "utf8")).toBe(
        content,
      );
      expect(await readFile(join(bundle, "README.md"), "utf8")).toBe("# App\n");
    },
  );
});

it("retains completed paid solves when a later helper cannot be cleaned up", async () => {
  const bundle = await bundleWith("add-eggs");
  let calls = 0;
  const solver: Solver = async () => {
    calls += 1;
    if (calls === 1) return passed;
    throw new SolveCleanupError(
      passed,
      ["process group 123"],
      { reason: "cleanup incomplete" },
      "measure_build_task",
    );
  };
  const result = await measureBuildTask(
    request(bundle, "add-eggs"),
    solver,
    new AbortController().signal,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected cleanup failure");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(projectAnalysisError(result.error)).toMatchObject({
    details: {
      partial_observation: {
        kind: "partial-task-measurement",
        solves: [{ usd: 0.5 }, { usd: 0.5 }],
      },
    },
  });
  expect(result.error.partialObservation).toMatchObject({
    kind: "partial-task-measurement",
    bundle,
    task: "add-eggs",
    solves: [
      { outcome: "passed", turns: 10, usd: 0.5 },
      { outcome: "passed", turns: 10, usd: 0.5 },
    ],
  });
});

it("returns a typed failure if difficulty preflight encounters an I/O error", async () => {
  const bundle = await bundleWith("add-eggs");
  const original = hostFiles.readHostFile;
  const spy = vi
    .spyOn(hostFiles, "readHostFile")
    .mockImplementation(async (path, ...rest) => {
      if (path.endsWith("difficulty.json"))
        throw Object.assign(new Error("disk failure"), { code: "EIO" });
      return original(path, ...rest);
    });
  try {
    const { calls, solver } = counting();
    const result = await measureBuildTask(
      request(bundle, "add-eggs"),
      solver,
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected I/O failure");
    expect(result.error).toMatchObject({
      _tag: "ProviderAdapterError",
      cause: expect.objectContaining({ code: "EIO" }),
    });
    expect(calls).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

it("retains a solve when cancellation arrives after the helper report", async () => {
  const bundle = await bundleWith("add-eggs");
  const reason = { stage: "final cleanup" };
  const result = await measureBuildTask(
    request(bundle, "add-eggs"),
    async () => {
      throw new SolveCancelledError(passed, "measure_build_task", reason);
    },
    new AbortController().signal,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error).toMatchObject({
    _tag: "AnalysisCancelledError",
    cause: reason,
    partialObservation: {
      kind: "partial-task-measurement",
      solves: [{ turns: 10, usd: 0.5 }],
    },
  });
});

it("retains completed solves when the destination becomes unreadable before publication", async () => {
  const bundle = await bundleWith("add-eggs");
  let calls = 0;
  const result = await measureBuildTask(
    request(bundle, "add-eggs"),
    async () => {
      calls += 1;
      if (calls === 3)
        await writeFile(join(bundle, "difficulty.json"), "invalid");
      return passed;
    },
    new AbortController().signal,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected refusal");
  expect(result.error.partialObservation).toMatchObject({
    kind: "partial-task-measurement",
    solves: [{ usd: 0.5 }, { usd: 0.5 }, { usd: 0.5 }],
  });
  expect(await readFile(join(bundle, "difficulty.json"), "utf8")).toBe(
    "invalid",
  );
});

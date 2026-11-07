import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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

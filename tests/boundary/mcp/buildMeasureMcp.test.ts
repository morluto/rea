import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseDesktopTask } from "../../../src/domain/desktop/appTask.js";
import {
  renderTaskSteps,
  renderTaskVerifier,
  taskVerifierArtifact,
} from "../../../src/domain/desktop/appTaskPython.js";
import { callOk, connectBuildServer } from "../../fixtures/buildComputerMcp.js";
import { fakeAgentEnvSolves } from "../../fixtures/fakeAgentEnvSolves.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const TASK = {
  name: "set-year",
  prompt: "In Notes, set the year to 1952 and save it.",
  checks: [
    {
      id: "year",
      kind: "lines_present",
      file: "Documents/n.txt",
      lines: ["1952"],
    },
    {
      id: "kept",
      kind: "lines_present",
      file: "Documents/n.txt",
      lines: ["milk"],
    },
  ],
};
const MODEL = "anthropic/claude-sonnet-5-5";
const README = "# Notes computer app\n\n## Task `set-year`\n\nThe task.\n";

/** A bundle holding TASK as the export writes it, with its README. */
const bundleWithTask = async () => {
  const parsed = parseDesktopTask(TASK);
  if (!parsed.ok) throw new Error(parsed.error);
  const bundle = await createTestTempDirectory("measured-bundle-");
  const steps = renderTaskSteps(parsed.value, "notes");
  const verifier = renderTaskVerifier(parsed.value, "notes");
  await mkdir(join(bundle, "tasks"));
  await mkdir(join(bundle, "artifacts", taskVerifierArtifact(parsed.value)), {
    recursive: true,
  });
  await writeFile(join(bundle, "tasks", "set-year.json"), steps);
  await writeFile(
    join(bundle, "artifacts", taskVerifierArtifact(parsed.value), "verify.py"),
    verifier,
  );
  await writeFile(join(bundle, "README.md"), README);
  const digest = createHash("sha256")
    .update(steps)
    .update(verifier)
    .digest("hex");
  return { bundle, digest };
};

const passed = (usd = 1, turns = 20) => ({
  outcome: "passed" as const,
  checks: { year: true, kept: true },
  turns,
  usd,
});
const missed = (check: "year" | "kept", usd = 1) => ({
  outcome: "scored below 1" as const,
  checks: { year: check !== "year", kept: check !== "kept" },
  turns: 30,
  usd,
});

const measure = async (
  solves: Parameters<typeof fakeAgentEnvSolves>[0],
  budget = 10,
  task = TASK.name,
) => {
  const runner = await fakeAgentEnvSolves(solves);
  const client = await connectBuildServer({
    ...runner.environment,
    LITELLM_BASE_URL: "http://127.0.0.1:9/fake-endpoint",
  });
  const { bundle, digest } = await bundleWithTask();
  const call = () =>
    client.callTool({
      name: "measure_build_task",
      arguments: { bundle, task, model: MODEL, budget_usd: budget },
    });
  return { runner, client, bundle, digest, call };
};

it("measures a task in fresh computers: 1 of 3 asks for 2 more, 2 of 5 keeps it, and the bundle records it", async () => {
  const { runner, client, bundle, digest } = await measure([
    passed(),
    missed("year"),
    missed("year"),
    passed(1.5, 24),
    missed("kept"),
  ]);

  const measured = toolContract("measure_build_task").outputSchema.parse(
    (
      await callOk(client, "measure_build_task", {
        bundle,
        task: TASK.name,
        model: MODEL,
        budget_usd: 10,
      })
    ).structuredContent,
  );

  expect(measured).toMatchObject({
    task: "set-year",
    model: MODEL,
    agent: "claude-code",
    band: "in_band",
    stopped: "decided",
    k: 5,
    passes: 2,
    unfinished: 0,
    usd: 5.5,
    turns: [20, 30, 30, 24, 30],
    failures_per_check: { year: 2, kept: 1 },
  });
  const solves = (await runner.notes("solves.jsonl")) as Record<
    string,
    unknown
  >[];
  expect(solves).toHaveLength(5);
  for (const solve of solves)
    expect(solve).toEqual({
      root: bundle,
      tasks: ["set-year"],
      model: MODEL,
      agent: "claude-code",
      sandbox: "local",
      emulate: false,
      endpoint: "http://127.0.0.1:9/fake-endpoint",
    });
  const recorded = JSON.parse(
    await readFile(join(bundle, "difficulty.json"), "utf8"),
  ) as { tasks: Record<string, Record<string, unknown>> };
  expect(recorded.tasks["set-year"]).toMatchObject({
    model: MODEL,
    band: "in_band",
    k: 5,
    passes: 2,
    usd: 5.5,
    failures_per_check: { year: 2, kept: 1 },
    task_sha256: digest,
    versions: { rea: expect.any(String) },
  });
  const readme = await readFile(join(bundle, "README.md"), "utf8");
  expect(readme.startsWith(README)).toBe(true);
  expect(readme).toContain("## Measured difficulty");
  expect(readme).toContain(`\`set-year\`: ${MODEL} passed 2 of 5, in the band`);
});

it("stops at 3 of 3 as too easy, running an unfinished solve again without counting it and keeping why it failed", async () => {
  const { runner, bundle, call } = await measure([
    { outcome: "failed", checks: {}, turns: 3, usd: 0.1 },
    passed(),
    passed(),
    passed(),
  ]);

  const measured = toolContract("measure_build_task").outputSchema.parse(
    (await call()).structuredContent,
  );

  expect(measured).toMatchObject({
    band: "too_easy",
    k: 3,
    passes: 3,
    unfinished: 1,
  });
  expect(measured.solves.map((solve) => solve.error)).toEqual([
    "RuntimeError: deploy",
    null,
    null,
    null,
  ]);
  const recorded = JSON.parse(
    await readFile(join(bundle, "difficulty.json"), "utf8"),
  ) as { tasks: Record<string, { solves: { error: unknown }[] }> };
  expect(recorded.tasks["set-year"]?.solves[0]?.error).toBe(
    "RuntimeError: deploy",
  );
  expect(await runner.notes("solves.jsonl")).toHaveLength(4);
});

it("stops before a solve the largest cost so far would take past the budget, leaving the band undecided", async () => {
  const { runner, call } = await measure(
    [passed(0.9), missed("year", 0.9), passed(0.9)],
    2,
  );

  const measured = toolContract("measure_build_task").outputSchema.parse(
    (await call()).structuredContent,
  );

  expect(measured).toMatchObject({
    band: "undecided",
    stopped: "budget",
    k: 2,
    usd: 1.8,
    budget_usd: 2,
  });
  expect(await runner.notes("solves.jsonl")).toHaveLength(2);
});

it("refuses a task the bundle does not hold before running a solve", async () => {
  const { runner, call } = await measure([passed()], 10, "add-bread");

  const { error } = parseMcpToolError(await call());

  expect(error.code).toBe("invalid_request");
  expect(error.message).toContain("add-bread");
  expect(await runner.notes("solves.jsonl")).toEqual([]);
});

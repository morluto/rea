import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { runProductionMcpDoctor } from "../../../src/mcpDoctor.js";

/**
 * An owned MCP server that forks a grandchild holding inherited stdio, then
 * exits on stdin EOF — the shape the production doctor launches against a
 * misbehaving or slow server. The grandchild stays in the doctor's process
 * group; stopping the owned family is the doctor's duty.
 */
const FIXTURE = `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "inherit",
});
process.stderr.write("fixture-started " + String(grandchild.pid) + "\\n");
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
`;

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForExit = async (
  predicate: () => boolean,
  budgetMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
};

it("stops the owned process family when the startup deadline expires", async () => {
  const root = await createTestTempDirectory("rea-doctor-descendant-");
  const fixture = join(root, "fixture.js");
  await writeFile(fixture, FIXTURE);

  const result = await runProductionMcpDoctor({
    command: process.execPath,
    args: [fixture],
    cwd: root,
    environment: { ...process.env, REA_MCP_DOCTOR_DEADLINE_MS: "1000" },
  });

  expect(result.healthy).toBe(false);
  expect(result.diagnostics.stderr).toContain("fixture-started");
  const match = /fixture-started (\d+)/.exec(result.diagnostics.stderr);
  expect(match).not.toBeNull();
  const grandchild = Number(match?.[1]);
  expect(Number.isSafeInteger(grandchild)).toBe(true);
  expect(await waitForExit(() => !isRunning(grandchild), 15_000)).toBe(true);
});

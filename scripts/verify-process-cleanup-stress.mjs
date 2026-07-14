#!/usr/bin/env node

import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  captureProcessScenario,
  probeProcessCaptureCapability,
} from "../dist/application/ProcessHarness.js";
import { parseProcessScenario } from "../dist/domain/processScenario.js";

const execFileAsync = promisify(execFile);
const fixture = fileURLToPath(
  new URL("../tests/fixtures/processFidelity.mjs", import.meta.url),
);
const iterations = Number.parseInt(
  process.env.REA_PROCESS_STRESS_RUNS ?? "25",
  10,
);

if (process.platform !== "linux")
  throw new Error("Real forkpty cleanup stress verification requires Linux");
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 250)
  throw new Error("REA_PROCESS_STRESS_RUNS must be an integer from 1 to 250");
const capability = await probeProcessCaptureCapability();
if (!capability.available)
  throw new Error(`Process capture unavailable: ${capability.reason}`);

for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const result = await captureProcessScenario(
    parseProcessScenario({
      approved: true,
      executable: process.execPath,
      arguments: [fixture, "tree"],
      working_directory: dirname(fixture),
      timeout_ms: 1_000,
      idle_timeout_ms: 2_000,
      settle_ms: 50,
    }),
    {
      enabled: true,
      executableRoots: [dirname(process.execPath)],
      workingRoots: [dirname(fixture)],
      allowedEnvironment: [],
      allowExternalNetwork: true,
    },
  );
  if (!result.ok)
    throw new Error(`forkpty cleanup run ${String(iteration)} failed`, {
      cause: result.error,
    });
  if (
    result.value.cleanup.owned_process_group !== "verified" ||
    result.value.cleanup.temporary_root !== "removed"
  )
    throw new Error(`forkpty cleanup run ${String(iteration)} was incomplete`);
  const commands = result.value.process_samples.map(({ command }) => command);
  if (!commands.some((command) => command.includes("tree-child")))
    throw new Error(
      `forkpty cleanup run ${String(iteration)} missed its child`,
    );

  const { stdout } = await execFileAsync("ps", ["-axo", "command="]);
  if (
    stdout.includes(`${fixture} tree-child`) ||
    stdout.includes(`${fixture} tree-grandchild`)
  )
    throw new Error(
      `forkpty cleanup run ${String(iteration)} leaked a process`,
    );
}

process.stdout.write(
  `${JSON.stringify({ platform: process.platform, iterations, verified: true })}\n`,
);

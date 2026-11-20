import { randomUUID } from "node:crypto";
import { access, symlink } from "node:fs/promises";
import { join } from "node:path";

import { runOwnedCommand } from "../dist/process/OwnedCommand.js";
import { createVerifierRun } from "./lib/verifier-run.mjs";
import {
  VerifierFixture,
  withVerifierFixture,
} from "./lib/verifier-fixture.mjs";

createVerifierRun();

if (process.platform !== "linux")
  throw new Error("Linux real-Hopper verification must run on Linux");
const configuredLauncher = process.env.HOPPER_LAUNCHER_PATH;
const launcher = configuredLauncher ?? "/opt/hopper/bin/Hopper";
await access(launcher);
await access("/usr/bin/Xvfb");
await access("/usr/bin/xauth");
await access("/usr/bin/python3");
// ldd runs before a workspace exists, so it uses the same short-lived owner
// as requireLaneToolchain rather than a fixture-retained command owner.
const linked = await runOwnedCommand(
  {
    command: "ldd",
    arguments: [launcher],
    cwd: process.cwd(),
    env: process.env,
    runId: `rea-hopper-linux-ldd-${randomUUID()}`,
    expectedCommand: null,
    sweepTokenOwnedProcesses: true,
  },
  { timeoutMs: null, diagnosticBytes: 1024 * 1024 },
);
if (`${linked.stdout.text}\n${linked.stderr.text}`.includes("not found"))
  throw new Error("Hopper has unresolved shared-library dependencies");
const alternateDirectory = await VerifierFixture.open({
  prefix: "rea-real-hopper-launcher-",
  private: false,
});
const alternateLauncher = join(alternateDirectory.path, "Hopper-alternate");
await withVerifierFixture(alternateDirectory, async () => {
  try {
    await symlink(launcher, alternateLauncher);
    process.env.HOPPER_LAUNCHER_PATH = alternateLauncher;
    await import("./verify-real-hopper.mjs");
  } finally {
    if (configuredLauncher === undefined)
      delete process.env.HOPPER_LAUNCHER_PATH;
    else process.env.HOPPER_LAUNCHER_PATH = configuredLauncher;
  }
});

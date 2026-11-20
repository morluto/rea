import { access, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { createVerifierRun } from "./lib/verifier-run.mjs";
import {
  VerifierFixture,
  withVerifierFixture,
} from "./lib/verifier-fixture.mjs";

const execFileAsync = promisify(execFile);
createVerifierRun();

if (process.platform !== "linux")
  throw new Error("Linux real-Hopper verification must run on Linux");
const configuredLauncher = process.env.HOPPER_LAUNCHER_PATH;
const launcher = configuredLauncher ?? "/opt/hopper/bin/Hopper";
await access(launcher);
await access("/usr/bin/Xvfb");
await access("/usr/bin/xauth");
await access("/usr/bin/python3");
const linked = await execFileAsync("ldd", [launcher]);
if (`${linked.stdout}\n${linked.stderr}`.includes("not found"))
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

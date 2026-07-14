import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HopperApplicationLauncher } from "../src/hopper/BridgeLauncher.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Hopper application launcher", () => {
  it.skipIf(process.platform !== "linux")(
    "uses the Linux demo helper for a non-canonical launcher path",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "rea-launcher-test-"));
      directories.push(directory);
      const helper = join(directory, "demo-helper.py");
      await writeFile(helper, "import sys\nsys.exit(0)\n");
      const launcher = new HopperApplicationLauncher({
        launcherPath: "/usr/bin/true",
        targetPath: "/tmp/fixture",
        targetKind: "executable",
        loaderArgs: [],
        bridgeScriptPath: "/tmp/hopper_bridge.py",
        demoHelperPath: helper,
      });

      const launched = await launcher.launch({
        directory,
        socketPath: join(directory, "bridge.sock"),
        token: "token",
        runId: "run-wrapper",
      });

      expect(launched.ok).toBe(true);
      if (!launched.ok) return;
      expect(launched.value.process.spawnfile).toBe("/usr/bin/python3");
      expect(launched.value.process.spawnargs).toContain(helper);
      expect(launched.value.shutdownByCleanup).toBe(true);
      expect(await readFile(join(directory, "bootstrap.py"), "utf8")).toContain(
        "REA_OWNS_PROCESS_LIFETIME = True",
      );
      if (launched.value.process.exitCode === null)
        await new Promise<void>((resolve) => {
          launched.value.process.once("exit", () => resolve());
        });
    },
  );
});

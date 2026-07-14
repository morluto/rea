import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type HopperApplicationLauncherOptions,
  usesLinuxDemo,
} from "../src/hopper/BridgeLauncher.js";

const execFileAsync = promisify(execFile);
const demoHelperPath = fileURLToPath(
  new URL("../scripts/hopper-demo-x11.py", import.meta.url),
);

const options = (launcherPath: string): HopperApplicationLauncherOptions => ({
  launcherPath,
  targetPath: "/target",
  targetKind: "executable",
  loaderArgs: [],
  bridgeScriptPath: "/rea/hopper_bridge.py",
  launchMode: "verified_linux_demo",
  demoHelperPath: "/rea/hopper-demo-x11.py",
});

describe("Hopper bridge launcher selection", () => {
  it.each([
    "/opt/hopper/bin/Hopper",
    "/usr/local/bin/hopper",
    "/workspace/bin/hopper-wrapper",
  ])(
    "routes launcher spelling %s through the explicitly selected pinned adapter",
    (path) => {
      expect(usesLinuxDemo(options(path))).toBe(true);
    },
  );

  it("does not infer demo behavior from a native launcher's basename", () => {
    expect(
      usesLinuxDemo({
        launcherPath: "/opt/hopper/bin/Hopper",
        targetPath: "/target",
        targetKind: "executable",
        loaderArgs: [],
        bridgeScriptPath: "/rea/hopper_bridge.py",
        launchMode: "native",
      }),
    ).toBe(false);
  });

  it("rejects an unpinned wrapper before executing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-hopper-wrapper-"));
    const wrapper = join(directory, "hopper-wrapper");
    const marker = join(directory, "executed");
    try {
      await writeFile(wrapper, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
      await chmod(wrapper, 0o700);
      await expect(
        execFileAsync(
          "python3",
          [
            demoHelperPath,
            "--hopper",
            wrapper,
            "--socket",
            join(directory, "bridge.sock"),
            "--",
            wrapper,
          ],
          { timeout: 3_000 },
        ),
      ).rejects.toMatchObject({
        code: 72,
        stderr: expect.stringContaining("unsupported Hopper binary"),
      });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

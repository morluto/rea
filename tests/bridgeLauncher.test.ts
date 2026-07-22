import { execFile } from "node:child_process";
import { access, chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import {
  type HopperApplicationLauncherOptions,
  linuxDemoLaunch,
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

  it("builds the namespace launch without sudo or a shell command", () => {
    const launch = linuxDemoLaunch(
      options("/opt/hopper/bin/Hopper"),
      {
        directory: "/tmp/rea-fixture",
        socketPath: "/tmp/rea-fixture/bridge.sock",
        token: "not-forwarded",
        runId: "fixture-run",
      },
      ["--analysis"],
      "user-mount-namespace",
    );

    expect(launch).toMatchObject({
      command: "/usr/bin/unshare",
      ownershipCommand: "/usr/bin/python3",
      args: [
        "--user",
        "--map-root-user",
        "--mount",
        "--propagation",
        "private",
        "/usr/bin/python3",
        "/rea/hopper-demo-x11.py",
        "--strategy",
        "user-mount-namespace",
        "--mount-private-x11",
        "--hopper",
        "/opt/hopper/bin/Hopper",
        "--socket",
        "/tmp/rea-fixture/bridge.sock",
        "--",
        "/opt/hopper/bin/Hopper",
        "--analysis",
      ],
    });
    expect(launch?.args).not.toContain("sudo");
    expect(launch?.args).not.toContain("-c");
  });

  it("keeps an ordinary Linux launch on the direct Python adapter", () => {
    expect(
      linuxDemoLaunch(
        options("/opt/hopper/bin/Hopper"),
        {
          directory: "/tmp/rea-fixture",
          socketPath: "/tmp/rea-fixture/bridge.sock",
          token: "not-forwarded",
          runId: "fixture-run",
        },
        [],
        "direct",
      ),
    ).toMatchObject({
      command: "/usr/bin/python3",
      args: [
        "/rea/hopper-demo-x11.py",
        "--strategy",
        "direct",
        "--hopper",
        "/opt/hopper/bin/Hopper",
        "--socket",
        "/tmp/rea-fixture/bridge.sock",
        "--",
        "/opt/hopper/bin/Hopper",
      ],
    });
  });

  it("rejects an unpinned wrapper before executing it", async () => {
    const directory = await createTestTempDirectory("rea-hopper-wrapper-");
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
        stderr: expect.stringContaining(
          '"failure_code":"unsupported_hopper_build"',
        ),
      });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

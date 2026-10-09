import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import {
  HopperApplicationLauncher,
  type HopperApplicationLauncherOptions,
  linuxDemoLaunch,
  usesLinuxDemo,
} from "../../../../src/hopper/BridgeLauncher.js";

import { ProviderProcessSupervisor } from "../../../../src/process/ProviderProcess.js";

const execFileAsync = promisify(execFile);
const demoHelperPath = fileURLToPath(
  new URL("../../../../scripts/hopper-demo-x11.py", import.meta.url),
);

const options = (launcherPath: string): HopperApplicationLauncherOptions => ({
  environment: {},
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
        environment: {},
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

it("launches Hopper helpers with the caller-selected environment without restoring ambient values", async () => {
  const directory = await createTestTempDirectory("rea-hopper-selected-env-");
  const launcher = new HopperApplicationLauncher({
    environment: { REA_SELECTED_VALUE: "caller-value" },
    launcherPath: process.execPath,
    targetPath: join(directory, "target"),
    targetKind: "executable",
    loaderArgs: [
      "-e",
      "process.stdout.write(JSON.stringify({ selected: process.env.REA_SELECTED_VALUE ?? null, home: process.env.HOME ?? null }))",
      "--",
    ],
    bridgeScriptPath: "/rea/unused-bridge.py",
    launchMode: "native",
  });
  const launched = await launcher.launch({
    directory,
    socketPath: join(directory, "bridge.sock"),
    token: "fixture-token",
    runId: randomUUID(),
  });
  if (!launched.ok) throw launched.error;
  const supervisor = new ProviderProcessSupervisor(launched.value);
  try {
    expect(await supervisor.waitForOutputClose(5_000)).toBe(true);
    expect(JSON.parse(supervisor.snapshot().stdout.text)).toEqual({
      selected: "caller-value",
      home: null,
    });
    expect(await supervisor.stop()).toMatchObject({
      status: "verified-cleanup",
    });
  } finally {
    await supervisor.stop();
    await launched.value.releaseLease?.();
  }
});

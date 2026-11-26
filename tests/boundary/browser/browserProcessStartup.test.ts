import { ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  processTest as it,
  waitForExit,
} from "../../support/process/processFixture.js";

import {
  BROWSER_DEVTOOLS_STARTUP_TIMEOUT_MS,
  BrowserStartupError,
  waitForBrowserDevtoolsPort,
} from "../../../scripts/lib/browser-process-startup.mjs";
import { assertOrdinaryWindowsVerifierCaller } from "../../../scripts/lib/windows-ordinary-user-verifier.mjs";

describe("browser process startup", () => {
  it("requires a positively observed ordinary Windows verifier caller", () => {
    expect(() =>
      assertOrdinaryWindowsVerifierCaller({
        administrator: false,
        elevated: false,
        integrityLevel: 8192,
      }),
    ).not.toThrow();

    for (const token of [
      { administrator: true, elevated: false },
      { administrator: false, elevated: true },
      { administrator: false },
      { administrator: false, elevated: null },
      null,
    ]) {
      expect(() => assertOrdinaryWindowsVerifierCaller(token)).toThrow(
        /ordinary, non-elevated user token/u,
      );
    }
  });

  it("returns a delayed valid DevToolsActivePort", async ({ processes }) => {
    const root = await temporaryRoot();
    const portPath = join(root, "DevToolsActivePort");
    const child = processes.spawn(process.execPath, [
      "-e",
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(portPath)}, "43117\\n/browser"), 20); setTimeout(() => {}, 1000)`,
    ]);
    try {
      await expect(
        waitForBrowserDevtoolsPort({
          child,
          executable: process.execPath,
          activePortPath: portPath,
          stderr: () => "",
          timeoutMs: 1_000,
          pollIntervalMs: 5,
        }),
      ).resolves.toBe(43_117);
    } finally {
      child.kill("SIGKILL");
      expect(await waitForExit(child, 5_000)).toBe(true);
    }
  });

  it("classifies signal termination instead of timing out", async ({
    processes,
  }) => {
    const root = await temporaryRoot();
    const child = processes.spawn(process.execPath, [
      "-e",
      "process.kill(process.pid, 'SIGTERM')",
    ]);

    const failure = await waitForBrowserDevtoolsPort({
      child,
      executable: process.execPath,
      activePortPath: join(root, "DevToolsActivePort"),
      stderr: () => "signal fixture",
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(BrowserStartupError);
    expect(failure).toMatchObject({
      failure: "signalled",
      exitCode: null,
      signalCode: "SIGTERM",
      stderr: "signal fixture",
    });
  });

  it("reports bounded timeout diagnostics", async () => {
    await expect(
      waitForBrowserDevtoolsPort({
        child: new ChildProcess(),
        executable: process.execPath,
        activePortPath: join(await temporaryRoot(), "DevToolsActivePort"),
        stderr: () => "",
        timeoutMs: 20,
        pollIntervalMs: 5,
      }),
    ).rejects.toMatchObject({
      _tag: "BrowserStartupError",
      failure: "timeout",
      exitCode: null,
      signalCode: null,
      startupTimeoutMs: 20,
      message: expect.stringMatching(/timeoutMs=20.*stderr=<empty>$/u),
    });
  });

  it("names the owner's deadline when a caller omits one", async ({
    processes,
  }) => {
    const root = await temporaryRoot();
    const child = processes.spawn(process.execPath, [
      "-e",
      "setTimeout(() => process.exit(3), 10)",
    ]);

    const failure = await waitForBrowserDevtoolsPort({
      child,
      executable: process.execPath,
      activePortPath: join(root, "DevToolsActivePort"),
      stderr: () => "owner default fixture",
      pollIntervalMs: 5,
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(BrowserStartupError);
    expect(failure).toMatchObject({
      failure: "exited",
      startupTimeoutMs: BROWSER_DEVTOOLS_STARTUP_TIMEOUT_MS,
    });
    expect(String(failure)).toContain(
      `timeoutMs=${String(BROWSER_DEVTOOLS_STARTUP_TIMEOUT_MS)}`,
    );
  });

  it("keeps a terminal startup outcome observed during a valid port read", async () => {
    const portPath = join(await temporaryRoot(), "DevToolsActivePort");
    await writeFile(portPath, "43117\n/devtools/browser/fixture");
    const spawnError = new Error("fixture launch failed");
    for (const failure of ["exited", "spawn-error"] as const) {
      const child = new ChildProcess();
      const pending = waitForBrowserDevtoolsPort({
        child,
        executable: process.execPath,
        activePortPath: portPath,
        stderr: () => "fixture startup diagnostic",
      });
      // The file read is in flight and already contains a valid port.
      if (failure === "spawn-error") child.emit("error", spawnError);
      Object.defineProperty(child, "exitCode", { value: 3 });
      child.emit("exit", 3, null);
      await expect(pending, failure).rejects.toMatchObject({
        _tag: "BrowserStartupError",
        failure,
        exitCode: failure === "exited" ? 3 : null,
        stderr: "fixture startup diagnostic",
        ...(failure === "spawn-error" ? { cause: spawnError } : {}),
      });
    }
  });
});

const temporaryRoot = async (): Promise<string> => {
  return createTestTempDirectory("rea-browser-startup-");
};

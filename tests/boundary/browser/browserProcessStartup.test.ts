import { join } from "node:path";

import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  processTest as it,
  waitForExit,
} from "../../support/process/processFixture.js";

import {
  BrowserStartupError,
  waitForBrowserDevtoolsPort,
} from "../../../src/browser/BrowserProcessStartup.js";

describe("browser process startup", () => {
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

  it.skipIf(process.platform === "win32")(
    "classifies signal termination instead of timing out",
    async ({ processes }) => {
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
    },
  );

  it("reports bounded timeout diagnostics", async ({ processes }) => {
    const root = await temporaryRoot();
    const child = processes.spawn(process.execPath, [
      "-e",
      "setTimeout(() => {}, 1000)",
    ]);
    try {
      const failure = await waitForBrowserDevtoolsPort({
        child,
        executable: process.execPath,
        activePortPath: join(root, "DevToolsActivePort"),
        stderr: () => "",
        timeoutMs: 20,
        pollIntervalMs: 5,
      }).catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(BrowserStartupError);
      expect(failure).toMatchObject({
        failure: "timeout",
        exitCode: null,
        signalCode: null,
      });
      expect(String(failure)).toContain("stderr=<empty>");
    } finally {
      child.kill("SIGKILL");
      expect(await waitForExit(child, 5_000)).toBe(true);
    }
  });
});

const temporaryRoot = async (): Promise<string> => {
  return createTestTempDirectory("rea-browser-startup-");
};

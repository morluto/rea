import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BrowserStartupError,
  waitForBrowserDevtoolsPort,
} from "../src/browser/BrowserProcessStartup.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("browser process startup", () => {
  it("returns a delayed valid DevToolsActivePort", async () => {
    const root = await temporaryRoot();
    const portPath = join(root, "DevToolsActivePort");
    const child = spawn(process.execPath, [
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
    }
  });

  it("classifies signal termination instead of timing out", async () => {
    const root = await temporaryRoot();
    const child = spawn(process.execPath, [
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
    const root = await temporaryRoot();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1000)"]);
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
    }
  });
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rea-browser-startup-"));
  roots.push(root);
  return root;
};

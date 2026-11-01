import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { spawnOwnedProviderProcess } from "../process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";

import { launchSetupPluginCommand } from "./SetupPluginCommand.js";

const scope = () => {
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  return resources;
};

it("returns interruption after successful child cleanup without terminating the setup owner", async () => {
  const kill = process.kill.bind(process);
  const selfSignals: Array<Parameters<typeof process.kill>[1]> = [];
  const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid !== process.pid) return kill(pid, signal);
    selfSignals.push(signal);
    return true;
  });
  onTestFinished(() => spy.mockRestore());
  const result = await launchSetupPluginCommand(
    process.execPath,
    ["--version"],
    {
      env: process.env,
      cwd: process.cwd(),
      timeoutMs: 5000,
      platform: process.platform,
      resources: scope(),
      launcher: async (options) => {
        const launched = await spawnOwnedProviderProcess(options);
        return {
          ...launched,
          cleanup: async () => {
            process.emit("SIGINT");
            return cleanupOwnedProcessGroup(launched.ownership);
          },
        };
      },
    },
  );
  expect(result.interruptedSignal).toBe("SIGINT");
  expect(result.cleanupFailure).toBeUndefined();
  expect(selfSignals).toEqual([]);
});

describe("launchSetupPluginCommand", () => {
  it("retains bounded head and tail bytes and preserves UTF-8 across writes", async () => {
    const result = await launchSetupPluginCommand(
      process.execPath,
      [
        "-e",
        `
      process.stdout.write(Buffer.from([0xe4]));
      setTimeout(() => {
        process.stdout.write(Buffer.from([0xb8, 0xad]));
        process.stderr.write('x'.repeat(60000));
        setTimeout(() => {
          process.stderr.write('y'.repeat(60000));
          process.stderr.write('FINAL: package permission denied');
          process.exitCode = 1;
        }, 30);
      }, 30);
    `,
      ],
      {
        env: process.env,
        cwd: process.cwd(),
        timeoutMs: 5000,
        platform: process.platform,
        resources: scope(),
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("中");
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(64 * 1024 + 50);
    expect(result.stderr).toContain("[output omitted]");
    expect(result.stderr).toContain("FINAL: package permission denied");
  });

  it("captures a successful command exit", async () => {
    const result = await launchSetupPluginCommand(
      process.execPath,
      ["--version"],
      {
        env: process.env,
        cwd: process.cwd(),
        timeoutMs: 30_000,
        platform: process.platform,
        resources: scope(),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  it("stops the runner tree at the deadline and reports the timeout", async () => {
    const startedAt = Date.now();
    const result = await launchSetupPluginCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        env: process.env,
        cwd: process.cwd(),
        timeoutMs: 300,
        platform: process.platform,
        resources: scope(),
      },
    );
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});

it.runIf(process.platform !== "win32")(
  "settles the plugin command deadline after a detached descendant inherits the exited runner's pipes",
  async () => {
    const result = await launchSetupPluginCommand(
      process.execPath,
      [
        "-e",
        `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("descendant:" + process.pid); setTimeout(() => process.stdout.write("natural-descendant-exit"), 60_000)'], {
      detached: true, stdio: ['ignore', 'inherit', 'inherit']
    });
    child.unref();
  `,
      ],
      {
        env: process.env,
        cwd: process.cwd(),
        // Ownership admission and two Node starts must finish before the
        // deadline tests held output pipes rather than startup cancellation.
        timeoutMs: 5000,
        platform: process.platform,
        resources: scope(),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain("descendant:");
    expect(result.cleanupFailure).toBeUndefined();
    expect(result.stdout).not.toContain("natural-descendant-exit");
  },
  15_000,
);

it.each([false, true])(
  "retains the exact runner cleanup for scope close and retry (interrupt=%s)",
  async (interrupt) => {
    const resources = new ArtifactResourceScope();
    let allowCleanup = false;
    let attempts = 0;
    onTestFinished(async () => {
      allowCleanup = true;
      await resources.close();
    });
    const result = await launchSetupPluginCommand(
      process.execPath,
      ["--version"],
      {
        env: process.env,
        cwd: process.cwd(),
        timeoutMs: 5000,
        platform: process.platform,
        resources,
        launcher: async (options) => {
          const launched = await spawnOwnedProviderProcess(options);
          return {
            ...launched,
            cleanup: async () => {
              attempts++;
              if (interrupt && attempts === 1) process.emit("SIGINT");
              return allowCleanup
                ? cleanupOwnedProcessGroup(launched.ownership)
                : {
                    cleaned: false as const,
                    reason: "controlled runner cleanup refusal",
                  };
            },
          };
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.cleanupFailure).toContain(
      "controlled runner cleanup refusal",
    );
    expect(result.interruptedSignal).toBe(interrupt ? "SIGINT" : undefined);
    expect(resources.hasPending).toBe(true);
    await expect(resources.close()).rejects.toThrow();
    expect(attempts).toBe(2);
    allowCleanup = true;
    await resources.close();
    expect(attempts).toBe(3);
    expect(resources.hasPending).toBe(false);
  },
);

it("captures the selected environment at admission and accepts reconfiguration on the next plugin command", async () => {
  const env = { ...process.env, REA_PLUGIN_SELECTED_VALUE: "first" };
  const resources = scope();
  const invoke = () =>
    launchSetupPluginCommand(
      process.execPath,
      ["-e", "process.stdout.write(process.env.REA_PLUGIN_SELECTED_VALUE)"],
      {
        env,
        cwd: process.cwd(),
        timeoutMs: 5000,
        platform: process.platform,
        resources,
      },
    );
  const first = invoke();
  env.REA_PLUGIN_SELECTED_VALUE = "second";
  expect((await first).stdout).toBe("first");
  expect((await invoke()).stdout).toBe("second");
  expect(resources.hasPending).toBe(false);
});

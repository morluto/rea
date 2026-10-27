import { describe, expect, it, onTestFinished } from "vitest";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { spawnOwnedProviderProcess } from "../process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";

import { PRODUCT_IDENTITY } from "../identity.js";
import {
  launchRegistrationRunnerCommand,
  materializeRegistrationRunnerCache,
  registrationPrewarmCommand,
  type RegistrationRunnerLaunch,
  type RegistrationRunnerLauncher,
} from "./SetupRegistrationPrewarm.js";

const scope = () => {
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  return resources;
};

const specifier = PRODUCT_IDENTITY.registrationPackageSpecifier;

const launch = (
  overrides: Partial<RegistrationRunnerLaunch> = {},
): RegistrationRunnerLaunch => ({
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...overrides,
});

describe("registrationPrewarmCommand", () => {
  it("replaces the server subcommand of an npx registration", () => {
    expect(registrationPrewarmCommand(["npx", "-y", specifier, "mcp"])).toEqual(
      ["npx", "-y", specifier, "--version"],
    );
  });

  it("keeps the Windows command wrapper", () => {
    expect(
      registrationPrewarmCommand([
        "cmd.exe",
        "/d",
        "/c",
        "npx",
        "-y",
        specifier,
        "mcp",
      ]),
    ).toEqual(["cmd.exe", "/d", "/c", "npx", "-y", specifier, "--version"]);
  });

  it("replaces the server subcommand of a bunx registration", () => {
    expect(registrationPrewarmCommand(["bunx", specifier, "mcp"])).toEqual([
      "bunx",
      specifier,
      "--version",
    ]);
  });

  it("keeps direct launchers and non-server commands undefined", () => {
    expect(registrationPrewarmCommand(["/opt/rea/rea", "mcp"])).toBeUndefined();
    expect(
      registrationPrewarmCommand(["npx", "-y", specifier, "doctor"]),
    ).toBeUndefined();
    expect(registrationPrewarmCommand([])).toBeUndefined();
  });
});

describe("materializeRegistrationRunnerCache", () => {
  it("skips direct launchers without launching", async () => {
    let launched = 0;
    const launcher: RegistrationRunnerLauncher = async () => {
      launched += 1;
      return launch();
    };
    const result = await materializeRegistrationRunnerCache(
      ["/opt/rea/rea", "mcp"],
      {},
      scope(),
      launcher,
    );
    expect(result).toEqual({ status: "skipped", reason: "direct_launcher" });
    expect(launched).toBe(0);
  });

  it("materializes the pinned spec once and reports warmed", async () => {
    const commands: (readonly string[])[] = [];
    const launcher: RegistrationRunnerLauncher = async (
      command,
      arguments_,
      options,
    ) => {
      commands.push([command, ...arguments_]);
      expect(options.timeoutMs).toBeGreaterThan(0);
      expect(options.env.REA_PREWARM_PROBE).toBe("1");
      expect(options.cwd.length).toBeGreaterThan(0);
      return launch({ stdout: "6.7.0\n" });
    };
    const result = await materializeRegistrationRunnerCache(
      ["npx", "-y", specifier, "mcp"],
      { REA_PREWARM_PROBE: "1" },
      scope(),
      launcher,
    );
    expect(result).toEqual({ status: "warmed" });
    expect(commands).toEqual([["npx", "-y", specifier, "--version"]]);
  });

  it("reports a bounded failure reason for a non-zero exit", async () => {
    const result = await materializeRegistrationRunnerCache(
      ["npx", "-y", specifier, "mcp"],
      {},
      scope(),
      async () => launch({ exitCode: 1, stderr: "spawn EPERM\n" }),
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toContain("exit 1");
    expect(result.reason).toContain("spawn EPERM");
    expect(result.reason).not.toMatch(/[\n\r]/u);
    expect(result.reason).toContain("first client start");
  });

  it("reports a timeout failure without command output facts", async () => {
    const result = await materializeRegistrationRunnerCache(
      ["npx", "-y", specifier, "mcp"],
      {},
      scope(),
      async () => launch({ exitCode: null, timedOut: true }),
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toContain("timed out");
  });

  it("reports a spawn failure", async () => {
    const result = await materializeRegistrationRunnerCache(
      ["npx", "-y", specifier, "mcp"],
      {},
      scope(),
      async () => launch({ exitCode: null, spawnError: "spawn npx ENOENT" }),
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toContain("spawn npx ENOENT");
  });

  it("reports a forwarded interrupt as a failure", async () => {
    const result = await materializeRegistrationRunnerCache(
      ["npx", "-y", specifier, "mcp"],
      {},
      scope(),
      async () => launch({ exitCode: null, interruptedSignal: "SIGINT" }),
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toContain("stopped by SIGINT");
  });
});

describe("launchRegistrationRunnerCommand", () => {
  it("retains bounded head and tail bytes and preserves UTF-8 across writes", async () => {
    const result = await launchRegistrationRunnerCommand(
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
    const prewarm = await materializeRegistrationRunnerCache(
      ["npx", "-y", specifier, "mcp"],
      {},
      scope(),
      async () => result,
    );
    expect(prewarm.status).toBe("failed");
    if (prewarm.status === "failed") {
      expect(prewarm.reason).toContain("exit 1");
      expect(prewarm.reason).toContain("FINAL: package permission denied");
    }
  });

  it("captures a successful command exit", async () => {
    const result = await launchRegistrationRunnerCommand(
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
    const result = await launchRegistrationRunnerCommand(
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
  "settles the prewarm deadline after a detached descendant inherits the exited runner's pipes",
  async () => {
    const result = await launchRegistrationRunnerCommand(
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
    const result = await launchRegistrationRunnerCommand(
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
    const prewarm = await materializeRegistrationRunnerCache(
      ["npx", "-y", specifier, "mcp"],
      {},
      resources,
      async () => result,
    );
    expect(prewarm).toMatchObject({ status: "failed" });
    await expect(resources.close()).rejects.toThrow();
    expect(attempts).toBe(2);
    allowCleanup = true;
    await resources.close();
    expect(attempts).toBe(3);
    expect(resources.hasPending).toBe(false);
  },
);

it("captures the selected environment at admission and accepts reconfiguration on the next prewarm", async () => {
  const env = { ...process.env, REA_PREWARM_SELECTED_VALUE: "first" };
  const resources = scope();
  const invoke = () =>
    launchRegistrationRunnerCommand(
      process.execPath,
      ["-e", "process.stdout.write(process.env.REA_PREWARM_SELECTED_VALUE)"],
      {
        env,
        cwd: process.cwd(),
        timeoutMs: 5000,
        platform: process.platform,
        resources,
      },
    );
  const first = invoke();
  env.REA_PREWARM_SELECTED_VALUE = "second";
  expect((await first).stdout).toBe("first");
  expect((await invoke()).stdout).toBe("second");
  expect(resources.hasPending).toBe(false);
});

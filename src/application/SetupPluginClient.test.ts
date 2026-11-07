import { expect, it, onTestFinished } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import type { SetupPluginCommandLauncher } from "./SetupPluginCommand.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import {
  AnalysisError,
  primaryAnalysisError,
} from "../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { SetupPluginClient } from "./SetupPluginClient.js";
import { launchSetupPluginCommand } from "./SetupPluginCommand.js";
import { runSetup } from "./Setup.js";
import { FakeSetupHost, options } from "./Setup.fixture.js";
import { withPluginSetup } from "./SetupPluginHost.js";

it("reports an explicit capture limit for valid inventory above 64 KiB", async () => {
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  const client = new SetupPluginClient(
    "codex",
    process.env,
    resources,
    (_command, _args, launchOptions) =>
      launchSetupPluginCommand(
        process.execPath,
        [
          "-e",
          "process.stdout.write(JSON.stringify({installed:[],padding:'x'.repeat(70000)}))",
        ],
        launchOptions,
      ),
  );
  expect(await client.inspect()).toMatchObject({
    status: "invalid",
    remediation: expect.stringContaining(
      "exceeded the 64 KiB output capture limit",
    ),
  });
});

it("preserves cancellation and retained cleanup ownership through setup and retry", async () => {
  const base = new FakeSetupHost("win32");
  base.clients = [
    { name: "claude_code", configPath: "/fixture/config", format: "json" },
  ];
  base.productRegistrations = [
    {
      client: "claude_code",
      config_path: "/fixture/config",
      command: [],
      state: "missing",
      remediation: "Install REA.",
    },
  ];
  let allowCleanup = false;
  let cleanupAttempts = 0;
  const host = withPluginSetup(
    base,
    {},
    { preferPlugins: true },
    async (_command, _args, launchOptions) => {
      launchOptions.resources.retain({
        kind: "lease",
        resource: "plugin child",
        lease: new AnalysisCleanupLease(async () => {
          cleanupAttempts++;
          if (!allowCleanup) throw new Error("controlled cleanup refusal");
        }, ["plugin child"]),
      });
      return {
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        interruptedSignal: "SIGINT",
        cleanupFailure: "controlled cleanup refusal",
      };
    },
  );
  onTestFinished(async () => {
    allowCleanup = true;
    await host.close?.();
  });
  const failure: unknown = await runSetup(
    { ...options(true), clientIds: ["claude_code"], proposeHopper: false },
    host,
  ).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(AnalysisError);
  if (!(failure instanceof AnalysisError))
    throw new Error("Expected cancellation");
  expect(primaryAnalysisError(failure)).toBeInstanceOf(AnalysisCancelledError);
  expect(primaryAnalysisError(failure).diagnostics?.interrupted_signal).toBe(
    "SIGINT",
  );
  expect(projectAnalysisError(failure).category).toBe("cancelled");
  expect(failure.cleanupIncomplete).toBe(true);
  expect(base.configurations + base.skillInstalls).toBe(0);
  expect(cleanupAttempts).toBe(1);
  allowCleanup = true;
  expect(await host.close?.()).toBeUndefined();
  expect(cleanupAttempts).toBe(2);
  expect(failure.cleanupIncomplete).toBe(false);
});

it.runIf(process.platform === "win32")(
  "resolves a runnable batch client in a quoted Windows PATH ahead of a PowerShell shim",
  async () => {
    const root = await createTestTempDirectory("rea-plugin-quoted-path-");
    const bin = join(root, "tools;clients");
    await mkdir(bin);
    const script = join(bin, "client.mjs");
    await writeFile(
      script,
      "process.stdout.write(JSON.stringify({installed:[]}));",
    );
    await writeFile(
      join(bin, "codex.cmd"),
      `@"${process.execPath}" "${script}" %*\r\n`,
    );
    await writeFile(
      join(bin, "codex.ps1"),
      "throw 'unsupported shim selected'",
    );
    const resources = new ArtifactResourceScope();
    onTestFinished(() => resources.close());
    const client = new SetupPluginClient(
      "codex",
      { ...process.env, PATH: `"${bin}"`, PATHEXT: ".PS1;.CMD" },
      resources,
    );
    expect(await client.inspect()).toMatchObject({
      status: "available",
      installed: false,
    });
  },
);
it.each(["inventory", "install", "readback"] as const)(
  "preserves bounded command failure details during %s",
  async (stage) => {
    const resources = new ArtifactResourceScope();
    onTestFinished(() => resources.close());
    const launch: SetupPluginCommandLauncher = async (_command, args) => {
      const failed =
        stage === "inventory" ||
        (stage === "install" ? args[1] !== "list" : args[1] === "list");
      return {
        exitCode: failed ? 1 : 0,
        signal: null,
        stdout: "",
        stderr: failed
          ? "Sign in to the marketplace before installing. " +
            "x".repeat(10000) +
            " END-OF-FAILURE"
          : "",
        timedOut: failed,
        ...(failed
          ? { cleanupFailure: "controlled child cleanup failure" }
          : {}),
      };
    };
    const client = new SetupPluginClient("claude", {}, resources, launch);
    const failure =
      stage === "inventory"
        ? await client.inspect()
        : await client.install(false);
    const message =
      typeof failure === "string"
        ? failure
        : failure?.status === "invalid"
          ? failure.remediation
          : "";
    expect(message).toContain("Sign in to the marketplace");
    expect(message).toContain("controlled child cleanup failure");
    expect(message).toContain("END-OF-FAILURE");
    expect(message.length).toBeLessThan(3000);
  },
);

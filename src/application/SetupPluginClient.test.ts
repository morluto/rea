import { expect, it, onTestFinished } from "vitest";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import {
  AnalysisError,
  primaryAnalysisError,
} from "../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { SetupPluginClient } from "./SetupPluginClient.js";
import { launchRegistrationRunnerCommand } from "./SetupRegistrationPrewarm.js";
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
      launchRegistrationRunnerCommand(
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
    true,
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

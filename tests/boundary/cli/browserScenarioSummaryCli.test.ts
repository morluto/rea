import { createCommandCli } from "../../support/cli/commandCli.js";
import { access } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { expect, it } from "vitest";

import { registerBrowserScenarioCommands } from "../../../src/cliBrowserScenarioCommands.js";
import { ok } from "../../../src/domain/result.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { AnalysisOutputError } from "../../../src/domain/analysisErrorCore.js";
import { AnalysisCleanupLease } from "../../../src/resources/AnalysisCleanupLease.js";
import { PlaywrightBrowserScenarioProvider } from "../../../src/browser/PlaywrightBrowserScenarioProvider.js";
import { scenarioCaptureFixture } from "../../fixtures/browserScenarioCapture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import type { BrowserScenarioCapturePort } from "../../../src/ports/BrowserScenarioCapturePort.js";
import { controlledCleanup } from "../../support/lifecycleHarness.js";

const identity = { id: "fixture", name: "Fixture", version: "1" };
const capture = scenarioCaptureFixture();
const runCli = async (
  provider: BrowserScenarioCapturePort,
  options: readonly string[] = [],
) => {
  const cli = createCommandCli();
  registerBrowserScenarioCommands(
    cli,
    pino({ level: "silent" }),
    {},
    {
      createProvider: () => provider,
    },
  );
  let stdout = "";
  await cli.serve(
    [
      "capture-browser-scenario",
      JSON.stringify({
        browser: { mode: "launch", executable_path: process.execPath },
        start_url: { url: "http://127.0.0.1:3101/" },
        actions: [
          { step_id: "browse", action: "wait_for_timeout", duration_ms: 1 },
        ],
      }),
      ...options,
      "--json",
    ],
    {
      env: {},
      stdout: (text) => {
        stdout += text;
      },
      exit: () => undefined,
    },
  );
  return JSON.parse(stdout) as unknown;
};

it.each([false, true])(
  "keeps the initial startup failure snapshot when cleanup refusal is %s",
  async (retryFails) => {
    const cleanup = controlledCleanup({
      refused: retryFails,
      failure: new Error("profile removal denied"),
    });
    const lease = new AnalysisCleanupLease(cleanup.close, ["owned-profile"]);
    const provider = new PlaywrightBrowserScenarioProvider(
      async (_scenario, options) => {
        options.retainCleanup?.(lease);
        throw new AnalysisOutputError(
          "capture_browser_scenario",
          "browser startup failed",
        );
      },
    );
    try {
      const failure = await runCli(provider);
      expect(failure).toMatchObject({
        code: "cleanup_incomplete",
        details: { reason: "browser startup failed" },
      });
      expect(cleanup.attempts).toBe(1);
      expect(lease.released).toBe(!retryFails);
      if (retryFails) {
        expect(failure).toMatchObject({
          details: {
            diagnostics: {
              primary_error: {
                code: "cleanup_incomplete",
                details: { reason: "browser startup failed" },
              },
              cleanup_error: {
                details: { diagnostics: { reason: "profile removal denied" } },
              },
            },
          },
        });
        cleanup.allow();
        await provider.close();
        expect(cleanup.attempts).toBe(2);
      } else
        expect(JSON.stringify(failure)).not.toContain("profile removal denied");
      expect(lease.released).toBe(true);
    } finally {
      cleanup.allow();
      await provider.close();
    }
  },
);

it.each(["complete", "summary"] as const)(
  "retains complete Evidence on cancellation during CLI cleanup with %s delivery",
  async (detail) => {
    const destination = join(
      await createTestTempDirectory("rea-browser-summary-cli-"),
      "evidence.json",
    );
    const originalExit = process.exitCode;
    const listeners = new Set(process.listeners("SIGINT"));
    let closed = false;
    const provider: BrowserScenarioCapturePort = {
      identity: () => identity,
      captureScenario: async () => ok(capture),
      close: async () => {
        closed = true;
        // Invoke only this command's newly installed listener in the shared worker.
        const installed = process
          .listeners("SIGINT")
          .filter((listener) => !listeners.has(listener));
        expect(installed).toHaveLength(1);
        installed[0]!("SIGINT");
      },
    };
    try {
      const output = await runCli(provider, [
        "--detail",
        detail,
        "--evidence_output",
        destination,
      ]);
      expect(output).toMatchObject({
        code: "cancelled",
        details: {
          partial_observation: {
            operation: "capture_browser_scenario",
            normalized_result: capture,
          },
        },
      });
      expect(closed).toBe(true);
      await expect(access(destination)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(new Set(process.listeners("SIGINT"))).toEqual(listeners);
    } finally {
      process.exitCode = originalExit;
    }
  },
);

it("keeps the provider's cleanup failure and completed Evidence without publishing a summary bundle", async () => {
  const destination = join(
    await createTestTempDirectory("rea-browser-summary-cleanup-"),
    "evidence.json",
  );
  const failure = new ProviderCleanupError(
    "owned-browser",
    ["owned-profile"],
    { reason: "cleanup denied" },
    { operation: "capture_browser_scenario" },
  );
  const provider: BrowserScenarioCapturePort = {
    identity: () => identity,
    captureScenario: async () => ok(capture),
    close: async () => {
      throw failure;
    },
  };
  const output = await runCli(provider, [
    "--detail",
    "summary",
    "--evidence_output",
    destination,
  ]);
  expect(output).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      resources: ["owned-profile"],
      partial_observation: {
        operation: "capture_browser_scenario",
        normalized_result: capture,
      },
    },
  });
  await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
});

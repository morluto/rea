import { spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { partialProcessCaptureObservationSchema } from "../../../src/domain/process/processCapture.js";
import {
  parseProcessCapture,
  type ProcessCapture,
} from "../../../src/domain/process/processCaptureParsing.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { runCliJson } from "../../fixtures/cliJsonProcess.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { itWithCaptureCapability as captureTest } from "../../boundary/process/processCaptureCapability.js";
import { expectSerializedUnverifiedHostCleanup } from "../../support/hostCleanup.js";

const finalizationFixture = fileURLToPath(
  new URL("../../fixtures/processFinalization.mjs", import.meta.url),
);

type CaptureScenario = Record<string, unknown>;
type CaptureOutcome =
  | { readonly kind: "capture"; readonly capture: ProcessCapture }
  | { readonly kind: "partial"; readonly partial: unknown };

const captureScenario = (
  mode: "cooperative" | "ignoring",
  root: string,
  additions: CaptureScenario = {},
): CaptureScenario => ({
  executable: process.execPath,
  arguments: [finalizationFixture, mode, root],
  working_directory: root,
  filesystem_observation_paths: [root],
  idle_timeout_ms: 10_000,
  ...additions,
});

const captureViaCli = async (
  root: string,
  scenario: CaptureScenario,
): Promise<CaptureOutcome> => {
  const scenarioPath = join(root, "scenario.json");
  await writeFile(scenarioPath, JSON.stringify(scenario));
  const document = await runCliJson([
    "capture-process",
    scenarioPath,
    "--format",
    "json",
  ]);
  if (typeof document === "object" && document !== null && "code" in document)
    return {
      kind: "partial",
      partial: expectSerializedUnverifiedHostCleanup({ error: document }),
    };
  return {
    kind: "capture",
    capture: parseProcessCapture(parseEvidence(document).normalized_result),
  };
};

const captureViaMcp = async (
  scenario: CaptureScenario,
): Promise<CaptureOutcome> => {
  const { call } = await connectLocalToolsMcp();
  const response = await call("capture_process_scenario", scenario);
  if (response.isError === true)
    return {
      kind: "partial",
      partial: expectSerializedUnverifiedHostCleanup(
        parseMcpToolError(response),
      ),
    };
  return {
    kind: "capture",
    capture: parseProcessCapture(
      parseEvidence(response.structuredContent).normalized_result,
    ),
  };
};

const finalizationFromPartial = (partial: unknown) => {
  const parsed = partialProcessCaptureObservationSchema.parse(partial);
  if ("capture" in parsed) return parsed.capture.exit.finalization;
  return parsed.observations.exit.state === "available"
    ? parsed.observations.exit.value.finalization
    : undefined;
};

const expectCooperativeFinalization = (outcome: CaptureOutcome): void => {
  if (outcome.kind === "partial") {
    expect(
      finalizationFromPartial(outcome.partial),
      "the cleanup-flake partial observation preserves SIGTERM finalization",
    ).toMatchObject({ signals: [{ signal: "SIGTERM", delivery: "signaled" }] });
    return;
  }
  const { capture } = outcome;
  expect(capture.exit.reason, "the deadline remains the exit reason").toBe(
    "timeout",
  );
  expect(capture.exit.code, "a deadline exit has no normal code").toBeNull();
  expect(
    capture.exit.finalization,
    "the cooperative target receives only SIGTERM",
  ).toMatchObject({
    requested_ms: 1_500,
    signals: [{ signal: "SIGTERM", delivery: "signaled" }],
  });
  expect(
    capture.exit.finalization?.signals,
    "cooperative finalization does not send SIGKILL",
  ).toHaveLength(1);
  expect(
    capture.exit.finalization?.elapsed_ms,
    "the cooperative target exits within its interval",
  ).toBeLessThan(1_500);
  expect(
    capture.frames.map(({ data }) => data).join(""),
    "finalization output is captured",
  ).toContain("finalized");
  expect(
    capture.files_after.find(({ path }) => path.endsWith("final.json"))?.sha256,
    "the final filesystem snapshot hashes the final report",
  ).toMatch(/^[0-9a-f]{64}$/u);
  expect(
    capture.manifest.scenario.finalization_ms,
    "the scenario commitment retains finalization_ms",
  ).toBe(1_500);
  expect(
    capture.manifest.comparison_contract.finalization_ms,
    "the comparison contract retains finalization_ms",
  ).toBe(1_500);
};

const expectIgnoringFinalization = (outcome: CaptureOutcome): void => {
  if (outcome.kind === "partial") {
    expect(
      finalizationFromPartial(outcome.partial),
      "the cleanup-flake partial observation preserves SIGTERM finalization",
    ).toMatchObject({ signals: [{ signal: "SIGTERM", delivery: "signaled" }] });
    return;
  }
  const { capture } = outcome;
  expect(capture.exit.reason, "the deadline remains the exit reason").toBe(
    "timeout",
  );
  expect(capture.exit.signal, "the ignoring child ends on SIGKILL").toBe(9);
  expect(
    capture.exit.finalization?.signals,
    "SIGTERM is followed by exactly one SIGKILL",
  ).toMatchObject([
    { signal: "SIGTERM", delivery: "signaled" },
    { signal: "SIGKILL", delivery: "signaled" },
  ]);
  expect(
    capture.exit.finalization?.signals,
    "the ignoring child has exactly two finalization attempts",
  ).toHaveLength(2);
  expect(
    capture.exit.finalization?.signals[1]?.sent_at_ms,
    "SIGKILL waits for the requested interval",
  ).toBeGreaterThanOrEqual(1_500);
  expect(
    capture.exit.finalization?.elapsed_ms,
    "the elapsed finalization duration is observed",
  ).toEqual(expect.any(Number));
  expect(
    capture.files_after.find(({ path }) => path.endsWith("final.json")),
    "an ignoring child does not write a final report",
  ).toBeUndefined();
};

captureTest.each(["CLI", "MCP"] as const)(
  "captures a cooperative finalizer through the compiled %s workflow",
  async (adapter) => {
    const root = await createTestTempDirectory("rea-finalization-accept-");
    const scenario = captureScenario("cooperative", root, {
      timeout_ms: 1_500,
      finalization_ms: 1_500,
    });
    const outcome =
      adapter === "CLI"
        ? await captureViaCli(root, scenario)
        : await captureViaMcp(scenario);
    expectCooperativeFinalization(outcome);
  },
  20_000,
);

captureTest.each(["CLI", "MCP"] as const)(
  "forces SIGKILL after the finalization interval through the compiled %s workflow",
  async (adapter) => {
    const root = await createTestTempDirectory("rea-finalization-accept-");
    const scenario = captureScenario("ignoring", root, {
      timeout_ms: 1_500,
      finalization_ms: 1_500,
    });
    const outcome =
      adapter === "CLI"
        ? await captureViaCli(root, scenario)
        : await captureViaMcp(scenario);
    expectIgnoringFinalization(outcome);
  },
  20_000,
);

captureTest.each(["CLI", "MCP"] as const)(
  "keeps the default identity through the compiled %s workflow without finalization_ms",
  async (adapter) => {
    const root = await createTestTempDirectory("rea-finalization-default-");
    const scenario = captureScenario("ignoring", root, { timeout_ms: 500 });
    const outcome =
      adapter === "CLI"
        ? await captureViaCli(root, scenario)
        : await captureViaMcp(scenario);
    if (outcome.kind === "partial") {
      expect(
        finalizationFromPartial(outcome.partial),
        "the cleanup-flake partial observation has no default finalization",
      ).toBeUndefined();
      return;
    }
    expect(
      outcome.capture.exit,
      "default captures have no finalization evidence",
    ).not.toHaveProperty("finalization");
    expect(
      outcome.capture.manifest.scenario,
      "the committed scenario keeps its legacy identity",
    ).not.toHaveProperty("finalization_ms");
    expect(
      outcome.capture.manifest.comparison_contract,
      "the comparison contract keeps its legacy identity",
    ).not.toHaveProperty("finalization_ms");
  },
  20_000,
);

captureTest.each(["CLI", "MCP"] as const)(
  "rejects an unrepresentable combined capture budget through the compiled %s workflow",
  async (adapter) => {
    const root = await createTestTempDirectory("rea-finalization-budget-");
    const scenario = captureScenario("cooperative", root, {
      timeout_ms: Number.MAX_SAFE_INTEGER,
      finalization_ms: 1,
      settle_ms: 0,
    });
    if (adapter === "CLI") {
      const scenarioPath = join(root, "scenario.json");
      await writeFile(scenarioPath, JSON.stringify(scenario));
      const response = await runCliJson([
        "capture-process",
        scenarioPath,
        "--format",
        "json",
      ]);
      expect(
        JSON.stringify(response),
        "CLI rejects the combined budget",
      ).toContain("timeout_ms + finalization_ms + settle_ms");
    } else {
      const { call } = await connectLocalToolsMcp();
      const response = await call("capture_process_scenario", scenario);
      expect(response.isError, "MCP rejects the combined budget").toBe(true);
      expect(
        JSON.stringify(response),
        "MCP explains the combined budget",
      ).toContain("timeout_ms + finalization_ms + settle_ms");
    }
    await expect(
      access(join(root, "periodic.json")),
      "invalid budgets are rejected before launching the fixture",
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);

captureTest(
  "cancels the compiled CLI and MCP workflows during finalization without waiting for grace",
  async () => {
    const cliRoot = await createTestTempDirectory(
      "rea-finalization-cli-cancel-",
    );
    const cliScenarioPath = join(cliRoot, "scenario.json");
    await writeFile(
      cliScenarioPath,
      JSON.stringify(
        captureScenario("ignoring", cliRoot, {
          timeout_ms: 300,
          finalization_ms: 20_000,
        }),
      ),
    );
    const cli = spawn(
      process.execPath,
      [
        "scripts/rea.mjs",
        "capture-process",
        cliScenarioPath,
        "--format",
        "json",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    cli.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    cli.stderr.resume();
    const cliClosed = new Promise<{ readonly code: number | null }>(
      (resolve, reject) => {
        cli.once("error", reject);
        cli.once("close", (code) => resolve({ code }));
      },
    );
    onTestFinished(async () => {
      if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL");
      await cliClosed;
    });
    await delay(1_500);
    const cliStarted = Date.now();
    cli.kill("SIGINT");
    const cliExit = await cliClosed;
    expect(cliExit.code, "SIGINT produces the CLI cancellation status").toBe(
      130,
    );
    expect(
      Date.now() - cliStarted,
      "CLI cancellation does not wait for the grace interval",
    ).toBeLessThan(8_000);
    const cliDocument: unknown = JSON.parse(stdout);
    if (
      typeof cliDocument === "object" &&
      cliDocument !== null &&
      "code" in cliDocument &&
      cliDocument.code === "cleanup_incomplete"
    ) {
      const partial = expectSerializedUnverifiedHostCleanup({
        error: cliDocument,
      });
      expect(
        finalizationFromPartial(partial),
        "CLI cleanup-flake partial observation records SIGKILL",
      ).toMatchObject({
        signals: [{ signal: "SIGTERM" }, { signal: "SIGKILL" }],
      });
    } else {
      expect(cliDocument, "CLI returns a typed cancelled result").toMatchObject(
        {
          code: "cancelled",
        },
      );
    }

    const mcpRoot = await createTestTempDirectory(
      "rea-finalization-mcp-cancel-",
    );
    const { client } = await connectLocalToolsMcp();
    const controller = new AbortController();
    const call = client.callTool(
      {
        name: "capture_process_scenario",
        arguments: captureScenario("ignoring", mcpRoot, {
          timeout_ms: 300,
          finalization_ms: 20_000,
        }),
      },
      { signal: controller.signal },
    );
    await delay(1_500);
    const mcpStarted = Date.now();
    controller.abort(new Error("cancel finalization acceptance fixture"));
    await expect(
      call,
      "MCP cancellation rejects the pending SDK request",
    ).rejects.toThrow("cancel finalization acceptance fixture");
    expect(
      Date.now() - mcpStarted,
      "MCP cancellation does not wait for the grace interval",
    ).toBeLessThan(8_000);
  },
  20_000,
);

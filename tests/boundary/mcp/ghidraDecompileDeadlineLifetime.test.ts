import { access } from "node:fs/promises";

import { expect, it } from "vitest";
import { z } from "zod";

import { AnalysisProviderRegistry } from "../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../src/application/binary/BinarySessionComposition.js";
import { runDirectAnalysis } from "../../../src/application/DirectAnalysis.js";
import type { DirectAnalysisDependencies } from "../../../src/application/DirectAnalysisDependencies.js";
import { projectCliAnalysisResult } from "../../../src/cli/projectCliAnalysisResult.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { analysisCliErrorEnvelopeSchema } from "../../../src/contracts/errorSchemas.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { GhidraClient } from "../../../src/ghidra/GhidraClient.js";
import { ghidraProfileInstallationHost } from "../../../src/ghidra/GhidraInstallation.fixture.js";
import { GhidraProvider } from "../../../src/ghidra/GhidraProvider.js";
import { silentLogger } from "../../../src/logger.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { GhidraFixtureLauncher } from "../providers/ghidra/ghidraClient.fixture.js";

// Only installation discovery and the Java bridge are simulated. The bridge
// fails one procedure_pseudo_code request with the production deadline code;
// requests cross the real client socket, provider projection and adapters.
const environment = {
  GHIDRA_INSTALL_DIR: "/fixture/ghidra",
  REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS: "1",
};
const BRIDGE_MESSAGE =
  "Ghidra decompilation of 0x1000 exceeded the 1-second configured decompilation limit (ghidra.decompile_timeout_seconds; launch seed REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS)";

const ghidraSession = (launcher: GhidraFixtureLauncher) => {
  const config = parseConfig(environment);
  if (!config.ok) throw config.error;
  return composeBinarySession(
    new AnalysisProviderRegistry([
      new GhidraProvider(
        config.value,
        silentLogger,
        {},
        ghidraProfileInstallationHost,
        (options) =>
          new GhidraClient({
            ...options,
            platform: process.platform,
            launcher,
          }),
      ),
    ]),
  );
};

const expectReleased = async (launcher: GhidraFixtureLauncher) => {
  expect(launcher.processes.length).toBeGreaterThan(0);
  for (const root of launcher.runtimeRoots)
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  for (const child of launcher.processes)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
};

const cliFailure = z.object({
  remediation: z.object({ action: z.string() }),
  details: z.object({ limit: z.record(z.string(), z.unknown()) }),
});

const runId = z.object({
  result: z.object({ analysis_run: z.object({ run_id: z.string() }) }),
});

it("tells a finished CLI invocation to rerun with the launch setting, not to reuse its released session", async () => {
  const launcher = new GhidraFixtureLauncher("decompile_timed_out");
  const create = () => ghidraSession(launcher);
  const dependencies: DirectAnalysisDependencies = {
    readConfiguration: () => parseConfig(environment),
    createBinarySession: create,
    createNativeDispatchBinarySession: create,
    createArtifactBinarySession: create,
    createNativeBinarySession: create,
    createManagedBinarySession: create,
  };
  const projected = analysisCliErrorEnvelopeSchema.parse(
    projectCliAnalysisResult(
      await runDirectAnalysis(
        dependencies,
        process.execPath,
        "procedure_pseudo_code",
        { procedure: "fixture_main" },
        { providerId: "ghidra" },
      ),
    ),
  );
  // The invocation has already released the Program the guidance describes.
  await expectReleased(launcher);
  expect(projected).toMatchObject({
    error: "Analysis failed",
    code: "provider_timeout",
    category: "timeout",
    retryable: true,
    message: `${BRIDGE_MESSAGE}. Only this procedure's decompilation was stopped.`,
    recovery: { kind: "inspect_timeout_state", timeout_ms: 1000 },
    details: {
      diagnostics: { remote_code: "decompile_timed_out" },
      limit: {
        setting: "ghidra.decompile_timeout_seconds",
        effective_value: 1,
        unit: "seconds",
        applies_at: "next_invocation",
        scope: "rea-invocation",
        environment: "REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS",
      },
    },
  });
  const { details, remediation } = cliFailure.parse(projected);
  expect(details.limit).not.toHaveProperty("agent_editable");
  expect(details.limit).not.toHaveProperty("rea_restart_required");
  expect(
    remediation.action.startsWith(
      "Set REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS above 1 seconds",
    ),
  ).toBe(true);
  expect(remediation.action).toContain("new REA invocation");
  const output = JSON.stringify(projected);
  for (const continuingOnly of [
    "remains usable",
    "update_analysis_settings",
    "this Program",
  ])
    expect(output).not.toContain(continuingOnly);
}, 30_000);

it("keeps same-session and runtime-update guidance for a continuing MCP connection", async () => {
  const launcher = new GhidraFixtureLauncher("decompile_timed_out");
  const harness = await createApplicationMcpHarness({
    session: ghidraSession(launcher),
    serverOptions: { logger: silentLogger },
    clientIdentity: { name: "ghidra-decompile-deadline", version: "1" },
  });
  const tool = (name: string, arguments_: Record<string, string> = {}) =>
    harness.client.callTool({ name, arguments: arguments_ });
  try {
    const opened = await tool("open_binary", {
      path: process.execPath,
      provider_id: "ghidra",
    });
    expect(opened.isError).not.toBe(true);
    const timedOut = parseMcpToolError(
      await tool("procedure_pseudo_code", { procedure: "fixture_main" }),
    ).error;
    expect(timedOut).toMatchObject({
      code: "provider_timeout",
      retryable: true,
      message: `${BRIDGE_MESSAGE}. Only this procedure's decompilation was stopped. The Ghidra session remains usable.`,
      recovery: { kind: "inspect_timeout_state", timeout_ms: 1000 },
      details: {
        limit: {
          setting: "ghidra.decompile_timeout_seconds",
          effective_value: 1,
          applies_at: "next_operation",
          agent_editable: true,
          scope: "rea-runtime",
          rea_restart_required: false,
        },
      },
    });
    expect(timedOut.remediation.action).toContain(
      "update_analysis_settings with setting ghidra.decompile_timeout_seconds",
    );
    // The claim is true here: the same provider run answers the next call.
    const run = runId.parse((await tool("binary_session")).structuredContent)
      .result.analysis_run.run_id;
    const address = await tool("procedure_address", {
      procedure: "fixture_main",
    });
    expect(address.isError, JSON.stringify(address)).not.toBe(true);
    expect(parseEvidence(address.structuredContent).normalized_result).toBe(
      "0x1000",
    );
    expect(
      runId.parse((await tool("binary_session")).structuredContent).result
        .analysis_run.run_id,
    ).toBe(run);
    expect(launcher.processes).toHaveLength(1);
  } finally {
    await harness.close();
    await expectReleased(launcher);
  }
}, 30_000);

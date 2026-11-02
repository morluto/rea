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
import {
  GHIDRA_SESSION_RETAINED,
  ghidraDecompileTimeoutRecovery,
} from "../../../src/ghidra/GhidraProviderClient.js";
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

const cliFailure = z.object({ message: z.string() });

/** Facts about the enforced deadline, independent of the caller's lifetime. */
const enforcedLimit = {
  setting: "ghidra.decompile_timeout_seconds",
  effective_value: 1,
  unit: "seconds",
  minimum: 1,
  maximum: 2_147_483,
  agent_editable: true,
  rea_restart_required: false,
};
/** A finished invocation can act only through a new invocation's launch value. */
const invocationLimit = {
  ...enforcedLimit,
  applies_at: "next_invocation",
  scope: "rea-invocation",
  environment: "REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS",
};

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
  const recovery = ghidraDecompileTimeoutRecovery(1, false);
  expect(projected).toMatchObject({
    error: "Analysis failed",
    code: "provider_timeout",
    category: "timeout",
    retryable: true,
    recovery: { kind: "inspect_timeout_state", timeout_ms: 1000 },
    // The owner's invocation recovery for the effective 1-second deadline.
    remediation: { action: recovery.remediationAction },
    details: {
      diagnostics: { remote_code: "decompile_timed_out" },
      limit: invocationLimit,
    },
  });
  const { message } = cliFailure.parse(projected);
  expect(message.startsWith(BRIDGE_MESSAGE)).toBe(true);
  expect(message).not.toContain(GHIDRA_SESSION_RETAINED);
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
      recovery: { kind: "inspect_timeout_state", timeout_ms: 1000 },
      remediation: {
        action: ghidraDecompileTimeoutRecovery(1, false)
          .continuingRemediationAction,
      },
      details: {
        limit: {
          ...enforcedLimit,
          applies_at: "next_operation",
          scope: "rea-runtime",
        },
      },
    });
    expect(timedOut.details?.limit).not.toHaveProperty("environment");
    expect(timedOut.message.startsWith(BRIDGE_MESSAGE)).toBe(true);
    expect(timedOut.message.endsWith(` ${GHIDRA_SESSION_RETAINED}`)).toBe(true);
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

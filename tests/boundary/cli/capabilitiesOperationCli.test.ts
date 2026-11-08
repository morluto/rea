import { Cli } from "incur";
import { expect, it } from "vitest";
import { z } from "zod";
import type {
  AnalysisProviderCandidate,
  CapabilityDescriptor,
  ProviderIdentity,
} from "../../../src/application/AnalysisProvider.js";
import { runSessionStatus } from "../../../src/application/DirectAnalysisStatus.js";
import { AnalysisProviderRegistry } from "../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../src/application/binary/BinarySessionComposition.js";
import { registerUtilityCommands } from "../../../src/cli/utilityCommands.js";
import { isCliOperationFailure } from "../../../src/cliLogging.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import {
  analysisProviderCandidate,
  operationProviderCandidate,
} from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { silentLogger } from "../../../src/logger.js";

const searchBytes = (
  provider: ProviderIdentity,
  available: boolean,
): CapabilityDescriptor => ({
  provider,
  operation: "search_bytes",
  ...(available
    ? { available: true as const, reason: null }
    : {
        available: false as const,
        reason: "Masked byte search has not been verified.",
      }),
  effects: {
    mutatesArtifact: false,
    launchesProcess: true,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem: false,
    changesPermissions: false,
    requiresRoot: false,
  },
  limitations: [],
});

const provider = (
  id: string,
  options: { readonly configured: boolean; readonly declares: boolean | null },
): AnalysisProviderCandidate => {
  const identity: ProviderIdentity = {
    id,
    name: `${id} provider`,
    version: null,
  };
  return {
    identity: () => identity,
    capabilities: () =>
      options.declares === null
        ? []
        : [searchBytes(identity, options.declares)],
    inspectAvailability: () =>
      options.configured
        ? { status: "available", code: null, reason: null, diagnostics: {} }
        : {
            status: "unavailable",
            code: "not_configured",
            reason: `${id} is not configured`,
            remediation: `Configure ${id}.`,
            diagnostics: {},
          },
    inspectTargetSupport: () => ({
      status: "supported",
      code: null,
      reason: null,
      diagnostics: {},
    }),
    resolveAnalysisProfile: () => {
      throw new Error("Status must not resolve a provider profile");
    },
    createClient: () => {
      throw new Error("Status must not start a provider client");
    },
  };
};

const createSession = () =>
  composeBinarySession(
    new AnalysisProviderRegistry([
      provider("alpha", { configured: true, declares: true }),
      provider("beta", { configured: true, declares: false }),
      provider("gamma", { configured: false, declares: null }),
    ]),
  );

const runCapabilities = async (arguments_: readonly string[]) => {
  const cli = Cli.create({ name: "rea" });
  registerUtilityCommands(
    cli,
    silentLogger,
    {},
    {
      runSessionStatus: (logger, view) =>
        runSessionStatus(
          {
            readConfiguration: () => parseConfig({}),
            createBinarySession: () => createSession(),
          },
          logger,
          view,
        ),
      runProviderAnalysis: async () => ({ ok: false, error: null }),
    },
  );
  let stdout = "";
  await cli.serve(["capabilities", ...arguments_, "--json"], {
    env: {},
    stdout: (text) => {
      stdout += text;
    },
    exit: () => {},
  });
  return z.record(z.string(), z.unknown()).parse(JSON.parse(stdout));
};

it("reports one tool's candidates through the session projection MCP uses", async () => {
  const output = await runCapabilities(["--operation", "search_bytes"]);
  const session = createSession();
  try {
    const direct = z.record(z.string(), z.unknown()).parse(
      await session.status({
        detail: "operation",
        operation: "search_bytes",
      }),
    );
    expect(output.operation_candidates).toEqual(direct.operation_candidates);
  } finally {
    await session.close();
  }
  expect(output).not.toHaveProperty("analysis_provider_candidates");
  expect(output.operation).toBe("search_bytes");
  expect(
    operationProviderCandidate
      .array()
      .parse(output.operation_candidates)
      .map(
        ({ provider: { id }, availability, target_support, declaration }) => [
          id,
          availability.status,
          target_support.status,
          declaration.status,
        ],
      ),
  ).toEqual([
    ["alpha", "available", "unknown", "available"],
    ["beta", "available", "unknown", "unavailable"],
    ["gamma", "unavailable", "unknown", "not_declared"],
  ]);
});

it("keeps complete provider facts without --operation", async () => {
  const output = await runCapabilities([]);
  expect(output).not.toHaveProperty("operation_candidates");
  expect(
    analysisProviderCandidate
      .array()
      .parse(output.analysis_provider_candidates)
      .map(({ provider: { id } }) => id),
  ).toEqual(["alpha", "beta", "gamma"]);
});

it("rejects a tool outside the deep-provider scope as invalid input", async () => {
  const output = await runCapabilities(["--operation", "inspect_macho"]);
  expect(isCliOperationFailure(output)).toBe(true);
  expect(output).toMatchObject({ error: { category: "invalid_input" } });
});

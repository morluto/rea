import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cli } from "incur";
import pino from "pino";
import { expect, it } from "vitest";
import { z } from "zod";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperationPort,
  type AnalysisProvider,
} from "../../../src/application/AnalysisProvider.js";
import { runDirectAnalysis } from "../../../src/application/DirectAnalysis.js";
import type { DirectAnalysisDependencies } from "../../../src/application/DirectAnalysisDependencies.js";
import { CLEANUP_STOPPED_VALUE_TRACE } from "../../../src/application/native/NativeValueTrace.js";
import {
  failingValueTraceReads,
  valueTraceDiamond,
  valueTraceProvider,
  VALUE_TRACE_DIAMOND_READS,
} from "../../../src/application/native/NativeValueTrace.fixture.js";
import { registerCoreNativeCommands } from "../../../src/cli/coreNativeCommands.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { nativeValueTraceSchema } from "../../../src/domain/native/nativeValueTrace.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err, ok } from "../../../src/domain/result.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const effects = {
  mutatesArtifact: false,
  launchesProcess: false,
  mayShowUi: false,
  mayAccessNetwork: false,
  mayWriteFilesystem: false,
  changesPermissions: false,
  requiresRoot: false,
};

/** One-shot CLI analysis over a simulated value-trace provider; returns parsed stdout. */
const serveTraceCli = async (
  port: AnalysisOperationPort,
  close: AnalysisClient["close"] = async () => ok(null),
) => {
  const directory = await createTestTempDirectory("rea-value-trace-cli-");
  const path = join(directory, "fixture.hop");
  await writeFile(path, "synthetic analysis database");
  const provider: AnalysisProvider = {
    identity: () => valueTraceProvider,
    capabilities: () =>
      (["analyze_function", "resolve_native_call_targets"] as const).map(
        (operation) => ({
          provider: valueTraceProvider,
          operation,
          available: true,
          reason: null,
          cachePolicy: "live",
          limitations: [],
          effects,
        }),
      ),
    resolveAnalysisProfile: async () =>
      ok({
        profile: createAnalysisProfile(valueTraceProvider, { fixture: true }),
      }),
    createClient: () => ({
      execute: async (operation, parameters, options) =>
        operation === "health"
          ? ok(createAnalysisExecution(null, valueTraceProvider))
          : port.execute(operation, parameters, options),
      close,
    }),
  };
  const createSession = () => createTestBinarySession(provider);
  const dependencies: DirectAnalysisDependencies = {
    readConfiguration: () => parseConfig({}),
    createBinarySession: createSession,
    createNativeDispatchBinarySession: createSession,
    createArtifactBinarySession: createSession,
    createNativeBinarySession: createSession,
    createManagedBinarySession: createSession,
  };
  const cli = Cli.create("rea-value-trace-cli-test", { sync: false });
  registerCoreNativeCommands(
    cli,
    pino({ enabled: false }),
    (target, tool, arguments_, options) =>
      runDirectAnalysis(dependencies, target, tool, arguments_, options),
  );
  return async (options: readonly string[]) => {
    let stdout = "";
    await cli.serve(
      ["trace-native-values", path, "0x1000", "--max-depth", "1", ...options],
      {
        env: {},
        stdout: (text) => {
          stdout += text;
        },
        exit: () => undefined,
      },
    );
    return { path, output: JSON.parse(stdout) as unknown };
  };
};

const traceCli = async () => {
  const run = await serveTraceCli(
    valueTraceDiamond({ sessionSubject: true }).port,
  );
  return async (options: readonly string[]) =>
    nativeValueTraceSchema.parse(
      parseEvidence((await run(options)).output).normalized_result,
    );
};

const cliFailureSchema = z.object({
  code: z.string(),
  details: z
    .object({
      resources: z.array(z.string()),
      partial_observation: z.unknown(),
    })
    .loose(),
});

it("reports the CLI last page and its observed node budget separately", async () => {
  const trace = await traceCli();
  expect(
    await trace(["--offset", "10", "--limit", "3", "--json"]),
  ).toMatchObject({
    nodes: [{ id: "0x3000/parameter:0" }],
    total_nodes: 11,
    next_offset: null,
    page_truncated: true,
    traversal: { status: "complete" },
    truncated: true,
    unknowns: [],
  });
  const capped = await trace([
    "--max-nodes",
    "9",
    "--offset",
    "8",
    "--limit",
    "3",
    "--json",
  ]);
  expect(capped).toMatchObject({
    nodes: [{ id: "0x3000/op-1" }],
    total_nodes: 9,
    next_offset: null,
    page_truncated: true,
    traversal: { status: "truncated", reasons: ["max_nodes"] },
    truncated: true,
  });
  expect(capped.unknowns).toContainEqual({
    procedure: "0x3000",
    address: null,
    reason: "Node budget reached",
  });
});

it.each([
  { close: "confirmed", resources: ["owned worker"] },
  { close: "unconfirmed", resources: ["owned session", "owned worker"] },
] as const)(
  "stops a CLI trace at a callee's unconfirmed cleanup with $close final close",
  async ({ close, resources }) => {
    const failure = new AnalysisCapabilityUnavailableError(
      valueTraceProvider.id,
      "analyze_function",
      "controlled child failure",
      {
        cleanup: {
          reason: "cleanup proof refused",
          resources: ["owned worker"],
        },
      },
    );
    const { port, reads } = failingValueTraceReads(
      valueTraceDiamond({ sessionSubject: true }).port,
      { "analyze_function:0x2000": failure },
    );
    const run = await serveTraceCli(
      port,
      close === "confirmed"
        ? async () => ok(null)
        : async () =>
            err(
              new ProviderCleanupError(
                valueTraceProvider.id,
                ["owned session"],
                {},
              ),
            ),
    );

    const { path, output } = await run(["--json"]);

    expect(reads).toEqual(VALUE_TRACE_DIAMOND_READS.slice(0, 4));
    const failed = cliFailureSchema.parse(output);
    expect(failed.code).toBe("cleanup_incomplete");
    expect([...failed.details.resources].sort()).toEqual(resources);
    const partial = parseEvidence(failed.details.partial_observation);
    expect(partial).toMatchObject({
      operation: "trace_native_values",
      caller_input_path: path,
      parameters: { procedure: "0x1000", max_depth: 1 },
    });
    const admitted = nativeValueTraceSchema.parse(partial.normalized_result);
    expect(admitted.procedures.map(({ address }) => address)).toEqual([
      "0x1000",
    ]);
    expect(admitted.traversal).toEqual({
      status: "truncated",
      reasons: ["cleanup_incomplete"],
    });
    expect(admitted.unknowns).toContainEqual({
      procedure: "0x2000",
      address: null,
      reason: CLEANUP_STOPPED_VALUE_TRACE,
    });
  },
);

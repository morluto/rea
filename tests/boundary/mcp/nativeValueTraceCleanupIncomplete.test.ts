import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { CLEANUP_STOPPED_VALUE_TRACE } from "../../../src/application/native/NativeValueTrace.js";
import {
  failingValueTraceReads,
  valueTraceDiamond,
  valueTraceProvider as provider,
  VALUE_TRACE_DIAMOND_READS as ALL_READS,
  type ValueTraceDiamondRead,
} from "../../../src/application/native/NativeValueTrace.fixture.js";
import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { evidenceBundleSchema } from "../../../src/domain/evidenceBundle.js";
import { nativeValueTraceSchema } from "../../../src/domain/native/nativeValueTrace.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  closeEnhancedToolResources,
  connect,
  jsonResult,
  resources,
} from "./enhancedToolsHarness.js";

afterEach(closeEnhancedToolResources);

const CHILD_FAILURE = "controlled child failure";

const childFailure = (operation: string, cleanup: boolean) => {
  const failure = new AnalysisCapabilityUnavailableError(
    provider.id,
    operation,
    CHILD_FAILURE,
    cleanup
      ? {
          cleanup: {
            reason: "cleanup proof refused",
            resources: ["owned worker"],
          },
        }
      : undefined,
  );
  // The owner retaining the worker binds this retry; the trace must keep it.
  return cleanup
    ? failure.bindCleanupRetry({ operation: "close_binary" })
    : failure;
};

/** Serve the diamond, failing each listed read, and record every dispatched read. */
const failingDiamond = (
  failures: Partial<Record<ValueTraceDiamondRead, AnalysisError>>,
  options: { readonly sessionSubject?: boolean } = {},
) => failingValueTraceReads(valueTraceDiamond(options).port, failures);

const request = {
  procedure: "0x1000",
  max_depth: 1,
  max_functions: 4,
  max_call_sites: 20,
  max_nodes: 100,
  max_edges: 200,
  limit: 100,
  offset: 0,
};
const trace = { name: "trace_native_values", arguments: request };

const stops = [
  {
    read: "resolve_native_call_targets:0x1004",
    stop: { procedure: "0x1000", address: "0x1004" },
    procedures: ["0x1000"],
    calls: [],
    // An unresolved call never discovers 0x2000.
    ordinaryReads: [0, 1, 2, 5],
  },
  {
    read: "analyze_function:0x2000",
    stop: { procedure: "0x2000", address: null },
    procedures: ["0x1000"],
    calls: ["0x1000/call-b->0x2000", "0x1000/call-c->0x3000"],
    // A failed dossier has no call sites to resolve.
    ordinaryReads: [0, 1, 2, 3, 5],
  },
  {
    read: "resolve_native_call_targets:0x2004",
    stop: { procedure: "0x2000", address: "0x2004" },
    procedures: ["0x1000", "0x2000"],
    calls: ["0x1000/call-b->0x2000", "0x1000/call-c->0x3000"],
    ordinaryReads: [0, 1, 2, 3, 4, 5],
  },
] as const;

const callEdges = (value: z.output<typeof nativeValueTraceSchema>) =>
  value.edges
    .filter(({ kind }) => kind === "call")
    .map(({ source, target }) => `${source}->${target}`);

describe("trace_native_values after a validated seed", () => {
  it.each(stops)(
    "stops at unconfirmed cleanup from $read and reports it with the admitted trace",
    async ({ read, stop, procedures, calls }) => {
      const operation = read.split(":")[0] ?? "";
      const { port, reads } = failingDiamond({
        [read]: childFailure(operation, true),
      });
      const client = await connect(port);

      const { error } = parseMcpToolError(await client.callTool(trace));

      // Nothing is dispatched after the read whose cleanup is unconfirmed.
      expect(reads).toEqual(ALL_READS.slice(0, ALL_READS.indexOf(read) + 1));
      expect(error).toMatchObject({
        code: "cleanup_incomplete",
        recovery: { kind: "retry_cleanup", operation: "close_binary" },
        details: {
          operation,
          cleanup: "incomplete",
          resources: ["owned worker"],
          cleanup_reason: "cleanup proof refused",
          execution_failure: "capability_unavailable",
        },
      });
      expect(JSON.stringify(error)).toContain(CHILD_FAILURE);
      // Without an Evidence writer the admitted trace stays inline.
      const partial = parseEvidence(error.details?.partial_observation);
      expect(partial).toMatchObject({
        operation: "trace_native_values",
        parameters: request,
      });
      const admitted = nativeValueTraceSchema.parse(partial.normalized_result);
      expect(admitted.procedures.map(({ address }) => address)).toEqual(
        procedures,
      );
      expect(callEdges(admitted)).toEqual(calls);
      expect(admitted).toMatchObject({
        traversal: { status: "truncated", reasons: ["cleanup_incomplete"] },
        truncated: true,
      });
      expect(admitted.unknowns).toContainEqual({
        ...stop,
        reason: CLEANUP_STOPPED_VALUE_TRACE,
      });
      // The stopping failure is the outcome, not one of the trace's unknowns.
      expect(JSON.stringify(admitted.unknowns)).not.toContain(CHILD_FAILURE);
    },
  );

  it.each(stops)(
    "keeps an ordinary failure from $read as a located unknown and continues",
    async ({ read, stop, ordinaryReads }) => {
      const operation = read.split(":")[0] ?? "";
      const { port, reads } = failingDiamond({
        [read]: childFailure(operation, false),
      });
      const client = await connect(port);

      const response = await client.callTool(trace);

      expect(response.isError).not.toBe(true);
      expect(reads).toEqual(ordinaryReads.map((index) => ALL_READS[index]));
      const completed = nativeValueTraceSchema.parse(jsonResult(response));
      expect(completed.traversal).toEqual({ status: "complete" });
      expect(completed.unknowns).toContainEqual({
        ...stop,
        reason: expect.stringContaining(CHILD_FAILURE),
      });
    },
  );

  it("keeps an earlier ordinary failure and dispatches nothing after a later cleanup failure", async () => {
    const { port, reads } = failingDiamond({
      "resolve_native_call_targets:0x1004": childFailure(
        "resolve_native_call_targets",
        false,
      ),
      "resolve_native_call_targets:0x1008": childFailure(
        "resolve_native_call_targets",
        true,
      ),
    });
    const client = await connect(port);

    const { error } = parseMcpToolError(await client.callTool(trace));

    expect(reads).toEqual(ALL_READS.slice(0, 3));
    expect(error).toMatchObject({
      code: "cleanup_incomplete",
      details: { resources: ["owned worker"] },
    });
    const admitted = nativeValueTraceSchema.parse(
      parseEvidence(error.details?.partial_observation).normalized_result,
    );
    expect(admitted.unknowns).toEqual([
      {
        procedure: "0x1000",
        address: "0x1004",
        reason: expect.stringContaining(CHILD_FAILURE),
      },
      {
        procedure: "0x1000",
        address: "0x1008",
        reason: CLEANUP_STOPPED_VALUE_TRACE,
      },
    ]);
  });

  it("returns a seed cleanup failure without a trace", async () => {
    const { port, reads } = failingDiamond({
      "analyze_function:0x1000": childFailure("analyze_function", true),
    });
    const client = await connect(port);

    const { error } = parseMcpToolError(await client.callTool(trace));

    expect(reads).toEqual(["analyze_function:0x1000"]);
    expect(error).toMatchObject({
      code: "cleanup_incomplete",
      details: { resources: ["owned worker"] },
    });
    expect(error.details?.partial_observation).toBeUndefined();
  });
});

/** Serve the failing diamond through a production session with a committed profile. */
const openSession = async (port: AnalysisOperationPort) => {
  const directory = await createTestTempDirectory("rea-value-trace-cleanup-");
  const target = join(directory, "fixture.com");
  await writeFile(target, Buffer.from([0xb8, 0x00, 0x4c, 0xcd, 0x21]));
  const session = createTestBinarySession({
    identity: () => provider,
    capabilities: () =>
      (["analyze_function", "resolve_native_call_targets"] as const).map(
        (operation) => ({
          provider,
          operation,
          available: true,
          reason: null,
          cachePolicy: "live",
          limitations: [],
          effects: {
            mutatesArtifact: false,
            launchesProcess: false,
            mayShowUi: false,
            mayAccessNetwork: false,
            mayWriteFilesystem: false,
            changesPermissions: false,
            requiresRoot: false,
          },
        }),
      ),
    // A committed profile lets the session retain each admitted read.
    resolveAnalysisProfile: async () =>
      ok({ profile: createAnalysisProfile(provider, { fixture: true }) }),
    createClient: () => ({
      execute: (operation, parameters, options) =>
        port.execute(operation, parameters, options),
      close: async () => ok(null),
    }),
  });
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "value-trace-cleanup", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const opened = await client.callTool({
    name: "open_binary",
    arguments: { path: target, format: "dos-com" },
  });
  expect(opened.isError).not.toBe(true);
  return { client, session };
};

it("retains the admitted trace and its completed sources as session Evidence", async () => {
  const { port, reads } = failingDiamond(
    {
      "analyze_function:0x3000": childFailure("analyze_function", true),
    },
    { sessionSubject: true },
  );
  const { client, session } = await openSession(port);

  const { error } = parseMcpToolError(await client.callTool(trace));

  expect(reads).toEqual(ALL_READS);
  expect(error).toMatchObject({
    code: "cleanup_incomplete",
    details: { resources: ["owned worker"] },
  });
  const reference = z
    .strictObject({
      kind: z.literal("retained-evidence"),
      evidence_id: z.string(),
    })
    .parse(error.details?.partial_observation);
  const exported = await client.callTool({
    name: "get_evidence_bundle",
    arguments: {},
  });
  expect(exported.isError).not.toBe(true);
  const bundle = evidenceBundleSchema.parse(
    z.object({ result: z.unknown() }).parse(exported.structuredContent).result,
  );
  expect(bundle.records.map(({ evidence_id }) => evidence_id)).toContain(
    reference.evidence_id,
  );
  const retained = session.evidenceForAnalysis(reference.evidence_id);
  expect(retained).toMatchObject({
    operation: "trace_native_values",
    subject: { format: "dos-com" },
  });
  expect(
    nativeValueTraceSchema.parse(retained?.normalized_result).traversal,
  ).toEqual({ status: "truncated", reasons: ["cleanup_incomplete"] });
  // Both dossiers completed before the stop stay linked as sources.
  const dossiers = (retained?.evidence_links ?? []).flatMap((link) => {
    const source = session.evidenceForAnalysis(link);
    return source?.operation === "analyze_function"
      ? [String(source.parameters.procedure)]
      : [];
  });
  expect(dossiers.sort()).toEqual(["0x1000", "0x2000"]);
});
